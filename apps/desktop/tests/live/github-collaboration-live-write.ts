// Source control app — GitHub collaboration live WRITE pass (opt-in evidence).
//
// Drives every collaboration write through the production gh transport
// against a DISPOSABLE PRIVATE repository this script creates under the
// signed-in account: draft/ready/close/reopen, comments, an inline review
// thread with reply and resolve, labels and assignees, server-side branch
// update, checks with a failing Actions job, its log and a re-run,
// auto-merge, and a squash merge that deletes the head branch. Every reply
// is re-decoded through the strict client decoders. The repository is left
// in place for the operator to inspect, archive, or delete — never deleted
// by this script.
//
// Usage:
//   bun apps/desktop/tests/live/github-collaboration-live-write.ts \
//     --repo adea-scm-live-2026-10-03 [--owner <login>]
//
// Exit code 0 only when every step's expectation held.
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  devCommandProofMessage,
  devOperationDecoders,
  devOperationDefinitions,
  type DevCommand,
  type DevOperation,
  type DevReply,
  type Scope,
} from '../../../../packages/types/src/dev-runtime'

import { createChannelAuthority } from '../../shell/src/dev-runtime/channel/authority'
import { registerGithubRuntime } from '../../shell/src/dev-runtime/github/register'

function argOf(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const REPO_NAME = argOf('--repo') ?? `adea-scm-live-${new Date().toISOString().slice(0, 10)}`
const ROOT = mkdtempSync(join(tmpdir(), 'adea-scm-live-write-'))
const CHECKOUT = join(ROOT, 'checkout')
const REPO_ID = '00000000-0000-4000-8000-000000005311'
const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

// ─── plain helpers (outside the provider boundary) ──────────────────────────

function sh(
  command: string,
  args: string[],
  cwd?: string
): { stdout: string; stderr: string; code: number } {
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
    code: proc.exitCode ?? 1,
  }
}

function must(command: string, args: string[], cwd?: string): string {
  const result = sh(command, args, cwd)
  if (result.code !== 0) throw new Error(`${command} ${args.join(' ')}: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

const git = (args: string[]) => must('git', args, CHECKOUT)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ─── step recorder ──────────────────────────────────────────────────────────

const results: { step: string; ok: boolean; detail: string }[] = []
function check(step: string, ok: boolean, detail: string): void {
  results.push({ step, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step.padEnd(40)} ${detail}`)
}

// ─── setup: a disposable private repository ─────────────────────────────────

const OWNER = argOf('--owner') ?? must('gh', ['api', 'user', '-q', '.login'])
const FULL = `${OWNER}/${REPO_NAME}`
console.log(`repository ${FULL} (private, disposable) in ${ROOT}`)
if (sh('gh', ['repo', 'view', FULL]).code === 0)
  throw new Error(`${FULL} already exists; pass a fresh --repo name`)
must('gh', [
  'repo',
  'create',
  FULL,
  '--private',
  '--description',
  'Adea source control live write pass (disposable)',
])
mkdirSync(CHECKOUT, { recursive: true })
must('git', ['init', '-q', '-b', 'main', CHECKOUT])
git(['config', 'user.name', 'Adea live pass'])
git(['config', 'user.email', `${OWNER}@users.noreply.github.com`])
git(['remote', 'add', 'origin', `https://github.com/${FULL}.git`])
must('gh', ['auth', 'setup-git'])
writeFileSync(join(CHECKOUT, 'README.md'), '# Live pass\n\nline two\nline three\nline four\n')
mkdirSync(join(CHECKOUT, '.github', 'workflows'), { recursive: true })
writeFileSync(
  join(CHECKOUT, '.github', 'workflows', 'checks.yml'),
  [
    'name: checks',
    'on: pull_request',
    'jobs:',
    '  pass:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo "all good"',
    '  gate:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: |',
    '          echo "checking ${{ github.head_ref }}"',
    '          case "${{ github.head_ref }}" in *fail*) echo "::error::intentional failure"; exit 1;; esac',
    '',
  ].join('\n')
)
git(['add', '-A'])
git(['commit', '-q', '-m', 'initial'])
git(['push', '-q', '-u', 'origin', 'main'])
must('gh', [
  'api',
  `repos/${FULL}`,
  '--method',
  'PATCH',
  '-F',
  'allow_auto_merge=true',
  '-F',
  'allow_squash_merge=true',
])
must('gh', [
  'api',
  `repos/${FULL}/labels`,
  '--method',
  'POST',
  '-f',
  'name=scm-live',
  '-f',
  'color=0e8a16',
])

function branch(name: string, file: string, text: string): void {
  git(['checkout', '-q', '-B', name, 'origin/main'])
  writeFileSync(join(CHECKOUT, file), text)
  git(['add', '-A'])
  git(['commit', '-q', '-m', `change on ${name}`])
  git(['push', '-q', '-u', 'origin', name])
}

// ─── signed channel over the production transport ───────────────────────────

const authority = createChannelAuthority({
  shellHost: '127.0.0.1',
  shellOrigin: 'https://127.0.0.1:4789',
})
const repo = {
  repoId: REPO_ID,
  canonicalRoot: CHECKOUT,
  remote: `https://github.com/${FULL}.git`,
  defaultBranch: 'main',
}
registerGithubRuntime({
  authority,
  scope,
  dataDir: join(ROOT, 'data'),
  resolveRepo: (repoId) => (repoId === REPO_ID ? repo : undefined),
  listRepos: () => [repo],
  resolveWorktree: () => undefined,
})
const handshake = authority.handshake(
  {
    schemaVersion: 1,
    method: 'dev.runtime.handshake.v1',
    requestId: randomUUID(),
    bootstrap: authority.issueLaunchBootstrap(),
    supportedProtocolVersions: ['1'],
    nonce: Buffer.from(randomBytes(16)).toString('base64url'),
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  },
  { trusted: true }
)
if (!handshake.ok) throw new Error('handshake refused')
const secret = Buffer.from(handshake.clientSecret, 'base64url')

async function call(
  operation: DevOperation,
  body: Record<string, unknown>,
  resourceId?: string
): Promise<DevReply> {
  const definition = devOperationDefinitions[operation]
  const command: DevCommand = {
    schemaVersion: 1,
    operation,
    requestId: randomUUID(),
    nonce: Buffer.from(randomBytes(16)).toString('base64url'),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    scope,
    capabilities: [...definition.capabilities],
    ...(definition.resource
      ? {
          resource: {
            kind: definition.resource.kind,
            id: resourceId ?? String(body[definition.resource.idField]),
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
  const reply = (await authority.execute(
    {
      channelId: handshake.channelId,
      clientCredentialId: handshake.clientCredentialId,
      command,
      proof,
    },
    { trusted: true }
  )) as DevReply
  devOperationDecoders[operation].reply({
    schemaVersion: 1,
    operation,
    requestId: command.requestId,
    ...(reply.ok
      ? { ok: true, value: reply.value, observedAt: new Date().toISOString() }
      : { ok: false, error: reply.error }),
  })
  return reply
}

async function value<T>(
  operation: DevOperation,
  body: Record<string, unknown>,
  resourceId?: string
): Promise<T> {
  const reply = await call(operation, body, resourceId)
  if (!reply.ok) throw new Error(`${operation}: ${reply.error.code}: ${reply.error.message}`)
  return reply.value as T
}

type Plan = {
  id: string
  digest: string
  resource: { id: string }
  blockers: { code: string; message: string }[]
}
async function planned<T>(
  plan: DevOperation,
  commit: DevOperation,
  body: Record<string, unknown>
): Promise<T | Plan> {
  const issued = await value<Plan>(plan, body)
  if (issued.blockers.length > 0) return issued
  return value<T>(commit, { planId: issued.id, planDigest: issued.digest }, issued.resource.id)
}

type Summary = {
  id: string
  number: number
  headSha: string
  draft: boolean
  state: string
  labels: string[]
  assignees: { login: string }[]
  behindBy?: number
  autoMerge?: { method: string }
  checks: { state: string; failing: number; running: number; total: number }
}
const summary = (id: string) =>
  value<Summary>('dev.github.pullRequestSummary', { pullRequestId: id, refresh: true })

async function waitFor<T>(
  what: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  seconds = 300
): Promise<T> {
  const deadline = Date.now() + seconds * 1000
  for (;;) {
    const current = await read()
    if (done(current)) return current
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(10_000)
  }
}

// ─── the pass ───────────────────────────────────────────────────────────────

try {
  branch(
    'feat/fail-gate',
    'README.md',
    '# Live pass\n\nline two changed\nline three\nline four\nline five\n'
  )
  const created = await value<{ id: string; draft: boolean }>('dev.github.createPullRequest', {
    repoId: REPO_ID,
    headRef: 'feat/fail-gate',
    baseRef: 'main',
    title: 'Live pass: failing gate',
    body: 'Opened by the **Adea** live write pass.',
    draft: true,
  })
  const pr = created.id
  check('createPullRequest', created.draft, `${pr} opened as draft`)

  const readyRead = await value<{ version: number }>('dev.github.pullRequest', {
    pullRequestId: pr,
    refresh: true,
  })
  await planned('dev.github.updatePlan', 'dev.github.updateCommit', {
    pullRequestId: pr,
    expectedVersion: readyRead.version,
    patch: { draft: false },
  })
  check('updatePlan draft=false', !(await summary(pr)).draft, 'marked ready for review')
  const draftRead = await value<{ version: number }>('dev.github.pullRequest', {
    pullRequestId: pr,
    refresh: true,
  })
  await planned('dev.github.updatePlan', 'dev.github.updateCommit', {
    pullRequestId: pr,
    expectedVersion: draftRead.version,
    patch: { draft: true },
  })
  check('updatePlan draft=true (GraphQL)', (await summary(pr)).draft, 'converted back to draft')
  const readyAgain = await value<{ version: number }>('dev.github.pullRequest', {
    pullRequestId: pr,
    refresh: true,
  })
  await planned('dev.github.updatePlan', 'dev.github.updateCommit', {
    pullRequestId: pr,
    expectedVersion: readyAgain.version,
    patch: { draft: false },
  })

  const comment = await value<{ kind: string; body: string }>('dev.github.comment', {
    pullRequestId: pr,
    body: 'A comment with `code` and text $(not a shell)',
  })
  check(
    'comment',
    comment.kind === 'comment' && comment.body.includes('$(not a shell)'),
    'comment created verbatim'
  )

  const head = (await summary(pr)).headSha
  const review = await value<{ kind: string; state: string }>('dev.github.submitReview', {
    pullRequestId: pr,
    expectedHeadSha: head,
    verdict: 'comment',
    body: 'Inline question below.',
    comments: [{ path: 'README.md', line: 3, side: 'right', body: 'Why change line two?' }],
  })
  check('submitReview (comment + inline)', review.kind === 'review', `review ${review.state}`)

  const stale = await call('dev.github.submitReview', {
    pullRequestId: pr,
    expectedHeadSha: 'f'.repeat(40),
    verdict: 'comment',
    body: 'x',
    comments: [],
  })
  check(
    'submitReview stale head refused',
    !stale.ok && stale.error.code === 'stale_version',
    stale.ok ? 'accepted' : stale.error.code
  )

  const timeline = await value<{ items: { kind: string; id: string; resolved?: boolean }[] }>(
    'dev.github.timeline',
    {
      pullRequestId: pr,
      limit: 100,
    }
  )
  const thread = timeline.items.find((item) => item.kind === 'thread')
  check('timeline has the thread', thread !== undefined, `${timeline.items.length} items`)
  if (thread) {
    const replied = await value<{ comments: unknown[] }>('dev.github.threadReply', {
      pullRequestId: pr,
      threadId: thread.id,
      body: 'Because the live pass says so.',
    })
    check('threadReply', replied.comments.length === 2, `${replied.comments.length} comments`)
    const resolved = await value<{ resolved: boolean }>('dev.github.threadResolve', {
      pullRequestId: pr,
      threadId: thread.id,
      resolved: true,
    })
    check('threadResolve true', resolved.resolved, 'resolved')
    const reopened = await value<{ resolved: boolean }>('dev.github.threadResolve', {
      pullRequestId: pr,
      threadId: thread.id,
      resolved: false,
    })
    check('threadResolve false', !reopened.resolved, 'unresolved')
  }

  const labelled = await value<Summary>('dev.github.metadataUpdate', {
    pullRequestId: pr,
    labels: { add: ['scm-live'], remove: [] },
    assignees: { add: [OWNER], remove: [] },
  })
  check(
    'metadataUpdate add',
    labelled.labels.includes('scm-live') && labelled.assignees.some((a) => a.login === OWNER),
    `labels ${labelled.labels.join(',')}`
  )
  const unlabelled = await value<Summary>('dev.github.metadataUpdate', {
    pullRequestId: pr,
    labels: { add: [], remove: ['scm-live'] },
  })
  check('metadataUpdate remove', !unlabelled.labels.includes('scm-live'), 'label removed')

  const settled = await waitFor(
    'checks to finish',
    () => summary(pr),
    (current) => current.checks.total >= 2 && current.checks.running === 0
  )
  check(
    'checks rollup',
    settled.checks.state === 'failure' && settled.checks.failing >= 1,
    JSON.stringify(settled.checks)
  )
  const runs = await value<{ items: { id: string; name: string; conclusion?: string }[] }>(
    'dev.github.checks',
    {
      pullRequestId: pr,
      sha: settled.headSha,
    }
  )
  const failing = runs.items.find((run) => run.conclusion === 'failure')
  check(
    'checks per sha',
    failing !== undefined,
    runs.items.map((run) => `${run.name}:${run.conclusion}`).join(' ')
  )
  if (failing) {
    const log = await value<{ text: string }>('dev.github.checkLog', {
      pullRequestId: pr,
      checkId: failing.id,
    })
    check(
      'checkLog',
      log.text.includes('intentional failure') && !log.text.includes('\u001b'),
      `${log.text.length} chars`
    )
    const rerun = await value<{ runId: string }>('dev.github.rerunFailedJobs', {
      pullRequestId: pr,
      checkId: failing.id,
    })
    check('rerunFailedJobs', rerun.runId.length > 0, `run ${rerun.runId}`)
  }

  const blockedMerge = await value<Plan>('dev.github.mergePlan', {
    pullRequestId: pr,
    expectedHeadSha: settled.headSha,
    method: 'squash',
  })
  check(
    'mergePlan blocks failing checks',
    blockedMerge.blockers.length > 0,
    blockedMerge.blockers.map((b) => b.message).join('; ')
  )

  // Move main on so the branch is behind, then update it on GitHub.
  git(['checkout', '-q', 'main'])
  git(['pull', '-q', '--ff-only', 'origin', 'main'])
  writeFileSync(join(CHECKOUT, 'NOTES.md'), 'main moved on\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'main moves on'])
  git(['push', '-q', 'origin', 'main'])
  const behind = await waitFor(
    'the branch to be behind',
    () => summary(pr),
    (current) => (current.behindBy ?? 0) > 0,
    60
  )
  const synced = await planned<Summary>(
    'dev.github.syncBranchPlan',
    'dev.github.syncBranchCommit',
    {
      pullRequestId: pr,
      expectedHeadSha: behind.headSha,
      method: 'merge',
    }
  )
  if (!('headSha' in synced))
    check('syncBranch merge', false, `blocked: ${synced.blockers.map((b) => b.message).join('; ')}`)
  else {
    // GitHub applies the update asynchronously; wait for the new head.
    const moved = await waitFor(
      'the updated head',
      () => summary(pr),
      (now) => now.headSha !== behind.headSha,
      120
    )
    check(
      'syncBranch merge',
      moved.behindBy === 0,
      `behind ${behind.behindBy} -> ${moved.behindBy ?? '?'}`
    )
  }

  // Auto-merge needs a pull request that cannot merge yet; GitHub decides.
  const current = await summary(pr)
  const auto = await call('dev.github.autoMergePlan', {
    pullRequestId: pr,
    expectedHeadSha: current.headSha,
    enabled: true,
    method: 'squash',
  })
  if (auto.ok) {
    const plan = auto.value as Plan
    if (plan.blockers.length > 0)
      check(
        'autoMergePlan',
        true,
        `typed blockers: ${plan.blockers.map((b) => b.message).join('; ')}`
      )
    else {
      const enabled = await call(
        'dev.github.autoMergeCommit',
        { planId: plan.id, planDigest: plan.digest },
        plan.resource.id
      )
      check(
        'autoMerge enable',
        enabled.ok || ['invalid_state', 'unauthorized'].includes(enabled.error.code),
        enabled.ok ? 'enabled' : `typed: ${enabled.error.message}`
      )
      if (enabled.ok) {
        const disable = await planned<Summary>(
          'dev.github.autoMergePlan',
          'dev.github.autoMergeCommit',
          {
            pullRequestId: pr,
            expectedHeadSha: current.headSha,
            enabled: false,
          }
        )
        check(
          'autoMerge disable',
          'id' in disable &&
            !('blockers' in disable) &&
            (disable as Summary).autoMerge === undefined,
          'disabled'
        )
      }
    }
  } else check('autoMergePlan', false, `${auto.error.code}: ${auto.error.message}`)

  const closeRead = await value<{ version: number }>('dev.github.pullRequest', {
    pullRequestId: pr,
    refresh: true,
  })
  await planned('dev.github.updatePlan', 'dev.github.updateCommit', {
    pullRequestId: pr,
    expectedVersion: closeRead.version,
    patch: { state: 'closed' },
  })
  check('close', (await summary(pr)).state === 'closed', 'closed')
  const reopenRead = await value<{ version: number }>('dev.github.pullRequest', {
    pullRequestId: pr,
    refresh: true,
  })
  await planned('dev.github.updatePlan', 'dev.github.updateCommit', {
    pullRequestId: pr,
    expectedVersion: reopenRead.version,
    patch: { state: 'open' },
  })
  check('reopen', (await summary(pr)).state === 'open', 'reopened')

  // A clean pull request merges and its branch is deleted.
  branch('feat/clean', 'CLEAN.md', 'clean change\n')
  const clean = await value<{ id: string }>('dev.github.createPullRequest', {
    repoId: REPO_ID,
    headRef: 'feat/clean',
    baseRef: 'main',
    title: 'Live pass: clean merge',
    body: '',
    draft: true,
  })
  const cleanRead = await value<{ version: number }>('dev.github.pullRequest', {
    pullRequestId: clean.id,
    refresh: true,
  })
  await planned('dev.github.updatePlan', 'dev.github.updateCommit', {
    pullRequestId: clean.id,
    expectedVersion: cleanRead.version,
    patch: { draft: false },
  })
  const green = await waitFor(
    'clean checks',
    () => summary(clean.id),
    (latest) => latest.checks.total >= 2 && latest.checks.running === 0
  )
  check('clean checks pass', green.checks.state === 'success', JSON.stringify(green.checks))
  const merged = await planned<{ state: string; headBranchDeleted?: boolean }>(
    'dev.github.mergePlan',
    'dev.github.mergeCommit',
    {
      pullRequestId: clean.id,
      expectedHeadSha: green.headSha,
      method: 'squash',
      deleteBranch: true,
    }
  )
  check(
    'merge squash + delete branch',
    'state' in merged && merged.state === 'merged' && merged.headBranchDeleted === true,
    JSON.stringify(merged).slice(0, 160)
  )
  check(
    'head branch gone on GitHub',
    sh('git', ['ls-remote', '--exit-code', 'origin', 'refs/heads/feat/clean'], CHECKOUT).code !== 0,
    'ls-remote'
  )
} catch (error) {
  check('pass', false, (error as Error).message)
}

const failed = results.filter((result) => !result.ok)
mkdirSync('artifacts', { recursive: true })
writeFileSync(
  'artifacts/source-control-live-write.json',
  JSON.stringify({ repository: FULL, results }, null, 2)
)
console.log(
  `\n${results.length - failed.length}/${results.length} passed against ${FULL} (left in place for review).`
)
process.exit(failed.length === 0 ? 0 : 1)
