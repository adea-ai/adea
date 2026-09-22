// M12 #423 — GitHub provider live-repo integration pass (opt-in evidence lane).
//
// The fixture suite (tests/dev-runtime-github-provider.test.ts) proves the
// provider against scripted gh transports; this lane is the issue's last open
// box: the SAME signed-channel harness construction driven against a REAL
// disposable GitHub repository. Differences from the fixture suite:
//
//   - the production `gh` transport is used (no `runGh` injection): every API
//     call is a real `gh api --hostname github.com` child process, and git
//     pushes/fetches go over HTTPS using the machine's gh credential helper;
//   - the repository is a private throwaway created for the run (and deleted
//     or archived afterwards, by the operator — never by this script);
//   - the PR-create idempotency fence is proven from its durable intent
//     record surviving a registrar restart (a real timed-out POST is not
//     safely reproducible against github.com without network manipulation),
//     plus the real deterministic-failure path (a 422 POST) end to end.
//
// Every step's typed outcome is recorded into a JSON artifact (default
// artifacts/m12-423-github-live.json, gitignored) for docs/evidence. The
// artifact only carries provider DTOs, typed error codes/messages (already
// credential-redacted by the provider), git SHAs, and github.com URLs —
// never tokens, and no email addresses exist anywhere in this lane.
//
// Usage:
//   bun apps/desktop/tests/live/github-live-pass.ts \
//     --repo adea-live-pass-2026-09-22 [--owner <login>] [--root <dir>] \
//     [--artifact <path>]
//
// Exit code 0 only when every step's expectation held.
import { createHmac, randomBytes, createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  devCommandProofMessage,
  devOperationDecoders,
  devOperationDefinitions,
  type DevCommand,
  type DevOperation,
  type DevReply,
  type FileIdentity,
  type Scope,
} from '../../../../packages/types/src/dev-runtime'

import { createChannelAuthority } from '../../shell/src/dev-runtime/channel/authority'
import { createDurableJsonStore } from '../../shell/src/dev-runtime/host-store'
import {
  registerGithubRuntime,
  redactCredentials,
} from '../../shell/src/dev-runtime/github/register'
import { directoryIdentity } from '../../shell/src/dev-runtime/worktrees/identity'

// ─── arguments and constants ────────────────────────────────────────────────

function argOf(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const REPO_NAME = argOf('--repo') ?? 'adea-live-pass-2026-09-22'
const ARTIFACT = argOf('--artifact') ?? 'artifacts/m12-423-github-live.json'
const ROOT = argOf('--root') ?? mkdtempSync(join(tmpdir(), 'adea-github-live-'))

const REPO_ID = '00000000-0000-4000-8000-000000004231'
const WORKTREE_ID = 'wt-github-live-01'
const GENERATION = 7
const HOST = 'github.com'

// The scope is a fixed local fixture identity, same shape as the unit suites.
const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

const WORKTREE = join(ROOT, 'worktree')
const DATA_DIR = join(ROOT, 'data')
const PR_CREATE_DIR = join(DATA_DIR, 'dev-runtime', 'github', 'pr-create')

// ─── plain child helpers (git / gh, outside the provider boundary) ─────────

type Child = { stdout: string; stderr: string; exitCode: number }

function spawnChild(command: string, args: string[], cwd?: string): Child {
  const proc = Bun.spawnSync([command, ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode ?? 1,
  }
}

const gitW = (args: string[], cwd = WORKTREE): Child => spawnChild('git', args, cwd)

function ghApi(args: string[]): Child {
  return spawnChild('gh', ['api', ...args, '--hostname', HOST])
}

function ghApiJson(path: string): unknown {
  const result = ghApi([path])
  if (result.exitCode !== 0)
    throw new Error(`gh api ${path} failed: ${redactCredentials(result.stderr.trim())}`)
  return JSON.parse(result.stdout) as unknown
}

// The registrars below intentionally OMIT runGh: they bind the production
// defaultRunGh transport, so every provider operation in this lane is a real
// `gh api --hostname github.com` child process, exactly as in the packaged
// shell. Nothing here injects a scripted transport.

// ─── signed-channel harness (same construction as the fixture suite) ───────

function handshakeChannel(authority: ReturnType<typeof createChannelAuthority>) {
  const bootstrap = authority.issueLaunchBootstrap()
  const at = Date.now()
  const handshake = authority.handshake(
    {
      schemaVersion: 1,
      method: 'dev.runtime.handshake.v1',
      requestId: randomUUID(),
      bootstrap,
      supportedProtocolVersions: ['1'],
      nonce: Buffer.from(randomBytes(16)).toString('base64url'),
      issuedAt: new Date(at - 1000).toISOString(),
      expiresAt: new Date(at + 30_000).toISOString(),
    },
    { trusted: true }
  )
  if (!handshake.ok) throw new Error('handshake refused')
  return {
    identity: {
      channelId: handshake.channelId,
      clientCredentialId: handshake.clientCredentialId,
    },
    secret: Buffer.from(handshake.clientSecret, 'base64url'),
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
    requestId: randomUUID(),
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
  authority: ReturnType<typeof createChannelAuthority>,
  channel: ReturnType<typeof handshakeChannel>,
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
  return authority.execute(
    {
      channelId: channel.identity.channelId,
      clientCredentialId: channel.identity.clientCredentialId,
      command,
      proof,
    },
    { trusted: true }
  )
}

// ─── registrar construction (real transport: runGh intentionally omitted) ──

type Registrar = {
  authority: ReturnType<typeof createChannelAuthority>
  channel: ReturnType<typeof handshakeChannel>
}

function buildRegistrar(worktreeIdentity: FileIdentity, repoRemote: string): Registrar {
  const authority = createChannelAuthority({
    shellHost: '127.0.0.1',
    shellOrigin: 'https://127.0.0.1:4789',
  })
  registerGithubRuntime({
    authority,
    scope,
    dataDir: DATA_DIR,
    resolveRepo: (repoId) =>
      repoId === REPO_ID
        ? {
            repoId,
            canonicalRoot: WORKTREE,
            remote: repoRemote,
            defaultBranch: 'main',
          }
        : undefined,
    listRepos: () => [
      { repoId: REPO_ID, canonicalRoot: WORKTREE, remote: repoRemote, defaultBranch: 'main' },
    ],
    resolveWorktree: (worktreeId) =>
      worktreeId === WORKTREE_ID
        ? {
            canonicalRoot: WORKTREE,
            rootIdentity: worktreeIdentity,
            generation: GENERATION,
            lifecycle: 'ready',
            repoId: REPO_ID,
          }
        : undefined,
    // runGh deliberately omitted: the production defaultRunGh transport runs.
  })
  return { authority, channel: handshakeChannel(authority) }
}

// ─── step recorder ──────────────────────────────────────────────────────────

type Step = {
  id: string
  title: string
  ok: boolean
  checks: { message: string; ok: boolean }[]
  evidence: Record<string, unknown>
}

const steps: Step[] = []
let current: Step | undefined

function beginStep(id: string, title: string): void {
  current = { id, title, ok: true, checks: [], evidence: {} }
  steps.push(current)
  console.log(`\n== ${id} ${title}`)
}

function check(ok: boolean, message: string): boolean {
  if (current === undefined) throw new Error('check outside a step')
  current.checks.push({ message, ok })
  if (!ok) current.ok = false
  console.log(`   ${ok ? 'PASS' : 'FAIL'} ${message}`)
  return ok
}

function record(key: string, value: unknown): void {
  if (current === undefined) throw new Error('record outside a step')
  current.evidence[key] = value
}

function fail(message: string): void {
  check(false, message)
}

function replyValueOrThrow<T>(reply: DevReply, what: string): T {
  if (!reply.ok) {
    fail(`${what}: unexpected refusal ${reply.error.code}: ${reply.error.message}`)
    throw new Error(`${what} refused`)
  }
  return reply.value as T
}

function replyErrorOf(reply: DevReply): { code: string; message: string } | undefined {
  return reply.ok ? undefined : { code: reply.error.code, message: reply.error.message }
}

const redactText = (text: string): string => redactCredentials(text).slice(0, 300)

const intentKeyFor = (headRef: string, baseRef: string): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        scope.accountId,
        scope.workspaceId,
        scope.runtimeNodeId,
        REPO_ID,
        HOST,
        OWNER,
        REPO_NAME,
        headRef,
        baseRef,
      ]),
      'utf8'
    )
    .digest('hex')

const intentFileFor = (headRef: string, baseRef: string): string =>
  join(PR_CREATE_DIR, `${intentKeyFor(headRef, baseRef)}.json`)

function openPullRequestsOnRemote(): { number: number; head: string; base: string }[] {
  const payload = ghApiJson(`repos/${OWNER}/${REPO_NAME}/pulls?state=open&per_page=100`) as {
    number: number
    head: { ref: string }
    base: { ref: string }
  }[]
  return payload.map((entry) => ({
    number: entry.number,
    head: entry.head.ref,
    base: entry.base.ref,
  }))
}

function remoteBranchSha(ref: string): string | undefined {
  const listing = gitW(['ls-remote', 'origin', `refs/heads/${ref}`])
  return listing.stdout.split('\t')[0]?.trim() || undefined
}

function headShaOf(): string {
  return gitW(['rev-parse', 'HEAD']).stdout.trim()
}

function decoderRoundTrip(operation: DevOperation, reply: DevReply): void {
  if (!reply.ok) return
  devOperationDecoders[operation].reply({
    schemaVersion: 1,
    operation,
    requestId: reply.requestId,
    ok: true,
    value: reply.value,
    observedAt: reply.observedAt,
  })
}

// ─── main ───────────────────────────────────────────────────────────────────

let OWNER = argOf('--owner') ?? ''

async function main(): Promise<number> {
  console.log(`M12 #423 github live pass — repo ${REPO_NAME}, root ${ROOT}`)

  // ── provision the disposable repository and seed it over plain git ───────
  if (OWNER === '') OWNER = (ghApiJson('user') as { login: string }).login
  const repoUrl = `https://${HOST}/${OWNER}/${REPO_NAME}.git`
  const existing = ghApi([`repos/${OWNER}/${REPO_NAME}`])
  if (existing.exitCode !== 0) {
    console.log(`creating private repository ${OWNER}/${REPO_NAME}`)
    const created = spawnChild('gh', [
      'repo',
      'create',
      `${OWNER}/${REPO_NAME}`,
      '--private',
      '--description',
      'Disposable live-pass repository for adea M12 #423; deleted after evidence capture',
    ])
    if (created.exitCode !== 0) throw new Error(`gh repo create failed: ${created.stderr}`)
  }
  const repoMeta = ghApiJson(`repos/${OWNER}/${REPO_NAME}`) as {
    private: boolean
    default_branch: string
    html_url: string
  }
  if (!repoMeta.private) throw new Error('refusing to run against a non-private repository')
  if (repoMeta.default_branch !== 'main')
    throw new Error(`unexpected default branch ${repoMeta.default_branch}`)

  mkdirSync(WORKTREE, { recursive: true })
  const remoteHeads = gitW(['ls-remote', '--heads', repoUrl]).stdout
  if (remoteHeads.includes('refs/heads/feat/live-pass'))
    throw new Error('feat/live-pass already exists on the remote; this lane needs a fresh repo')
  const openPullRequestsBeforeSeed = openPullRequestsOnRemote()
  if (openPullRequestsBeforeSeed.length > 0)
    throw new Error(
      'the repository already carries open pull requests; this lane needs a fresh repo'
    )

  if (remoteHeads.trim() === '') {
    console.log('seeding empty repository (README on main)')
    gitW(['init', '-b', 'main'])
    gitW(['remote', 'add', 'origin', repoUrl])
    gitW(['config', 'user.name', 'Adea Live Pass'])
    gitW(['config', 'user.email', 'adea-live@example.com'])
    gitW(['config', 'core.hooksPath', '/dev/null'])
    writeFileSync(
      join(WORKTREE, 'README.md'),
      `# ${REPO_NAME}\n\nDisposable private repository for the adea M12 #423 provider live pass.\n`
    )
    gitW(['add', '.'])
    const committed = gitW(['commit', '-q', '-m', 'chore: seed live-pass repository'])
    if (committed.exitCode !== 0) throw new Error(`seed commit failed: ${committed.stderr}`)
    const pushed = gitW(['push', '-q', '-u', 'origin', 'main'])
    if (pushed.exitCode !== 0) throw new Error(`seed push failed: ${pushed.stderr}`)
  } else {
    console.log('repository already seeded on main; cloning')
    gitW(['init', '-b', 'main'])
    gitW(['remote', 'add', 'origin', repoUrl])
    gitW(['config', 'user.name', 'Adea Live Pass'])
    gitW(['config', 'user.email', 'adea-live@example.com'])
    gitW(['config', 'core.hooksPath', '/dev/null'])
    const fetched = gitW(['fetch', '-q', 'origin'])
    if (fetched.exitCode !== 0) throw new Error(`fetch failed: ${fetched.stderr}`)
    gitW(['reset', '-q', '--hard', 'origin/main'])
    gitW(['branch', '-q', '--set-upstream-to=origin/main', 'main'])
  }

  // The feature branch stays LOCAL: pushing it is the provider's first job
  // (upstream setup is part of the evidence).
  gitW(['checkout', '-q', '-b', 'feat/live-pass'])
  writeFileSync(join(WORKTREE, 'feature.txt'), 'live pass feature work\n')
  gitW(['add', 'feature.txt'])
  const featureCommit = gitW(['commit', '-q', '-m', 'feat: live-pass branch work'])
  if (featureCommit.exitCode !== 0)
    throw new Error(`feature commit failed: ${featureCommit.stderr}`)

  const identity = directoryIdentity(WORKTREE)
  const primary = buildRegistrar({ ...identity.identity } as FileIdentity, repoUrl)
  const executeOp = async (
    operation: DevOperation,
    body: Record<string, unknown>,
    resource?: { kind: string; id: string; generation: number }
  ): Promise<DevReply> =>
    execute(primary.authority, primary.channel, makeCommand(operation, body, resource))

  const repoResource = (): { kind: string; id: string; generation: number } => ({
    kind: 'repository',
    id: REPO_ID,
    generation: GENERATION,
  })

  let pullRequestId = ''
  let prNumber = 0
  let firstHeadSha = ''
  const started = Date.now()

  // ── 1. account read ──────────────────────────────────────────────────────
  beginStep('s01', 'dev.github.account reads the real authenticated account')
  {
    const reply = await executeOp('dev.github.account', {})
    const account = replyValueOrThrow<{
      login: string
      name?: string
      host: string
      provider: string
    }>(reply, 'account read')
    check(account.provider === 'github', 'provider is github')
    check(account.host === HOST, `host is ${HOST}`)
    check(account.login === OWNER, `login matches the authenticated owner (${OWNER})`)
    record('account', { login: account.login, name: account.name ?? null, host: account.host })
    decoderRoundTrip('dev.github.account', reply)
  }

  // ── 2. repository adopt/inspect ──────────────────────────────────────────
  beginStep('s02', 'dev.github.repository inspects the real repository (fresh)')
  {
    const reply = await executeOp('dev.github.repository', { repoId: REPO_ID }, repoResource())
    const repository = replyValueOrThrow<{
      owner: string
      name: string
      fullName: string
      defaultBranch: string
      visibility: string
      private: boolean
      freshness: string
      url: string
    }>(reply, 'repository inspect')
    check(repository.fullName === `${OWNER}/${REPO_NAME}`, `fullName is ${OWNER}/${REPO_NAME}`)
    check(repository.visibility === 'private', 'visibility decodes as private')
    check(repository.defaultBranch === 'main', 'defaultBranch is main')
    check(repository.freshness === 'fresh', 'freshness is fresh')
    record('repository', {
      fullName: repository.fullName,
      visibility: repository.visibility,
      defaultBranch: repository.defaultBranch,
      freshness: repository.freshness,
      url: repository.url,
    })
    decoderRoundTrip('dev.github.repository', reply)
  }

  // ── 3. push plan + commit (upstream setup) ───────────────────────────────
  firstHeadSha = headShaOf()
  beginStep('s03', 'dev.github.pushPlan plans the first push of feat/live-pass')
  let pushPlan = { id: '', digest: '' }
  {
    const reply = await executeOp(
      'dev.github.pushPlan',
      {
        repoId: REPO_ID,
        worktreeId: WORKTREE_ID,
        ref: 'feat/live-pass',
        expectedLocalSha: firstHeadSha,
      },
      repoResource()
    )
    const plan = replyValueOrThrow<{
      id: string
      digest: string
      blockers: { code: string }[]
      factVersions: Record<string, string>
    }>(reply, 'push plan')
    check(plan.blockers.length === 0, 'plan carries no blockers')
    check(plan.factVersions.localSha === firstHeadSha, 'plan pins the local head sha')
    check(
      plan.factVersions.repository === `${OWNER}/${REPO_NAME}`,
      'plan names the real repository'
    )
    pushPlan = { id: plan.id, digest: plan.digest }
    record('pushPlan1', { id: plan.id, factVersions: plan.factVersions, blockers: plan.blockers })
  }

  beginStep('s04', 'dev.github.pushCommit pushes with upstream setup (-u) to the real remote')
  {
    const reply = await executeOp(
      'dev.github.pushCommit',
      { planId: pushPlan.id, planDigest: pushPlan.digest },
      repoResource()
    )
    const push = replyValueOrThrow<{
      ref: string
      headSha: string
      remoteSha: string
      forced: boolean
      upstreamSet: boolean
    }>(reply, 'push commit')
    check(push.upstreamSet === true, 'upstream was set on the first push')
    check(push.forced === false, 'push was a normal fast-forward')
    check(push.headSha === firstHeadSha, 'pushed sha equals the local head')
    const remoteNow = remoteBranchSha('feat/live-pass')
    check(remoteNow === firstHeadSha, 'ls-remote confirms the branch on the real remote')
    record('push1', {
      ref: push.ref,
      headSha: push.headSha,
      remoteSha: push.remoteSha,
      upstreamSet: push.upstreamSet,
      remoteVerified: remoteNow,
    })
    decoderRoundTrip('dev.github.pushCommit', reply)
  }

  // ── 4. draft PR create ───────────────────────────────────────────────────
  beginStep('s05', 'dev.github.createPullRequest creates a real draft PR')
  {
    const reply = await executeOp(
      'dev.github.createPullRequest',
      {
        repoId: REPO_ID,
        headRef: 'feat/live-pass',
        baseRef: 'main',
        title: 'Live pass: draft PR from the provider',
        body: 'Created by the M12 #423 live-repo pass against a disposable repository.',
        draft: true,
      },
      repoResource()
    )
    const pr = replyValueOrThrow<{
      id: string
      number: number
      state: string
      draft: boolean
      headRef: string
      baseRef: string
      reconciled: boolean
      url: string
    }>(reply, 'PR create')
    pullRequestId = pr.id
    prNumber = pr.number
    check(pr.state === 'open', 'PR state is open')
    check(pr.draft === true, 'PR is a draft')
    check(pr.reconciled === false, 'PR was created (not reconciled)')
    check(pr.headRef === 'feat/live-pass' && pr.baseRef === 'main', 'head/base refs match')
    record('createPullRequest', { id: pr.id, number: pr.number, url: pr.url, reconciled: false })
    decoderRoundTrip('dev.github.createPullRequest', reply)
  }

  // ── 5. PR read: mergeability / reviews / checks shapes ───────────────────
  beginStep('s06', 'dev.github.pullRequest reads the real PR with decorated fields')
  let prVersion = 0
  {
    const reply = await executeOp(
      'dev.github.pullRequest',
      { pullRequestId: pullRequestId },
      { kind: 'pull_request', id: pullRequestId, generation: 0 }
    )
    const pr = replyValueOrThrow<{
      mergeable: string
      reviewDecision?: string
      aheadBehind?: { ahead: number; behind: number }
      version: number
      headSha: string
      labels: string[]
      authorLogin?: string
      updatedAt: string
    }>(reply, 'PR read')
    prVersion = pr.version
    check(pr.headSha === firstHeadSha, 'head sha matches the pushed commit')
    check(
      ['mergeable', 'conflicting', 'unknown'].includes(pr.mergeable),
      `mergeable is a typed shape (${pr.mergeable})`
    )
    check(pr.version >= 1, `version token is ${pr.version}`)
    check(Array.isArray(pr.labels), 'labels decode as an array')
    record('pullRequest', {
      id: pullRequestId,
      number: prNumber,
      mergeable: pr.mergeable,
      reviewDecision: pr.reviewDecision ?? null,
      aheadBehind: pr.aheadBehind ?? null,
      version: pr.version,
      updatedAt: pr.updatedAt,
      labels: pr.labels,
      authorLogin: pr.authorLogin ?? null,
    })
    decoderRoundTrip('dev.github.pullRequest', reply)
  }

  beginStep('s07', 'second unrefreshed read serves the 30s cache with the same version')
  {
    const reply = await executeOp(
      'dev.github.pullRequest',
      { pullRequestId: pullRequestId },
      { kind: 'pull_request', id: pullRequestId, generation: 0 }
    )
    const pr = replyValueOrThrow<{ version: number; updatedAt: string }>(reply, 'cached PR read')
    check(pr.version === prVersion, 'version did not bump within the cache window')
    record('pullRequestCached', { version: pr.version })
  }

  beginStep('s08', 'dev.github.checks pages the real check runs for the PR head')
  {
    const reply = await executeOp(
      'dev.github.checks',
      { pullRequestId, limit: 100 },
      { kind: 'pull_request', id: pullRequestId, generation: 0 }
    )
    const page = replyValueOrThrow<{ items: { name: string; status: string }[] }>(
      reply,
      'checks page'
    )
    check(Array.isArray(page.items), 'checks decode as an array')
    // A disposable repository has no CI: the empty page is the real-world
    // shape the fixtures could not prove (they scripted two runs).
    check(page.items.length === 0, 'no check runs exist on the disposable repo (empty page)')
    record('checks', { count: page.items.length })
    decoderRoundTrip('dev.github.checks', reply)
  }

  beginStep('s09', 'dev.github.pullRequests lists the open PR')
  {
    const reply = await executeOp(
      'dev.github.pullRequests',
      { repoId: REPO_ID, limit: 50 },
      repoResource()
    )
    const page = replyValueOrThrow<{ items: { number: number }[] }>(reply, 'PR list')
    check(page.items.length === 1, 'exactly one open PR is listed')
    check(page.items[0]?.number === prNumber, `the listed PR is #${prNumber}`)
    record('pullRequests', {
      count: page.items.length,
      numbers: page.items.map((item) => item.number),
    })
  }

  beginStep('s10', 'dev.github.issues lists the (empty) issue page')
  {
    const reply = await executeOp('dev.github.issues', { repoId: REPO_ID }, repoResource())
    const page = replyValueOrThrow<{ items: unknown[] }>(reply, 'issues page')
    check(page.items.length === 0, 'no issues exist')
    record('issues', { count: page.items.length })
  }

  beginStep('s11', 'dev.github.milestones lists the (empty) milestone page')
  {
    const reply = await executeOp('dev.github.milestones', { repoId: REPO_ID }, repoResource())
    const page = replyValueOrThrow<{ items: unknown[] }>(reply, 'milestones page')
    check(page.items.length === 0, 'no milestones exist')
    record('milestones', { count: page.items.length })
  }

  beginStep('s12', 'dev.github.mergePlan refuses the draft PR before any merge call')
  {
    const reply = await executeOp(
      'dev.github.mergePlan',
      { pullRequestId, expectedHeadSha: firstHeadSha, method: 'squash' },
      { kind: 'pull_request', id: pullRequestId, generation: 0 }
    )
    const error = replyErrorOf(reply)
    check(
      reply.ok === false && error?.code === 'invalid_state',
      `draft merge refused (${error?.code})`
    )
    record('mergePlanRefusal', {
      code: error?.code ?? null,
      message: error ? redactText(error.message) : null,
    })
  }

  // ── 6. PR title update (plan/commit) ─────────────────────────────────────
  beginStep('s13', 'dev.github.updatePlan plans a title patch against the local version')
  let updatePlanId = ''
  let updatePlanDigest = ''
  {
    const reply = await executeOp(
      'dev.github.updatePlan',
      { pullRequestId, expectedVersion: prVersion, patch: { title: 'Live pass: retitled draft' } },
      { kind: 'pull_request', id: pullRequestId, generation: 0 }
    )
    const plan = replyValueOrThrow<{ id: string; digest: string }>(reply, 'update plan')
    updatePlanId = plan.id
    updatePlanDigest = plan.digest
    record('updatePlan', { id: plan.id })
  }

  beginStep('s14', 'dev.github.updateCommit applies the title patch to the real PR')
  {
    const reply = await executeOp(
      'dev.github.updateCommit',
      { planId: updatePlanId, planDigest: updatePlanDigest },
      { kind: 'pull_request', id: pullRequestId, generation: 0 }
    )
    const pr = replyValueOrThrow<{ title: string; version: number }>(reply, 'update commit')
    check(pr.title === 'Live pass: retitled draft', 'server title now carries the patch')
    record('updateCommit', { title: pr.title, version: pr.version })
  }

  // ── 7. update-branch: advance main, plan, merge, push the result ─────────
  beginStep('s15', 'harness advances main on the remote (plain git)')
  let newBaseSha = ''
  {
    gitW(['checkout', '-q', 'main'])
    writeFileSync(join(WORKTREE, 'base.txt'), 'base advanced for the update-branch proof\n')
    gitW(['add', 'base.txt'])
    gitW(['commit', '-q', '-m', 'chore: advance base for update-branch proof'])
    const pushed = gitW(['push', '-q', 'origin', 'main'])
    check(pushed.exitCode === 0, 'base push to main succeeded')
    newBaseSha = remoteBranchSha('main') ?? ''
    gitW(['checkout', '-q', 'feat/live-pass'])
    const fetched = gitW(['fetch', '-q', 'origin'])
    check(fetched.exitCode === 0, 'fetch brought the new base into the worktree')
    record('baseAdvance', { baseSha: newBaseSha })
  }

  beginStep('s16', 'dev.github.updateBranchPlan previews the merge (no blockers)')
  let branchPlanId = ''
  let branchPlanDigest = ''
  {
    const reply = await executeOp(
      'dev.github.updateBranchPlan',
      {
        pullRequestId,
        worktreeId: WORKTREE_ID,
        expectedGeneration: GENERATION,
        strategy: 'merge',
        expectedHeadSha: headShaOf(),
        expectedBaseSha: newBaseSha,
      },
      { kind: 'pull_request', id: pullRequestId, generation: GENERATION }
    )
    const plan = replyValueOrThrow<{ id: string; digest: string; blockers: { code: string }[] }>(
      reply,
      'update-branch plan'
    )
    check(plan.blockers.length === 0, 'plan carries no blockers')
    branchPlanId = plan.id
    branchPlanDigest = plan.digest
    record('updateBranchPlan', { id: plan.id, blockers: plan.blockers })
  }

  beginStep('s17', 'dev.github.updateBranchCommit merges the base into the PR branch locally')
  let mergedHeadSha = ''
  {
    const reply = await executeOp(
      'dev.github.updateBranchCommit',
      { planId: branchPlanId, planDigest: branchPlanDigest },
      { kind: 'pull_request', id: pullRequestId, generation: GENERATION }
    )
    const merged = replyValueOrThrow<{
      state: string
      previousHeadSha: string
      headSha?: string
      conflictedPaths?: string[]
    }>(reply, 'update-branch commit')
    check(merged.state === 'merged', 'merge completed without conflict')
    mergedHeadSha = merged.headSha ?? ''
    check(
      mergedHeadSha !== '' && mergedHeadSha !== firstHeadSha,
      'head advanced to the merge commit'
    )
    const ancestor = gitW(['merge-base', '--is-ancestor', newBaseSha, headShaOf()])
    check(ancestor.exitCode === 0, 'the base is an ancestor of the merged head')
    record('updateBranchCommit', { state: merged.state, headSha: mergedHeadSha })
  }

  beginStep('s18', 'dev.github.pushCommit pushes the merge result (upstream already set)')
  {
    const planReply = await executeOp(
      'dev.github.pushPlan',
      {
        repoId: REPO_ID,
        worktreeId: WORKTREE_ID,
        ref: 'feat/live-pass',
        expectedLocalSha: headShaOf(),
      },
      repoResource()
    )
    const plan = replyValueOrThrow<{ id: string; digest: string }>(planReply, 'second push plan')
    const reply = await executeOp(
      'dev.github.pushCommit',
      { planId: plan.id, planDigest: plan.digest },
      repoResource()
    )
    const push = replyValueOrThrow<{ remoteSha: string; upstreamSet: boolean; forced: boolean }>(
      reply,
      'second push commit'
    )
    check(push.upstreamSet === false, 'upstream was NOT re-set on the second push')
    check(push.remoteSha === headShaOf(), 'remote sha equals the merged head')
    check(
      remoteBranchSha('feat/live-pass') === headShaOf(),
      'ls-remote confirms the merge on the remote'
    )
    record('push2', { remoteSha: push.remoteSha, upstreamSet: push.upstreamSet })
  }

  beginStep('s19', 'refreshed PR read shows the advanced head and ahead/behind')
  {
    const reply = await executeOp(
      'dev.github.pullRequest',
      { pullRequestId, refresh: true },
      { kind: 'pull_request', id: pullRequestId, generation: 0 }
    )
    const pr = replyValueOrThrow<{
      headSha: string
      aheadBehind?: { ahead: number; behind: number }
      mergeable: string
      version: number
    }>(reply, 'refreshed PR read')
    check(pr.headSha === mergedHeadSha, 'server head sha is the merge commit')
    check(
      ['mergeable', 'conflicting', 'unknown'].includes(pr.mergeable),
      `mergeable is a typed shape (${pr.mergeable})`
    )
    record('pullRequestRefreshed', {
      headSha: pr.headSha,
      aheadBehind: pr.aheadBehind ?? null,
      mergeable: pr.mergeable,
      version: pr.version,
    })
  }

  // ── 8. PR-create idempotency fence ───────────────────────────────────────
  beginStep('s20', 'createPullRequest for a missing head branch hits the real 422 path')
  {
    const reply = await executeOp(
      'dev.github.createPullRequest',
      {
        repoId: REPO_ID,
        headRef: 'feat/fence-recovery',
        baseRef: 'main',
        title: 'Live pass: fence recovery PR',
        body: 'Created after deterministic-failure recovery in the M12 #423 live pass.',
        draft: true,
      },
      repoResource()
    )
    const error = replyErrorOf(reply)
    check(reply.ok === false, 'the create was refused')
    check(error?.code === 'invalid_state', `real GitHub 422 mapped to ${error?.code}`)
    const intentFile = intentFileFor('feat/fence-recovery', 'main')
    check(existsSync(intentFile), 'the durable intent record was persisted before the POST')
    if (existsSync(intentFile)) {
      const envelope = JSON.parse(readFileSync(intentFile, 'utf8')) as {
        schemaVersion: number
        records: { startedAt: string }[]
      }
      check(
        envelope.schemaVersion === 1 && envelope.records.length === 1,
        'intent record is the provider schema'
      )
      record('fenceDeterministicFailure', {
        code: error?.code ?? null,
        intentFile: 'dev-runtime/github/pr-create/<sha256>.json',
      })
    }
  }

  beginStep('s21', 'retry after the deterministic 422 is fenced (bug evidence: wedged intent)')
  {
    // The branch now really exists on the remote, but the wedge from s20
    // blocks the create even though GitHub's 422 provably created nothing.
    const pushed = gitW(['push', '-q', 'origin', 'HEAD:refs/heads/feat/fence-recovery'])
    check(pushed.exitCode === 0, 'feat/fence-recovery now exists on the remote')
    const reply = await executeOp(
      'dev.github.createPullRequest',
      {
        repoId: REPO_ID,
        headRef: 'feat/fence-recovery',
        baseRef: 'main',
        title: 'Live pass: fence recovery PR',
        body: 'Created after deterministic-failure recovery in the M12 #423 live pass.',
        draft: true,
      },
      repoResource()
    )
    const error = replyErrorOf(reply)
    check(reply.ok === false, 'the retry was refused')
    check(
      error?.code === 'remote_unavailable' && error.message.includes('unknown outcome'),
      `fence refused with (${error?.code}): ${error ? redactText(error.message) : ''}`
    )
    const pairPulls = openPullRequestsOnRemote().filter(
      (entry) => entry.head === 'feat/fence-recovery' && entry.base === 'main'
    )
    check(pairPulls.length === 0, 'no PR exists for the pair (the fence prevented a duplicate)')
    record('fenceRetryRefused', { code: error?.code ?? null, pairPulls: pairPulls.length })
  }

  beginStep('s22', 'a fresh registrar refuses a seeded durable intent without any POST')
  {
    // Model the ambiguous-delivery path that cannot be safely provoked against
    // github.com: the provider persisted its intent and died before learning
    // the outcome. Seed exactly that record with the provider's own store
    // implementation, then let a FRESH registrar (process restart) meet it.
    gitW(['push', '-q', 'origin', 'HEAD:refs/heads/feat/live-pass-fence'])
    const headRef = 'feat/live-pass-fence'
    const baseRef = 'main'
    mkdirSync(PR_CREATE_DIR, { recursive: true, mode: 0o700 })
    const intentStore = createDurableJsonStore<{ startedAt: string }>({
      file: intentFileFor(headRef, baseRef),
      schemaVersion: 1,
      label: 'GitHub PR create',
    })
    intentStore.save([{ startedAt: new Date().toISOString() }])
    const pullsBefore = openPullRequestsOnRemote().length

    const restarted = buildRegistrar({ ...identity.identity } as FileIdentity, repoUrl)
    const restartedReply = await execute(
      restarted.authority,
      restarted.channel,
      makeCommand(
        'dev.github.createPullRequest',
        {
          repoId: REPO_ID,
          headRef,
          baseRef,
          title: 'Live pass: fence proof PR',
          body: 'Proves the durable PR-create fence against the real API.',
          draft: true,
        },
        repoResource()
      )
    )
    const error = replyErrorOf(restartedReply)
    check(restartedReply.ok === false, 'the restarted registrar refused')
    check(
      error?.code === 'remote_unavailable' && error.message.includes('unknown outcome'),
      `fence refusal (${error?.code}): ${error ? redactText(error.message) : ''}`
    )
    const pullsAfter = openPullRequestsOnRemote().length
    check(pullsAfter === pullsBefore, `no POST reached GitHub (open PRs stayed at ${pullsBefore})`)
    record('fenceRestart', { pullsBefore, pullsAfter, code: error?.code ?? null })
  }

  beginStep('s23', 'manual intent recovery completes: the real POST creates PR #2')
  {
    rmSync(intentFileFor('feat/live-pass-fence', 'main'))
    const reply = await executeOp(
      'dev.github.createPullRequest',
      {
        repoId: REPO_ID,
        headRef: 'feat/live-pass-fence',
        baseRef: 'main',
        title: 'Live pass: fence proof PR',
        body: 'Proves the durable PR-create fence against the real API.',
        draft: true,
      },
      repoResource()
    )
    const pr = replyValueOrThrow<{
      number: number
      draft: boolean
      reconciled: boolean
      state: string
    }>(reply, 'fence recovery create')
    check(pr.draft === true && pr.state === 'open', 'PR #2 is an open draft')
    check(pr.reconciled === false, 'PR #2 was genuinely created (not reconciled)')
    const remotePulls = openPullRequestsOnRemote()
    check(
      remotePulls.some(
        (entry) => entry.number === pr.number && entry.head === 'feat/live-pass-fence'
      ),
      'the API confirms PR #2 for feat/live-pass-fence'
    )
    record('fenceRecoveryCreate', { number: pr.number })
  }

  beginStep('s24', 'repeating the create reconciles against the real PR (no duplicate)')
  {
    const pullsBefore = openPullRequestsOnRemote().length
    const reply = await executeOp(
      'dev.github.createPullRequest',
      {
        repoId: REPO_ID,
        headRef: 'feat/live-pass-fence',
        baseRef: 'main',
        title: 'Live pass: fence proof PR',
        body: 'Proves the durable PR-create fence against the real API.',
        draft: true,
      },
      repoResource()
    )
    const pr = replyValueOrThrow<{ number: number; reconciled: boolean }>(
      reply,
      'reconciled create'
    )
    check(pr.reconciled === true, 'the second create reconciled instead of duplicating')
    check(openPullRequestsOnRemote().length === pullsBefore, 'no duplicate PR was created')
    record('fenceReconcile', { number: pr.number })
  }

  beginStep('s25', 'wedged-intent recovery for the s20/s21 pair completes with PR #3')
  {
    rmSync(intentFileFor('feat/fence-recovery', 'main'))
    const reply = await executeOp(
      'dev.github.createPullRequest',
      {
        repoId: REPO_ID,
        headRef: 'feat/fence-recovery',
        baseRef: 'main',
        title: 'Live pass: fence recovery PR',
        body: 'Created after deterministic-failure recovery in the M12 #423 live pass.',
        draft: true,
      },
      repoResource()
    )
    const pr = replyValueOrThrow<{ number: number; reconciled: boolean }>(
      reply,
      'wedged recovery create'
    )
    check(pr.reconciled === false, 'PR #3 was genuinely created after recovery')
    record('wedgedRecoveryCreate', { number: pr.number })
  }

  // ── artifact + verdict ───────────────────────────────────────────────────
  const ok = steps.every((step) => step.ok)
  writeArtifact(
    ok,
    repoMeta.html_url,
    repoUrl,
    new Date(started).toISOString(),
    Date.now() - started
  )
  console.log(`\nartifact: ${ARTIFACT}`)
  console.log(
    `M12-423 GITHUB LIVE PASS ${ok ? 'PASS' : 'FAIL'} (${steps.filter((step) => step.ok).length}/${steps.length} steps)`
  )
  return ok ? 0 : 1
}

function writeArtifact(
  ok: boolean,
  repoHtmlUrl: string,
  repoUrl: string,
  startedAt: string,
  durationMs: number
): void {
  const artifact = {
    lane: 'm12-423-github-live',
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs,
    repository: { owner: OWNER, name: REPO_NAME, host: HOST, private: true, url: repoHtmlUrl },
    remote: repoUrl,
    transport: 'production defaultRunGh (gh CLI, --hostname github.com)',
    steps: steps.map((step) => ({
      id: step.id,
      title: step.title,
      ok: step.ok,
      checks: step.checks,
      evidence: step.evidence,
    })),
    outcome: ok ? 'PASS' : 'FAIL',
  }
  mkdirSync(dirname(ARTIFACT), { recursive: true })
  writeFileSync(ARTIFACT, `${JSON.stringify(artifact, null, 2)}\n`)
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    steps.push({
      id: 'aborted',
      title: 'lane aborted before completion',
      ok: false,
      checks: [{ message: redactText(message), ok: false }],
      evidence: {},
    })
    writeArtifact(false, `https://${HOST}/${OWNER}/${REPO_NAME}`, '', new Date().toISOString(), 0)
    console.error('M12-423 GITHUB LIVE PASS ERROR', redactText(message))
    console.error(`artifact (partial): ${ARTIFACT}`)
    process.exit(1)
  })
