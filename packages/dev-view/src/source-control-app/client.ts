/*
 * The source control app's runtime client: typed calls over the Dev Runtime
 * contract. Every read and write goes through the authenticated runtime
 * channel; plan/commit pairs are folded into one call that refuses with the
 * plan's blockers instead of committing. Errors surface as `ScmError` with a
 * bounded, plain-text message.
 */
import type {
  DevErrorCode,
  DevRuntimePage,
  GitHubAccount,
  GitHubActor,
  GitHubBranch,
  GitHubChangedFile,
  GitHubCheck,
  GitHubCheckLog,
  GitHubCommitSummary,
  GitHubCompare,
  GitHubLabel,
  GitHubMergeMethod,
  GitHubPullRequest,
  GitHubPullRequestSummary,
  GitHubRepository,
  GitHubReviewCommentInput,
  GitHubTimelineItem,
  MutationPlan,
  Project,
  Repo,
  RuntimeSession,
  Scope,
  Worktree,
} from '@adea-ai/types/dev-runtime'
import { decodeWorktree } from '@adea-ai/types/dev-runtime-registry-dto'

import { buildDevCommand } from '../browser/command'
import type { DevRuntimeService } from '../platform'
import { providerOf, type ScmProvider } from './model/types'

export class ScmError extends Error {
  readonly code: DevErrorCode | 'blocked' | 'unavailable'
  readonly blockers: readonly string[]
  constructor(code: ScmError['code'], message: string, blockers: readonly string[] = []) {
    super(message)
    this.code = code
    this.blockers = blockers
  }
}

/** Plain, bounded text for any failure the UI shows. */
export function errorText(error: unknown): string {
  if (error instanceof ScmError) return error.message
  if (error instanceof Error) return clip(error.message)
  return 'The operation failed.'
}

function clip(text: string, budget = 240): string {
  // oxlint-disable-next-line no-control-regex -- stripping provider control characters is intentional
  const printable = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return printable.length > budget ? `${printable.slice(0, budget - 1)}…` : printable
}

type Operation = Parameters<typeof buildDevCommand>[0]['operation']
type Resource = { kind: string; id: string; generation: number }

/** The shared strict worktree DTO (ADR 0011); every listed item decodes. */
export type WorktreeRecord = Worktree

const repo = (repoId: string): Resource => ({ kind: 'repository', id: repoId, generation: 0 })
const pr = (pullRequestId: string): Resource => ({
  kind: 'pull_request',
  id: pullRequestId,
  generation: 0,
})

export function createScmClient(runtime: DevRuntimeService, scope: Scope) {
  /** Which provider serves a repository; set from the runtime catalog. */
  const repoProviders = new Map<string, ScmProvider>()
  /** The provider family for an operation: merge request ids carry their
   *  provider; repository ids are looked up in the catalog. */
  const op = (name: string, id: string): Operation => {
    const provider =
      id.startsWith('gl:') || id.startsWith('gh:')
        ? providerOf(id)
        : (repoProviders.get(id) ?? 'github')
    return `dev.${provider}.${name}` as Operation
  }

  async function call<T>(
    operation: Operation,
    body: Record<string, unknown>,
    resource?: Resource
  ): Promise<T> {
    let reply
    try {
      reply = await runtime.execute(
        buildDevCommand({ operation, scope, body, ...(resource ? { resource } : {}) })
      )
    } catch (error) {
      throw new ScmError(
        'unavailable',
        error instanceof Error ? clip(error.message) : 'The runtime is unavailable.'
      )
    }
    if (!reply.ok) throw new ScmError(reply.error.code, clip(reply.error.message))
    return reply.value as T
  }

  /** Plan, refuse on blockers, then commit against the plan's own binding. */
  async function planned<T>(
    planOperation: Operation,
    commitOperation: Operation,
    body: Record<string, unknown>,
    resource: Resource
  ): Promise<T> {
    const plan = await call<MutationPlan>(planOperation, body, resource)
    if (plan.blockers.length > 0)
      throw new ScmError(
        'blocked',
        plan.blockers.map((blocker) => clip(blocker.message)).join(' '),
        plan.blockers.map((blocker) => blocker.code)
      )
    return call<T>(commitOperation, { planId: plan.id, planDigest: plan.digest }, plan.resource)
  }

  async function allPages<T>(
    operation: Operation,
    body: Record<string, unknown>,
    resource?: Resource
  ): Promise<T[]> {
    const items: T[] = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page += 1) {
      const result = await call<DevRuntimePage<T>>(
        operation,
        { ...body, ...(cursor ? { cursor } : {}) },
        resource
      )
      items.push(...result.items)
      if (!result.nextCursor) break
      cursor = result.nextCursor
    }
    return items
  }

  return {
    scope,
    /** Record which provider serves each repository. */
    setRepoProviders: (entries: Iterable<readonly [string, ScmProvider]>) => {
      repoProviders.clear()
      for (const [repoId, provider] of entries) repoProviders.set(repoId, provider)
    },
    // ── Runtime catalog ──
    projects: () => allPages<Project>('dev.project.list', { limit: 500 }),
    repos: () => allPages<Repo>('dev.repo.list', { limit: 500 }),
    worktrees: async (): Promise<WorktreeRecord[]> =>
      (await allPages<unknown>('dev.worktree.list', { archived: false, limit: 500 })).map((item) =>
        decodeWorktree(item)
      ),
    sessions: () => allPages<RuntimeSession>('dev.session.list', { archived: false, limit: 500 }),

    // ── Provider reads (GitHub, or GitLab's mirror) ──
    account: (provider: ScmProvider = 'github') =>
      call<GitHubAccount>(`dev.${provider}.account` as Operation, {}),
    repository: (repoId: string, refresh = false) =>
      call<GitHubRepository>(
        op('repository', repoId),
        { repoId, ...(refresh ? { refresh } : {}) },
        repo(repoId)
      ),
    summaries: (repoId: string, state: 'open' | 'closed' | 'merged', cursor?: string) =>
      call<DevRuntimePage<GitHubPullRequestSummary>>(
        op('pullRequestSummaries', repoId),
        { repoId, state, limit: 50, ...(cursor ? { cursor } : {}) },
        repo(repoId)
      ),
    summary: (pullRequestId: string, refresh = false) =>
      call<GitHubPullRequestSummary>(
        op('pullRequestSummary', pullRequestId),
        { pullRequestId, ...(refresh ? { refresh } : {}) },
        pr(pullRequestId)
      ),
    timeline: async (pullRequestId: string) => {
      const items: GitHubTimelineItem[] = []
      let cursor: string | undefined
      for (let page = 0; page < 10; page += 1) {
        const result = await call<DevRuntimePage<GitHubTimelineItem>>(
          op('timeline', pullRequestId),
          { pullRequestId, limit: 100, ...(cursor ? { cursor } : {}) },
          pr(pullRequestId)
        )
        items.push(...result.items)
        if (!result.nextCursor) break
        cursor = result.nextCursor
      }
      return items.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
    },
    commits: (pullRequestId: string) =>
      call<DevRuntimePage<GitHubCommitSummary>>(
        op('commits', pullRequestId),
        { pullRequestId, limit: 100 },
        pr(pullRequestId)
      ),
    files: async (pullRequestId: string) => {
      const items: GitHubChangedFile[] = []
      let cursor: string | undefined
      for (let page = 0; page < 30; page += 1) {
        const result = await call<DevRuntimePage<GitHubChangedFile>>(
          op('files', pullRequestId),
          { pullRequestId, limit: 100, ...(cursor ? { cursor } : {}) },
          pr(pullRequestId)
        )
        items.push(...result.items)
        if (!result.nextCursor) break
        cursor = result.nextCursor
      }
      return items
    },
    checks: (pullRequestId: string, sha?: string) =>
      call<DevRuntimePage<GitHubCheck>>(
        op('checks', pullRequestId),
        { pullRequestId, limit: 100, ...(sha ? { sha } : {}) },
        pr(pullRequestId)
      ),
    checkLog: (pullRequestId: string, checkId: string) =>
      call<GitHubCheckLog>(
        op('checkLog', pullRequestId),
        { pullRequestId, checkId },
        pr(pullRequestId)
      ),
    labels: (repoId: string) =>
      call<DevRuntimePage<GitHubLabel>>(op('labels', repoId), { repoId, limit: 100 }, repo(repoId)),
    assignableUsers: (repoId: string, query: string) =>
      call<DevRuntimePage<GitHubActor>>(
        op('assignableUsers', repoId),
        { repoId, limit: 50, ...(query ? { query } : {}) },
        repo(repoId)
      ),
    branches: (repoId: string) =>
      allPages<GitHubBranch>(op('branches', repoId), { repoId, limit: 100 }, repo(repoId)),
    compare: (repoId: string, baseRef: string, headRef: string) =>
      call<GitHubCompare>(op('compare', repoId), { repoId, baseRef, headRef }, repo(repoId)),

    // ── Conversation writes ──
    comment: (pullRequestId: string, body: string) =>
      call<GitHubTimelineItem>(
        op('comment', pullRequestId),
        { pullRequestId, body },
        pr(pullRequestId)
      ),
    threadReply: (pullRequestId: string, threadId: string, body: string) =>
      call<GitHubTimelineItem>(
        op('threadReply', pullRequestId),
        { pullRequestId, threadId, body },
        pr(pullRequestId)
      ),
    threadResolve: (pullRequestId: string, threadId: string, resolved: boolean) =>
      call<GitHubTimelineItem>(
        op('threadResolve', pullRequestId),
        { pullRequestId, threadId, resolved },
        pr(pullRequestId)
      ),
    metadataUpdate: (
      pullRequestId: string,
      change: Partial<
        Record<'reviewers' | 'assignees' | 'labels', { add: string[]; remove: string[] }>
      >
    ) =>
      call<GitHubPullRequestSummary>(
        op('metadataUpdate', pullRequestId),
        { pullRequestId, ...change },
        pr(pullRequestId)
      ),
    submitReview: (
      pullRequestId: string,
      expectedHeadSha: string,
      verdict: 'comment' | 'approve' | 'request_changes',
      body: string,
      comments: readonly GitHubReviewCommentInput[]
    ) =>
      call<GitHubTimelineItem>(
        op('submitReview', pullRequestId),
        { pullRequestId, expectedHeadSha, verdict, body, comments },
        pr(pullRequestId)
      ),
    rerunFailedJobs: (pullRequestId: string, checkId: string) =>
      call<{ runId: string }>(
        op('rerunFailedJobs', pullRequestId),
        { pullRequestId, checkId },
        pr(pullRequestId)
      ),

    // ── Plan/commit pairs ──
    merge: (
      pullRequestId: string,
      expectedHeadSha: string,
      method: GitHubMergeMethod,
      deleteBranch: boolean
    ) =>
      planned<GitHubPullRequest>(
        op('mergePlan', pullRequestId),
        op('mergeCommit', pullRequestId),
        { pullRequestId, expectedHeadSha, method, deleteBranch },
        pr(pullRequestId)
      ),
    autoMerge: (
      pullRequestId: string,
      expectedHeadSha: string,
      enabled: boolean,
      method?: GitHubMergeMethod
    ) =>
      planned<GitHubPullRequestSummary>(
        op('autoMergePlan', pullRequestId),
        op('autoMergeCommit', pullRequestId),
        { pullRequestId, expectedHeadSha, enabled, ...(method ? { method } : {}) },
        pr(pullRequestId)
      ),
    syncBranch: (pullRequestId: string, expectedHeadSha: string, method: 'merge' | 'rebase') =>
      planned<GitHubPullRequestSummary>(
        op('syncBranchPlan', pullRequestId),
        op('syncBranchCommit', pullRequestId),
        { pullRequestId, expectedHeadSha, method },
        pr(pullRequestId)
      ),
    /** Draft and open/closed changes ride the #423 update plan, which binds
     *  the read model's version. */
    update: async (
      pullRequestId: string,
      patch: { draft?: boolean; state?: 'open' | 'closed' }
    ) => {
      const current = await call<GitHubPullRequest>(
        op('pullRequest', pullRequestId),
        { pullRequestId, refresh: true },
        pr(pullRequestId)
      )
      return planned<GitHubPullRequest>(
        op('updatePlan', pullRequestId),
        op('updateCommit', pullRequestId),
        { pullRequestId, expectedVersion: current.version, patch },
        pr(pullRequestId)
      )
    },
    /** Pull requests open as drafts by repository policy. */
    createPullRequest: (
      repoId: string,
      headRef: string,
      baseRef: string,
      title: string,
      body: string
    ) =>
      call<GitHubPullRequest>(
        op('createPullRequest', repoId),
        { repoId, headRef, baseRef, title, body, draft: true },
        repo(repoId)
      ),
  }
}

export type ScmClient = ReturnType<typeof createScmClient>
