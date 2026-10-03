// Source control app: GitLab provider acceptance. Runs on a scripted glab
// transport (no network) behind the real signed channel. Every reply is
// re-decoded through the strict client decoders, so a mapping that drifts
// from the shared review contract fails here. Covers remote parsing, the
// merge request read models (draft prefix, approvals, pipeline rollup),
// discussions as threads and lifecycle events, head-pipeline checks, log
// sanitising, user text on stdin, head binding on reviews and merges,
// rebase-only branch updates, draft toggles through the title prefix,
// create-time reconciliation, and the typed refusals for what GitLab lacks.
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
import {
  displayTitle,
  parseGitLabRemote,
  pipelineState,
  registerGitlabRuntime,
  type GlabRunner,
} from '../shell/src/dev-runtime/gitlab/register'
import { git, initRepo, scope } from './worktree-fixtures'

const REPO_ID = '00000000-0000-4000-8000-00000000gl01'
const PROJECT = 'acme/platform/widgets'
const MR_ID = `gl:${PROJECT}!7`
const HEAD = 'a'.repeat(40)
const MOVED = 'b'.repeat(40)
const BASE = 'c'.repeat(40)
const NOW = '2026-10-03T12:00:00Z'
const ENCODED = `projects/${encodeURIComponent(PROJECT)}`

// ─── scripted glab ──────────────────────────────────────────────────────────

type Call = { args: readonly string[]; stdin?: string }
type Response = { stdout?: string; stderr?: string; exitCode?: number }
type Responder = (path: string, call: Call) => Response | undefined

function scriptedGlab(respond: Responder): { runner: GlabRunner; calls: Call[] } {
  const calls: Call[] = []
  const runner: GlabRunner = async (args, options) => {
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

const json = (value: unknown): Response => ({ stdout: JSON.stringify(value) })
const queryOf = (call: Call): string =>
  call.stdin ? String((JSON.parse(call.stdin) as { query?: string }).query ?? '') : ''
const bodyOf = (call: Call): Record<string, unknown> =>
  call.stdin ? (JSON.parse(call.stdin) as Record<string, unknown>) : {}
const methodOf = (call: Call): string =>
  call.args.includes('--method') ? call.args[call.args.indexOf('--method') + 1]! : 'GET'

const projectRest = {
  path: 'widgets',
  path_with_namespace: PROJECT,
  default_branch: 'main',
  web_url: `https://gitlab.com/${PROJECT}`,
  visibility: 'private',
  merge_method: 'merge',
  squash_option: 'default_off',
}

function mrNode(overrides: Record<string, unknown> = {}) {
  return {
    id: 'gid://gitlab/MergeRequest/700',
    iid: '7',
    title: 'Draft: Add widget support',
    webUrl: `https://gitlab.com/${PROJECT}/-/merge_requests/7`,
    state: 'opened',
    draft: true,
    author: { username: 'juno', name: 'Juno', bot: true },
    sourceBranch: 'agent/juno/widgets',
    targetBranch: 'main',
    diffHeadSha: HEAD,
    sourceProjectId: 11,
    targetProjectId: 11,
    labels: { nodes: [{ title: 'area::frontend' }] },
    assignees: { nodes: [{ username: 'dana', name: 'Dana', bot: false }] },
    reviewers: {
      nodes: [
        {
          username: 'octocat',
          name: null,
          bot: false,
          mergeRequestInteraction: { reviewState: 'UNREVIEWED', approved: false },
        },
        {
          username: 'rhea',
          name: 'Rhea',
          bot: false,
          mergeRequestInteraction: { reviewState: 'REQUESTED_CHANGES', approved: false },
        },
        {
          username: 'mika',
          name: 'Mika',
          bot: false,
          mergeRequestInteraction: { reviewState: 'APPROVED', approved: true },
        },
      ],
    },
    approvedBy: { nodes: [{ username: 'mika', name: 'Mika', bot: false }] },
    approved: false,
    approvalsLeft: 1,
    approvalsRequired: 2,
    detailedMergeStatus: 'NOT_APPROVED',
    conflicts: false,
    shouldBeRebased: false,
    autoMergeEnabled: false,
    squashOnMerge: false,
    mergeUser: null,
    diffStatsSummary: { additions: 12, deletions: 3, fileCount: 2 },
    commitCount: 1,
    headPipeline: {
      status: 'RUNNING',
      jobs: {
        nodes: [
          { status: 'SUCCESS', allowFailure: false },
          { status: 'FAILED', allowFailure: true },
          { status: 'RUNNING', allowFailure: false },
          { status: 'MANUAL', allowFailure: true },
        ],
      },
    },
    userPermissions: { pushToSourceBranch: true },
    createdAt: NOW,
    updatedAt: NOW,
    mergedAt: null,
    closedAt: null,
    description: 'Body',
    ...overrides,
  }
}

function mrRest(overrides: Record<string, unknown> = {}) {
  return {
    iid: 7,
    title: 'Draft: Add widget support',
    description: 'Body',
    state: 'opened',
    draft: true,
    source_branch: 'agent/juno/widgets',
    target_branch: 'main',
    source_project_id: 11,
    target_project_id: 11,
    sha: HEAD,
    diff_refs: { base_sha: BASE, start_sha: BASE, head_sha: HEAD },
    author: { username: 'juno' },
    web_url: `https://gitlab.com/${PROJECT}/-/merge_requests/7`,
    has_conflicts: false,
    detailed_merge_status: 'not_approved',
    labels: ['area::frontend'],
    reviewers: [{ id: 41 }],
    assignees: [],
    updated_at: NOW,
    ...overrides,
  }
}

/** The reads every write path re-proves against. */
function baseResponder(
  extra: Responder = () => undefined,
  mr: Record<string, unknown> = {}
): Responder {
  return (path, call) => {
    const answer = extra(path, call)
    if (answer) return answer
    if (path === ENCODED) return json(projectRest)
    if (path === `${ENCODED}/merge_requests/7` && methodOf(call) === 'GET') return json(mrRest(mr))
    if (path === 'graphql' && queryOf(call).includes('mergeRequest(iid'))
      return json({ data: { project: { mergeRequest: mrNode() } } })
    if (path.startsWith(`${ENCODED}/repository/compare`)) return json({ commits: [{}, {}] })
    if (path === 'user')
      return json({ username: 'dana', name: 'Dana', web_url: 'https://gitlab.com/dana' })
    return undefined
  }
}

// ─── channel harness ────────────────────────────────────────────────────────

const roots: string[] = []
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function harness(respond: Responder) {
  const root = mkdtempSync(join(tmpdir(), 'adea-glprov-'))
  roots.push(root)
  const repoPath = realpathSync(initRepo(join(root, 'checkout')))
  git(repoPath, ['remote', 'add', 'origin', `git@gitlab.com:${PROJECT}.git`])
  const glab = scriptedGlab(respond)
  const authority = createChannelAuthority({
    shellHost: '127.0.0.1',
    shellOrigin: 'https://127.0.0.1:4789',
  })
  const repo = { repoId: REPO_ID, canonicalRoot: repoPath }
  const registration = registerGitlabRuntime({
    authority,
    scope,
    resolveRepo: (repoId) => (repoId === REPO_ID ? repo : undefined),
    listRepos: () => [repo],
    runGlab: glab.runner,
    cacheTtlMs: 0,
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
  const planTargets = new Map<string, string>()

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
  return { run, calls: glab.calls, registration }
}

function valueOf<T>(reply: DevReply): T {
  if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`)
  return reply.value as T
}

function errorCode(reply: DevReply): string | undefined {
  return reply.ok ? undefined : reply.error.code
}

const note = (id: number, body: string, extra: Record<string, unknown> = {}) => ({
  id: `gid://gitlab/Note/${id}`,
  body,
  system: false,
  createdAt: `2026-10-03T1${id % 10}:00:00Z`,
  author: { username: 'mika', name: 'Mika', bot: false },
  position: null,
  ...extra,
})

type Plan = { id: string; digest: string; blockers: { code: string }[] }

// ─── suites ─────────────────────────────────────────────────────────────────

describe('GitLab registration and remotes', () => {
  test('registers every dev.gitlab operation in the contract', () => {
    const { registration } = harness(() => undefined)
    const expected = Object.keys(devOperationDefinitions).filter((op) =>
      op.startsWith('dev.gitlab.')
    )
    expect(registration.commands.toSorted()).toEqual(expected.toSorted())
    expect(registration.registeredCommands).toBe(expected.length)
  })

  test('parses nested-group remotes and refuses untrusted hosts', () => {
    expect(parseGitLabRemote('git@gitlab.com:acme/platform/widgets.git', ['gitlab.com'])).toEqual({
      host: 'gitlab.com',
      fullPath: 'acme/platform/widgets',
    })
    expect(parseGitLabRemote('https://gitlab.com/acme/widgets', ['gitlab.com']).fullPath).toBe(
      'acme/widgets'
    )
    expect(() =>
      parseGitLabRemote('https://git.example.com/acme/widgets.git', ['gitlab.com'])
    ).toThrow(/not trusted/)
    expect(() => parseGitLabRemote('https://gitlab.com/acme/../x.git', ['gitlab.com'])).toThrow()
    expect(() => parseGitLabRemote('https://gitlab.com/solo', ['gitlab.com'])).toThrow()
  })

  test('strips draft prefixes and maps pipeline states', () => {
    expect(displayTitle('Draft: Ship it')).toBe('Ship it')
    expect(displayTitle('[Draft] Ship it')).toBe('Ship it')
    expect(displayTitle('Drafting rules')).toBe('Drafting rules')
    expect(pipelineState('SUCCESS')).toBe('success')
    expect(pipelineState('CANCELED')).toBe('failure')
    expect(pipelineState('MANUAL')).toBe('pending')
    expect(pipelineState(null)).toBe('none')
  })

  test('a missing glab binary is a typed capability refusal', async () => {
    const { run } = harness(() => ({
      stderr: 'the glab CLI is not installed on this machine',
      exitCode: 127,
    }))
    // The scripted runner cannot set spawnCode, so the stderr classifies.
    expect(errorCode(await run('dev.gitlab.account', {}))).toBeDefined()
  })
})

describe('merge request read models', () => {
  test('summaries map merge requests to the shared DTO', async () => {
    const { run, calls } = harness(
      baseResponder((path, call) => {
        if (path === 'graphql' && queryOf(call).includes('mergeRequests('))
          return json({
            data: {
              project: {
                mergeRequests: {
                  pageInfo: { hasNextPage: true, endCursor: 'eyJpZCI6IjcifQ' },
                  nodes: [mrNode(), { ...mrNode({ iid: '8' }), diffHeadSha: null }],
                },
              },
            },
          })
        return undefined
      })
    )
    const page = valueOf<{ items: Record<string, unknown>[]; nextCursor?: string }>(
      await run('dev.gitlab.pullRequestSummaries', { repoId: REPO_ID, state: 'open', limit: 25 })
    )
    // A merge request with no diff yet is skipped, not a decode failure.
    expect(page.items).toHaveLength(1)
    expect(page.nextCursor).toBeDefined()
    const summary = page.items[0]!
    expect(summary.id).toBe(MR_ID)
    expect(summary.title).toBe('Add widget support')
    expect(summary.draft).toBe(true)
    expect(summary.mergeState).toBe('blocked')
    expect(summary.reviewDecision).toBe('changes_requested')
    expect(summary.requestedReviewers).toEqual([{ login: 'octocat', kind: 'user' }])
    expect(summary.reviews).toEqual([
      { actor: { login: 'mika', kind: 'user', name: 'Mika' }, state: 'approved' },
      { actor: { login: 'rhea', kind: 'user', name: 'Rhea' }, state: 'changes_requested' },
    ])
    // allow_failure jobs count as passing; manual jobs as skipped.
    expect(summary.checks).toEqual({
      state: 'pending',
      passing: 2,
      failing: 0,
      running: 1,
      skipped: 1,
      total: 4,
    })
    expect(summary.mergeMethods).toEqual(['merge', 'squash'])
    const listing = calls.find((call) => queryOf(call).includes('mergeRequests('))!
    expect((bodyOf(listing).variables as Record<string, unknown>).state).toBe('opened')
  })

  test('the summary reads behind-by from a compare against the target', async () => {
    const { run } = harness(baseResponder())
    const summary = valueOf<{ behindBy?: number; body?: string; repoId: string }>(
      await run('dev.gitlab.pullRequestSummary', { pullRequestId: MR_ID })
    )
    expect(summary.behindBy).toBe(2)
    expect(summary.body).toBe('Body')
    expect(summary.repoId).toBe(REPO_ID)
  })

  test('discussions become threads, comments, approvals and lifecycle events', async () => {
    const { run } = harness(
      baseResponder((path, call) => {
        if (path !== 'graphql') return undefined
        if (queryOf(call).includes('discussions('))
          return json({
            data: {
              project: {
                mergeRequest: {
                  discussions: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        id: 'gid://gitlab/Discussion/abcdef0123456789',
                        resolved: false,
                        resolvable: true,
                        notes: {
                          nodes: [
                            note(1, 'Does this throw?', {
                              position: {
                                newPath: 'src/a.ts',
                                oldPath: 'src/a.ts',
                                newLine: 4,
                                oldLine: null,
                              },
                            }),
                          ],
                        },
                      },
                      {
                        id: 'gid://gitlab/Discussion/1',
                        resolved: false,
                        resolvable: false,
                        notes: { nodes: [note(2, 'Looks good')] },
                      },
                      {
                        id: 'gid://gitlab/Discussion/2',
                        resolved: false,
                        resolvable: false,
                        notes: {
                          nodes: [note(3, 'approved this merge request', { system: true })],
                        },
                      },
                      {
                        id: 'gid://gitlab/Discussion/3',
                        resolved: false,
                        resolvable: false,
                        notes: {
                          nodes: [
                            note(4, 'marked this merge request as **ready**', { system: true }),
                          ],
                        },
                      },
                      {
                        id: 'gid://gitlab/Discussion/4',
                        resolved: false,
                        resolvable: false,
                        notes: { nodes: [note(5, 'added 1 commit', { system: true })] },
                      },
                    ],
                  },
                },
              },
            },
          })
        if (queryOf(call).includes('commits('))
          return json({
            data: {
              project: {
                mergeRequest: {
                  diffHeadSha: HEAD,
                  headPipeline: { status: 'SUCCESS' },
                  commits: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        sha: HEAD,
                        title: 'Add widgets',
                        authoredDate: '2026-10-03T09:00:00Z',
                        author: { username: 'juno' },
                        authorName: 'Juno',
                      },
                    ],
                  },
                },
              },
            },
          })
        return undefined
      })
    )
    const page = valueOf<{ items: { kind: string; [key: string]: unknown }[] }>(
      await run('dev.gitlab.timeline', { pullRequestId: MR_ID, limit: 100 })
    )
    expect(page.items.map((item) => item.kind)).toEqual([
      'commit',
      'thread',
      'comment',
      'review',
      'event',
    ])
    const thread = page.items.find((item) => item.kind === 'thread')!
    expect(thread).toMatchObject({
      id: 'abcdef0123456789',
      path: 'src/a.ts',
      line: 4,
      side: 'right',
      resolved: false,
    })
    expect(page.items.find((item) => item.kind === 'event')).toMatchObject({
      event: 'ready_for_review',
    })
    expect(page.items.find((item) => item.kind === 'commit')).toMatchObject({
      sha: HEAD,
      checks: 'success',
    })
  })

  test('checks read the head pipeline jobs, stage-qualified', async () => {
    const job = (id: number, status: string, extra: Record<string, unknown> = {}) => ({
      id: `gid://gitlab/Ci::Build/${id}`,
      name: `job-${id}`,
      status,
      allowFailure: false,
      startedAt: NOW,
      finishedAt: status === 'RUNNING' ? null : NOW,
      webPath: `/x/-/jobs/${id}`,
      failureMessage: null,
      stage: { name: 'test' },
      ...extra,
    })
    const { run, calls } = harness(
      baseResponder((path, call) => {
        if (path === 'graphql' && queryOf(call).includes('headPipeline { jobs'))
          return json({
            data: {
              project: {
                mergeRequest: {
                  diffHeadSha: HEAD,
                  headPipeline: {
                    jobs: {
                      nodes: [
                        job(1, 'SUCCESS'),
                        job(2, 'FAILED', { failureMessage: 'script failure' }),
                        job(3, 'FAILED', { allowFailure: true }),
                        job(4, 'RUNNING'),
                      ],
                    },
                  },
                },
              },
            },
          })
        return undefined
      })
    )
    const page = valueOf<{ items: Record<string, unknown>[] }>(
      await run('dev.gitlab.checks', { pullRequestId: MR_ID, sha: HEAD, limit: 100 })
    )
    expect(page.items.map((item) => [item.id, item.name, item.status, item.conclusion])).toEqual([
      ['1', 'test / job-1', 'completed', 'success'],
      ['2', 'test / job-2', 'completed', 'failure'],
      ['3', 'test / job-3', 'completed', 'neutral'],
      ['4', 'test / job-4', 'in_progress', undefined],
    ])
    expect(page.items[1]!.title).toBe('script failure')
    // The head SHA never falls through to another pipeline for the commit.
    expect(calls.some((call) => queryOf(call).includes('pipelines(sha'))).toBe(false)
  })

  test('job logs drop section markers and terminal escapes', async () => {
    const { run } = harness(
      baseResponder((path) =>
        path === `${ENCODED}/jobs/42/trace`
          ? {
              stdout:
                'section_start:1700000000:build_script\r\u001b[0K\u001b[32;1m$ make\u001b[0;m\nok\nsection_end:1700000001:build_script\r\u001b[0K',
            }
          : undefined
      )
    )
    const log = valueOf<{ text: string; truncated: boolean }>(
      await run('dev.gitlab.checkLog', { pullRequestId: MR_ID, checkId: '42' })
    )
    expect(log.text).not.toContain('\u001b')
    expect(log.text).not.toContain('section_')
    expect(log.text).toContain('$ make')
    expect(
      errorCode(await run('dev.gitlab.checkLog', { pullRequestId: MR_ID, checkId: '4;2' }))
    ).toBe('identity_mismatch')
  })

  test('diffs map to changed files with counted lines', async () => {
    const { run } = harness(
      baseResponder((path) =>
        path.startsWith(`${ENCODED}/merge_requests/7/diffs`)
          ? json([
              {
                old_path: 'a.ts',
                new_path: 'a.ts',
                diff: '@@ -1,2 +1,2 @@\n-a\n+b\n+c\n',
                new_file: false,
                deleted_file: false,
                renamed_file: false,
              },
              {
                old_path: 'old.ts',
                new_path: 'new.ts',
                diff: '',
                new_file: false,
                deleted_file: false,
                renamed_file: true,
              },
            ])
          : undefined
      )
    )
    const page = valueOf<{ items: Record<string, unknown>[] }>(
      await run('dev.gitlab.files', { pullRequestId: MR_ID, limit: 100 })
    )
    expect(page.items[0]).toMatchObject({
      path: 'a.ts',
      status: 'modified',
      additions: 2,
      deletions: 1,
    })
    expect(page.items[1]).toMatchObject({
      path: 'new.ts',
      previousPath: 'old.ts',
      status: 'renamed',
    })
  })
})

describe('merge request writes', () => {
  test('comments ride stdin, never argv', async () => {
    const secret = 'a comment with --hostname evil.example and $(rm -rf)'
    const { run, calls } = harness(
      baseResponder((path, call) =>
        path === `${ENCODED}/merge_requests/7/notes` && methodOf(call) === 'POST'
          ? json({
              id: 99,
              body: secret,
              created_at: NOW,
              author: { username: 'dana', bot: false },
            })
          : undefined
      )
    )
    const item = valueOf<{ kind: string; body: string }>(
      await run('dev.gitlab.comment', { pullRequestId: MR_ID, body: secret })
    )
    expect(item).toMatchObject({ kind: 'comment', body: secret })
    const post = calls.find((call) => call.args[1] === `${ENCODED}/merge_requests/7/notes`)!
    expect(post.args.join(' ')).not.toContain('evil.example')
    expect(bodyOf(post).body).toBe(secret)
  })

  test('reviews refuse request-changes and bind approval to the head', async () => {
    const { run, calls } = harness(
      baseResponder((path, call) => {
        if (path.endsWith('/approve') || path.endsWith('/discussions') || path.endsWith('/notes'))
          return methodOf(call) === 'POST' ? json({}) : undefined
        return undefined
      })
    )
    expect(
      errorCode(
        await run('dev.gitlab.submitReview', {
          pullRequestId: MR_ID,
          verdict: 'request_changes',
          body: 'No',
          expectedHeadSha: HEAD,
          comments: [],
        })
      )
    ).toBe('unsupported_capability')
    expect(
      errorCode(
        await run('dev.gitlab.submitReview', {
          pullRequestId: MR_ID,
          verdict: 'approve',
          body: '',
          expectedHeadSha: MOVED,
          comments: [],
        })
      )
    ).toBe('stale_version')
    const review = valueOf<{ state: string; author: { login: string } }>(
      await run('dev.gitlab.submitReview', {
        pullRequestId: MR_ID,
        verdict: 'approve',
        body: 'Ship it',
        expectedHeadSha: HEAD,
        comments: [{ path: 'src/a.ts', line: 4, side: 'right', body: 'nit' }],
      })
    )
    expect(review).toMatchObject({ state: 'approved', author: { login: 'dana' } })
    const approve = calls.find((call) => call.args[1]?.endsWith('/approve'))!
    expect(bodyOf(approve)).toEqual({ sha: HEAD })
    const inline = calls.find((call) => call.args[1]?.endsWith('/discussions'))!
    expect(bodyOf(inline).position).toMatchObject({
      head_sha: HEAD,
      base_sha: BASE,
      new_line: 4,
      new_path: 'src/a.ts',
    })
  })

  test('metadata updates resolve usernames and refuse team reviewers', async () => {
    const { run, calls } = harness(
      baseResponder((path, call) => {
        if (path.startsWith('users?username=octocat')) return json([{ id: 42 }])
        if (path === `${ENCODED}/merge_requests/7` && methodOf(call) === 'PUT')
          return json(mrRest())
        return undefined
      })
    )
    expect(
      errorCode(
        await run('dev.gitlab.metadataUpdate', {
          pullRequestId: MR_ID,
          reviewers: { add: ['acme/core'], remove: [] },
        })
      )
    ).toBe('unsupported_capability')
    valueOf(
      await run('dev.gitlab.metadataUpdate', {
        pullRequestId: MR_ID,
        reviewers: { add: ['octocat'], remove: [] },
        labels: { add: ['bug'], remove: ['area::frontend'] },
      })
    )
    const put = calls.find((call) => methodOf(call) === 'PUT')!
    expect(bodyOf(put)).toEqual({
      reviewer_ids: [41, 42],
      add_labels: 'bug',
      remove_labels: 'area::frontend',
    })
  })

  test('branch updates are rebase-only and re-prove the head', async () => {
    let head = HEAD
    const { run, calls } = harness(
      baseResponder((path, call) => {
        if (path === `${ENCODED}/merge_requests/7/rebase` && methodOf(call) === 'PUT')
          return json({ rebase_in_progress: true })
        if (path === `${ENCODED}/merge_requests/7` && methodOf(call) === 'GET')
          return json(mrRest({ sha: head }))
        return undefined
      })
    )
    const mergePlan = valueOf<Plan>(
      await run('dev.gitlab.syncBranchPlan', {
        pullRequestId: MR_ID,
        expectedHeadSha: HEAD,
        method: 'merge',
      })
    )
    expect(mergePlan.blockers.map((blocker) => blocker.code)).toContain('unsupported_capability')
    const plan = valueOf<Plan>(
      await run('dev.gitlab.syncBranchPlan', {
        pullRequestId: MR_ID,
        expectedHeadSha: HEAD,
        method: 'rebase',
      })
    )
    expect(plan.blockers).toEqual([])
    head = MOVED
    expect(
      errorCode(
        await run('dev.gitlab.syncBranchCommit', { planId: plan.id, planDigest: plan.digest })
      )
    ).toBe('stale_version')
    head = HEAD
    valueOf(await run('dev.gitlab.syncBranchCommit', { planId: plan.id, planDigest: plan.digest }))
    expect(calls.some((call) => call.args[1] === `${ENCODED}/merge_requests/7/rebase`)).toBe(true)
    expect(
      errorCode(
        await run('dev.gitlab.syncBranchCommit', { planId: plan.id, planDigest: plan.digest })
      )
    ).toBe('plan_stale')
  })

  test('merges bind the planned head and remove the source branch', async () => {
    const { run, calls } = harness(
      baseResponder(
        (path, call) => {
          if (path === 'graphql' && queryOf(call).includes('mergeRequest(iid'))
            return json({
              data: {
                project: {
                  mergeRequest: mrNode({
                    draft: false,
                    title: 'Add widget support',
                    detailedMergeStatus: 'MERGEABLE',
                    approvalsLeft: 0,
                    reviewers: { nodes: [] },
                    headPipeline: {
                      status: 'SUCCESS',
                      jobs: { nodes: [{ status: 'SUCCESS', allowFailure: false }] },
                    },
                  }),
                },
              },
            })
          if (path === `${ENCODED}/merge_requests/7/merge`) return json({ state: 'merged' })
          if (path.startsWith(`${ENCODED}/repository/branches/`))
            return { stderr: 'HTTP 404 Not Found', exitCode: 1 }
          return undefined
        },
        { draft: false, title: 'Add widget support' }
      )
    )
    const plan = valueOf<Plan>(
      await run('dev.gitlab.mergePlan', {
        pullRequestId: MR_ID,
        expectedHeadSha: HEAD,
        method: 'squash',
        deleteBranch: true,
      })
    )
    expect(plan.blockers).toEqual([])
    const merged = valueOf<{ headBranchDeleted?: boolean }>(
      await run('dev.gitlab.mergeCommit', { planId: plan.id, planDigest: plan.digest })
    )
    expect(merged.headBranchDeleted).toBe(true)
    const merge = calls.find((call) => call.args[1] === `${ENCODED}/merge_requests/7/merge`)!
    expect(bodyOf(merge)).toEqual({ sha: HEAD, squash: true, should_remove_source_branch: true })
  })

  test('merge plans surface blockers from the merge request state', async () => {
    const { run } = harness(baseResponder())
    expect(
      errorCode(
        await run('dev.gitlab.mergePlan', {
          pullRequestId: MR_ID,
          expectedHeadSha: HEAD,
          method: 'merge',
        })
      )
    ).toBe('invalid_state')
  })

  test('draft toggles travel through the title prefix', async () => {
    const { run, calls } = harness(
      baseResponder((path, call) =>
        path === `${ENCODED}/merge_requests/7` && methodOf(call) === 'PUT'
          ? json(mrRest({ title: 'Add widget support', draft: false }))
          : undefined
      )
    )
    const detail = valueOf<{ version: number; draft: boolean; title: string }>(
      await run('dev.gitlab.pullRequest', { pullRequestId: MR_ID })
    )
    expect(detail).toMatchObject({ draft: true, title: 'Add widget support' })
    const plan = valueOf<Plan>(
      await run('dev.gitlab.updatePlan', {
        pullRequestId: MR_ID,
        expectedVersion: detail.version,
        patch: { draft: false },
      })
    )
    const updated = valueOf<{ draft: boolean }>(
      await run('dev.gitlab.updateCommit', { planId: plan.id, planDigest: plan.digest })
    )
    expect(updated.draft).toBe(false)
    const put = calls.find((call) => methodOf(call) === 'PUT')!
    expect(bodyOf(put)).toEqual({ title: 'Add widget support' })
  })

  test('new merge requests open as drafts and reconcile an existing one', async () => {
    let existing: unknown[] = []
    const { run, calls } = harness(
      baseResponder((path, call) => {
        if (path.startsWith(`${ENCODED}/merge_requests?state=opened`)) return json(existing)
        if (path === `${ENCODED}/merge_requests` && methodOf(call) === 'POST') return json(mrRest())
        return undefined
      })
    )
    const body = {
      repoId: REPO_ID,
      headRef: 'agent/juno/widgets',
      baseRef: 'main',
      title: 'Add widget support',
      body: 'Body',
      draft: true,
    }
    const created = valueOf<{ reconciled?: boolean; draft: boolean; id: string }>(
      await run('dev.gitlab.createPullRequest', body)
    )
    expect(created).toMatchObject({ reconciled: false, draft: true, id: MR_ID })
    const post = calls.find((call) => methodOf(call) === 'POST')!
    expect(bodyOf(post).title).toBe('Draft: Add widget support')
    existing = [mrRest()]
    const again = valueOf<{ reconciled?: boolean }>(await run('dev.gitlab.createPullRequest', body))
    expect(again.reconciled).toBe(true)
    expect(calls.filter((call) => methodOf(call) === 'POST')).toHaveLength(1)
  })

  test('re-runs retry only pipelines of this merge request branch', async () => {
    const { run, calls } = harness(
      baseResponder((path, call) => {
        if (path === `${ENCODED}/jobs/5`)
          return json({ ref: 'agent/juno/widgets', pipeline: { id: 900 } })
        if (path === `${ENCODED}/jobs/6`) return json({ ref: 'main', pipeline: { id: 901 } })
        if (path === `${ENCODED}/pipelines/900/retry` && methodOf(call) === 'POST')
          return json({ id: 900 })
        return undefined
      })
    )
    expect(
      valueOf(await run('dev.gitlab.rerunFailedJobs', { pullRequestId: MR_ID, checkId: '5' }))
    ).toMatchObject({
      runId: '900',
    })
    expect(
      errorCode(await run('dev.gitlab.rerunFailedJobs', { pullRequestId: MR_ID, checkId: '6' }))
    ).toBe('identity_mismatch')
    expect(calls.some((call) => call.args[1] === `${ENCODED}/pipelines/901/retry`)).toBe(false)
  })

  test('thread replies are scoped to the merge request discussion', async () => {
    const discussion = {
      id: 'abcdef0123456789',
      notes: [
        {
          id: 1,
          body: 'Does this throw?',
          system: false,
          created_at: NOW,
          resolvable: true,
          resolved: false,
          author: { username: 'mika', name: 'Mika' },
          position: { new_path: 'src/a.ts', old_path: 'src/a.ts', new_line: 4, old_line: null },
        },
      ],
    }
    const { run, calls } = harness(
      baseResponder((path, call) => {
        if (path === `${ENCODED}/merge_requests/7/discussions/abcdef0123456789`)
          return methodOf(call) === 'GET' ? json(discussion) : json({})
        if (path === `${ENCODED}/merge_requests/7/discussions/abcdef0123456789/notes`)
          return json({})
        return undefined
      })
    )
    const thread = valueOf<{ kind: string; path: string }>(
      await run('dev.gitlab.threadReply', {
        pullRequestId: MR_ID,
        threadId: 'abcdef0123456789',
        body: 'No',
      })
    )
    expect(thread).toMatchObject({ kind: 'thread', path: 'src/a.ts' })
    expect(
      errorCode(
        await run('dev.gitlab.threadReply', {
          pullRequestId: MR_ID,
          threadId: 'fedcba9876543210',
          body: 'No',
        })
      )
    ).toBe('not_found')
    expect(calls.some((call) => call.args[1]?.includes('fedcba9876543210/notes'))).toBe(false)
  })
})
