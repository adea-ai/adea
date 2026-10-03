// Source control app: pull request collaboration provider acceptance. Runs
// on a scripted gh transport (no network) behind the real signed channel.
// Every success reply is re-decoded through the strict client decoders, so a
// host mapping that drifts from the contract fails here. Covers the inbox and
// detail read models, the timeline, user text riding stdin (never argv),
// thread ownership re-proofs, review head binding, auto-merge and branch-sync
// plan/commit fencing, metadata login validation, check-log sanitising,
// re-run branch binding, merge-time head branch deletion, and draft toggles.
import { createHmac, randomBytes } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import {
  devCommandProofMessage,
  devOperationDecoders,
  devOperationDefinitions,
  type DevCommand,
  type DevOperation,
  type DevReply,
} from '../../../packages/types/src/dev-runtime'

import { createChannelAuthority } from '../shell/src/dev-runtime/channel/authority'
import { registerGithubRuntime, type GhRunner } from '../shell/src/dev-runtime/github/register'
import { git, initRepo, scope } from './worktree-fixtures'

const REPO_ID = '00000000-0000-4000-8000-00000000repo'
const PR_ID = 'gh:acme/widgets#7'
const HEAD = 'a'.repeat(40)
const MOVED = 'b'.repeat(40)
const BASE = 'c'.repeat(40)
const NOW = '2026-10-03T12:00:00Z'

// ─── scripted gh ────────────────────────────────────────────────────────────

type Call = { args: readonly string[]; stdin?: string }
type Response = { stdout?: string; stderr?: string; exitCode?: number }
type Responder = (path: string, call: Call) => Response | undefined

/** Matches REST calls on their api path and GraphQL calls on the operation
 *  name found in the stdin document. Unmatched calls fail loudly. */
function scriptedGh(respond: Responder): { runner: GhRunner; calls: Call[] } {
  const calls: Call[] = []
  const runner: GhRunner = async (args, options) => {
    const call = { args, ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}) }
    calls.push(call)
    const response = respond(args[1] ?? '', call) ?? {
      stderr: `HTTP 404: unscripted ${args[1]}`,
      exitCode: 1,
    }
    return {
      stdout: response.stdout ?? '',
      stderr: response.stderr ?? '',
      exitCode: response.exitCode ?? 0,
    }
  }
  return { runner, calls }
}

const graphqlQuery = (call: Call): string =>
  call.stdin ? String((JSON.parse(call.stdin) as { query: string }).query) : ''
const graphqlVariables = (call: Call): Record<string, unknown> =>
  call.stdin ? (JSON.parse(call.stdin) as { variables: Record<string, unknown> }).variables : {}
const json = (value: unknown): Response => ({ stdout: JSON.stringify(value) })

function summaryNode(overrides: Record<string, unknown> = {}) {
  return {
    id: 'PR_node7',
    number: 7,
    title: 'Add widget support',
    url: 'https://github.com/acme/widgets/pull/7',
    state: 'OPEN',
    isDraft: false,
    author: { __typename: 'Bot', login: 'juno' },
    headRefName: 'agent/juno/widgets',
    headRefOid: HEAD,
    baseRefName: 'main',
    isCrossRepository: false,
    additions: 12,
    deletions: 3,
    changedFiles: 2,
    commits: { totalCount: 1 },
    labels: { nodes: [{ name: 'area:frontend' }] },
    assignees: { nodes: [{ login: 'dana', name: 'Dana' }] },
    reviewRequests: {
      nodes: [
        { requestedReviewer: { __typename: 'User', login: 'octocat', name: null } },
        { requestedReviewer: { __typename: 'Team', combinedSlug: 'acme/core', name: 'Core' } },
      ],
    },
    latestReviews: {
      nodes: [
        {
          author: { __typename: 'User', login: 'mika' },
          state: 'APPROVED',
          commit: { oid: HEAD },
          submittedAt: NOW,
        },
      ],
    },
    reviewDecision: 'REVIEW_REQUIRED',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'BLOCKED',
    autoMergeRequest: null,
    viewerCanUpdateBranch: true,
    closingIssuesReferences: {
      nodes: [
        {
          number: 3,
          title: 'Widgets',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/issues/3',
        },
      ],
    },
    createdAt: NOW,
    updatedAt: NOW,
    mergedAt: null,
    closedAt: null,
    rollup: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              state: 'PENDING',
              contexts: {
                checkRunCountsByState: [
                  { state: 'SUCCESS', count: 3 },
                  { state: 'IN_PROGRESS', count: 1 },
                ],
                statusContextCountsByState: [{ state: 'FAILURE', count: 1 }],
              },
            },
          },
        },
      ],
    },
    ...overrides,
  }
}

const repositorySettings = {
  mergeCommitAllowed: true,
  squashMergeAllowed: true,
  rebaseMergeAllowed: false,
  autoMergeAllowed: true,
}

function summaryResponse(overrides: Record<string, unknown> = {}): Response {
  return json({
    data: {
      repository: {
        ...repositorySettings,
        pullRequest: { ...summaryNode(overrides), body: 'Body' },
      },
    },
  })
}

function threadNode(number = 7) {
  return {
    __typename: 'PullRequestReviewThread',
    id: 'PRRT_1',
    isResolved: false,
    isOutdated: false,
    path: 'src/a.ts',
    line: 4,
    originalLine: 4,
    startLine: null,
    originalStartLine: null,
    diffSide: 'RIGHT',
    comments: {
      nodes: [
        {
          id: 'PRRC_1',
          author: { __typename: 'User', login: 'mika' },
          body: 'Does this throw?',
          createdAt: '2026-10-03T11:00:00Z',
          diffHunk: '@@ -1,2 +1,2 @@\n-a\n+b',
        },
      ],
    },
    pullRequest: { number, repository: { owner: { login: 'acme' }, name: 'widgets' } },
  }
}

// ─── channel harness ────────────────────────────────────────────────────────

const roots: string[] = []
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function harness(respond: Responder) {
  const root = mkdtempSync(join(tmpdir(), 'adea-ghcollab-'))
  roots.push(root)
  const repoPath = realpathSync(initRepo(join(root, 'checkout')))
  git(repoPath, ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git'])
  const gh = scriptedGh(respond)
  const authority = createChannelAuthority({
    shellHost: '127.0.0.1',
    shellOrigin: 'https://127.0.0.1:4789',
  })
  const repo = {
    repoId: REPO_ID,
    canonicalRoot: repoPath,
    remote: 'https://github.com/acme/widgets.git',
    defaultBranch: 'main',
  }
  registerGithubRuntime({
    authority,
    scope,
    dataDir: root,
    resolveRepo: (repoId) => (repoId === REPO_ID ? repo : undefined),
    listRepos: () => [repo],
    resolveWorktree: () => undefined,
    runGh: gh.runner,
    protectedRefs: ['release'],
  })
  const bootstrap = authority.issueLaunchBootstrap()
  const at = Date.now()
  const handshake = authority.handshake(
    {
      schemaVersion: 1,
      method: 'dev.runtime.handshake.v1',
      requestId: '00000000-0000-4000-8000-000000000030',
      bootstrap,
      supportedProtocolVersions: ['1'],
      nonce: 'dGhpcy1ub25jZS1oYXMtYXQtbGVhc3QtMTI4LWJpdHM',
      issuedAt: new Date(at - 1000).toISOString(),
      expiresAt: new Date(at + 30_000).toISOString(),
    },
    { trusted: true }
  )
  if (!handshake.ok) throw new Error('handshake refused')
  const secret = Buffer.from(handshake.clientSecret, 'base64url')

  async function run(operation: DevOperation, body: Record<string, unknown>): Promise<DevReply> {
    const definition = devOperationDefinitions[operation]
    const idField = definition.resource?.idField
    const command: DevCommand = {
      schemaVersion: 1,
      operation,
      requestId: '00000000-0000-4000-8000-000000000031',
      nonce: Buffer.from(randomBytes(16)).toString('base64url'),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      scope,
      capabilities: [...definition.capabilities],
      ...(definition.resource
        ? {
            resource: {
              kind: definition.resource.kind,
              id: String(body[idField!] ?? planTargets.get(String(body.planId)) ?? ''),
              generation: 0,
            },
          }
        : {}),
      body,
    }
    const proof = createHmac('sha256', secret)
      .update(
        devCommandProofMessage({
          channelId: handshake.channelId,
          clientCredentialId: handshake.clientCredentialId,
          command,
        }),
        'utf8'
      )
      .digest('base64url')
    const reply = await authority.execute(
      {
        channelId: handshake.channelId,
        clientCredentialId: handshake.clientCredentialId,
        command,
        proof,
      },
      { trusted: true }
    )
    // The client decodes every reply strictly; so does this suite.
    devOperationDecoders[operation].reply({
      schemaVersion: 1,
      operation,
      requestId: command.requestId,
      ...(reply.ok
        ? { ok: true, value: reply.value, observedAt: new Date().toISOString() }
        : { ok: false, error: reply.error }),
    })
    if (reply.ok && typeof reply.value === 'object' && reply.value && 'digest' in reply.value) {
      const plan = reply.value as { id: string; resource: { id: string } }
      planTargets.set(plan.id, plan.resource.id)
    }
    return reply
  }
  const planTargets = new Map<string, string>()
  return { run, calls: gh.calls }
}

function valueOf<T>(reply: DevReply): T {
  if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`)
  return reply.value as T
}

function errorCode(reply: DevReply): string | undefined {
  return reply.ok ? undefined : reply.error.code
}

// ─── suites ─────────────────────────────────────────────────────────────────

describe('pull request read models', () => {
  test('inbox summaries map GraphQL to the strict summary DTO', async () => {
    const { run, calls } = harness((path, call) => {
      if (path === 'graphql' && graphqlQuery(call).includes('pullRequests('))
        return json({
          data: {
            repository: {
              ...repositorySettings,
              pullRequests: {
                pageInfo: { hasNextPage: true, endCursor: 'Y3Vyc29yOjI1' },
                nodes: [summaryNode()],
              },
            },
          },
        })
      return undefined
    })
    const page = valueOf<{ items: Record<string, unknown>[]; nextCursor?: string }>(
      await run('dev.github.pullRequestSummaries', { repoId: REPO_ID, state: 'open', limit: 25 })
    )
    const summary = page.items[0]!
    expect(summary.id).toBe(PR_ID)
    expect(summary.author).toEqual({ login: 'juno', kind: 'bot' })
    expect(summary.requestedReviewers).toEqual([
      { login: 'octocat', kind: 'user' },
      { login: 'acme/core', kind: 'team', name: 'Core' },
    ])
    expect(summary.checks).toEqual({
      state: 'pending',
      passing: 3,
      failing: 1,
      running: 1,
      skipped: 0,
      total: 5,
    })
    expect(summary.mergeState).toBe('blocked')
    expect(summary.mergeMethods).toEqual(['merge', 'squash'])
    expect(summary.body).toBeUndefined()
    expect(page.nextCursor).toBeDefined()
    expect(graphqlVariables(calls[0]!)).toMatchObject({
      owner: 'acme',
      name: 'widgets',
      states: ['OPEN'],
    })
    // The GraphQL document rides stdin; argv carries only the fixed shape.
    expect(calls[0]!.args).toEqual([
      'api',
      'graphql',
      '--hostname',
      'github.com',
      '--input',
      '-',
      '--method',
      'POST',
    ])
  })

  test('a single summary carries the body and behind count', async () => {
    const { run } = harness((path) => {
      if (path === 'graphql') return summaryResponse()
      if (path.startsWith('repos/acme/widgets/compare/')) return json({ ahead_by: 1, behind_by: 5 })
      return undefined
    })
    const summary = valueOf<Record<string, unknown>>(
      await run('dev.github.pullRequestSummary', { pullRequestId: PR_ID, refresh: true })
    )
    expect(summary.body).toBe('Body')
    expect(summary.behindBy).toBe(5)
    expect(summary.linkedIssues).toHaveLength(1)
  })

  test('the timeline interleaves threads, skips unknown nodes and sorts by time', async () => {
    const { run } = harness((path, call) => {
      if (path === 'graphql' && graphqlQuery(call).includes('timelineItems'))
        return json({
          data: {
            repository: {
              pullRequest: {
                timelineItems: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      __typename: 'IssueComment',
                      id: 'IC_1',
                      author: { __typename: 'User', login: 'dana' },
                      body: 'Ship it\u001b[31m',
                      createdAt: '2026-10-03T12:00:00Z',
                    },
                    {
                      __typename: 'PullRequestCommit',
                      id: 'PRC_1',
                      commit: {
                        oid: HEAD,
                        messageHeadline: 'Add widgets',
                        committedDate: '2026-10-03T10:00:00Z',
                        author: { name: 'Juno', user: { login: 'juno' } },
                        statusCheckRollup: { state: 'FAILURE' },
                      },
                    },
                    { __typename: 'LabeledEvent', id: 'LE_1', createdAt: NOW },
                    {
                      __typename: 'MergedEvent',
                      id: 'ME_1',
                      actor: { __typename: 'User', login: 'dana' },
                      createdAt: '2026-10-03T13:00:00Z',
                      commit: { oid: BASE },
                    },
                  ],
                },
                reviewThreads: { nodes: [threadNode()] },
              },
            },
          },
        })
      return undefined
    })
    const page = valueOf<{ items: { kind: string; body?: string; detail?: string }[] }>(
      await run('dev.github.timeline', { pullRequestId: PR_ID })
    )
    expect(page.items.map((item) => item.kind)).toEqual(['commit', 'thread', 'comment', 'event'])
    expect(page.items[2]!.body).toBe('Ship it')
    expect(page.items[3]!.detail).toBe(BASE)
  })

  test('check logs are sanitised and tailed; non-Actions checks are typed', async () => {
    const { run, calls } = harness((path, call) => {
      if (path === 'repos/acme/widgets/actions/jobs/42/logs')
        return { stdout: `${'x'.repeat(600_000)}\n\u001b[31mFAIL\u001b[0m a.test.ts\r\n` }
      if (path === 'repos/acme/widgets/actions/jobs/43/logs')
        return { stderr: 'HTTP 404: Not Found', exitCode: 1 }
      if (path === 'repos/acme/widgets/actions/jobs/44/logs')
        return call.args.includes('--allow-escape-sequences')
          ? { stderr: 'unknown flag: --allow-escape-sequences', exitCode: 1 }
          : { stdout: 'old gh log\n' }
      return undefined
    })
    const log = valueOf<{ text: string; truncated: boolean }>(
      await run('dev.github.checkLog', { pullRequestId: PR_ID, checkId: '42' })
    )
    expect(log.truncated).toBe(true)
    expect(log.text.endsWith('FAIL a.test.ts\n')).toBe(true)
    expect(log.text.length).toBeLessThanOrEqual(524_288)
    const missing = await run('dev.github.checkLog', { pullRequestId: PR_ID, checkId: '43' })
    expect(errorCode(missing)).toBe('not_found')
    // Recent gh needs an explicit opt-in to print escapes; older gh lacks the flag.
    expect(calls[0]!.args).toContain('--allow-escape-sequences')
    const legacy = valueOf<{ text: string }>(
      await run('dev.github.checkLog', { pullRequestId: PR_ID, checkId: '44' })
    )
    expect(legacy.text).toBe('old gh log\n')
  })

  test('changed files bound patches and page by offset', async () => {
    const { run } = harness((path) => {
      if (path.startsWith('repos/acme/widgets/pulls/7/files'))
        return json([
          {
            filename: 'src/a.ts',
            status: 'modified',
            additions: 1,
            deletions: 1,
            patch: '@@ -1 +1 @@\n-a\n+b',
          },
          { filename: 'logo.png', status: 'added', additions: 0, deletions: 0 },
          {
            filename: 'big.txt',
            status: 'modified',
            additions: 1,
            deletions: 0,
            patch: 'y'.repeat(300_000),
          },
        ])
      return undefined
    })
    const page = valueOf<{ items: { patch?: string; patchTruncated: boolean }[] }>(
      await run('dev.github.files', { pullRequestId: PR_ID, limit: 100 })
    )
    expect(page.items[1]!.patch).toBeUndefined()
    expect(page.items[2]!.patchTruncated).toBe(true)
  })
})

describe('repository read', () => {
  test('carries the default branch head and its CI state, best effort', async () => {
    let broken = false
    const { run } = harness((path, call) => {
      if (path === 'repos/acme/widgets')
        return json({
          id: 1,
          name: 'widgets',
          owner: { login: 'acme' },
          default_branch: 'main',
          html_url: 'https://github.com/acme/widgets',
          private: true,
          fork: false,
        })
      if (path === 'graphql' && graphqlQuery(call).includes('defaultBranchRef'))
        return broken
          ? { stderr: 'HTTP 502', exitCode: 1 }
          : json({
              data: {
                repository: {
                  defaultBranchRef: {
                    target: { oid: BASE, statusCheckRollup: { state: 'SUCCESS' } },
                  },
                },
              },
            })
      return undefined
    })
    const repo = valueOf<{ defaultBranchHead?: unknown }>(
      await run('dev.github.repository', { repoId: REPO_ID, refresh: true })
    )
    expect(repo.defaultBranchHead).toEqual({ sha: BASE, checks: 'success' })
    broken = true
    const degraded = valueOf<{ defaultBranchHead?: unknown }>(
      await run('dev.github.repository', { repoId: REPO_ID, refresh: true })
    )
    expect(degraded.defaultBranchHead).toBeUndefined()
  })
})

describe('conversation writes', () => {
  test('comment text rides stdin, never argv', async () => {
    const secretish = 'please review $(rm -rf /) --hostname evil.example'
    const { run, calls } = harness((path) => {
      if (path === 'repos/acme/widgets/issues/7/comments')
        return json({
          node_id: 'IC_9',
          user: { login: 'octocat', type: 'User' },
          body: secretish,
          created_at: NOW,
        })
      return undefined
    })
    const comment = valueOf<{ kind: string; body: string }>(
      await run('dev.github.comment', { pullRequestId: PR_ID, body: secretish })
    )
    expect(comment).toMatchObject({ kind: 'comment', body: secretish })
    expect(calls[0]!.args.join(' ')).not.toContain('rm -rf')
    expect(JSON.parse(calls[0]!.stdin!)).toEqual({ body: secretish })
  })

  test('thread writes re-prove the thread belongs to this pull request', async () => {
    let owner = 7
    let resolved = false
    const { run, calls } = harness((path, call) => {
      if (path !== 'graphql') return undefined
      const query = graphqlQuery(call)
      if (query.includes('node(id:'))
        return json({ data: { node: { ...threadNode(owner), isResolved: resolved } } })
      if (query.includes('resolveReviewThread')) {
        resolved = true
        return json({ data: { resolveReviewThread: { thread: { id: 'PRRT_1' } } } })
      }
      return undefined
    })
    const thread = valueOf<{ resolved: boolean }>(
      await run('dev.github.threadResolve', {
        pullRequestId: PR_ID,
        threadId: 'PRRT_1',
        resolved: true,
      })
    )
    expect(thread.resolved).toBe(true)
    owner = 8
    const before = calls.length
    const foreign = await run('dev.github.threadReply', {
      pullRequestId: PR_ID,
      threadId: 'PRRT_1',
      body: 'hi',
    })
    expect(errorCode(foreign)).toBe('identity_mismatch')
    // Refused before any mutation was sent.
    expect(calls.slice(before).some((call) => graphqlQuery(call).includes('mutation'))).toBe(false)
  })

  test('reviews bind the head the reviewer read and validate verdict bodies', async () => {
    let head = HEAD
    const { run, calls } = harness((path) => {
      if (path === 'graphql') return summaryResponse({ headRefOid: head })
      if (path === 'repos/acme/widgets/pulls/7/reviews')
        return json({
          node_id: 'PRR_9',
          user: { login: 'octocat', type: 'User' },
          state: 'APPROVED',
          body: '',
          commit_id: HEAD,
          submitted_at: NOW,
        })
      return undefined
    })
    const comment = { path: 'src/a.ts', line: 4, side: 'left' as const, startLine: 2, body: 'nit' }
    const review = valueOf<{ kind: string; state: string }>(
      await run('dev.github.submitReview', {
        pullRequestId: PR_ID,
        expectedHeadSha: HEAD,
        verdict: 'approve',
        body: '',
        comments: [comment],
      })
    )
    expect(review).toMatchObject({ kind: 'review', state: 'approved' })
    const posted = JSON.parse(calls.find((call) => call.args[1]?.endsWith('/reviews'))!.stdin!)
    expect(posted).toMatchObject({
      event: 'APPROVE',
      commit_id: HEAD,
      comments: [{ path: 'src/a.ts', line: 4, side: 'LEFT', start_line: 2, start_side: 'LEFT' }],
    })
    const empty = await run('dev.github.submitReview', {
      pullRequestId: PR_ID,
      expectedHeadSha: HEAD,
      verdict: 'request_changes',
      body: '  ',
      comments: [],
    })
    expect(errorCode(empty)).toBe('invalid_state')
    head = MOVED
    const stale = await run('dev.github.submitReview', {
      pullRequestId: PR_ID,
      expectedHeadSha: HEAD,
      verdict: 'comment',
      body: 'hm',
      comments: [],
    })
    expect(errorCode(stale)).toBe('stale_version')
  })

  test('metadata updates validate logins and split teams', async () => {
    const { run, calls } = harness((path) => {
      if (path === 'repos/acme/widgets/pulls/7/requested_reviewers') return json({})
      if (path === 'repos/acme/widgets/issues/7/labels/needs%20review') return json({})
      if (path === 'graphql') return summaryResponse()
      if (path.startsWith('repos/acme/widgets/compare/')) return json({ ahead_by: 1, behind_by: 0 })
      return undefined
    })
    valueOf(
      await run('dev.github.metadataUpdate', {
        pullRequestId: PR_ID,
        reviewers: { add: ['octocat', 'acme/core'], remove: [] },
        labels: { add: [], remove: ['needs review'] },
      })
    )
    const request = calls.find((call) => call.args[1]?.endsWith('/requested_reviewers'))!
    expect(JSON.parse(request.stdin!)).toEqual({ reviewers: ['octocat'], team_reviewers: ['core'] })
    const bad = await run('dev.github.metadataUpdate', {
      pullRequestId: PR_ID,
      assignees: { add: ['../../etc'], remove: [] },
    })
    expect(errorCode(bad)).toBe('identity_mismatch')
  })

  test('re-running failed jobs is bound to the pull request branch', async () => {
    let branch = 'agent/juno/widgets'
    const { run, calls } = harness((path) => {
      if (path === 'repos/acme/widgets/actions/jobs/42')
        return json({ run_id: 9001, head_branch: branch })
      if (path === 'graphql') return summaryResponse()
      if (path === 'repos/acme/widgets/actions/runs/9001/rerun-failed-jobs') return json({})
      return undefined
    })
    expect(
      valueOf<{ runId: string }>(
        await run('dev.github.rerunFailedJobs', { pullRequestId: PR_ID, checkId: '42' })
      ).runId
    ).toBe('9001')
    branch = 'main'
    const before = calls.length
    const foreign = await run('dev.github.rerunFailedJobs', { pullRequestId: PR_ID, checkId: '42' })
    expect(errorCode(foreign)).toBe('identity_mismatch')
    expect(calls.slice(before).some((call) => call.args[1]?.includes('rerun'))).toBe(false)
  })
})

describe('auto-merge and branch sync plans', () => {
  test('auto-merge enables only on the planned head', async () => {
    let head = HEAD
    let autoMerge: unknown = null
    const { run, calls } = harness((path, call) => {
      if (path.startsWith('repos/acme/widgets/compare/')) return json({ ahead_by: 1, behind_by: 0 })
      if (path !== 'graphql') return undefined
      const query = graphqlQuery(call)
      if (query.includes('enablePullRequestAutoMerge')) {
        autoMerge = { mergeMethod: 'SQUASH', enabledBy: { login: 'octocat' } }
        return json({ data: { enablePullRequestAutoMerge: { clientMutationId: null } } })
      }
      return summaryResponse({ headRefOid: head, autoMergeRequest: autoMerge })
    })
    const plan = valueOf<{ id: string; digest: string; blockers: unknown[] }>(
      await run('dev.github.autoMergePlan', {
        pullRequestId: PR_ID,
        expectedHeadSha: HEAD,
        enabled: true,
        method: 'squash',
      })
    )
    expect(plan.blockers).toEqual([])
    const forged = await run('dev.github.autoMergeCommit', {
      planId: plan.id,
      planDigest: '0'.repeat(64),
    })
    expect(errorCode(forged)).toBe('plan_stale')
    const summary = valueOf<{ autoMerge?: { method: string } }>(
      await run('dev.github.autoMergeCommit', { planId: plan.id, planDigest: plan.digest })
    )
    expect(summary.autoMerge?.method).toBe('squash')
    const mutation = calls.find((call) =>
      graphqlQuery(call).includes('enablePullRequestAutoMerge')
    )!
    expect(graphqlVariables(mutation)).toEqual({ pr: 'PR_node7', method: 'SQUASH', head: HEAD })

    autoMerge = null
    const second = valueOf<{ id: string; digest: string }>(
      await run('dev.github.autoMergePlan', {
        pullRequestId: PR_ID,
        expectedHeadSha: HEAD,
        enabled: true,
        method: 'squash',
      })
    )
    head = MOVED
    const moved = await run('dev.github.autoMergeCommit', {
      planId: second.id,
      planDigest: second.digest,
    })
    expect(errorCode(moved)).toBe('stale_version')
  })

  test('auto-merge plans report disallowed methods and clean PRs as blockers', async () => {
    const { run } = harness((path) =>
      path === 'graphql' ? summaryResponse({ mergeStateStatus: 'CLEAN' }) : undefined
    )
    const plan = valueOf<{ blockers: { code: string }[] }>(
      await run('dev.github.autoMergePlan', {
        pullRequestId: PR_ID,
        expectedHeadSha: HEAD,
        enabled: true,
        method: 'rebase',
      })
    )
    expect(plan.blockers.map((entry) => entry.code).toSorted()).toEqual([
      'invalid_state',
      'unsupported_capability',
    ])
  })

  test('branch sync is blocked when nothing is behind and fenced on head', async () => {
    let behind = 0
    let head = HEAD
    const { run, calls } = harness((path, call) => {
      if (path.startsWith('repos/acme/widgets/compare/'))
        return json({ ahead_by: 1, behind_by: behind })
      if (path !== 'graphql') return undefined
      if (graphqlQuery(call).includes('updatePullRequestBranch'))
        return json({ data: { updatePullRequestBranch: { clientMutationId: null } } })
      return summaryResponse({ headRefOid: head })
    })
    const upToDate = valueOf<{ blockers: { code: string }[] }>(
      await run('dev.github.syncBranchPlan', {
        pullRequestId: PR_ID,
        expectedHeadSha: HEAD,
        method: 'merge',
      })
    )
    expect(upToDate.blockers.map((entry) => entry.code)).toEqual(['already_completed'])
    behind = 3
    const plan = valueOf<{ id: string; digest: string; blockers: unknown[] }>(
      await run('dev.github.syncBranchPlan', {
        pullRequestId: PR_ID,
        expectedHeadSha: HEAD,
        method: 'rebase',
      })
    )
    expect(plan.blockers).toEqual([])
    valueOf(await run('dev.github.syncBranchCommit', { planId: plan.id, planDigest: plan.digest }))
    const mutation = calls.find((call) => graphqlQuery(call).includes('updatePullRequestBranch'))!
    expect(graphqlVariables(mutation)).toEqual({ pr: 'PR_node7', head: HEAD, method: 'REBASE' })
    const again = valueOf<{ id: string; digest: string }>(
      await run('dev.github.syncBranchPlan', {
        pullRequestId: PR_ID,
        expectedHeadSha: HEAD,
        method: 'merge',
      })
    )
    head = MOVED
    expect(
      errorCode(
        await run('dev.github.syncBranchCommit', { planId: again.id, planDigest: again.digest })
      )
    ).toBe('stale_version')
  })
})

describe('#423 extensions', () => {
  function restPr(overrides: Record<string, unknown> = {}) {
    return {
      number: 7,
      node_id: 'PR_node7',
      title: 'Add widget support',
      state: 'open',
      draft: false,
      merged: false,
      user: { login: 'juno' },
      head: {
        ref: 'agent/juno/widgets',
        sha: HEAD,
        repo: { name: 'widgets', full_name: 'acme/widgets', owner: { login: 'acme' } },
      },
      base: {
        ref: 'main',
        sha: BASE,
        repo: {
          name: 'widgets',
          full_name: 'acme/widgets',
          default_branch: 'main',
          owner: { login: 'acme' },
        },
      },
      html_url: 'https://github.com/acme/widgets/pull/7',
      mergeable: true,
      updated_at: NOW,
      labels: [],
      ...overrides,
    }
  }

  test('merge with deleteBranch deletes a same-repository, unprotected head', async () => {
    let merged = false
    let protectedBranch = false
    const { run, calls } = harness((path) => {
      if (path === 'repos/acme/widgets/pulls/7')
        return json(restPr(merged ? { state: 'closed', merged: true } : {}))
      if (path.startsWith('repos/acme/widgets/compare/')) return json({ ahead_by: 1, behind_by: 0 })
      if (path.startsWith('repos/acme/widgets/pulls/7/reviews')) return json([])
      if (path.startsWith(`repos/acme/widgets/commits/${HEAD}/check-runs`))
        return json({ total_count: 0, check_runs: [] })
      if (path === 'repos/acme/widgets/pulls/7/merge') {
        merged = true
        return json({ merged: true, sha: BASE })
      }
      if (path === 'repos/acme/widgets/branches/agent%2Fjuno%2Fwidgets')
        return json({ name: 'agent/juno/widgets', protected: protectedBranch })
      if (path === 'repos/acme/widgets/git/refs/heads/agent%2Fjuno%2Fwidgets') return { stdout: '' }
      return undefined
    })
    const plan = valueOf<{ id: string; digest: string }>(
      await run('dev.github.mergePlan', {
        pullRequestId: PR_ID,
        expectedHeadSha: HEAD,
        method: 'squash',
        deleteBranch: true,
      })
    )
    const result = valueOf<{ state: string; headBranchDeleted?: boolean }>(
      await run('dev.github.mergeCommit', { planId: plan.id, planDigest: plan.digest })
    )
    expect(result).toMatchObject({ state: 'merged', headBranchDeleted: true })
    expect(calls.some((call) => call.args.includes('DELETE'))).toBe(true)

    merged = false
    protectedBranch = true
    const second = valueOf<{ id: string; digest: string }>(
      await run('dev.github.mergePlan', {
        pullRequestId: PR_ID,
        expectedHeadSha: HEAD,
        method: 'squash',
        deleteBranch: true,
      })
    )
    const kept = valueOf<{ headBranchDeleted?: boolean }>(
      await run('dev.github.mergeCommit', { planId: second.id, planDigest: second.digest })
    )
    expect(kept.headBranchDeleted).toBe(false)
  })

  test('update plans convert to draft through GraphQL and close through REST', async () => {
    let draft = false
    let state = 'open'
    const { run, calls } = harness((path, call) => {
      if (path === 'repos/acme/widgets/pulls/7') {
        if (call.args.includes('PATCH')) state = 'closed'
        return json(restPr({ draft, state }))
      }
      if (path.startsWith('repos/acme/widgets/compare/')) return json({ ahead_by: 1, behind_by: 0 })
      if (path.startsWith('repos/acme/widgets/pulls/7/reviews')) return json([])
      if (path === 'graphql') {
        const query = graphqlQuery(call)
        if (query.includes('convertPullRequestToDraft')) {
          draft = true
          return json({ data: { convertPullRequestToDraft: { clientMutationId: null } } })
        }
        return json({
          data: {
            repository: {
              pullRequest: { id: 'PR_node7', headRefOid: HEAD, state: 'OPEN', isDraft: draft },
            },
          },
        })
      }
      return undefined
    })
    const read = valueOf<{ version: number }>(
      await run('dev.github.pullRequest', { pullRequestId: PR_ID })
    )
    const plan = valueOf<{ id: string; digest: string }>(
      await run('dev.github.updatePlan', {
        pullRequestId: PR_ID,
        expectedVersion: read.version,
        patch: { draft: true, state: 'closed' },
      })
    )
    const updated = valueOf<{ draft: boolean; state: string }>(
      await run('dev.github.updateCommit', { planId: plan.id, planDigest: plan.digest })
    )
    expect(updated).toMatchObject({ draft: true, state: 'closed' })
    expect(calls.some((call) => graphqlQuery(call).includes('convertPullRequestToDraft'))).toBe(
      true
    )
  })

  test('check runs read a specific commit and carry their output title', async () => {
    const { run, calls } = harness((path) => {
      if (path.startsWith(`repos/acme/widgets/commits/${MOVED}/check-runs`))
        return json({
          total_count: 1,
          check_runs: [
            {
              id: 5,
              name: 'unit-tests',
              status: 'completed',
              conclusion: 'failure',
              output: { title: '3 of 412 tests failed' },
            },
          ],
        })
      return undefined
    })
    const page = valueOf<{ items: { title?: string }[] }>(
      await run('dev.github.checks', { pullRequestId: PR_ID, sha: MOVED })
    )
    expect(page.items[0]!.title).toBe('3 of 412 tests failed')
    expect(calls.some((call) => call.args[1] === 'repos/acme/widgets/pulls/7')).toBe(false)
  })
})
