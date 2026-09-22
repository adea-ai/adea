// The watcher lane's status read rides the authority gate (M12): the git
// registrar's injected `readStatus` seam dispatches the REGISTERED
// `dev.git.status` provider through `authority.dispatchLocal` — the in-process
// lane that runs the same terminal admission steps as the socket path — never
// a private call into the porcelain helpers. This suite proves the dispatch
// evidence on a real disposable repository with a scripted watcher handle and
// a manual clock shared by the registrar AND the authority: a refresh that
// fills the cache leaves `command_accepted` audit records with NO channel
// fields (the internal-lane signature) even though no socket path ever ran.
import { randomBytes, randomUUID } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  devOperationDefinitions,
  type DevCommand,
  type FileIdentity,
} from '../../../packages/types/src/dev-runtime'

import {
  createChannelAuthority,
  INTERNAL_DISPATCH_MARKER,
} from '../shell/src/dev-runtime/channel/authority'
import { registerGitRuntime } from '../shell/src/dev-runtime/git/register'
import {
  STATUS_WATCHER_LIMITS,
  createRefreshGate,
  type OpenWatcher,
  type StatusWatchEvent,
} from '../shell/src/dev-runtime/git/status-watcher'
import { directoryIdentity } from '../shell/src/dev-runtime/worktrees/identity'
import { initRepo, scope } from './worktree-fixtures'

const WORKTREE_ID = 'wt-watcher-dispatch-0001'

/** Deterministic clock + timer wheel shared by the registrar and the
 *  authority, so the watcher's envelopes are always fresh to the gate. */
function manualClock() {
  let nowMs = Date.now()
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = []
  return {
    now: (): number => nowMs,
    schedule(fn: () => void, ms: number): () => void {
      const timer = { at: nowMs + ms, fn, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    advance(ms: number): void {
      const deadline = nowMs + ms
      for (const timer of timers.toSorted((left, right) => left.at - right.at)) {
        if (timer.cancelled || timer.at > deadline) continue
        timer.cancelled = true
        nowMs = Math.max(nowMs, timer.at)
        timer.fn()
      }
      nowMs = deadline
    },
  }
}

/** Scripted watcher handle whose events the test fires directly. */
function scriptedWatcher(): {
  open: OpenWatcher
  fire: () => void
  closed: () => boolean
} {
  let onEvent: (() => void) | undefined
  let closed = false
  return {
    open: (handlers) => {
      onEvent = handlers.onEvent
      return {
        close: () => {
          closed = true
        },
      }
    },
    fire: () => onEvent?.(),
    closed: () => closed,
  }
}

function makeStatusCommand(worktreeId: string, generation: number): DevCommand {
  const definition = devOperationDefinitions['dev.git.status']
  return {
    schemaVersion: 1,
    operation: 'dev.git.status',
    requestId: randomUUID(),
    nonce: Buffer.from(randomBytes(16)).toString('base64url'),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    scope,
    capabilities: [...definition.capabilities],
    resource: { kind: 'worktree', id: worktreeId, generation },
    body: { worktreeId, limit: 100 },
  }
}

async function waitUntil(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('watcher condition not met before its timeout')
}

describe('watcher status reads ride the authority gate (dispatchLocal)', () => {
  test('a watcher refresh dispatches the registered provider through dispatchLocal, audited without channel fields', async () => {
    const base = mkdtempSync(join(tmpdir(), 'adea-watcher-gate-'))
    try {
      const repoPath = initRepo(join(base, 'worktree'))
      mkdirSync(join(repoPath, 'src'), { recursive: true })
      writeFileSync(join(repoPath, 'tracked.txt'), 'one\n')
      const identity = directoryIdentity(repoPath)
      const rootIdentity = { ...identity.identity } as FileIdentity

      const clock = manualClock()
      const watcher = scriptedWatcher()
      const events: StatusWatchEvent[] = []
      // One manual clock shared by the authority and the registrar: the
      // watcher's envelopes are always fresh to the gate it dispatches into.
      const authority = createChannelAuthority({
        now: clock.now,
        shellHost: '127.0.0.1',
        shellOrigin: 'https://127.0.0.1:4789',
      })
      const registered = registerGitRuntime({
        authority,
        scope,
        now: clock.now,
        resolveWorktree: (worktreeId) =>
          worktreeId === WORKTREE_ID
            ? { canonicalRoot: repoPath, rootIdentity, generation: 3, lifecycle: 'ready' }
            : undefined,
        onWatcherEvent: (event) => events.push(event),
        watcher: {
          openWatcher: watcher.open,
          schedule: clock.schedule,
          gate: createRefreshGate(STATUS_WATCHER_LIMITS.maxRefreshConcurrency),
        },
      })
      try {
        // No socket path exists in this suite: no handshake, no signed frame.
        expect(authority.activeChannelIds().length).toBe(0)

        // The construction dispatch (an internal-lane dispatch itself)
        // reconciles the watcher map: the ready sighting starts the watcher.
        const bootstrapReply = await authority.dispatchLocal(
          INTERNAL_DISPATCH_MARKER,
          makeStatusCommand(WORKTREE_ID, 3)
        )
        expect(bootstrapReply.ok).toBe(true)
        expect(registered.statusWatchers.snapshot(WORKTREE_ID)).toMatchObject({
          worktreeId: WORKTREE_ID,
          generation: 3,
          mode: 'watching',
        })

        // A real tree move, fired through the scripted handle: 250 ms
        // coalesce → ONE invalidation → one refresh read THROUGH THE GATE.
        writeFileSync(join(repoPath, 'tracked.txt'), 'one\ntwo\n')
        watcher.fire()
        clock.advance(STATUS_WATCHER_LIMITS.coalesceMs + 1)
        await waitUntil(() => events.some((event) => event.reason === 'refreshed'))

        // The cache repopulated with real status bytes read through the gate.
        const snapshot = registered.statusWatchers.snapshot(WORKTREE_ID)
        expect(snapshot).toMatchObject({ generation: 3, stale: false, cachedGeneration: 3 })

        // Dispatch evidence: every accepted dev.git.status record carries NO
        // channel fields — the internal-lane signature — and the socket lane
        // never contributed a single record.
        const accepted = authority
          .auditSnapshot()
          .filter((record) => record.kind === 'command_accepted')
        expect(accepted.length).toBeGreaterThanOrEqual(2)
        for (const record of accepted) {
          expect(record.operation).toBe('dev.git.status')
          expect(record.channelId).toBeUndefined()
          expect(record.clientCredentialId).toBeUndefined()
        }
        expect(authority.countersSnapshot().commandsAccepted).toBe(accepted.length)
        expect(authority.countersSnapshot().commandsRefused).toBe(0)
      } finally {
        registered.statusWatchers.stopAll()
      }
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }, 20_000)

  test('a stale-generation envelope refuses at the gate and the cache stays honestly empty', async () => {
    const base = mkdtempSync(join(tmpdir(), 'adea-watcher-gate-race-'))
    try {
      const repoPath = initRepo(join(base, 'worktree'))
      const identity = directoryIdentity(repoPath)
      const rootIdentity = { ...identity.identity } as FileIdentity
      const watcher = scriptedWatcher()
      const events: StatusWatchEvent[] = []
      const authority = createChannelAuthority({
        shellHost: '127.0.0.1',
        shellOrigin: 'https://127.0.0.1:4789',
      })
      const registered = registerGitRuntime({
        authority,
        scope,
        resolveWorktree: (worktreeId) =>
          worktreeId === WORKTREE_ID
            ? { canonicalRoot: repoPath, rootIdentity, generation: 4, lifecycle: 'ready' }
            : undefined,
        onWatcherEvent: (event) => events.push(event),
        watcher: {
          openWatcher: watcher.open,
          schedule: () => () => undefined,
        },
      })
      try {
        // The live record sits at generation 4; the envelope pins 3 — the
        // lost-race shape the watcher lane must survive honestly.
        const reply = await authority.dispatchLocal(
          INTERNAL_DISPATCH_MARKER,
          makeStatusCommand(WORKTREE_ID, 3)
        )
        expect(reply.ok).toBe(false)
        if (!reply.ok) expect(reply.error.code).toBe('stale_generation')
        // Reconcile ran on the resolution path (the watcher map tracks the
        // live record even when the command is then refused), but the
        // refused read left no cached state behind.
        const snapshot = registered.statusWatchers.snapshot(WORKTREE_ID)
        expect(snapshot).toMatchObject({ generation: 4, mode: 'watching' })
        expect(snapshot?.stale).toBe(true)
        expect(snapshot?.cachedGeneration).toBeUndefined()
        expect(authority.countersSnapshot().commandsAccepted).toBe(0)
        expect(authority.countersSnapshot().commandsRefused).toBe(1)
      } finally {
        registered.statusWatchers.stopAll()
      }
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
