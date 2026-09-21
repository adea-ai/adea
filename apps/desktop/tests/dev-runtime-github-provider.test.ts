// #423 GitHub remote source-control provider acceptance. Everything runs on
// scripted `gh` transports and disposable local repositories — no network:
// pushes go through `url.<base>.insteadOf` rewrites onto a local bare remote,
// and gh JSON arrives from in-process fixtures treated as untrusted input.
// Covers typed-unavailable (gh absent / unauthenticated), stale-cache falls
// back on rate limits, plan/commit fencing negatives for push / PR update /
// merge / update-branch, the force-with-lease flow, PR-create reconciliation,
// and token redaction on every error surface.
import { createHmac, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
  type FileIdentity,
  type Scope,
} from '../../../packages/types/src/dev-runtime'

import { createChannelAuthority } from '../shell/src/dev-runtime/channel/authority'
import {
  parseGitHubRemote,
  redactCredentials,
  registerGithubRuntime,
  type GhRunner,
} from '../shell/src/dev-runtime/github/register'
import { directoryIdentity } from '../shell/src/dev-runtime/worktrees/identity'
import { git, initRepo, scope } from './worktree-fixtures'

const REPO_ID = '00000000-0000-4000-8000-00000000repo'
const WORKTREE_ID = 'wt-github-fixture-01'
const GENERATION = 2

// ─── scripted gh transport ──────────────────────────────────────────────────

type GhCall = readonly string[]
type GhResponse = { stdout?: string; exitCode?: number; stderr?: string }

/** A scripted gh: matches on the api PATH argument, records every call, and
 *  lets each test mutate its canned responses between steps. */
function ghFixture(respond: (path: string, args: GhCall) => GhResponse): {
  runner: GhRunner
  calls: GhCall[]
} {
  const calls: GhCall[] = []
  const runner: GhRunner = async (args) => {
    calls.push(args)
    const path = args[1] ?? ''
    const result = respond(path, args)
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: result.exitCode ?? 0,
    }
  }
  return { runner, calls }
}

const ACCOUNT_JSON = JSON.stringify({
  login: 'octocat',
  name: 'The Octocat',
  html_url: 'https://github.com/octocat',
})

const REPO_JSON = JSON.stringify({
  id: 1001,
  name: 'widgets',
  owner: { login: 'acme' },
  default_branch: 'main',
  html_url: 'https://github.com/acme/widgets',
  private: false,
  fork: false,
})

function prJson(options: {
  headSha: string
  baseSha: string
  updatedAt?: string
  headRef?: string
  baseRef?: string
  draft?: boolean
  mergeable?: boolean | null
  number?: number
}): string {
  return JSON.stringify({
    number: options.number ?? 7,
    title: 'Add widget support',
    body: 'Implements widgets',
    state: 'open',
    draft: options.draft ?? false,
    merged: false,
    user: { login: 'octocat' },
    head: {
      ref: options.headRef ?? 'feat/widgets',
      sha: options.headSha,
      repo: { name: 'widgets', owner: { login: 'acme' } },
    },
    base: {
      ref: options.baseRef ?? 'main',
      sha: options.baseSha,
      repo: { name: 'widgets', owner: { login: 'acme' } },
    },
    html_url: 'https://github.com/acme/widgets/pull/7',
    mergeable: options.mergeable ?? true,
    updated_at: options.updatedAt ?? '2026-09-01T10:00:00Z',
    labels: [{ name: 'area:frontend' }],
  })
}

const COMPARE_JSON = JSON.stringify({ ahead_by: 1, behind_by: 2 })
const REVIEWS_JSON = JSON.stringify([
  { user: { login: 'reviewer' }, state: 'APPROVED' },
  { user: { login: 'other' }, state: 'COMMENTED' },
])
const CHECK_RUNS_JSON = JSON.stringify({
  total_count: 2,
  check_runs: [
    {
      id: 11,
      name: 'build',
      status: 'in_progress',
      started_at: '2026-09-01T10:05:00Z',
    },
    {
      id: 9,
      name: 'lint',
      status: 'completed',
      conclusion: 'success',
      details_url: 'https://github.com/acme/widgets/actions/runs/9',
      started_at: '2026-09-01T10:04:00Z',
      completed_at: '2026-09-01T10:05:00Z',
    },
  ],
})

// ─── disposable repository fixture ─────────────────────────────────────────

type Fixture = {
  root: string
  repoPath: string
  barePath: string
  rootIdentity: FileIdentity
  headSha: () => string
  bareSha: (ref: string) => string
  cleanup(): void
}

/** A local checkout whose `origin` is a github.com URL rewritten through
 *  `insteadOf` onto a local bare repository: the provider sees a real GitHub
 *  remote and parses it, while git transport stays entirely offline. */
function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'adea-githubprov-'))
  const acmeDir = join(root, 'acme')
  mkdirSync(acmeDir, { recursive: true })
  const barePath = initRepo(join(acmeDir, 'widgets.git'), { bare: true })
  const repoPath = realpathSync(initRepo(join(root, 'checkout')))
  git(repoPath, ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git'])
  git(repoPath, ['config', `url.${acmeDir}/.insteadOf`, 'https://github.com/acme/'])
  // Publish main to the bare origin BEFORE branching: the GitHub fixture's
  // PR base sha must resolve locally and in the bare repo.
  git(repoPath, ['push', '-q', 'origin', 'main'])
  git(repoPath, ['checkout', '-q', '-b', 'feat/widgets'])
  writeFileSync(join(repoPath, 'feature.txt'), 'feature work\n')
  git(repoPath, ['add', 'feature.txt'])
  git(repoPath, ['commit', '-q', '-m', 'feat: widget support'])
  return {
    root,
    repoPath,
    barePath,
    rootIdentity: { ...directoryIdentity(repoPath).identity } as FileIdentity,
    headSha: () => git(repoPath, ['rev-parse', 'HEAD']).stdout.trim(),
    bareSha: (ref: string) => git(barePath, ['rev-parse', ref]).stdout.trim(),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

// ─── channel harness (same as the #399 git provider suite) ─────────────────

function runtimeFor(fixture: Fixture, runGh: GhRunner) {
  const authority = createChannelAuthority({
    shellHost: '127.0.0.1',
    shellOrigin: 'https://127.0.0.1:4789',
  })
  const registered = registerGithubRuntime({
    authority,
    scope,
    resolveRepo: (repoId) =>
      repoId === REPO_ID
        ? {
            repoId,
            canonicalRoot: fixture.repoPath,
            remote: 'https://github.com/acme/widgets.git',
            defaultBranch: 'main',
          }
        : undefined,
    listRepos: () => [
      {
        repoId: REPO_ID,
        canonicalRoot: fixture.repoPath,
        remote: 'https://github.com/acme/widgets.git',
        defaultBranch: 'main',
      },
    ],
    resolveWorktree: (worktreeId) =>
      worktreeId === WORKTREE_ID
        ? {
            canonicalRoot: fixture.repoPath,
            rootIdentity: fixture.rootIdentity,
            generation: GENERATION,
            lifecycle: 'ready',
            repoId: REPO_ID,
          }
        : undefined,
    runGh,
  })
  return { authority, registered }
}

function handshakeChannel(authority: ReturnType<typeof createChannelAuthority>) {
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
  return {
    identity: {
      channelId: handshake.channelId,
      clientCredentialId: handshake.clientCredentialId,
    },
    secret,
  }
}

function makeCommand(
  operation: DevOperation,
  body: Record<string, unknown>,
  resource?: { kind: string; id: string; generation: number }
): DevCommand {
  const definition = devOperationDefinitions[operation]
  const capabilities = [...definition.capabilities].toSorted((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  )
  return {
    schemaVersion: 1,
    operation,
    requestId: '00000000-0000-4000-8000-000000000031',
    nonce: Buffer.from(randomBytes(16)).toString('base64url'),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    scope,
    capabilities,
    resource,
    body,
  }
}

async function execute(
  channel: ReturnType<typeof handshakeChannel>,
  authority: ReturnType<typeof createChannelAuthority>,
  command: DevCommand
): Promise<DevReply> {
  const proof = createHmac('sha256', channel.secret)
    .update(
      devCommandProofMessage({
        channelId: channel.identity.channelId,
        clientCredentialId: channel.identity.clientCredentialId,
        command,
      }),
      'utf8'
    )
    .digest('base64url')
  const reply = await authority.execute(
    {
      channelId: channel.identity.channelId,
      clientCredentialId: channel.identity.clientCredentialId,
      command,
      proof,
    },
    { trusted: true }
  )
  if (!reply.ok) console.log('[DBG-REPLY]', command.operation, JSON.stringify(reply.error))
  return reply
}

function repoResource(): { kind: string; id: string; generation: number } {
  return { kind: 'repository', id: REPO_ID, generation: 0 }
}

const fixtures: Fixture[] = []
afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.cleanup()
})

// ─── suites ──────────────────────────────────────────────────────────────────

describe('github remote provider', () => {
  test('registers exactly the github operations', () => {
    const fixture = makeFixture()
    fixtures.push(fixture)
    const { runner } = ghFixture(() => ({}))
    const { registered } = runtimeFor(fixture, runner)
    expect(registered.commands.toSorted()).toEqual(
      [
        'dev.github.account',
        'dev.github.checks',
        'dev.github.createPullRequest',
        'dev.github.issues',
        'dev.github.mergeCommit',
        'dev.github.mergePlan',
        'dev.github.milestones',
        'dev.github.pullRequest',
        'dev.github.pullRequests',
        'dev.github.pushCommit',
        'dev.github.pushPlan',
        'dev.github.repository',
        'dev.github.updateBranchCommit',
        'dev.github.updateBranchPlan',
        'dev.github.updateCommit',
        'dev.github.updatePlan',
      ].toSorted()
    )
    expect(registered.registeredCommands).toBe(16)
  })

  test('account read decodes gh JSON strictly through the channel', async () => {
    const fixture = makeFixture()
    fixtures.push(fixture)
    const { runner, calls } = ghFixture((path) =>
      path === 'user' ? { stdout: ACCOUNT_JSON } : { exitCode: 1, stderr: 'unexpected' }
    )
    const { authority } = runtimeFor(fixture, runner)
    const channel = handshakeChannel(authority)
    const reply = await execute(channel, authority, makeCommand('dev.github.account', {}))
    expect(reply.ok).toBe(true)
    if (!reply.ok) return
    expect(reply.value).toMatchObject({
      provider: 'github',
      host: 'github.com',
      login: 'octocat',
      name: 'The Octocat',
    })
    // gh was invoked with the explicit host flag and api path only.
    expect(calls[0]?.slice(0, 2)).toEqual(['api', 'user'])
    expect(calls[0]).toContain('--hostname')
    devOperationDecoders['dev.github.account'].reply({
      schemaVersion: 1,
      operation: 'dev.github.account',
      requestId: reply.requestId,
      ok: true,
      value: reply.value,
      observedAt: reply.observedAt,
    })
  })

  test('gh absence and unauthenticated gh resolve typed, retryable refusals', async () => {
    const fixture = makeFixture()
    fixtures.push(fixture)
    // A runner that models a missing binary exactly like the default one does.
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- fixture intentionally models a stable absent binary
    const absent: GhRunner = async () => ({
      stdout: '',
      stderr: 'spawn gh ENOENT',
      exitCode: 127,
      spawnCode: 'capability_unavailable' as const,
    })
    const absentAuthority = createChannelAuthority({
      shellHost: '127.0.0.1',
      shellOrigin: 'https://127.0.0.1:4789',
    })
    registerGithubRuntime({
      authority: absentAuthority,
      scope,
      resolveRepo: () => undefined,
      listRepos: () => [],
      resolveWorktree: () => undefined,
      runGh: absent,
    })
    const absentChannel = handshakeChannel(absentAuthority)
    const absentReply = await execute(
      absentChannel,
      absentAuthority,
      makeCommand('dev.github.account', {})
    )
    expect(absentReply).toMatchObject({
      ok: false,
      error: { code: 'capability_unavailable' },
    })

    const { runner } = ghFixture(() => ({ exitCode: 4, stderr: 'gh auth login required' }))
    const { authority } = runtimeFor(fixture, runner)
    const channel = handshakeChannel(authority)
    const refused = await execute(channel, authority, makeCommand('dev.github.account', {}))
    expect(refused).toMatchObject({ ok: false, error: { code: 'unauthenticated' } })
  })

  test('error surfaces never leak embedded credentials', async () => {
    const fixture = makeFixture()
    fixtures.push(fixture)
    // The transport echoes a credential-bearing URL in its stderr; the typed
    // error must redact it before it reaches the channel reply.
    const { runner } = ghFixture(() => ({
      exitCode: 1,
      stderr: 'fatal: unable to access https://ci-bot:ghp_supersecret@github.com/acme/widgets.git/',
    }))
    const { authority } = runtimeFor(fixture, runner)
    const channel = handshakeChannel(authority)
    const reply = await execute(channel, authority, makeCommand('dev.github.account', {}))
    expect(reply.ok).toBe(false)
    if (reply.ok) return
    expect(reply.error.message).toContain('<redacted>@')
    expect(reply.error.message).not.toContain('ghp_supersecret')
    expect(redactCredentials('ssh://deploy:tick%77et@builds.local/acme.git')).toBe(
      'ssh://<redacted>@builds.local/acme.git'
    )
  })

  test('repository resolves the origin remote and serves stale on rate limits', async () => {
    const fixture = makeFixture()
    fixtures.push(fixture)
    let healthy = true
    const { runner } = ghFixture((path) => {
      if (path !== 'repos/acme/widgets') return { exitCode: 1, stderr: 'unexpected' }
      if (healthy) return { stdout: REPO_JSON }
      return { exitCode: 1, stderr: 'API rate limit exceeded for installation' }
    })
    const { authority } = runtimeFor(fixture, runner)
    const channel = handshakeChannel(authority)
    const fresh = await execute(
      channel,
      authority,
      makeCommand('dev.github.repository', { repoId: REPO_ID }, repoResource())
    )
    expect(fresh.ok).toBe(true)
    if (!fresh.ok) return
    expect(fresh.value).toMatchObject({
      repoId: REPO_ID,
      owner: 'acme',
      name: 'widgets',
      defaultBranch: 'main',
      freshness: 'fresh',
    })

    // Rate-limited re-read: the last known read model is served stale, never
    // fabricated, and the failure is never reported as a fresh answer.
    healthy = false
    const stale = await execute(
      channel,
      authority,
      makeCommand('dev.github.repository', { repoId: REPO_ID }, repoResource())
    )
    expect(stale.ok).toBe(true)
    if (stale.ok) expect(stale.value.freshness).toBe('stale')

    // A repository that is not registered fails typed, before any gh call.
    const unknown = await execute(
      channel,
      authority,
      makeCommand(
        'dev.github.repository',
        { repoId: '00000000-0000-4000-8000-00000000zed0' },
        { kind: 'repository', id: '00000000-0000-4000-8000-00000000zed0', generation: 0 }
      )
    )
    expect(unknown).toMatchObject({ ok: false, error: { code: 'not_found' } })
  })

  test('pull request read model decorates compare and reviews, then bumps version on change', async () => {
    const fixture = makeFixture()
    fixtures.push(fixture)
    const headSha = fixture.headSha()
    let updatedAt = '2026-09-01T10:00:00Z'
    let baseSha = headSha
    const { runner, calls } = ghFixture((path) => {
      if (path === `repos/acme/widgets/pulls/7`)
        return {
          stdout: prJson({ headSha, baseSha, updatedAt }),
        }
      if (path.startsWith('repos/acme/widgets/compare/main...')) return { stdout: COMPARE_JSON }
      if (path === 'repos/acme/widgets/pulls/7/reviews?per_page=100')
        return { stdout: REVIEWS_JSON }
      return { exitCode: 1, stderr: 'unexpected' }
    })
    const { authority } = runtimeFor(fixture, runner)
    const channel = handshakeChannel(authority)
    const prId = 'gh:acme/widgets#7'
    const read = await execute(
      channel,
      authority,
      makeCommand(
        'dev.github.pullRequest',
        { pullRequestId: prId },
        { kind: 'pull_request', id: prId, generation: 0 }
      )
    )
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.value).toMatchObject({
      id: prId,
      repoId: REPO_ID,
      number: 7,
      state: 'open',
      draft: false,
      headSha,
      mergeable: 'mergeable',
      reviewDecision: 'approved',
      aheadBehind: { ahead: 1, behind: 2 },
      labels: ['area:frontend'],
      version: 1,
    })
    devOperationDecoders['dev.github.pullRequest'].reply({
      schemaVersion: 1,
      operation: 'dev.github.pullRequest',
      requestId: read.requestId,
      ok: true,
      value: read.value,
      observedAt: read.observedAt,
    })

    // Server truth moves: the local version token bumps on refresh.
    updatedAt = '2026-09-02T11:00:00Z'
    const refreshed = await execute(
      channel,
      authority,
      makeCommand(
        'dev.github.pullRequest',
        { pullRequestId: prId, refresh: true },
        { kind: 'pull_request', id: prId, generation: 0 }
      )
    )
    expect(refreshed.ok).toBe(true)
    if (refreshed.ok) expect(refreshed.value.version).toBe(2)

    // Malformed provider payloads fail closed as corrupt_state.
    const { runner: badRunner } = ghFixture(() => ({
      stdout: JSON.stringify({ number: 'seven', unexpected: true }),
    }))
    const badAuthority = createChannelAuthority({
      shellHost: '127.0.0.1',
      shellOrigin: 'https://127.0.0.1:4789',
    })
    registerGithubRuntime({
      authority: badAuthority,
      scope,
      resolveRepo: () => undefined,
      listRepos: () => [],
      resolveWorktree: () => undefined,
      runGh: badRunner,
    })
    const badChannel = handshakeChannel(badAuthority)
    const corrupt = await execute(
      badChannel,
      badAuthority,
      makeCommand(
        'dev.github.pullRequest',
        { pullRequestId: prId },
        { kind: 'pull_request', id: prId, generation: 0 }
      )
    )
    expect(corrupt).toMatchObject({ ok: false, error: { code: 'corrupt_state' } })
    void baseSha
    void calls
  })

  test('checks page comes from the PR head and decodes strictly', async () => {
    const fixture = makeFixture()
    fixtures.push(fixture)
    const headSha = fixture.headSha()
    const { runner } = ghFixture((path) => {
      if (path === 'repos/acme/widgets/pulls/7')
        return { stdout: prJson({ headSha, baseSha: headSha }) }
      if (path === `repos/acme/widgets/commits/${headSha}/check-runs?per_page=100`)
        return { stdout: CHECK_RUNS_JSON }
      return { exitCode: 1, stderr: 'unexpected' }
    })
    const { authority } = runtimeFor(fixture, runner)
    const channel = handshakeChannel(authority)
    const prId = 'gh:acme/widgets#7'
    const reply = await execute(
      channel,
      authority,
      makeCommand(
        'dev.github.checks',
        { pullRequestId: prId, limit: 100 },
        { kind: 'pull_request', id: prId, generation: 0 }
      )
    )
    expect(reply.ok).toBe(true)
    if (!reply.ok) return
    expect(reply.value.items.map((check: { name: string }) => check.name)).toEqual([
      'build',
      'lint',
    ])
    expect(reply.value.items[1]).toMatchObject({ status: 'completed', conclusion: 'success' })
    devOperationDecoders['dev.github.checks'].reply({
      schemaVersion: 1,
      operation: 'dev.github.checks',
      requestId: reply.requestId,
      ok: true,
      value: reply.value,
      observedAt: reply.observedAt,
    })
  })

  test('issues and milestones decode and the issues page excludes pull requests', async () => {
    const fixture = makeFixture()
    fixtures.push(fixture)
    const issuesJson = JSON.stringify([
      {
        number: 423,
        title: 'GitHub source control',
        state: 'open',
        html_url: 'https://github.com/acme/widgets/issues/423',
        labels: [{ name: 'type:feature' }],
        updated_at: '2026-09-01T09:00:00Z',
      },
      {
        number: 400,
        title: 'A pull request, not an issue',
        state: 'open',
        html_url: 'https://github.com/acme/widgets/pull/400',
        labels: [],
        updated_at: '2026-09-01T09:00:00Z',
        pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/400' },
      },
    ])
    const milestonesJson = JSON.stringify([
      {
        number: 12,
        title: 'M12 — Daily Driver',
        state: 'open',
        open_issues: 3,
        closed_issues: 9,
        html_url: 'https://github.com/acme/widgets/milestone/12',
        due_on: '2026-12-31T00:00:00Z',
      },
    ])
    const { runner } = ghFixture((path) => {
      if (path.startsWith('repos/acme/widgets/issues?')) return { stdout: issuesJson }
      if (path.startsWith('repos/acme/widgets/milestones?')) return { stdout: milestonesJson }
      return { exitCode: 1, stderr: 'unexpected' }
    })
    const { authority } = runtimeFor(fixture, runner)
    const channel = handshakeChannel(authority)
    const issues = await execute(
      channel,
      authority,
      makeCommand('dev.github.issues', { repoId: REPO_ID }, repoResource())
    )
    expect(issues.ok).toBe(true)
    if (issues.ok)
      expect(issues.value.items.map((issue: { number: number }) => issue.number)).toEqual([423])
    const milestones = await execute(
      channel,
      authority,
      makeCommand('dev.github.milestones', { repoId: REPO_ID }, repoResource())
    )
    expect(milestones.ok).toBe(true)
    if (milestones.ok) {
      expect(milestones.value.items[0]).toMatchObject({ id: 'ghm:acme/widgets#12', number: 12 })
    }
  })

  test('push is a plan/commit pair that pushes the planned sha from the canonical root', async () => {
    const fixture = makeFixture()
    fixtures.push(fixture)
    let respondNotFound = false
    const { runner, calls } = ghFixture((path) => {
      if (path === 'repos/acme/widgets') return { stdout: REPO_JSON }
      return { exitCode: 1, stderr: respondNotFound ? 'not found' : 'unexpected' }
    })
    const { authority } = runtimeFor(fixture, runner)
    const channel = handshakeChannel(authority)
    const headSha = fixture.headSha()

    // Stale expected sha refuses at plan time with no side effect.
    const stalePlan = await execute(
      channel,
      authority,
      makeCommand(
        'dev.github.pushPlan',
        {
          repoId: REPO_ID,
          worktreeId: WORKTREE_ID,
          ref: 'feat/widgets',
          expectedLocalSha: 'f'.repeat(40),
        },
        repoResource()
      )
    )
    expect(stalePlan).toMatchObject({ ok: false, error: { code: 'stale_version' } })

    const plan = await execute(
      channel,
      authority,
      makeCommand(
        'dev.github.pushPlan',
        {
          repoId: REPO_ID,
          worktreeId: WORKTREE_ID,
          ref: 'feat/widgets',
          expectedLocalSha: headSha,
        },
        repoResource()
      )
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.blockers).toHaveLength(0)
    expect(plan.value.factVersions.localSha).toBe(headSha)
    // The plan resource pins the repository at the worktree's bound generation.
    expect(plan.value.resource).toEqual({ kind: 'repository', id: REPO_ID, generation: GENERATION })

    // A foreign repository resource cannot drive the plan's commit.
    const foreign = await execute(
      channel,
      authority,
      makeCommand(
        'dev.github.pushCommit',
        { planId: plan.value.id, planDigest: plan.value.digest },
        { kind: 'repository', id: '00000000-0000-4000-8000-00000000xrep', generation: 0 }
      )
    )
    expect(foreign).toMatchObject({ ok: false, error: { code: 'identity_mismatch' } })

    // Digest mismatch refuses before any push.
    const wrongDigest = await execute(
      channel,
      authority,
      makeCommand(
        'dev.github.pushCommit',
        { planId: plan.value.id, planDigest: 'a'.repeat(64) },
        repoResource()
      )
    )
    expect(wrongDigest).toMatchObject({ ok: false, error: { code: 'plan_stale' } })

    const push = await execute(
      channel,
      authority,
      makeCommand(
        'dev.github.pushCommit',
        { planId: plan.value.id, planDigest: plan.value.digest },
        repoResource()
      )
    )
    expect(push.ok).toBe(true)
    if (!push.ok) return
    expect(push.value).toMatchObject({
      repoId: REPO_ID,
      ref: 'feat/widgets',
      headSha,
      remoteSha: headSha,
      forced: false,
      upstreamSet: true,
    })
    // Server truth was re-read: the bare remote really holds the branch.
    expect(fixture.bareSha('refs/heads/feat/widgets')).toBe(headSha)

    // Consuming the plan twice refuses (single-use plans).
    const replay = await execute(
      channel,
      authority,
      makeCommand(
        'dev.github.pushCommit',
        { planId: plan.value.id, planDigest: plan.value.digest },
        repoResource()
      )
    )
    expect(replay).toMatchObject({ ok: false, error: { code: 'plan_stale' } })
    void respondNotFound
    void calls
  })

  test('push predicts non-fast-forward, and force requires lease, confirmation-free sha match, and refuses protected branches', async () => {
    const fixture = makeFixture()
    fixtures.push(fixture)
    const { runner } = ghFixture(() => ({}))
    const { authority } = runtimeFor(fixture, runner)
    const channel = handshakeChannel(authority)
    const headSha = fixture.headSha()

    // Land the branch remotely, then rewrite local history to diverge.
    git(fixture.repoPath, ['push', '-q', 'origin', 'feat/widgets'])
    const remoteSha = fixture.bareSha('refs/heads/feat/widgets')
    git(fixture.repoPath, ['commit', '-q', '--amend', '-m', 'feat: rewritten'])
    const rewrittenSha = fixture.headSha()

    const plan = await execute(
      channel,
      authority,
      makeCommand(
        'dev.github.pushPlan',
        {
          repoId: REPO_ID,
          worktreeId: WORKTREE_ID,
          ref: 'feat/widgets',
          expectedLocalSha: rewrittenSha,
        },
        repoResource()
      )
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.blockers).toHaveLength(1)
    expect(plan.value.blockers[0].code).toBe('remote_changed')

    // Plain commit against a moved remote is rejected by the transport and
    // mapped to remote_changed, never reported as success.
    const plain = await execute(
      channel,
      authority,
      makeCommand(
        'dev.github.pushCommit',
        { planId: plan.value.id, planDigest: plan.value.digest },
        repoResource()
      )
    )
    expect(plain.ok).toBe(false)
    if (!plain.ok) expect(plain.error.code).toBe('remote_changed')

    // Force on the default branch is refused outright.
    git(fixture.repoPath, ['checkout', '-q', 'main'])
    const mainSha = fixture.headSha()
    const protectedPlan = await execute(
      channel,
      authority,
      makeCommand(
        'dev.github.pushPlan',
        {
          repoId: REPO_ID,
          worktreeId: WORKTREE_ID,
          ref: 'main',
          expectedLocalSha: mainSha,
          forceWithLease: { expectedRemoteSha: remoteSha },
        },
        repoResource()
      )
    )
    expect(protectedPlan).toMatchObject({ ok: false, error: { code: 'force_push_denied' } })
    git(fixture.repoPath, ['checkout', '-q', 'feat/widgets'])

    // Stale lease sha refuses at plan time.
    const staleLease = await execute(
      channel,
      authority,
      makeCommand(
        'dev.github.pushPlan',
        {
          repoId: REPO_ID,
          worktreeId: WORKTREE_ID,
          ref: 'feat/widgets',
          expectedLocalSha: rewrittenSha,
          forceWithLease: { expectedRemoteSha: 'a'.repeat(40) },
        },
        repoResource()
      )
    )
    expect(staleLease).toMatchObject({ ok: false, error: { code: 'stale_version' } })

    // The force-with-lease flow pushes with the exact expected remote sha.
    const forcePlan = await execute(
      channel,
      authority,
      makeCommand(
        'dev.github.pushPlan',
        {
          repoId: REPO_ID,
          worktreeId: WORKTREE_ID,
          ref: 'feat/widgets',
          expectedLocalSha: rewrittenSha,
          forceWithLease: { expectedRemoteSha: remoteSha },
        },
        repoResource()
      )
    )
    expect(forcePlan.ok).toBe(true)
    if (!forcePlan.ok) return
    const forced = await execute(
      channel,
      authority,
      makeCommand(
        'dev.github.pushCommit',
        { planId: forcePlan.value.id, planDigest: forcePlan.value.digest },
        repoResource()
      )
    )
    expect(forced.ok).toBe(true)
    if (forced.ok) {
      expect(forced.value.forced).toBe(true)
      expect(forced.value.remoteSha).toBe(rewrittenSha)
    }
    expect(fixture.bareSha('refs/heads/feat/widgets')).toBe(rewrittenSha)
    void headSha
  })

  test('createPullRequest reconciles duplicates and creates draft by default', async () => {
    const fixture = makeFixture()
    fixtures.push(fixture)
    const headSha = fixture.headSha()
    let searchResult: unknown = []
    let createCalls = 0
    const { runner, calls } = ghFixture((path, args) => {
      if (path.includes('/pulls?head=acme%3Afeat%2Fwidgets&base=main&state=open'))
        return { stdout: JSON.stringify(searchResult) }
      if (path === 'repos/acme/widgets/pulls' && args.includes('POST')) {
        createCalls += 1
        return { stdout: prJson({ headSha, baseSha: headSha, draft: true }) }
      }
      return { exitCode: 1, stderr: 'unexpected' }
    })
    const { authority } = runtimeFor(fixture, runner)
    const channel = handshakeChannel(authority)
    const body = {
      repoId: REPO_ID,
      headRef: 'feat/widgets',
      baseRef: 'main',
      title: 'Add widget support',
      body: 'Implements widgets',
      draft: true,
    }
    const created = await execute(
      channel,
      authority,
      makeCommand('dev.github.createPullRequest', body, repoResource())
    )
    expect(created.ok).toBe(true)
    if (created.ok) {
      expect(created.value.reconciled).toBe(false)
      expect(created.value.draft).toBe(true)
    }
    expect(createCalls).toBe(1)
    // The create arguments carry the draft flag and the field values; never a token.
    const post = calls.find((call) => call.includes('POST'))
    expect(post).toBeDefined()
    expect(post).toContain('-F')
    expect(post).toContain('draft=true')

    // An open PR for the same head/base reconciles instead of duplicating.
    searchResult = [JSON.parse(prJson({ headSha, baseSha: headSha }))]
    const reconciled = await execute(
      channel,
      authority,
      makeCommand('dev.github.createPullRequest', body, repoResource())
    )
    expect(reconciled.ok).toBe(true)
    if (reconciled.ok) expect(reconciled.value.reconciled).toBe(true)
    expect(createCalls).toBe(1)

    // Ambiguous delivery: the create timed out, the re-search found the PR.
    searchResult = []
    let failCreateOnce = true
    const { runner: retryRunner } = ghFixture((path, args) => {
      if (path.includes('/pulls?head=acme%3Afeat%2Fwidgets&base=main&state=open'))
        return { stdout: JSON.stringify(searchResult) }
      if (path === 'repos/acme/widgets/pulls' && args.includes('POST')) {
        if (failCreateOnce) {
          failCreateOnce = false
          return { exitCode: 1, stderr: 'context deadline exceeded' }
        }
        createCalls += 1
        return { stdout: prJson({ headSha, baseSha: headSha }) }
      }
      return { exitCode: 1, stderr: 'unexpected' }
    })
    const retryAuthority = createChannelAuthority({
      shellHost: '127.0.0.1',
      shellOrigin: 'https://127.0.0.1:4789',
    })
    registerGithubRuntime({
      authority: retryAuthority,
      scope,
      resolveRepo: (repoId) =>
        repoId === REPO_ID
          ? { repoId, canonicalRoot: fixture.repoPath, defaultBranch: 'main' }
          : undefined,
      listRepos: () => [],
      resolveWorktree: () => undefined,
      runGh: retryRunner,
    })
    const retryChannel = handshakeChannel(retryAuthority)
    searchResult = [JSON.parse(prJson({ headSha, baseSha: headSha }))]
    const recovered = await execute(
      retryChannel,
      retryAuthority,
      makeCommand('dev.github.createPullRequest', body, repoResource())
    )
    expect(recovered.ok).toBe(true)
    if (recovered.ok) expect(recovered.value.reconciled).toBe(true)
  })

  test('PR update is a versioned plan/commit pair that refuses drifted server truth', async () => {
    const fixture = makeFixture()
    fixtures.push(fixture)
    const headSha = fixture.headSha()
    let updatedAt = '2026-09-01T10:00:00Z'
    let patchedTitle: string | undefined
    const { runner } = ghFixture((path, args) => {
      if (path === 'repos/acme/widgets/pulls/7') {
        if (args.includes('PATCH')) {
          patchedTitle = args.find((arg) => arg.startsWith('title='))?.slice('title='.length)
          updatedAt = '2026-09-03T12:00:00Z'
        }
        return { stdout: prJson({ headSha, baseSha: headSha, updatedAt }) }
      }
      if (path.startsWith('repos/acme/widgets/compare/')) return { stdout: COMPARE_JSON }
      if (path.endsWith('/reviews?per_page=100')) return { stdout: '[]' }
      return { exitCode: 1, stderr: 'unexpected' }
    })
    const { authority } = runtimeFor(fixture, runner)
    const channel = handshakeChannel(authority)
    const prId = 'gh:acme/widgets#7'
    const resource = { kind: 'pull_request', id: prId, generation: GENERATION }

    const wrongVersion = await execute(
      channel,
      authority,
      makeCommand(
        'dev.github.updatePlan',
        { pullRequestId: prId, expectedVersion: 99, patch: { title: 'New title' } },
        resource
      )
    )
    expect(wrongVersion).toMatchObject({ ok: false, error: { code: 'stale_version' } })

    const plan = await execute(
      channel,
      authority,
      makeCommand(
        'dev.github.updatePlan',
        { pullRequestId: prId, expectedVersion: 1, patch: { title: 'New title' } },
        resource
      )
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return

    // Server truth moved after the plan: the commit refuses.
    updatedAt = '2026-09-02T11:00:00Z'
    const drifted = await execute(
      channel,
      authority,
      makeCommand(
        'dev.github.updateCommit',
        { planId: plan.value.id, planDigest: plan.value.digest },
        resource
      )
    )
    expect(drifted).toMatchObject({ ok: false, error: { code: 'stale_version' } })

    // Back to the planned state: the commit applies and re-reads server truth.
    updatedAt = '2026-09-01T10:00:00Z'
    const applied = await execute(
      channel,
      authority,
      makeCommand(
        'dev.github.updateCommit',
        { planId: plan.value.id, planDigest: plan.value.digest },
        resource
      )
    )
    expect(applied.ok).toBe(true)
    if (applied.ok) expect(applied.value.title).toBe('Add widget support')
    expect(patchedTitle).toBe('New title')
  })

  test('merge plan refuses drafts and head drift; the commit passes the sha guard', async () => {
    const fixture = makeFixture()
    fixtures.push(fixture)
    const headSha = fixture.headSha()
    let draft = true
    let mergeCalled = 0
    const { runner } = ghFixture((path, args) => {
      if (path === 'repos/acme/widgets/pulls/7')
        return { stdout: prJson({ headSha, baseSha: headSha, draft }) }
      if (path.startsWith('repos/acme/widgets/compare/')) return { stdout: COMPARE_JSON }
      if (path.endsWith('/reviews?per_page=100')) return { stdout: REVIEWS_JSON }
      if (
        path === 'repos/acme/widgets/pulls/7/check-runs?per_page=100' ||
        path.endsWith('/check-runs?per_page=100')
      )
        return { stdout: CHECK_RUNS_JSON }
      if (path === 'repos/acme/widgets/pulls/7/merge' && args.includes('PUT')) {
        mergeCalled += 1
        return { stdout: JSON.stringify({ merged: true, sha: headSha }) }
      }
      return { exitCode: 1, stderr: 'unexpected' }
    })
    const { authority } = runtimeFor(fixture, runner)
    const channel = handshakeChannel(authority)
    const prId = 'gh:acme/widgets#7'
    const resource = { kind: 'pull_request', id: prId, generation: GENERATION }

    const draftPlan = await execute(
      channel,
      authority,
      makeCommand(
        'dev.github.mergePlan',
        { pullRequestId: prId, expectedHeadSha: headSha, method: 'squash' },
        resource
      )
    )
    expect(draftPlan).toMatchObject({ ok: false, error: { code: 'invalid_state' } })
    draft = false

    const driftPlan = await execute(
      channel,
      authority,
      makeCommand(
        'dev.github.mergePlan',
        { pullRequestId: prId, expectedHeadSha: 'a'.repeat(40), method: 'squash' },
        resource
      )
    )
    expect(driftPlan).toMatchObject({ ok: false, error: { code: 'stale_version' } })

    // In-progress checks surface as plan blockers, and the merge commit still
    // re-proves the head sha against server truth.
    const plan = await execute(
      channel,
      authority,
      makeCommand(
        'dev.github.mergePlan',
        { pullRequestId: prId, expectedHeadSha: headSha, method: 'squash' },
        resource
      )
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.blockers.some((blocker) => blocker.message.includes('build'))).toBe(true)

    // Head moved server-side between plan and commit → refuse.
    const movedHead = 'b'.repeat(40)
    let serveHead = headSha
    const { runner: driftRunner } = ghFixture((path) => {
      if (path === 'repos/acme/widgets/pulls/7')
        return { stdout: prJson({ headSha: serveHead, baseSha: headSha, draft: false }) }
      if (path.startsWith('repos/acme/widgets/compare/')) return { stdout: COMPARE_JSON }
      if (path.endsWith('/reviews?per_page=100')) return { stdout: '[]' }
      if (path.endsWith('/check-runs?per_page=100')) return { stdout: CHECK_RUNS_JSON }
      return { exitCode: 1, stderr: 'unexpected' }
    })
    const driftAuthority = createChannelAuthority({
      shellHost: '127.0.0.1',
      shellOrigin: 'https://127.0.0.1:4789',
    })
    registerGithubRuntime({
      authority: driftAuthority,
      scope,
      resolveRepo: (repoId) =>
        repoId === REPO_ID
          ? { repoId, canonicalRoot: fixture.repoPath, defaultBranch: 'main' }
          : undefined,
      listRepos: () => [],
      resolveWorktree: () => undefined,
      runGh: driftRunner,
    })
    const driftChannel = handshakeChannel(driftAuthority)
    const driftPlan2 = await execute(
      driftChannel,
      driftAuthority,
      makeCommand(
        'dev.github.mergePlan',
        { pullRequestId: prId, expectedHeadSha: headSha, method: 'squash' },
        resource
      )
    )
    expect(driftPlan2.ok).toBe(true)
    if (!driftPlan2.ok) return
    serveHead = movedHead
    const driftCommit = await execute(
      driftChannel,
      driftAuthority,
      makeCommand(
        'dev.github.mergeCommit',
        { planId: driftPlan2.value.id, planDigest: driftPlan2.value.digest },
        resource
      )
    )
    expect(driftCommit).toMatchObject({ ok: false, error: { code: 'stale_version' } })

    // Happy path: the merge runs with the explicit method and conditional sha.
    const commit = await execute(
      channel,
      authority,
      makeCommand(
        'dev.github.mergeCommit',
        { planId: plan.value.id, planDigest: plan.value.digest },
        resource
      )
    )
    expect(commit.ok).toBe(true)
    expect(mergeCalled).toBeGreaterThanOrEqual(1)
  })

  test('update branch plans merge-base previews and commits real merges offline', async () => {
    const fixture = makeFixture()
    fixtures.push(fixture)
    const { runner } = ghFixture((path) => {
      if (path === 'repos/acme/widgets/pulls/7')
        return {
          stdout: prJson({
            headSha: fixture.headSha(),
            baseSha: fixture.bareSha('refs/heads/main'),
          }),
        }
      return { exitCode: 1, stderr: 'unexpected' }
    })
    const { authority } = runtimeFor(fixture, runner)
    const channel = handshakeChannel(authority)
    const prId = 'gh:acme/widgets#7'
    const resource = { kind: 'pull_request', id: prId, generation: GENERATION }

    // A PR whose base is unknown locally plans with an explicit fetch blocker.
    const noBase = await execute(
      channel,
      authority,
      makeCommand(
        'dev.github.updateBranchPlan',
        {
          pullRequestId: prId,
          worktreeId: WORKTREE_ID,
          expectedGeneration: GENERATION,
          strategy: 'merge',
          expectedHeadSha: fixture.headSha(),
          expectedBaseSha: 'c'.repeat(40),
        },
        resource
      )
    )
    expect(noBase.ok).toBe(true)
    if (noBase.ok)
      expect(noBase.value.blockers.map((blocker: { code: string }) => blocker.code)).toContain(
        'base_not_found'
      )

    // Advance main remotely with a non-conflicting change, then fetch.
    git(fixture.repoPath, ['checkout', '-q', 'main'])
    writeFileSync(join(fixture.repoPath, 'other.txt'), 'base work\n')
    git(fixture.repoPath, ['add', 'other.txt'])
    git(fixture.repoPath, ['commit', '-q', '-m', 'chore: base work'])
    git(fixture.repoPath, ['push', '-q', 'origin', 'main'])
    const baseSha = fixture.bareSha('refs/heads/main')
    git(fixture.repoPath, ['checkout', '-q', 'feat/widgets'])
    git(fixture.repoPath, ['fetch', '-q', 'origin'])
    const headSha = fixture.headSha()

    const plan = await execute(
      channel,
      authority,
      makeCommand(
        'dev.github.updateBranchPlan',
        {
          pullRequestId: prId,
          worktreeId: WORKTREE_ID,
          expectedGeneration: GENERATION,
          strategy: 'merge',
          expectedHeadSha: headSha,
          expectedBaseSha: baseSha,
        },
        resource
      )
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.blockers).toHaveLength(0)

    // Wrong generation is refused before anything runs.
    const staleGeneration = await execute(
      channel,
      authority,
      makeCommand(
        'dev.github.updateBranchPlan',
        {
          pullRequestId: prId,
          worktreeId: WORKTREE_ID,
          expectedGeneration: GENERATION + 1,
          strategy: 'merge',
          expectedHeadSha: headSha,
          expectedBaseSha: baseSha,
        },
        // The envelope must stay self-consistent (resource generation equals
        // the body's expectedGeneration); the PROVIDER then refuses because
        // the worktree sits at the older generation.
        { kind: 'pull_request', id: prId, generation: GENERATION + 1 }
      )
    )
    expect(staleGeneration).toMatchObject({ ok: false, error: { code: 'stale_generation' } })

    // Dirtying the worktree after the plan makes the commit refuse.
    writeFileSync(join(fixture.repoPath, 'dirty.txt'), 'uncommitted\n')
    const dirtyCommit = await execute(
      channel,
      authority,
      makeCommand(
        'dev.github.updateBranchCommit',
        { planId: plan.value.id, planDigest: plan.value.digest },
        resource
      )
    )
    expect(dirtyCommit).toMatchObject({ ok: false, error: { code: 'dirty' } })
    git(fixture.repoPath, ['restore', '--worktree', '--', 'dirty.txt'])
    rmSync(join(fixture.repoPath, 'dirty.txt'))

    const merged = await execute(
      channel,
      authority,
      makeCommand(
        'dev.github.updateBranchCommit',
        { planId: plan.value.id, planDigest: plan.value.digest },
        resource
      )
    )
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    expect(merged.value.state).toBe('merged')
    expect(merged.value.headSha).toBe(fixture.headSha())
    expect(merged.value.headSha).not.toBe(headSha)
    expect(
      git(fixture.repoPath, ['merge-base', '--is-ancestor', baseSha, fixture.headSha()]).code
    ).toBe(0)
  })

  test('update branch conflicts leave a recoverable merge state with exact paths', async () => {
    const fixture = makeFixture()
    fixtures.push(fixture)
    const { runner } = ghFixture((path) => {
      if (path === 'repos/acme/widgets/pulls/7')
        return {
          stdout: prJson({
            headSha: fixture.headSha(),
            baseSha: fixture.bareSha('refs/heads/main'),
          }),
        }
      return { exitCode: 1, stderr: 'unexpected' }
    })
    const { authority } = runtimeFor(fixture, runner)
    const channel = handshakeChannel(authority)
    const prId = 'gh:acme/widgets#7'
    const resource = { kind: 'pull_request', id: prId, generation: GENERATION }

    // Main and feat/widgets both rewrite the same lines.
    writeFileSync(join(fixture.repoPath, 'shared.txt'), 'version 1\n')
    git(fixture.repoPath, ['add', 'shared.txt'])
    git(fixture.repoPath, ['commit', '-q', '-m', 'base shared'])
    git(fixture.repoPath, ['push', '-q', 'origin', 'main'])
    git(fixture.repoPath, ['checkout', '-q', '-b', 'feat/conflict'])
    writeFileSync(join(fixture.repoPath, 'shared.txt'), 'feature version\n')
    git(fixture.repoPath, ['add', 'shared.txt'])
    git(fixture.repoPath, ['commit', '-q', '-m', 'feature shared'])
    const headSha = fixture.headSha()
    git(fixture.repoPath, ['checkout', '-q', 'main'])
    writeFileSync(join(fixture.repoPath, 'shared.txt'), 'main version\n')
    git(fixture.repoPath, ['add', 'shared.txt'])
    git(fixture.repoPath, ['commit', '-q', '-m', 'main shared'])
    git(fixture.repoPath, ['push', '-q', 'origin', 'main'])
    const baseSha = fixture.bareSha('refs/heads/main')
    git(fixture.repoPath, ['checkout', '-q', 'feat/conflict'])
    git(fixture.repoPath, ['fetch', '-q', 'origin'])

    const plan = await execute(
      channel,
      authority,
      makeCommand(
        'dev.github.updateBranchPlan',
        {
          pullRequestId: prId,
          worktreeId: WORKTREE_ID,
          expectedGeneration: GENERATION,
          strategy: 'merge',
          expectedHeadSha: headSha,
          expectedBaseSha: baseSha,
        },
        resource
      )
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.blockers).toHaveLength(0)

    const conflicted = await execute(
      channel,
      authority,
      makeCommand(
        'dev.github.updateBranchCommit',
        { planId: plan.value.id, planDigest: plan.value.digest },
        resource
      )
    )
    expect(conflicted.ok).toBe(true)
    if (!conflicted.ok) return
    expect(conflicted.value.state).toBe('conflicted')
    expect(conflicted.value.conflictedPaths).toEqual(['shared.txt'])
    expect(conflicted.value.recovery?.abort).toContain('git merge --abort')
    // The merge state is preserved exactly for recovery — no silent abort/reset.
    expect(git(fixture.repoPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).code).toBe(0)
    expect(fixture.headSha()).toBe(headSha)
    // The documented abort action actually restores the pre-merge state.
    git(fixture.repoPath, ['merge', '--abort'])
    expect(git(fixture.repoPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).code).not.toBe(0)
  })

  test('update branch refuses when the branch already contains the base', async () => {
    const fixture = makeFixture()
    fixtures.push(fixture)
    git(fixture.repoPath, ['checkout', '-q', 'main'])
    git(fixture.repoPath, ['push', '-q', 'origin', 'main'])
    git(fixture.repoPath, ['checkout', '-q', 'feat/widgets'])
    git(fixture.repoPath, ['fetch', '-q', 'origin'])
    const baseSha = fixture.bareSha('refs/heads/main')
    const { runner } = ghFixture((path) => {
      if (path === 'repos/acme/widgets/pulls/7')
        return { stdout: prJson({ headSha: fixture.headSha(), baseSha }) }
      return { exitCode: 1, stderr: 'unexpected' }
    })
    const { authority } = runtimeFor(fixture, runner)
    const channel = handshakeChannel(authority)
    const prId = 'gh:acme/widgets#7'
    const plan = await execute(
      channel,
      authority,
      makeCommand(
        'dev.github.updateBranchPlan',
        {
          pullRequestId: prId,
          worktreeId: WORKTREE_ID,
          expectedGeneration: GENERATION,
          strategy: 'merge',
          expectedHeadSha: fixture.headSha(),
          expectedBaseSha: baseSha,
        },
        { kind: 'pull_request', id: prId, generation: GENERATION }
      )
    )
    expect(plan.ok).toBe(true)
    if (plan.ok)
      expect(plan.value.blockers.map((blocker: { code: string }) => blocker.code)).toContain(
        'already_completed'
      )
  })

  test('remote parsing enforces host trust and shape', () => {
    const hosts = ['github.com']
    expect(parseGitHubRemote('https://github.com/acme/widgets.git', hosts)).toEqual({
      host: 'github.com',
      owner: 'acme',
      repo: 'widgets',
    })
    expect(parseGitHubRemote('https://user:token@github.com/acme/widgets', hosts)).toEqual({
      host: 'github.com',
      owner: 'acme',
      repo: 'widgets',
    })
    expect(parseGitHubRemote('git@github.com:acme/widgets.git', hosts)).toEqual({
      host: 'github.com',
      owner: 'acme',
      repo: 'widgets',
    })
    expect(parseGitHubRemote('ssh://git@github.com/acme/widgets.git', hosts)).toEqual({
      host: 'github.com',
      owner: 'acme',
      repo: 'widgets',
    })
    // Enterprise hosts are refused until explicitly trusted.
    expect(() => parseGitHubRemote('https://ghe.acme.dev/acme/widgets.git', hosts)).toThrow(
      'not trusted for GitHub operations'
    )
    expect(parseGitHubRemote('https://ghe.acme.dev/acme/widgets.git', ['ghe.acme.dev'])).toEqual({
      host: 'ghe.acme.dev',
      owner: 'acme',
      repo: 'widgets',
    })
    expect(() => parseGitHubRemote('/local/path/repo', hosts)).toThrow()
    expect(() => parseGitHubRemote('https://github.com/acme/../etc.git', hosts)).toThrow()
    expect(() => parseGitHubRemote('https://github.com/only-owner', hosts)).toThrow()
  })

  test('foreign scope fails closed before any transport call', async () => {
    const fixture = makeFixture()
    fixtures.push(fixture)
    const { runner, calls } = ghFixture(() => ({ stdout: ACCOUNT_JSON }))
    const { authority } = runtimeFor(fixture, runner)
    const channel = handshakeChannel(authority)
    const foreign: Scope = { ...scope, workspaceId: '00000000-0000-4000-8000-000000000099' }
    const reply = await execute(channel, authority, {
      ...makeCommand('dev.github.account', {}),
      scope: foreign,
    })
    expect(reply).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    expect(calls).toHaveLength(0)
  })
})
