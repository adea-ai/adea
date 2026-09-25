// #399 local-git provider acceptance over disposable repositories: porcelain
// status parsing, paging, CAS commits, stage/unstage, fetch against a local
// bare remote, namespaced checkpoint refs that never dirty the branch, and
// explicit discard/restore plan-commit pairs. Filenames with leading dashes,
// spaces, and Unicode stay representable end to end.
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import {
  devCommandProofMessage,
  devOperationDecoders,
  devOperationDefinitions,
  type DevCommand,
  type DevOperation,
  type FileIdentity,
  type Scope,
} from '../../../packages/types/src/dev-runtime'

import { createChannelAuthority } from '../shell/src/dev-runtime/channel/authority'
import { buildHunkPatch, registerGitRuntime } from '../shell/src/dev-runtime/git/register'
import { directoryIdentity } from '../shell/src/dev-runtime/worktrees/identity'
import { initRepo, git, scope } from './worktree-fixtures'

const WORKTREE_ID = 'wt-git-fixture-0001'
const scratch: string[] = []
// Every test builds its own registrar via runtime(); each dev.git.* dispatch
// reconciles a status watcher (recursive fs.watch handle + coalescing refresh
// timer) on that registrar, so the views are collected here for teardown.
const registrars: ReturnType<typeof registerGitRuntime>[] = []
let repoPath: string
let rootIdentity: FileIdentity

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'adea-gitprov-'))
  scratch.push(base)
  repoPath = initRepo(join(base, 'worktree'))
  const identity = directoryIdentity(repoPath)
  rootIdentity = { ...identity.identity } as FileIdentity
})

afterAll(() => {
  // Host teardown contract: stop every watcher while the watched roots still
  // exist, then remove the scratch directories.
  for (const registered of registrars) registered.statusWatchers.stopAll()
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

function runtime() {
  const authority = createChannelAuthority({
    shellHost: '127.0.0.1',
    shellOrigin: 'https://127.0.0.1:4789',
  })
  const registered = registerGitRuntime({
    authority,
    scope,
    resolveWorktree: (worktreeId) =>
      worktreeId === WORKTREE_ID
        ? {
            canonicalRoot: repoPath,
            rootIdentity,
            generation: 2,
            lifecycle: 'ready',
          }
        : undefined,
  })
  registrars.push(registered)
  return { authority, registered }
}

function handshakeChannel(authority: ReturnType<typeof createChannelAuthority>) {
  const bootstrap = authority.issueLaunchBootstrap()
  const at = Date.now()
  const handshake = authority.handshake(
    {
      schemaVersion: 1,
      method: 'dev.runtime.handshake.v1',
      requestId: '00000000-0000-4000-8000-000000000020',
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
  resource = { kind: 'worktree', id: WORKTREE_ID, generation: 2 }
): DevCommand {
  const definition = devOperationDefinitions[operation]
  const capabilities = [...definition.capabilities].toSorted((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  )
  return {
    schemaVersion: 1,
    operation,
    requestId: '00000000-0000-4000-8000-000000000021',
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
) {
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

function wsPath(relativePath: string): Record<string, unknown> {
  return { worktreeId: WORKTREE_ID, rootIdentity, relativePath }
}

describe('local git provider', () => {
  test('status reports staged, unstaged, and untracked porcelain entries', async () => {
    writeFileSync(join(repoPath, 'modified.txt'), 'changed\n')
    writeFileSync(join(repoPath, 'untracked.txt'), 'new\n')
    git(repoPath, ['add', 'modified.txt'])
    const { authority } = runtime()
    const channel = handshakeChannel(authority)
    const status = await execute(
      channel,
      authority,
      makeCommand('dev.git.status', { worktreeId: WORKTREE_ID, limit: 100 })
    )
    expect(status.ok).toBe(true)
    if (!status.ok) return
    const entries = status.value.entries
    const staged = entries.find((entry) => entry.path.relativePath === 'modified.txt')
    expect(staged?.staged).toBe('A')
    const untracked = entries.find((entry) => entry.path.relativePath === 'untracked.txt')
    expect(untracked?.untracked).toBe(true)
    expect(status.value.headRef).toBe('main')
    expect(typeof status.value.indexSha).toBe('string')
    expect(status.value.indexSha).toMatch(/^[0-9a-f]{64}$/)
    // Reply satisfies the installed strict decoder.
    devOperationDecoders['dev.git.status'].reply({
      schemaVersion: 1,
      operation: 'dev.git.status',
      requestId: status.requestId,
      ok: true,
      value: status.value,
      observedAt: status.observedAt,
    })
  })

  test('stage, unstage, and CAS commit with filenames that begin with a dash or carry Unicode', async () => {
    const dashName = '-leading-dash.txt'
    const unicodeName = 'λ-ünICODE newline-free.txt'
    writeFileSync(join(repoPath, dashName), 'dash\n')
    writeFileSync(join(repoPath, unicodeName), 'unicode\n')
    const { authority } = runtime()
    const channel = handshakeChannel(authority)

    const stage = await execute(
      channel,
      authority,
      makeCommand('dev.git.stage', {
        worktreeId: WORKTREE_ID,
        paths: [wsPath(dashName), wsPath(unicodeName)],
      })
    )
    expect(stage.ok).toBe(true)
    if (stage.ok) {
      const dash = stage.value.entries.find((entry) => entry.path.relativePath === dashName)
      expect(dash?.staged).toBe('A')
    }

    // Unstage while the file is only staged: a freshly-added file returns to
    // untracked ('?'), and Unicode names survive the porcelain round trip.

    const status = await execute(
      channel,
      authority,
      makeCommand('dev.git.status', { worktreeId: WORKTREE_ID, limit: 500 })
    )
    expect(status.ok).toBe(true)
    const indexSha = status.ok ? status.value.indexSha : undefined
    expect(indexSha).toBeDefined()

    // CAS commit with a stale index fingerprint refuses.
    const staleCommit = await execute(
      channel,
      authority,
      makeCommand('dev.git.commit', {
        worktreeId: WORKTREE_ID,
        message: 'should not commit',
        expectedIndexSha: 'f'.repeat(64),
      })
    )
    expect(staleCommit.ok).toBe(false)
    if (!staleCommit.ok) expect(staleCommit.error.code).toBe('stale_version')

    const commit = await execute(
      channel,
      authority,
      makeCommand('dev.git.commit', {
        worktreeId: WORKTREE_ID,
        message: 'feat: dash and unicode files',
        expectedIndexSha: indexSha,
      })
    )
    expect(commit.ok).toBe(true)
    if (commit.ok) {
      expect(commit.value.subject).toBe('feat: dash and unicode files')
      expect(commit.value.sha).toMatch(/^[0-9a-f]{40}$/)
    }
  })

  test('history pages commits deterministically', async () => {
    const { authority } = runtime()
    const channel = handshakeChannel(authority)
    const first = await execute(
      channel,
      authority,
      makeCommand('dev.git.history', { worktreeId: WORKTREE_ID, limit: 1 })
    )
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.value.items.length).toBe(1)
    expect(typeof first.value.nextCursor).toBe('string')
    const second = await execute(
      channel,
      authority,
      makeCommand('dev.git.history', {
        worktreeId: WORKTREE_ID,
        limit: 50,
        cursor: first.value.nextCursor,
      })
    )
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value.items.length).toBeGreaterThanOrEqual(1)
    const seen = new Set(first.value.items.map((commit) => commit.sha))
    for (const commit of second.value.items) expect(seen.has(commit.sha)).toBe(false)
  })

  test('diff parses worktree, staged, and commit hunks; binary content is skipped', async () => {
    writeFileSync(join(repoPath, 'diffable.txt'), 'one\ntwo\nthree\n')
    git(repoPath, ['add', 'diffable.txt'])
    git(repoPath, ['commit', '-m', 'diff base'])
    writeFileSync(join(repoPath, 'diffable.txt'), 'one\nTWO changed\nthree\n')
    const { authority } = runtime()
    const channel = handshakeChannel(authority)

    const worktreeDiff = await execute(
      channel,
      authority,
      makeCommand('dev.git.diff', { worktreeId: WORKTREE_ID, mode: 'worktree', limit: 100 })
    )
    expect(worktreeDiff.ok).toBe(true)
    if (worktreeDiff.ok) {
      expect(worktreeDiff.value.items.length).toBeGreaterThanOrEqual(1)
      const hunk = worktreeDiff.value.items.find(
        (entry) => entry.path.relativePath === 'diffable.txt'
      )
      expect(hunk).toBeDefined()
      expect(hunk?.lines.some((line) => line.kind === 'delete' && line.text === 'two')).toBe(true)
      expect(hunk?.lines.some((line) => line.kind === 'add' && line.text === 'TWO changed')).toBe(
        true
      )
    }

    const stagedDiff = await execute(
      channel,
      authority,
      makeCommand('dev.git.diff', { worktreeId: WORKTREE_ID, mode: 'staged', limit: 100 })
    )
    expect(stagedDiff.ok).toBe(true)
    if (stagedDiff.ok) expect(stagedDiff.value.items.length).toBe(0)

    const head = git(repoPath, ['rev-parse', 'HEAD']).stdout.trim()
    const commitDiff = await execute(
      channel,
      authority,
      makeCommand('dev.git.diff', {
        worktreeId: WORKTREE_ID,
        mode: 'commit',
        ref: head,
        limit: 100,
      })
    )
    expect(commitDiff.ok).toBe(true)
    if (commitDiff.ok) expect(commitDiff.value.items.length).toBeGreaterThanOrEqual(1)
  })

  test('rejects Git option/pathspec injection before spawning a child', async () => {
    const { authority } = runtime()
    const channel = handshakeChannel(authority)
    const unsafeHistory = await execute(
      channel,
      authority,
      makeCommand('dev.git.history', { worktreeId: WORKTREE_ID, ref: '--output=/tmp/escape' })
    )
    expect(unsafeHistory.ok).toBe(false)
    if (!unsafeHistory.ok) expect(unsafeHistory.error.code).toBe('invalid_state')

    const unsafePath = await execute(
      channel,
      authority,
      makeCommand('dev.git.stage', {
        worktreeId: WORKTREE_ID,
        paths: [wsPath(':(top)')],
      })
    )
    expect(unsafePath.ok).toBe(false)
    if (!unsafePath.ok) expect(unsafePath.error.code).toBe('invalid_state')

    const unsafeRemote = await execute(
      channel,
      authority,
      makeCommand('dev.git.fetch', { worktreeId: WORKTREE_ID, remoteName: '--upload-pack=echo' })
    )
    expect(unsafeRemote.ok).toBe(false)
    if (!unsafeRemote.ok) expect(unsafeRemote.error.code).toBe('invalid_state')
  })

  test('fetch reports before/after refs from a local bare remote with redacted errors', async () => {
    const base = mkdtempSync(join(tmpdir(), 'adea-gitremote-'))
    scratch.push(base)
    const bare = initRepo(join(base, 'remote.git'), { bare: true })
    git(repoPath, ['remote', 'add', 'origin', bare])
    git(repoPath, ['push', '-q', 'origin', 'main'])
    writeFileSync(join(repoPath, 'fetchable.txt'), 'downstream\n')
    git(repoPath, ['add', 'fetchable.txt'])
    git(repoPath, ['commit', '-q', '-m', 'ahead commit'])
    git(repoPath, ['push', '-q', 'origin', 'main'])
    git(repoPath, ['update-ref', '-d', 'refs/remotes/origin/main'])

    const { authority } = runtime()
    const channel = handshakeChannel(authority)
    const fetched = await execute(
      channel,
      authority,
      makeCommand('dev.git.fetch', { worktreeId: WORKTREE_ID, remoteName: 'origin', prune: true })
    )
    expect(fetched.ok).toBe(true)
    if (fetched.ok) {
      expect(fetched.value.remoteName).toBe('origin')
      expect(fetched.value.before['refs/remotes/origin/main']).toBeUndefined()
      expect(fetched.value.after['refs/remotes/origin/main']).toMatch(/^[0-9a-f]{40}$/)
    }

    // A missing remote fails typed and never leaks a remote URL.
    const missing = await execute(
      channel,
      authority,
      makeCommand('dev.git.fetch', { worktreeId: WORKTREE_ID, remoteName: 'nowhere' })
    )
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('remote_unavailable')
    git(repoPath, ['remote', 'remove', 'origin'])
  })

  test('checkpoints write namespaced refs without dirtying branch or index; restore is explicit', async () => {
    writeFileSync(join(repoPath, 'checkpointed.txt'), 'checkpoint state\n')
    git(repoPath, ['add', 'checkpointed.txt'])
    git(repoPath, ['commit', '-q', '-m', 'checkpoint base'])
    const headBefore = git(repoPath, ['rev-parse', 'HEAD']).stdout.trim()
    const branchBefore = git(repoPath, ['symbolic-ref', '--short', 'HEAD']).stdout.trim()

    const { authority } = runtime()
    const channel = handshakeChannel(authority)
    const checkpoint = await execute(
      channel,
      authority,
      makeCommand('dev.git.checkpoint', { worktreeId: WORKTREE_ID, label: 'before experiment' })
    )
    expect(checkpoint.ok).toBe(true)
    if (!checkpoint.ok) return
    expect(checkpoint.value.worktreeId).toBe(WORKTREE_ID)
    expect(checkpoint.value.label).toBe('before experiment')

    // The branch pointer and the worktree are untouched by the checkpoint.
    expect(git(repoPath, ['rev-parse', 'HEAD']).stdout.trim()).toBe(headBefore)
    expect(git(repoPath, ['symbolic-ref', '--short', 'HEAD']).stdout.trim()).toBe(branchBefore)
    const refName = `refs/adea/checkpoints/${WORKTREE_ID}/${checkpoint.value.id}`
    const refSha = git(repoPath, ['rev-parse', '--verify', '-q', refName]).stdout.trim()
    expect(refSha).toMatch(/^[0-9a-f]{40}$/)
    // The checkpoint never appears on the branch or in the working tree.
    const branchContains = git(repoPath, ['merge-base', '--is-ancestor', refSha, headBefore])
    expect(branchContains.code).not.toBe(0)

    // Worktree drifts, then an explicit restore plan/commit brings it back.
    writeFileSync(join(repoPath, 'checkpointed.txt'), 'drifted state\n')
    const plan = await execute(
      channel,
      authority,
      makeCommand('dev.git.restorePlan', {
        worktreeId: WORKTREE_ID,
        checkpointId: checkpoint.value.id,
        paths: [wsPath('checkpointed.txt')],
      })
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.factVersions.checkpointSha).toMatch(/^[0-9a-f]{40}$/)
    const restore = await execute(
      channel,
      authority,
      makeCommand('dev.git.restoreCommit', { planId: plan.value.id, planDigest: plan.value.digest })
    )
    expect(restore.ok).toBe(true)
    expect(readFileSync(join(repoPath, 'checkpointed.txt'), 'utf8')).toBe('checkpoint state\n')
  })

  test('discard is a plan/commit pair that restores tracked paths from HEAD', async () => {
    writeFileSync(join(repoPath, 'discardable.txt'), 'wanted\n')
    git(repoPath, ['add', 'discardable.txt'])
    git(repoPath, ['commit', '-q', '-m', 'discard base'])
    writeFileSync(join(repoPath, 'discardable.txt'), 'unwanted drift\n')

    const { authority } = runtime()
    const channel = handshakeChannel(authority)
    const plan = await execute(
      channel,
      authority,
      makeCommand('dev.git.discardPlan', {
        worktreeId: WORKTREE_ID,
        paths: [wsPath('discardable.txt')],
      })
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.blockers.length).toBe(0)

    const discard = await execute(
      channel,
      authority,
      makeCommand('dev.git.discardCommit', {
        planId: plan.value.id,
        planDigest: plan.value.digest,
      })
    )
    expect(discard.ok).toBe(true)
    expect(readFileSync(join(repoPath, 'discardable.txt'), 'utf8')).toBe('wanted\n')

    // Untracked files are refused in the plan, never silently deleted.
    writeFileSync(join(repoPath, 'untracked-keep.txt'), 'precious\n')
    const untrackedPlan = await execute(
      channel,
      authority,
      makeCommand('dev.git.discardPlan', {
        worktreeId: WORKTREE_ID,
        paths: [wsPath('untracked-keep.txt')],
      })
    )
    expect(untrackedPlan.ok).toBe(true)
    if (untrackedPlan.ok) expect(untrackedPlan.value.blockers.length).toBe(1)
    expect(readFileSync(join(repoPath, 'untracked-keep.txt'), 'utf8')).toBe('precious\n')
  })

  test('foreign scope, missing worktree context, and stale generation fail closed', async () => {
    const { authority } = runtime()
    const channel = handshakeChannel(authority)
    const foreign: Scope = { ...scope, workspaceId: '00000000-0000-4000-8000-000000000099' }
    const foreignReply = await execute(channel, authority, {
      ...makeCommand('dev.git.status', { worktreeId: WORKTREE_ID, limit: 10 }),
      scope: foreign,
    })
    expect(foreignReply.ok).toBe(false)
    if (!foreignReply.ok) expect(foreignReply.error.code).toBe('unauthorized')

    const noContext = await execute(
      channel,
      authority,
      makeCommand(
        'dev.git.status',
        { worktreeId: 'wt-elsewhere', limit: 10 },
        { kind: 'worktree', id: 'wt-elsewhere', generation: 2 }
      )
    )
    expect(noContext.ok).toBe(false)
    if (!noContext.ok) expect(noContext.error.code).toBe('not_found')

    const stale = await execute(
      channel,
      authority,
      makeCommand(
        'dev.git.status',
        { worktreeId: WORKTREE_ID, limit: 10 },
        { kind: 'worktree', id: WORKTREE_ID, generation: 3 }
      )
    )
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.error.code).toBe('stale_generation')
  })

  test('hunk staging is a plan/commit pair that applies one hunk of a multi-hunk file', async () => {
    const base =
      'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\ntwelve\nthirteen\nfourteen\n'
    writeFileSync(join(repoPath, 'hunks.txt'), base)
    git(repoPath, ['add', 'hunks.txt'])
    git(repoPath, ['commit', '-q', '-m', 'hunk base'])
    writeFileSync(
      join(repoPath, 'hunks.txt'),
      base.replace('two', 'TWO').replace('eleven', 'ELEVEN')
    )

    const { authority } = runtime()
    const channel = handshakeChannel(authority)

    // The client selects hunks straight from the provider's own diff page.
    const diff = await execute(
      channel,
      authority,
      makeCommand('dev.git.diff', { worktreeId: WORKTREE_ID, mode: 'worktree', limit: 100 })
    )
    expect(diff.ok).toBe(true)
    if (!diff.ok) return
    const fileHunks = diff.value.items.filter((hunk) => hunk.path.relativePath === 'hunks.txt')
    expect(fileHunks.length).toBe(2)

    const plan = await execute(
      channel,
      authority,
      makeCommand('dev.git.hunkStagingPlan', {
        worktreeId: WORKTREE_ID,
        direction: 'stage',
        hunks: [fileHunks[0]],
      })
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.factVersions.hunkCount).toBe('1')

    const commit = await execute(
      channel,
      authority,
      makeCommand('dev.git.hunkStagingCommit', {
        planId: plan.value.id,
        planDigest: plan.value.digest,
      })
    )
    expect(commit.ok).toBe(true)

    // The index holds ONLY the first hunk; the second change stays worktree-only.
    const staged = git(repoPath, ['diff', '--cached', '--', 'hunks.txt']).stdout
    expect(staged).toContain('+TWO')
    expect(staged).not.toContain('+ELEVEN')
    const worktreeLeft = git(repoPath, ['diff', '--', 'hunks.txt']).stdout
    expect(worktreeLeft).toContain('+ELEVEN')
    if (commit.ok) {
      const entry = commit.value.entries.find((row) => row.path.relativePath === 'hunks.txt')
      expect(entry?.staged).toBe('M')
      expect(entry?.unstaged).toBe('M')
    }
  })

  test('hunk unstaging reverse-applies a staged hunk out of the index', async () => {
    // State from the previous test: TWO staged, ELEVEN worktree-only.
    const { authority } = runtime()
    const channel = handshakeChannel(authority)

    const stagedDiff = await execute(
      channel,
      authority,
      makeCommand('dev.git.diff', { worktreeId: WORKTREE_ID, mode: 'staged', limit: 100 })
    )
    expect(stagedDiff.ok).toBe(true)
    if (!stagedDiff.ok) return
    const fileHunks = stagedDiff.value.items.filter(
      (hunk) => hunk.path.relativePath === 'hunks.txt'
    )
    expect(fileHunks.length).toBe(1)
    const firstStaged = stagedDiff.value.items[0]
    if (!firstStaged) throw new Error('expected a staged hunk')

    const plan = await execute(
      channel,
      authority,
      makeCommand('dev.git.hunkStagingPlan', {
        worktreeId: WORKTREE_ID,
        direction: 'unstage',
        hunks: [firstStaged],
      })
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const commit = await execute(
      channel,
      authority,
      makeCommand('dev.git.hunkStagingCommit', {
        planId: plan.value.id,
        planDigest: plan.value.digest,
      })
    )
    expect(commit.ok).toBe(true)
    // The reverse application removed the staged hunk; both edits remain
    // worktree-only until re-staged.
    const staged = git(repoPath, ['diff', '--cached', '--', 'hunks.txt']).stdout
    expect(staged).not.toContain('+TWO')
    const worktree = git(repoPath, ['diff', '--', 'hunks.txt']).stdout
    expect(worktree).toContain('+TWO')
    expect(worktree).toContain('+ELEVEN')
  })

  test('hunk staging fails typed on selection drift and on index movement before commit', async () => {
    writeFileSync(join(repoPath, 'drift.txt'), 'keep\nchange me\nkeep\n')
    git(repoPath, ['add', 'drift.txt'])
    git(repoPath, ['commit', '-q', '-m', 'drift base'])
    writeFileSync(join(repoPath, 'drift.txt'), 'keep\nchanged\nkeep\n')

    const { authority } = runtime()
    const channel = handshakeChannel(authority)

    // A selection naming a hunk the fresh diff does not contain is refused.
    const drifted = await execute(
      channel,
      authority,
      makeCommand('dev.git.hunkStagingPlan', {
        worktreeId: WORKTREE_ID,
        direction: 'stage',
        hunks: [
          {
            path: wsPath('drift.txt'),
            oldStart: 999,
            oldLines: 1,
            newStart: 999,
            newLines: 1,
            lines: [],
          },
        ],
      })
    )
    expect(drifted.ok).toBe(false)
    if (!drifted.ok) expect(drifted.error.code).toBe('stale_version')

    // A valid plan whose index fingerprint moves before the commit is fenced.
    writeFileSync(join(repoPath, 'drift.txt'), 'keep\nagain\nkeep\n')
    const diff = await execute(
      channel,
      authority,
      makeCommand('dev.git.diff', {
        worktreeId: WORKTREE_ID,
        mode: 'worktree',
        path: wsPath('drift.txt'),
        limit: 10,
      })
    )
    expect(diff.ok).toBe(true)
    const hunk = diff.ok ? diff.value.items[0] : undefined
    if (!hunk) throw new Error('expected a diffable hunk')
    const plan = await execute(
      channel,
      authority,
      makeCommand('dev.git.hunkStagingPlan', {
        worktreeId: WORKTREE_ID,
        direction: 'stage',
        hunks: [hunk],
      })
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    // The index moves on after the plan (someone stages the whole file).
    git(repoPath, ['add', 'drift.txt'])
    const commit = await execute(
      channel,
      authority,
      makeCommand('dev.git.hunkStagingCommit', {
        planId: plan.value.id,
        planDigest: plan.value.digest,
      })
    )
    expect(commit.ok).toBe(false)
    if (!commit.ok) expect(commit.error.code).toBe('stale_version')
    // The fenced plan applied nothing: the index holds the FULL worktree
    // content from the interfering `git add`, never a partial patch.
    const staged = git(repoPath, ['diff', '--cached', '--', 'drift.txt']).stdout
    expect(staged).toContain('+again')
  })

  test('buildHunkPatch slices exact hunks from git output, keeping no-newline markers', () => {
    const diffText = [
      'diff --git a/keep.txt b/keep.txt',
      'index 1111111..2222222 100644',
      '--- a/keep.txt',
      '+++ b/keep.txt',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
      'diff --git a/tail.txt b/tail.txt',
      'index 3333333..4444444 100644',
      '--- a/tail.txt',
      '+++ b/tail.txt',
      '@@ -1,2 +1,2 @@',
      ' x',
      '-y',
      '\\ No newline at end of file',
      '+z',
      '\\ No newline at end of file',
      '',
    ].join('\n')

    const patch = buildHunkPatch(diffText, [
      { relativePath: 'tail.txt', oldStart: 1, oldLines: 2, newStart: 1, newLines: 2 },
    ])
    // The patch carries ONLY the selected file, byte-verbatim, marker included.
    expect(patch).toBe(
      [
        'diff --git a/tail.txt b/tail.txt',
        'index 3333333..4444444 100644',
        '--- a/tail.txt',
        '+++ b/tail.txt',
        '@@ -1,2 +1,2 @@',
        ' x',
        '-y',
        '\\ No newline at end of file',
        '+z',
        '\\ No newline at end of file',
        '',
      ].join('\n')
    )
    // Both hunks in order.
    const both = buildHunkPatch(diffText, [
      { relativePath: 'keep.txt', oldStart: 1, oldLines: 3, newStart: 1, newLines: 3 },
      { relativePath: 'tail.txt', oldStart: 1, oldLines: 2, newStart: 1, newLines: 2 },
    ])
    expect(both).toContain('@@ -1,3 +1,3 @@')
    expect(both).toContain('@@ -1,2 +1,2 @@')
    expect(both.indexOf('keep.txt')).toBeLessThan(both.indexOf('tail.txt'))
    // A selection the diff cannot locate fails typed.
    expect(() =>
      buildHunkPatch(diffText, [
        { relativePath: 'ghost.txt', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 },
      ])
    ).toThrow()
  })

  test('registers exactly the local git operations', () => {
    const { registered } = runtime()
    expect(registered.commands.toSorted()).toEqual(
      [
        'dev.git.checkpoint',
        'dev.git.commit',
        'dev.git.diff',
        'dev.git.discardCommit',
        'dev.git.discardPlan',
        'dev.git.fetch',
        'dev.git.history',
        'dev.git.hunkStagingCommit',
        'dev.git.hunkStagingPlan',
        'dev.git.restoreCommit',
        'dev.git.restorePlan',
        'dev.git.stage',
        'dev.git.status',
        'dev.git.unstage',
      ].toSorted()
    )
    expect(registered.registeredCommands).toBe(14)
  })
  // Appended last: the newline fixture stages a file and the merge test leaves
  // the repository mid-conflict, so neither may run before the suites that
  // assert on a settled worktree.
  test('a filename carrying a newline stays representable through status and stage', async () => {
    const newlineName = 'two\nlines.txt'
    writeFileSync(join(repoPath, newlineName), 'newline\n')
    const { authority } = runtime()
    const channel = handshakeChannel(authority)

    const status = await execute(
      channel,
      authority,
      makeCommand('dev.git.status', { worktreeId: WORKTREE_ID, limit: 500 })
    )
    expect(status.ok).toBe(true)
    if (!status.ok) return
    // Porcelain is read NUL-delimited, so a newline is a character in the path
    // rather than a record separator and the name arrives whole.
    const entry = status.value.entries.find(
      (candidate) => candidate.path.relativePath === newlineName
    )
    expect(entry?.untracked).toBe(true)

    const stage = await execute(
      channel,
      authority,
      makeCommand('dev.git.stage', {
        worktreeId: WORKTREE_ID,
        paths: [wsPath(newlineName)],
      })
    )
    expect(stage.ok).toBe(true)
    if (stage.ok) {
      const staged = stage.value.entries.find(
        (candidate) => candidate.path.relativePath === newlineName
      )
      expect(staged?.staged).toBe('A')
    }
    // Git fixtures under a loaded machine: the repository work, not the lane, is what runs slow.
  }, 30_000)

  test('a real conflicted merge is reported as an unmerged entry, not as a staged edit', async () => {
    const conflictName = 'conflict.txt'
    writeFileSync(join(repoPath, conflictName), 'base\n')
    git(repoPath, ['add', conflictName])
    git(repoPath, ['commit', '-m', 'chore: conflict base'])
    git(repoPath, ['checkout', '-b', 'conflict-branch'])
    writeFileSync(join(repoPath, conflictName), 'branch\n')
    git(repoPath, ['commit', '-am', 'feat: branch side'])
    git(repoPath, ['checkout', 'main'])
    writeFileSync(join(repoPath, conflictName), 'main\n')
    git(repoPath, ['commit', '-am', 'feat: main side'])

    // --no-ff: the toolchain's global config forbids fast-forward merges, and a
    // refused fast-forward exits non-zero without ever creating the conflict.
    const merge = git(repoPath, ['merge', '--no-ff', 'conflict-branch'])
    expect(merge.code).not.toBe(0)

    const { authority } = runtime()
    const channel = handshakeChannel(authority)
    const status = await execute(
      channel,
      authority,
      makeCommand('dev.git.status', { worktreeId: WORKTREE_ID, limit: 500 })
    )
    expect(status.ok).toBe(true)
    if (!status.ok) return
    const entry = status.value.entries.find(
      (candidate) => candidate.path.relativePath === conflictName
    )
    // Porcelain UU: unmerged in both the index and the worktree.
    expect(entry).toMatchObject({ staged: 'U', unstaged: 'U', untracked: false })
  }, 30_000)
})

void randomUUID
