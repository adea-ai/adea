// Pull request collaboration handlers for the source control app.
//
// Layered on the #423 registrar: the inbox and detail read models (GraphQL
// through `gh api graphql`), the conversation timeline, commits, changed
// files, check logs, picker read models, and the collaboration mutations —
// comments, thread replies and resolution, reviewer/assignee/label edits,
// review submission, auto-merge, server-side branch update, and re-running
// failed jobs. Request bodies that carry user text travel on gh's stdin
// (`--input -`), never argv. Consequential changes to the branch or its
// merge outcome (auto-merge, branch update) are plan/commit pairs that bind
// the head SHA and re-prove it at commit time; everything else re-reads
// server truth before reporting success.
import { createHash, randomUUID } from 'node:crypto'

import type {
  DevCommand,
  DevError,
  DevOperation,
  DevRuntimePage,
  GitHubActor,
  GitHubBranch,
  GitHubCheckRollupState,
  GitHubCheckLog,
  GitHubCompare,
  GitHubLabel,
  GitHubMergeMethod,
  GitHubRerunResult,
  GitHubTimelineItem,
  MutationPlan,
  Scope,
} from '../../../../../../packages/types/src/dev-runtime'
import { devOperationDecoders } from '../../../../../../packages/types/src/dev-runtime'
import {
  ASSIGNABLE_USERS_QUERY,
  BODY_MAX,
  COMMITS_QUERY,
  CONVERT_TO_DRAFT_MUTATION,
  DEFAULT_BRANCH_HEAD_QUERY,
  DISABLE_AUTO_MERGE_MUTATION,
  ENABLE_AUTO_MERGE_MUTATION,
  READY_FOR_REVIEW_MUTATION,
  REPLY_THREAD_MUTATION,
  RESOLVE_THREAD_MUTATION,
  SUMMARIES_QUERY,
  SUMMARY_QUERY,
  THREAD_QUERY,
  TIMELINE_QUERY,
  UNRESOLVE_THREAD_MUTATION,
  UPDATE_BRANCH_MUTATION,
  PULL_REQUEST_NODE_QUERY,
  TYPENAME,
  cleanText,
  graphqlData,
  graphqlMergeMethod,
  mapChangedFile,
  mapCommitSummary,
  mapRepositorySettings,
  mapRollupState,
  mapRestComment,
  mapRestReview,
  mapSummary,
  mapThread,
  mapTimelineNode,
  type MappedSummary,
} from './graphql'
import type { GhRunResult, GhRunner, GithubRepoContext, ParsedRemote } from './register'
import { arr, bool, gitSha, num, obj, optStr, str } from './untrusted'

const PLAN_TTL_MS = 10 * 60_000
const LOG_TAIL_MAX = 524_288
const LOG_READ_BUDGET = 32 * 1024 * 1024
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/
const TEAM_PATTERN = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/
const CHECK_ID_PATTERN = /^\d{1,20}$/

export type CollaborationContext = Readonly<{
  scope: Scope
  host: string
  now(): number
  cacheTtlMs: number
  runGh: GhRunner
  devError(code: DevError['code'], message: string, retryable?: boolean): DevError
  classifyGh(result: GhRunResult, operation: string): DevError
  requireScope(command: DevCommand): void
  resourceOf(command: DevCommand, kind: string, bodyId: unknown): string
  repoContext(command: DevCommand): { repoId: string; record: GithubRepoContext }
  remoteOf(canonicalRoot: string, remoteName: string): Promise<ParsedRemote>
  prIdParts(pullRequestId: string): { owner: string; repo: string; number: number }
  repoIdForRemote(parts: { owner: string; repo: string }): string
  ghJson(args: readonly string[], options?: { staleFallback?: boolean }): Promise<unknown>
  apiArgs(host: string, path: string, extra?: readonly string[]): string[]
  /** Drop the #423 REST read-model cache for a pull request after a write. */
  invalidatePullRequest(parts: { owner: string; repo: string; number: number }): void
}>

type CollaborationPlan =
  | {
      kind: 'auto-merge'
      pullRequestId: string
      headSha: string
      enabled: boolean
      method: GitHubMergeMethod
      expiresAt: number
      digest: string
    }
  | {
      kind: 'sync-branch'
      pullRequestId: string
      headSha: string
      method: 'merge' | 'rebase'
      expiresAt: number
      digest: string
    }

type Parts = { owner: string; repo: string; number: number }

function digestOf(facts: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(facts), 'utf8').digest('hex')
}

function iso(at: number): string {
  return new Date(at).toISOString()
}

function planBlocker(code: DevError['code'], message: string): DevError {
  return { code, retryable: false, message }
}

function encodeCursor(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url')
}

export function createCollaborationHandlers(
  ctx: CollaborationContext
): Partial<Record<DevOperation, (command: DevCommand) => unknown>> {
  const plans = new Map<string, CollaborationPlan>()
  const cache = new Map<string, { value: unknown; observedAt: number }>()
  const STALEABLE: ReadonlySet<DevError['code']> = new Set([
    'rate_limited',
    'remote_unavailable',
    'timeout',
  ])

  // ── Transport ────────────────────────────────────────────────────────────

  /** A JSON request through `gh api --input -`: the body (GraphQL document,
   *  variables, or REST JSON with user text) rides stdin, never argv. */
  async function ghInput(
    path: string,
    body: unknown,
    options: { method?: string; operation: string; cacheKey?: string; allowCached?: boolean }
  ): Promise<unknown> {
    const { cacheKey, allowCached = false } = options
    if (allowCached && cacheKey !== undefined) {
      const hit = cache.get(cacheKey)
      if (hit && ctx.now() - hit.observedAt < ctx.cacheTtlMs) return hit.value
    }
    const extra = ['--input', '-', ...(options.method ? ['--method', options.method] : [])]
    const result = await ctx.runGh(ctx.apiArgs(ctx.host, path, extra), {
      stdin: JSON.stringify(body),
    })
    if (result.exitCode !== 0) {
      const failure = ctx.classifyGh(result, options.operation)
      const stale = cacheKey !== undefined ? cache.get(cacheKey)?.value : undefined
      if (stale !== undefined && STALEABLE.has(failure.code)) return stale
      throw failure
    }
    let parsed: unknown
    try {
      parsed = result.stdout.trim().length === 0 ? {} : JSON.parse(result.stdout)
    } catch {
      throw ctx.devError('corrupt_state', 'gh returned output that is not valid JSON')
    }
    if (cacheKey !== undefined) cache.set(cacheKey, { value: parsed, observedAt: ctx.now() })
    return parsed
  }

  async function graphql(
    query: string,
    variables: Record<string, unknown>,
    options: { operation: string; cacheKey?: string; allowCached?: boolean }
  ): Promise<Record<string, unknown>> {
    const payload = await ghInput('graphql', { query, variables }, { method: 'POST', ...options })
    return graphqlData(payload)
  }

  function forgetPullRequest(parts: Parts): void {
    for (const key of cache.keys())
      if (key.startsWith(`pr:${parts.owner}/${parts.repo}#${parts.number}:`)) cache.delete(key)
    cache.delete(`summaries:${parts.owner}/${parts.repo}`)
    for (const key of cache.keys())
      if (key.startsWith(`summaries:${parts.owner}/${parts.repo}:`)) cache.delete(key)
    ctx.invalidatePullRequest(parts)
  }

  function pullRequestOf(command: DevCommand): { pullRequestId: string; parts: Parts } {
    ctx.requireScope(command)
    const body = command.body as { pullRequestId?: unknown }
    const pullRequestId = ctx.resourceOf(command, 'pull_request', body.pullRequestId)
    return { pullRequestId, parts: ctx.prIdParts(pullRequestId) }
  }

  async function repoRemote(command: DevCommand) {
    const { record } = ctx.repoContext(command)
    const parsed = await ctx.remoteOf(record.canonicalRoot, 'origin')
    return { record, parsed }
  }

  function pageOf<T>(
    items: readonly T[],
    pageInfo: Record<string, unknown> | undefined
  ): DevRuntimePage<T> {
    const hasNext = pageInfo !== undefined && pageInfo.hasNextPage === true
    const end = pageInfo === undefined ? undefined : optStr(pageInfo.endCursor, 'endCursor', 512)
    return {
      items,
      ...(hasNext && end ? { nextCursor: encodeCursor(end) } : {}),
      observedAt: iso(ctx.now()),
    }
  }

  function graphqlCursor(cursor: unknown): string | null {
    if (cursor === undefined) return null
    const text = Buffer.from(String(cursor), 'base64url').toString('utf8')
    if (text.length === 0 || text.length > 512)
      throw ctx.devError('not_found', 'unknown listing cursor')
    return text
  }

  function restPage(cursor: unknown, limit: number): { start: number; page: number } {
    if (cursor === undefined) return { start: 0, page: 1 }
    const start = Number(Buffer.from(String(cursor), 'base64url').toString('utf8'))
    if (!Number.isSafeInteger(start) || start < 0 || start % limit !== 0)
      throw ctx.devError('not_found', 'unknown listing cursor')
    return { start, page: start / limit + 1 }
  }

  function restPageOf<T>(items: readonly T[], start: number, limit: number): DevRuntimePage<T> {
    return {
      items,
      ...(items.length === limit ? { nextCursor: encodeCursor(String(start + limit)) } : {}),
      observedAt: iso(ctx.now()),
    }
  }

  async function readSummary(
    parts: Parts,
    options: { refresh: boolean; withBehind: boolean }
  ): Promise<MappedSummary> {
    const data = await graphql(
      SUMMARY_QUERY,
      { owner: parts.owner, name: parts.repo, number: parts.number },
      {
        operation: 'pull request read',
        cacheKey: `pr:${parts.owner}/${parts.repo}#${parts.number}:summary`,
        allowCached: !options.refresh,
      }
    )
    const repository = obj(data.repository, 'repository')
    if (repository.pullRequest === null || repository.pullRequest === undefined)
      throw ctx.devError('not_found', 'the pull request was not found on the remote')
    const mapped = mapSummary(repository.pullRequest, 'pullRequest', {
      owner: parts.owner,
      repo: parts.repo,
      repoId: ctx.repoIdForRemote(parts),
      settings: mapRepositorySettings(repository, 'repository'),
      observedAt: iso(ctx.now()),
      withBody: true,
    })
    if (!options.withBehind || mapped.summary.state !== 'open') return mapped
    try {
      const compare = obj(
        await ctx.ghJson(
          ctx.apiArgs(
            ctx.host,
            `repos/${parts.owner}/${parts.repo}/compare/${encodeURIComponent(mapped.summary.baseRef)}...${mapped.summary.headSha}`
          )
        ),
        'compare'
      )
      return {
        nodeId: mapped.nodeId,
        summary: { ...mapped.summary, behindBy: num(compare.behind_by, 'compare.behind_by') },
      }
    } catch {
      // Ahead/behind is decoration: a failed compare leaves it absent.
      return mapped
    }
  }

  async function readThread(threadId: string, parts: Parts) {
    const data = await graphql(THREAD_QUERY, { id: threadId }, { operation: 'review thread read' })
    const node = data.node
    if (
      node === null ||
      node === undefined ||
      obj(node, 'node')[TYPENAME] !== 'PullRequestReviewThread'
    )
      throw ctx.devError('not_found', 'the review thread was not found')
    const mapped = mapThread(node, 'thread')
    if (
      mapped.owner.owner.toLowerCase() !== parts.owner.toLowerCase() ||
      mapped.owner.repo.toLowerCase() !== parts.repo.toLowerCase() ||
      mapped.owner.number !== parts.number
    )
      throw ctx.devError('identity_mismatch', 'the review thread belongs to another pull request')
    return mapped.item
  }

  function livePlan<K extends CollaborationPlan['kind']>(
    planId: string,
    kind: K,
    planDigest: unknown
  ): Extract<CollaborationPlan, { kind: K }> {
    const entry = plans.get(planId)
    if (!entry || entry.expiresAt <= ctx.now() || entry.kind !== kind)
      throw ctx.devError(
        'plan_stale',
        'the plan is unknown, expired, or does not match this operation'
      )
    if (String(planDigest) !== entry.digest)
      throw ctx.devError('plan_stale', 'the plan digest does not match the issued plan')
    return entry as Extract<CollaborationPlan, { kind: K }>
  }

  function planEnvelope(
    planId: string,
    operation: DevOperation,
    entry: CollaborationPlan,
    factVersions: Record<string, string>,
    stepKind: string,
    blockers: readonly DevError[]
  ): MutationPlan {
    return {
      id: planId,
      operation,
      scope: ctx.scope,
      resource: { kind: 'pull_request', id: entry.pullRequestId, generation: 0 },
      factVersions,
      steps: [{ id: entry.kind, kind: stepKind, targetId: entry.pullRequestId, dependsOn: [] }],
      blockers: blockers.map((item) => ({ code: item.code, message: item.message })),
      requiredApprovalIds: [],
      digest: entry.digest,
      expiresAt: iso(entry.expiresAt),
    }
  }

  function validLogin(login: string, allowTeam: boolean): string {
    if (LOGIN_PATTERN.test(login) || (allowTeam && TEAM_PATTERN.test(login))) return login
    throw ctx.devError('identity_mismatch', `${login.slice(0, 64)} is not a GitHub login`)
  }

  // ── Handlers ─────────────────────────────────────────────────────────────

  return {
    'dev.github.pullRequestSummaries': async (command) => {
      const body = devOperationDecoders['dev.github.pullRequestSummaries'].request(command.body)
      const { record, parsed } = await repoRemote(command)
      const state = String(body.state ?? 'open')
      const limit = Number(body.limit ?? 25)
      const after = graphqlCursor(body.cursor)
      const data = await graphql(
        SUMMARIES_QUERY,
        {
          owner: parsed.owner,
          name: parsed.repo,
          states: [state.toUpperCase()],
          first: limit,
          after,
        },
        {
          operation: 'pull request listing',
          cacheKey: `summaries:${parsed.owner}/${parsed.repo}:${state}:${limit}:${after ?? ''}`,
          allowCached: true,
        }
      )
      const repository = obj(data.repository, 'repository')
      const settings = mapRepositorySettings(repository, 'repository')
      const connection = obj(repository.pullRequests, 'repository.pullRequests')
      const observedAt = iso(ctx.now())
      const items = arr(connection.nodes ?? [], 'pullRequests.nodes').map(
        (node, index) =>
          mapSummary(node, `pullRequests.nodes[${index}]`, {
            owner: parsed.owner,
            repo: parsed.repo,
            repoId: record.repoId,
            settings,
            observedAt,
            withBody: false,
          }).summary
      )
      return pageOf(items, obj(connection.pageInfo, 'pageInfo'))
    },

    'dev.github.pullRequestSummary': async (command) => {
      const body = devOperationDecoders['dev.github.pullRequestSummary'].request(command.body)
      const { parts } = pullRequestOf(command)
      const { summary } = await readSummary(parts, {
        refresh: body.refresh === true,
        withBehind: true,
      })
      return summary
    },

    'dev.github.timeline': async (command) => {
      const body = devOperationDecoders['dev.github.timeline'].request(command.body)
      const { parts } = pullRequestOf(command)
      const after = graphqlCursor(body.cursor)
      const data = await graphql(
        TIMELINE_QUERY,
        {
          owner: parts.owner,
          name: parts.repo,
          number: parts.number,
          first: Number(body.limit ?? 100),
          after,
          withThreads: after === null,
        },
        { operation: 'timeline read' }
      )
      const pr = obj(obj(data.repository, 'repository').pullRequest, 'pullRequest')
      const timeline = obj(pr.timelineItems, 'timelineItems')
      const items: GitHubTimelineItem[] = []
      arr(timeline.nodes ?? [], 'timelineItems.nodes').forEach((node, index) => {
        if (node === null) return
        const mapped = mapTimelineNode(node, `timelineItems.nodes[${index}]`)
        if (mapped) items.push(mapped)
      })
      if (pr.reviewThreads !== undefined && pr.reviewThreads !== null)
        arr(obj(pr.reviewThreads, 'reviewThreads').nodes ?? [], 'reviewThreads.nodes').forEach(
          (node, index) => {
            if (node !== null) items.push(mapThread(node, `reviewThreads.nodes[${index}]`).item)
          }
        )
      items.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      return pageOf(items, obj(timeline.pageInfo, 'pageInfo'))
    },

    'dev.github.commits': async (command) => {
      const body = devOperationDecoders['dev.github.commits'].request(command.body)
      const { parts } = pullRequestOf(command)
      const data = await graphql(
        COMMITS_QUERY,
        {
          owner: parts.owner,
          name: parts.repo,
          number: parts.number,
          first: Number(body.limit ?? 100),
          after: graphqlCursor(body.cursor),
        },
        { operation: 'commit listing' }
      )
      const commits = obj(
        obj(obj(data.repository, 'repository').pullRequest, 'pullRequest').commits,
        'commits'
      )
      const items = arr(commits.nodes ?? [], 'commits.nodes').map((node, index) =>
        mapCommitSummary(node, `commits.nodes[${index}]`)
      )
      return pageOf(items, obj(commits.pageInfo, 'pageInfo'))
    },

    'dev.github.files': async (command) => {
      const body = devOperationDecoders['dev.github.files'].request(command.body)
      const { parts } = pullRequestOf(command)
      const limit = Number(body.limit ?? 100)
      const { start, page } = restPage(body.cursor, limit)
      const payload = await ctx.ghJson(
        ctx.apiArgs(
          ctx.host,
          `repos/${parts.owner}/${parts.repo}/pulls/${parts.number}/files?per_page=${limit}&page=${page}`
        )
      )
      const items = arr(payload, 'files').map((entry, index) =>
        mapChangedFile(entry, `files[${index}]`)
      )
      return restPageOf(items, start, limit)
    },

    'dev.github.checkLog': async (command) => {
      const body = devOperationDecoders['dev.github.checkLog'].request(command.body)
      const { parts } = pullRequestOf(command)
      const checkId = String(body.checkId)
      if (!CHECK_ID_PATTERN.test(checkId))
        throw ctx.devError('identity_mismatch', 'check id is malformed')
      // Raw logs carry terminal escapes; recent gh refuses to print them
      // without an explicit opt-in. They are stripped below, so the opt-in
      // is safe; older gh without the flag gets the plain call.
      const logPath = `repos/${parts.owner}/${parts.repo}/actions/jobs/${checkId}/logs`
      let result = await ctx.runGh(ctx.apiArgs(ctx.host, logPath, ['--allow-escape-sequences']), {
        maxOutputBytes: LOG_READ_BUDGET,
      })
      if (result.exitCode !== 0 && /unknown flag/i.test(result.stderr))
        result = await ctx.runGh(ctx.apiArgs(ctx.host, logPath), {
          maxOutputBytes: LOG_READ_BUDGET,
        })
      if (result.exitCode !== 0) {
        const failure = ctx.classifyGh(result, 'check log read')
        if (failure.code === 'not_found')
          throw ctx.devError(
            'not_found',
            'logs are only available for GitHub Actions jobs that still retain them'
          )
        throw failure
      }
      const raw = result.stdout
      const tail = raw.length > LOG_TAIL_MAX ? raw.slice(raw.length - LOG_TAIL_MAX) : raw
      const cleaned = cleanText(tail, LOG_TAIL_MAX)
      return {
        checkId,
        text: cleaned.text,
        truncated: raw.length > LOG_TAIL_MAX || cleaned.truncated,
        observedAt: iso(ctx.now()),
      } satisfies GitHubCheckLog
    },

    'dev.github.labels': async (command) => {
      const body = devOperationDecoders['dev.github.labels'].request(command.body)
      const { parsed } = await repoRemote(command)
      const limit = Number(body.limit ?? 100)
      const { start, page } = restPage(body.cursor, limit)
      const payload = await ctx.ghJson(
        ctx.apiArgs(
          parsed.host,
          `repos/${parsed.owner}/${parsed.repo}/labels?per_page=${limit}&page=${page}`
        )
      )
      const items = arr(payload, 'labels').map((entry, index): GitHubLabel => {
        const item = obj(entry, `labels[${index}]`)
        const color = optStr(item.color, `labels[${index}].color`, 16)?.toLowerCase()
        const description = optStr(item.description, `labels[${index}].description`, 1024)
        return {
          name: str(item.name, `labels[${index}].name`, 256),
          ...(color && /^[0-9a-f]{6}$/.test(color) ? { color } : {}),
          ...(description ? { description: cleanText(description, 1024).text } : {}),
        }
      })
      return restPageOf(items, start, limit)
    },

    'dev.github.assignableUsers': async (command) => {
      const body = devOperationDecoders['dev.github.assignableUsers'].request(command.body)
      const { parsed } = await repoRemote(command)
      const query = String(body.query ?? '')
      const data = await graphql(
        ASSIGNABLE_USERS_QUERY,
        {
          owner: parsed.owner,
          name: parsed.repo,
          query: query.length > 0 ? query : null,
          first: Number(body.limit ?? 50),
        },
        {
          operation: 'assignable users read',
          cacheKey: `users:${parsed.owner}/${parsed.repo}:${query}`,
          allowCached: true,
        }
      )
      const users = obj(obj(data.repository, 'repository').assignableUsers, 'assignableUsers')
      const items = arr(users.nodes ?? [], 'assignableUsers.nodes').map(
        (entry, index): GitHubActor => {
          const item = obj(entry, `assignableUsers[${index}]`)
          const name = optStr(item.name, `assignableUsers[${index}].name`, 256)
          return {
            login: str(item.login, `assignableUsers[${index}].login`, 100),
            kind: 'user',
            ...(name ? { name } : {}),
          }
        }
      )
      return { items, observedAt: iso(ctx.now()) } satisfies DevRuntimePage<GitHubActor>
    },

    'dev.github.branches': async (command) => {
      const body = devOperationDecoders['dev.github.branches'].request(command.body)
      const { parsed } = await repoRemote(command)
      const limit = Number(body.limit ?? 100)
      const { start, page } = restPage(body.cursor, limit)
      const payload = await ctx.ghJson(
        ctx.apiArgs(
          parsed.host,
          `repos/${parsed.owner}/${parsed.repo}/branches?per_page=${limit}&page=${page}`
        )
      )
      const items = arr(payload, 'branches').map((entry, index): GitHubBranch => {
        const item = obj(entry, `branches[${index}]`)
        return {
          name: str(item.name, `branches[${index}].name`, 255),
          sha: gitSha(
            obj(item.commit, `branches[${index}].commit`).sha,
            `branches[${index}].commit.sha`
          ),
          protected: item.protected === true,
        }
      })
      return restPageOf(items, start, limit)
    },

    'dev.github.compare': async (command) => {
      const body = devOperationDecoders['dev.github.compare'].request(command.body)
      const { parsed } = await repoRemote(command)
      const baseRef = String(body.baseRef)
      const headRef = String(body.headRef)
      if (
        !REF_PATTERN.test(baseRef) ||
        !REF_PATTERN.test(headRef) ||
        baseRef.includes('..') ||
        headRef.includes('..')
      )
        throw ctx.devError('identity_mismatch', 'base and head must be simple branch names')
      const payload = obj(
        await ctx.ghJson(
          ctx.apiArgs(
            parsed.host,
            `repos/${parsed.owner}/${parsed.repo}/compare/${encodeURIComponent(baseRef)}...${encodeURIComponent(headRef)}?per_page=100`
          ),
          { staleFallback: false }
        ),
        'compare'
      )
      const files = payload.files === undefined ? [] : arr(payload.files, 'compare.files')
      let additions = 0
      let deletions = 0
      files.forEach((entry, index) => {
        const file = obj(entry, `compare.files[${index}]`)
        additions += num(file.additions, `compare.files[${index}].additions`)
        deletions += num(file.deletions, `compare.files[${index}].deletions`)
      })
      return {
        baseRef,
        headRef,
        status:
          (['ahead', 'behind', 'diverged', 'identical'] as const).find(
            (status) => status === payload.status
          ) ?? 'diverged',
        aheadBy: num(payload.ahead_by, 'compare.ahead_by'),
        behindBy: num(payload.behind_by, 'compare.behind_by'),
        commitCount: num(payload.total_commits, 'compare.total_commits'),
        changedFiles: files.length,
        additions,
        deletions,
        observedAt: iso(ctx.now()),
      } satisfies GitHubCompare
    },

    // ── Conversation writes ──────────────────────────────────────────────

    'dev.github.comment': async (command) => {
      const body = devOperationDecoders['dev.github.comment'].request(command.body)
      const { parts } = pullRequestOf(command)
      const created = await ghInput(
        `repos/${parts.owner}/${parts.repo}/issues/${parts.number}/comments`,
        { body: String(body.body).slice(0, BODY_MAX) },
        { method: 'POST', operation: 'comment' }
      )
      forgetPullRequest(parts)
      return mapRestComment(created)
    },

    'dev.github.threadReply': async (command) => {
      const body = devOperationDecoders['dev.github.threadReply'].request(command.body)
      const { parts } = pullRequestOf(command)
      const threadId = String(body.threadId)
      // Re-prove the thread belongs to this pull request before writing.
      await readThread(threadId, parts)
      await graphql(
        REPLY_THREAD_MUTATION,
        { thread: threadId, body: String(body.body).slice(0, BODY_MAX) },
        { operation: 'thread reply' }
      )
      forgetPullRequest(parts)
      return await readThread(threadId, parts)
    },

    'dev.github.threadResolve': async (command) => {
      const body = devOperationDecoders['dev.github.threadResolve'].request(command.body)
      const { parts } = pullRequestOf(command)
      const threadId = String(body.threadId)
      const current = await readThread(threadId, parts)
      const resolved = body.resolved === true
      if (current.resolved !== resolved)
        await graphql(
          resolved ? RESOLVE_THREAD_MUTATION : UNRESOLVE_THREAD_MUTATION,
          { thread: threadId },
          { operation: resolved ? 'thread resolve' : 'thread unresolve' }
        )
      forgetPullRequest(parts)
      return await readThread(threadId, parts)
    },

    'dev.github.metadataUpdate': async (command) => {
      const body = devOperationDecoders['dev.github.metadataUpdate'].request(command.body)
      const { parts } = pullRequestOf(command)
      const base = `repos/${parts.owner}/${parts.repo}`
      type Delta = { add: readonly string[]; remove: readonly string[] }
      const reviewers = body.reviewers as Delta | undefined
      const assignees = body.assignees as Delta | undefined
      const labels = body.labels as Delta | undefined
      if (!reviewers && !assignees && !labels)
        throw ctx.devError('invalid_state', 'the update carries no changes')
      const split = (logins: readonly string[]) => {
        const users = logins.map((login) => validLogin(login, true))
        return {
          reviewers: users.filter((login) => !login.includes('/')),
          team_reviewers: users
            .filter((login) => login.includes('/'))
            .map((login) => login.split('/')[1]!),
        }
      }
      if (reviewers?.add.length)
        await ghInput(`${base}/pulls/${parts.number}/requested_reviewers`, split(reviewers.add), {
          method: 'POST',
          operation: 'request reviewers',
        })
      if (reviewers?.remove.length)
        await ghInput(
          `${base}/pulls/${parts.number}/requested_reviewers`,
          split(reviewers.remove),
          {
            method: 'DELETE',
            operation: 'remove reviewers',
          }
        )
      if (assignees?.add.length)
        await ghInput(
          `${base}/issues/${parts.number}/assignees`,
          { assignees: assignees.add.map((login) => validLogin(login, false)) },
          { method: 'POST', operation: 'add assignees' }
        )
      if (assignees?.remove.length)
        await ghInput(
          `${base}/issues/${parts.number}/assignees`,
          { assignees: assignees.remove.map((login) => validLogin(login, false)) },
          { method: 'DELETE', operation: 'remove assignees' }
        )
      if (labels?.add.length)
        await ghInput(
          `${base}/issues/${parts.number}/labels`,
          { labels: [...labels.add] },
          { method: 'POST', operation: 'add labels' }
        )
      for (const label of labels?.remove ?? []) {
        const result = await ctx.runGh(
          ctx.apiArgs(
            ctx.host,
            `${base}/issues/${parts.number}/labels/${encodeURIComponent(label)}`,
            ['--method', 'DELETE']
          )
        )
        // Removing a label that is already gone is the requested end state.
        if (result.exitCode !== 0 && ctx.classifyGh(result, 'remove label').code !== 'not_found')
          throw ctx.classifyGh(result, 'remove label')
      }
      forgetPullRequest(parts)
      return (await readSummary(parts, { refresh: true, withBehind: true })).summary
    },

    'dev.github.submitReview': async (command) => {
      const body = devOperationDecoders['dev.github.submitReview'].request(command.body)
      const { parts } = pullRequestOf(command)
      const verdict = String(body.verdict) as 'comment' | 'approve' | 'request_changes'
      const text = String(body.body)
      const comments = (body.comments ?? []) as readonly {
        path: string
        line: number
        side: 'left' | 'right'
        startLine?: number
        body: string
      }[]
      if (verdict === 'request_changes' && text.trim().length === 0)
        throw ctx.devError('invalid_state', 'requesting changes needs a summary')
      if (verdict === 'comment' && text.trim().length === 0 && comments.length === 0)
        throw ctx.devError('invalid_state', 'a comment review needs a summary or inline comments')
      // Inline comments are anchored to the head the reviewer read; a moved
      // head would silently misplace them.
      const { summary } = await readSummary(parts, { refresh: true, withBehind: false })
      if (summary.state !== 'open')
        throw ctx.devError('invalid_state', `the pull request is ${summary.state}, not open`)
      if (summary.headSha !== String(body.expectedHeadSha))
        throw ctx.devError(
          'stale_version',
          'the pull request head moved on since you read the diff'
        )
      const created = await ghInput(
        `repos/${parts.owner}/${parts.repo}/pulls/${parts.number}/reviews`,
        {
          commit_id: summary.headSha,
          body: text,
          event:
            verdict === 'approve'
              ? 'APPROVE'
              : verdict === 'request_changes'
                ? 'REQUEST_CHANGES'
                : 'COMMENT',
          comments: comments.map((comment) => ({
            path: comment.path,
            line: comment.line,
            side: comment.side === 'left' ? 'LEFT' : 'RIGHT',
            ...(comment.startLine !== undefined && comment.startLine < comment.line
              ? {
                  start_line: comment.startLine,
                  start_side: comment.side === 'left' ? 'LEFT' : 'RIGHT',
                }
              : {}),
            body: comment.body,
          })),
        },
        { method: 'POST', operation: 'review submit' }
      )
      forgetPullRequest(parts)
      return mapRestReview(created)
    },

    'dev.github.rerunFailedJobs': async (command) => {
      const body = devOperationDecoders['dev.github.rerunFailedJobs'].request(command.body)
      const { parts } = pullRequestOf(command)
      const checkId = String(body.checkId)
      if (!CHECK_ID_PATTERN.test(checkId))
        throw ctx.devError('identity_mismatch', 'check id is malformed')
      const job = obj(
        await ctx.ghJson(
          ctx.apiArgs(ctx.host, `repos/${parts.owner}/${parts.repo}/actions/jobs/${checkId}`),
          {
            staleFallback: false,
          }
        ),
        'job'
      )
      const runId = String(num(job.run_id, 'job.run_id'))
      const { summary } = await readSummary(parts, { refresh: false, withBehind: false })
      // Bind the job to this pull request's branch before re-running it.
      if (optStr(job.head_branch, 'job.head_branch', 512) !== summary.headRef)
        throw ctx.devError('identity_mismatch', 'the job did not run for this pull request branch')
      await ghInput(
        `repos/${parts.owner}/${parts.repo}/actions/runs/${runId}/rerun-failed-jobs`,
        {},
        { method: 'POST', operation: 're-run failed jobs' }
      )
      forgetPullRequest(parts)
      return { checkId, runId, observedAt: iso(ctx.now()) } satisfies GitHubRerunResult
    },

    // ── Auto-merge: plan/commit pair ─────────────────────────────────────

    'dev.github.autoMergePlan': async (command) => {
      const body = devOperationDecoders['dev.github.autoMergePlan'].request(command.body)
      const { pullRequestId, parts } = pullRequestOf(command)
      const { summary } = await readSummary(parts, { refresh: true, withBehind: false })
      if (summary.state !== 'open')
        throw ctx.devError('invalid_state', `the pull request is ${summary.state}, not open`)
      if (summary.headSha !== String(body.expectedHeadSha))
        throw ctx.devError(
          'stale_version',
          'the pull request head moved on since the caller observed it'
        )
      const enabled = body.enabled === true
      const method = (body.method ??
        summary.autoMerge?.method ??
        summary.mergeMethods[0] ??
        'merge') as GitHubMergeMethod
      const blockers: DevError[] = []
      if (enabled) {
        if (!summary.autoMergeAllowed)
          blockers.push(
            planBlocker('unsupported_capability', 'the repository does not allow auto-merge')
          )
        if (!summary.mergeMethods.includes(method))
          blockers.push(
            planBlocker('unsupported_capability', `the repository does not allow ${method} merges`)
          )
        if (summary.draft)
          blockers.push(
            planBlocker('invalid_state', 'mark the pull request ready before enabling auto-merge')
          )
        if (summary.mergeState === 'clean')
          blockers.push(
            planBlocker('invalid_state', 'the pull request can merge now; merge it directly')
          )
        if (summary.autoMerge?.method === method)
          blockers.push(planBlocker('already_completed', 'auto-merge is already enabled'))
      } else if (summary.autoMerge === undefined) {
        blockers.push(planBlocker('already_completed', 'auto-merge is not enabled'))
      }
      const facts = { kind: 'auto-merge', pullRequestId, headSha: summary.headSha, enabled, method }
      const entry: CollaborationPlan = {
        kind: 'auto-merge',
        pullRequestId,
        headSha: summary.headSha,
        enabled,
        method,
        expiresAt: ctx.now() + PLAN_TTL_MS,
        digest: digestOf(facts),
      }
      const planId = randomUUID()
      plans.set(planId, entry)
      return planEnvelope(
        planId,
        'dev.github.autoMergeCommit',
        entry,
        { headSha: summary.headSha, method, enabled: String(enabled) },
        enabled ? 'github_auto_merge_enable' : 'github_auto_merge_disable',
        blockers
      )
    },

    'dev.github.autoMergeCommit': async (command) => {
      const body = devOperationDecoders['dev.github.autoMergeCommit'].request(command.body)
      ctx.requireScope(command)
      const entry = livePlan(String(body.planId), 'auto-merge', body.planDigest)
      if (ctx.resourceOf(command, 'pull_request', entry.pullRequestId) !== entry.pullRequestId)
        throw ctx.devError('identity_mismatch', 'the plan is bound to another pull request')
      const parts = ctx.prIdParts(entry.pullRequestId)
      const current = await readSummary(parts, { refresh: true, withBehind: false })
      if (current.summary.state !== 'open')
        throw ctx.devError(
          'invalid_state',
          `the pull request is ${current.summary.state}, not open`
        )
      if (current.summary.headSha !== entry.headSha)
        throw ctx.devError(
          'stale_version',
          'the pull request head moved on since the plan was made'
        )
      if (entry.enabled)
        await graphql(
          ENABLE_AUTO_MERGE_MUTATION,
          { pr: current.nodeId, method: graphqlMergeMethod(entry.method), head: entry.headSha },
          { operation: 'enable auto-merge' }
        )
      else
        await graphql(
          DISABLE_AUTO_MERGE_MUTATION,
          { pr: current.nodeId },
          { operation: 'disable auto-merge' }
        )
      plans.delete(String(body.planId))
      forgetPullRequest(parts)
      const after = await readSummary(parts, { refresh: true, withBehind: true })
      if ((after.summary.autoMerge !== undefined) !== entry.enabled)
        throw ctx.devError(
          'remote_unavailable',
          'GitHub accepted the change but has not reflected it yet',
          true
        )
      return after.summary
    },

    // ── Server-side branch update: plan/commit pair ──────────────────────

    'dev.github.syncBranchPlan': async (command) => {
      const body = devOperationDecoders['dev.github.syncBranchPlan'].request(command.body)
      const { pullRequestId, parts } = pullRequestOf(command)
      const { summary } = await readSummary(parts, { refresh: true, withBehind: true })
      if (summary.state !== 'open')
        throw ctx.devError('invalid_state', `the pull request is ${summary.state}, not open`)
      if (summary.headSha !== String(body.expectedHeadSha))
        throw ctx.devError(
          'stale_version',
          'the pull request head moved on since the caller observed it'
        )
      const method = String(body.method) as 'merge' | 'rebase'
      const blockers: DevError[] = []
      // viewerCanUpdateBranch only reflects "require up to date" protection,
      // not permission; GitHub itself refuses a viewer who cannot push.
      if (summary.behindBy === 0)
        blockers.push(planBlocker('already_completed', 'the branch already contains its base'))
      if (summary.mergeable === 'conflicting')
        blockers.push(
          planBlocker('conflicted', 'the branch conflicts with its base; resolve it locally')
        )
      const facts = { kind: 'sync-branch', pullRequestId, headSha: summary.headSha, method }
      const entry: CollaborationPlan = {
        kind: 'sync-branch',
        pullRequestId,
        headSha: summary.headSha,
        method,
        expiresAt: ctx.now() + PLAN_TTL_MS,
        digest: digestOf(facts),
      }
      const planId = randomUUID()
      plans.set(planId, entry)
      return planEnvelope(
        planId,
        'dev.github.syncBranchCommit',
        entry,
        {
          headSha: summary.headSha,
          method,
          ...(summary.behindBy !== undefined ? { behindBy: String(summary.behindBy) } : {}),
        },
        method === 'rebase' ? 'github_branch_rebase' : 'github_branch_merge',
        blockers
      )
    },

    'dev.github.syncBranchCommit': async (command) => {
      const body = devOperationDecoders['dev.github.syncBranchCommit'].request(command.body)
      ctx.requireScope(command)
      const entry = livePlan(String(body.planId), 'sync-branch', body.planDigest)
      if (ctx.resourceOf(command, 'pull_request', entry.pullRequestId) !== entry.pullRequestId)
        throw ctx.devError('identity_mismatch', 'the plan is bound to another pull request')
      const parts = ctx.prIdParts(entry.pullRequestId)
      const current = await readSummary(parts, { refresh: true, withBehind: false })
      if (current.summary.state !== 'open')
        throw ctx.devError(
          'invalid_state',
          `the pull request is ${current.summary.state}, not open`
        )
      if (current.summary.headSha !== entry.headSha)
        throw ctx.devError(
          'stale_version',
          'the pull request head moved on since the plan was made'
        )
      await graphql(
        UPDATE_BRANCH_MUTATION,
        { pr: current.nodeId, head: entry.headSha, method: entry.method.toUpperCase() },
        { operation: 'update branch' }
      )
      plans.delete(String(body.planId))
      forgetPullRequest(parts)
      return (await readSummary(parts, { refresh: true, withBehind: true })).summary
    },
  }
}

/** Draft and close/reopen for the #423 update plan: GitHub's REST PATCH
 *  cannot change draft state, so that half goes through GraphQL. */
export async function applyDraftState(
  ctx: Pick<CollaborationContext, 'runGh' | 'apiArgs' | 'host' | 'classifyGh' | 'devError'>,
  parts: Parts,
  draft: boolean
): Promise<void> {
  const run = async (query: string, variables: Record<string, unknown>) => {
    const result = await ctx.runGh(
      ctx.apiArgs(ctx.host, 'graphql', ['--input', '-', '--method', 'POST']),
      {
        stdin: JSON.stringify({ query, variables }),
      }
    )
    if (result.exitCode !== 0) throw ctx.classifyGh(result, 'draft state change')
    try {
      return graphqlData(JSON.parse(result.stdout))
    } catch (error) {
      if (error instanceof SyntaxError)
        throw ctx.devError('corrupt_state', 'gh returned output that is not valid JSON')
      throw error
    }
  }
  const data = await run(PULL_REQUEST_NODE_QUERY, {
    owner: parts.owner,
    name: parts.repo,
    number: parts.number,
  })
  const pr = obj(obj(data.repository, 'repository').pullRequest, 'pullRequest')
  if (bool(pr.isDraft, 'pullRequest.isDraft') === draft) return
  await run(draft ? CONVERT_TO_DRAFT_MUTATION : READY_FOR_REVIEW_MUTATION, {
    pr: str(pr.id, 'pullRequest.id', 128),
  })
}

/** The default branch's head commit and its check rollup, for the source
 *  control sidebar's per-project CI dot. Best effort: absent when GitHub has
 *  no default branch or the read fails. */
export async function readDefaultBranchHead(
  ctx: Pick<CollaborationContext, 'runGh' | 'apiArgs' | 'classifyGh'>,
  parsed: { host: string; owner: string; repo: string }
): Promise<{ sha: string; checks: GitHubCheckRollupState } | undefined> {
  const result = await ctx.runGh(
    ctx.apiArgs(parsed.host, 'graphql', ['--input', '-', '--method', 'POST']),
    {
      stdin: JSON.stringify({
        query: DEFAULT_BRANCH_HEAD_QUERY,
        variables: { owner: parsed.owner, name: parsed.repo },
      }),
    }
  )
  if (result.exitCode !== 0) throw ctx.classifyGh(result, 'default branch read')
  const data = graphqlData(JSON.parse(result.stdout))
  const ref = obj(data.repository, 'repository').defaultBranchRef
  if (ref === null || ref === undefined) return undefined
  const target = obj(obj(ref, 'defaultBranchRef').target, 'defaultBranchRef.target')
  return {
    sha: gitSha(target.oid, 'defaultBranchRef.target.oid'),
    checks: mapRollupState(target.statusCheckRollup, 'defaultBranchRef.target.statusCheckRollup'),
  }
}
