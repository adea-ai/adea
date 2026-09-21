// Watcher-driven git status invalidation (#399 residue): bursts coalesce
// into one invalidation and at most one refresh (injected scheduler, no real
// sleeps), every cache entry and in-flight refresh is generation-fenced, a
// watcher that cannot open or that fails mid-stream degrades to the bounded
// stat-fingerprint lane (no faster than the 60-second floor), concurrent
// refreshes dedupe through the bounded gate, and stop/restart is clean. All
// clocks and timers are injected.
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  devCommandProofMessage,
  devOperationDefinitions,
  type DevCommand,
  type DevReply,
  type FileIdentity,
} from '../../../packages/types/src/dev-runtime'
import { createChannelAuthority } from '../shell/src/dev-runtime/channel/authority'
import { registerGitRuntime } from '../shell/src/dev-runtime/git/register'
import {
  STATUS_WATCHER_LIMITS,
  createRefreshGate,
  createWorktreeStatusWatcher,
  worktreeStatusFingerprint,
  type OpenWatcher,
  type StatusWatchEvent,
  type WatcherHandle,
} from '../shell/src/dev-runtime/git/status-watcher'
import { directoryIdentity } from '../shell/src/dev-runtime/worktrees/identity'
import { initRepo, scope } from './worktree-fixtures'

/** Deterministic clock + timer wheel: no real sleeps anywhere. */
function manualClock() {
  let nowMs = 1_000_000
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
    get pendingTimers(): number {
      return timers.filter((timer) => !timer.cancelled).length
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
  fail: () => void
  closed: () => boolean
} {
  let onEvent: (() => void) | undefined
  let onFailed: (() => void) | undefined
  let closed = false
  return {
    open: (handlers) => {
      onEvent = handlers.onEvent
      onFailed = handlers.onFailed
      return {
        close: () => {
          closed = true
        },
      } satisfies WatcherHandle
    },
    fire: () => onEvent?.(),
    fail: () => onFailed?.(),
    closed: () => closed,
  }
}

function watcherRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'adea-status-watcher-'))
  // The stat facts a worktree really has.
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(join(root, '.git', 'index'), 'INDEX')
  return root
}

/** Drains pending microtasks until the predicate holds (or gives up). */
async function flushUntil(predicate: () => boolean): Promise<void> {
  for (let round = 0; round < 50 && !predicate(); round += 1) {
    await Promise.resolve()
  }
}

describe('burst coalescing', () => {
  test('a thousand-event burst schedules one window, invalidates once, refreshes once', async () => {
    const clock = manualClock()
    const handle = scriptedWatcher()
    const events: StatusWatchEvent[] = []
    let reads = 0
    const watcher = createWorktreeStatusWatcher<string>({
      worktreeId: 'wt-1',
      generation: 3,
      canonicalRoot: watcherRoot(),
      readStatus: async () => {
        reads += 1
        return `status-${reads}`
      },
      onChange: (event) => events.push(event),
      openWatcher: handle.open,
      now: clock.now,
      schedule: clock.schedule,
    })
    watcher.start()
    watcher.subscribe(() => undefined)
    // A whole burst inside one window: the scheduler must hold exactly one
    // pending window the entire time.
    for (let index = 0; index < 1000; index += 1) handle.fire()
    expect(clock.pendingTimers).toBe(1)
    // The window has not elapsed: nothing invalidated, nothing read.
    expect(watcher.cached()).toBeUndefined()
    expect(reads).toBe(0)
    // One tick under the window: still pending, nothing read.
    clock.advance(STATUS_WATCHER_LIMITS.coalesceMs - 1)
    expect(clock.pendingTimers).toBe(1)
    expect(reads).toBe(0)
    // The window elapses: exactly one invalidation, exactly one read.
    clock.advance(1)
    await flushUntil(() => reads > 0)
    await flushUntil(() => watcher.cached() !== undefined)
    expect(reads).toBe(1)
    expect(watcher.cached()).toBe('status-1')
    expect(clock.pendingTimers).toBe(0)
    // Events landing after the tick start a NEW window.
    handle.fire()
    expect(clock.pendingTimers).toBe(1)
    // The invalidation was announced once, with the fenced generation.
    const treeChanged = events.filter((event) => event.reason === 'tree_changed')
    expect(treeChanged.length).toBe(1)
    expect(treeChanged[0]).toMatchObject({ worktreeId: 'wt-1', generation: 3, revision: 2 })
    clock.advance(STATUS_WATCHER_LIMITS.coalesceMs)
    await flushUntil(() => reads > 1)
    expect(reads).toBe(2)
    expect(events.filter((event) => event.reason === 'refreshed').length).toBe(1)
    watcher.stop()
  })
})

describe('generation fencing', () => {
  test('an in-flight refresh from a fenced generation never publishes', async () => {
    const clock = manualClock()
    const handle = scriptedWatcher()
    const resolvers: Array<(value: string | undefined) => void> = []
    const watcher = createWorktreeStatusWatcher<string>({
      worktreeId: 'wt-1',
      generation: 7,
      canonicalRoot: watcherRoot(),
      readStatus: () =>
        new Promise<string | undefined>((resolve) => {
          resolvers.push(resolve)
        }),
      openWatcher: handle.open,
      now: clock.now,
      schedule: clock.schedule,
    })
    watcher.start()
    const pending = watcher.refresh()
    await flushUntil(() => resolvers.length === 1)
    // The read is stuck in flight; the worktree is re-fenced underneath it.
    watcher.refence(8)
    expect(watcher.snapshot()).toMatchObject({ generation: 8, stale: true })
    resolvers[0]!('status-from-generation-7')
    // The result describes the dead generation: discarded, never published.
    expect(await pending).toBeUndefined()
    expect(watcher.cached()).toBeUndefined()
    // A post-fence refresh publishes normally under the new generation.
    const fresh = watcher.refresh()
    await flushUntil(() => resolvers.length === 2)
    resolvers[1]!('status-from-generation-8')
    expect(await fresh).toBe('status-from-generation-8')
    expect(watcher.snapshot().cachedGeneration).toBe(8)
    watcher.stop()
  })

  test('a completed cache entry dies with its generation', async () => {
    const clock = manualClock()
    const handle = scriptedWatcher()
    const watcher = createWorktreeStatusWatcher<string>({
      worktreeId: 'wt-1',
      generation: 1,
      canonicalRoot: watcherRoot(),
      readStatus: async () => 'status-v1',
      openWatcher: handle.open,
      now: clock.now,
      schedule: clock.schedule,
    })
    watcher.start()
    await watcher.refresh()
    expect(watcher.snapshot().cachedGeneration).toBe(1)
    watcher.refence(2)
    expect(watcher.cached()).toBeUndefined()
    expect(watcher.snapshot().stale).toBe(true)
    watcher.stop()
  })
})

describe('degraded fingerprint lane', () => {
  test('an unopenable watcher degrades at start and invalidates no faster than the floor', () => {
    const clock = manualClock()
    const root = watcherRoot()
    try {
      const events: StatusWatchEvent[] = []
      const watcher = createWorktreeStatusWatcher<string>({
        worktreeId: 'wt-1',
        generation: 1,
        canonicalRoot: root,
        readStatus: async () => 'status',
        onChange: (event) => events.push(event),
        openWatcher: () => undefined,
        now: clock.now,
        schedule: clock.schedule,
      })
      watcher.start()
      expect(watcher.snapshot().mode).toBe('degraded')
      expect(events.map((event) => event.reason)).toContain('degraded')
      // Baseline fingerprint taken; a real tree change is invisible until
      // the 60-second floor elapses — no matter how often it is read.
      writeFileSync(join(root, 'changed.txt'), 'one')
      utimesSync(join(root, '.git', 'index'), new Date(clock.now()), new Date(clock.now()))
      clock.advance(30_000)
      expect(watcher.cached()).toBeUndefined()
      clock.advance(31_000)
      watcher.cached()
      // The floor elapsed AND the fingerprint moved: invalidated.
      expect(watcher.snapshot().stale).toBe(true)
      expect(events.filter((event) => event.reason === 'tree_changed').length).toBe(1)
      watcher.stop()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('an unchanged tree never invalidates, however often it is read', () => {
    const clock = manualClock()
    const root = watcherRoot()
    try {
      const events: StatusWatchEvent[] = []
      const watcher = createWorktreeStatusWatcher<string>({
        worktreeId: 'wt-1',
        generation: 1,
        canonicalRoot: root,
        onChange: (event) => events.push(event),
        openWatcher: () => undefined,
        now: clock.now,
        schedule: clock.schedule,
      })
      watcher.start()
      for (let day = 0; day < 5; day += 1) {
        clock.advance(STATUS_WATCHER_LIMITS.fingerprintMinIntervalMs + 1)
        watcher.cached()
      }
      expect(events.filter((event) => event.reason === 'tree_changed').length).toBe(0)
      watcher.stop()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a watcher that fails mid-stream degrades once and ignores further events', () => {
    const clock = manualClock()
    const handle = scriptedWatcher()
    const events: StatusWatchEvent[] = []
    const watcher = createWorktreeStatusWatcher<string>({
      worktreeId: 'wt-1',
      generation: 1,
      canonicalRoot: watcherRoot(),
      onChange: (event) => events.push(event),
      openWatcher: handle.open,
      now: clock.now,
      schedule: clock.schedule,
    })
    watcher.start()
    handle.fail()
    expect(watcher.snapshot().mode).toBe('degraded')
    expect(events.filter((event) => event.reason === 'degraded').length).toBe(1)
    // Events after the death are not watching events; nothing re-fires.
    handle.fire()
    expect(clock.pendingTimers).toBe(0)
    handle.fail()
    expect(events.filter((event) => event.reason === 'degraded').length).toBe(1)
    watcher.stop()
  })
})

describe('refresh dedup and the bounded gate', () => {
  test('concurrent refreshes dedupe onto one read; the gate caps concurrency', async () => {
    const clock = manualClock()
    const handle = scriptedWatcher()
    const gate = createRefreshGate(1)
    const resolvers: Array<(value: string | undefined) => void> = []
    const watcher = createWorktreeStatusWatcher<string>({
      worktreeId: 'wt-1',
      generation: 1,
      canonicalRoot: watcherRoot(),
      readStatus: () =>
        new Promise<string | undefined>((resolve) => {
          resolvers.push(resolve)
        }),
      openWatcher: handle.open,
      gate,
      now: clock.now,
      schedule: clock.schedule,
    })
    watcher.start()
    const first = watcher.refresh()
    await flushUntil(() => resolvers.length === 1)
    const second = watcher.refresh()
    expect(second).toBe(first)
    resolvers[0]!('status-once')
    expect(await first).toBe('status-once')
    expect(await second).toBe('status-once')
    expect(resolvers.length).toBe(1)
    expect(watcher.cached()).toBe('status-once')
    // A finished refresh clears the dedupe slot; the next call reads again.
    const third = watcher.refresh()
    await flushUntil(() => resolvers.length === 2)
    resolvers[1]!('status-once-again')
    expect(await third).toBe('status-once-again')
    watcher.stop()
  })

  test('a shared gate with one slot serializes two watchers', async () => {
    const gate = createRefreshGate(1)
    let releaseA: ((value: string | undefined) => void) | undefined
    let readB: (() => void) | undefined
    const clock = manualClock()
    const watcherA = createWorktreeStatusWatcher<string>({
      worktreeId: 'wt-a',
      generation: 1,
      canonicalRoot: watcherRoot(),
      readStatus: () =>
        new Promise<string | undefined>((resolve) => {
          releaseA = resolve
        }),
      openWatcher: () => undefined,
      gate,
      now: clock.now,
      schedule: clock.schedule,
    })
    const watcherB = createWorktreeStatusWatcher<string>({
      worktreeId: 'wt-b',
      generation: 1,
      canonicalRoot: watcherRoot(),
      readStatus: () =>
        new Promise<string | undefined>((resolve) => {
          readB = () => resolve('b')
        }),
      openWatcher: () => undefined,
      gate,
      now: clock.now,
      schedule: clock.schedule,
    })
    const a = watcherA.refresh()
    await flushUntil(() => releaseA !== undefined)
    const b = watcherB.refresh()
    await flushUntil(() => gate.waiting === 1)
    // B waits for the single slot while A holds it.
    expect(gate.active).toBe(1)
    expect(gate.waiting).toBe(1)
    releaseA?.('a')
    expect(await a).toBe('a')
    await flushUntil(() => readB !== undefined)
    readB?.()
    expect(await b).toBe('b')
    expect(gate.active).toBe(0)
    watcherA.stop()
    watcherB.stop()
  })
})

describe('manual invalidation, stop, and restart', () => {
  test('invalidate clears the cache; stop is loud once and restart rewatches', async () => {
    const clock = manualClock()
    const handle = scriptedWatcher()
    const events: StatusWatchEvent[] = []
    const watcher = createWorktreeStatusWatcher<string>({
      worktreeId: 'wt-1',
      generation: 1,
      canonicalRoot: watcherRoot(),
      readStatus: async () => 'status',
      onChange: (event) => events.push(event),
      openWatcher: handle.open,
      now: clock.now,
      schedule: clock.schedule,
    })
    watcher.start()
    await watcher.refresh()
    expect(watcher.cached()).toBe('status')
    watcher.invalidate()
    expect(watcher.cached()).toBeUndefined()
    // Stopping with a dirty (invalidated) cache is silent; a held cache
    // announces `stopped` exactly once.
    await watcher.refresh()
    watcher.stop()
    expect(watcher.snapshot().mode).toBe('stopped')
    expect(events.filter((event) => event.reason === 'stopped').length).toBe(1)
    expect(handle.closed()).toBe(true)
    // Idempotent stop; restart rewatches cleanly.
    watcher.stop()
    watcher.start()
    expect(watcher.snapshot().mode).toBe('watching')
    await watcher.refresh()
    expect(watcher.cached()).toBe('status')
    watcher.stop()
  })

  test('a pending coalesce window is cancelled by stop, never fired', () => {
    const clock = manualClock()
    const handle = scriptedWatcher()
    const events: StatusWatchEvent[] = []
    const watcher = createWorktreeStatusWatcher<string>({
      worktreeId: 'wt-1',
      generation: 1,
      canonicalRoot: watcherRoot(),
      onChange: (event) => events.push(event),
      openWatcher: handle.open,
      now: clock.now,
      schedule: clock.schedule,
    })
    watcher.start()
    handle.fire()
    expect(clock.pendingTimers).toBe(1)
    watcher.stop()
    clock.advance(STATUS_WATCHER_LIMITS.coalesceMs * 10)
    expect(events.filter((event) => event.reason === 'tree_changed').length).toBe(0)
  })
})

describe('production fingerprint facts', () => {
  test('the fingerprint moves with index and HEAD facts, absent stays absent', () => {
    const root = watcherRoot()
    try {
      const baseline = worktreeStatusFingerprint(root)
      utimesSync(join(root, '.git', 'index'), new Date(5_000), new Date(5_000))
      const moved = worktreeStatusFingerprint(root)
      expect(moved).not.toBe(baseline)
      const empty = mkdtempSync(join(tmpdir(), 'adea-status-watcher-empty-'))
      try {
        // No .git at all: facts are 'absent', never fabricated.
        expect(worktreeStatusFingerprint(empty).endsWith('|absent|absent')).toBe(true)
      } finally {
        rmSync(empty, { recursive: true, force: true })
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ─── Production construction (the git registrar's composed lane) ────────────
//
// The registrar builds one bounded watcher per ready worktree on the git
// dispatch path: created on the first ready sighting, refenced when the live
// generation moves, stopped and discarded when the worktree closes or stops
// being ready. Status is read ONLY through the registered `dev.git.status`
// provider — the same handler the authority's gate dispatches — never a
// private shortcut.

const WATCHTREE_ID = 'wt-watcher-compose-0001'

/** Scripted handle factory tracking opens/closes across reconcile runs. */
function recordingWatcher(): {
  open: OpenWatcher
  opened(): number
  fire(): void
  fail(): void
  closedCount(): number
} {
  let onEvent: (() => void) | undefined
  let onFailed: (() => void) | undefined
  let openCount = 0
  let closeCount = 0
  return {
    open: (handlers) => {
      openCount += 1
      onEvent = handlers.onEvent
      onFailed = handlers.onFailed
      return {
        close: () => {
          closeCount += 1
        },
      } satisfies WatcherHandle
    },
    opened: () => openCount,
    fire: () => onEvent?.(),
    fail: () => onFailed?.(),
    closedCount: () => closeCount,
  }
}

/** Bounded real-time wait for subprocess-backed async work (real git reads);
 *  the explicit per-test timeouts bound the whole thing. */
async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('watcher condition not met before its timeout')
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

/** A disposable git repository registered on a real channel authority, with
 *  the worktree record mutable so tests can re-fence and close it. */
function watcherFixture(
  seams: { openWatcher?: OpenWatcher; schedule?: (fn: () => void, ms: number) => () => void } = {}
) {
  const base = mkdtempSync(join(tmpdir(), 'adea-watcher-compose-'))
  const repoPath = initRepo(join(base, 'worktree'))
  const identity = directoryIdentity(repoPath)
  const rootIdentity = { ...identity.identity } as FileIdentity
  let record:
    | {
        canonicalRoot: string
        rootIdentity: FileIdentity
        generation: number
        lifecycle: string
      }
    | undefined = {
    canonicalRoot: repoPath,
    rootIdentity,
    generation: 1,
    lifecycle: 'ready',
  }
  const events: StatusWatchEvent[] = []
  const authority = createChannelAuthority({
    shellHost: '127.0.0.1',
    shellOrigin: 'https://127.0.0.1:4789',
  })
  const registered = registerGitRuntime({
    authority,
    scope,
    resolveWorktree: (worktreeId) => (worktreeId === WATCHTREE_ID ? record : undefined),
    onWatcherEvent: (event) => events.push(event),
    ...(seams.openWatcher || seams.schedule
      ? {
          watcher: {
            ...(seams.openWatcher ? { openWatcher: seams.openWatcher } : {}),
            ...(seams.schedule ? { schedule: seams.schedule } : {}),
          },
        }
      : {}),
  })
  const bootstrap = authority.issueLaunchBootstrap()
  const at = Date.now()
  const handshake = authority.handshake(
    {
      schemaVersion: 1,
      method: 'dev.runtime.handshake.v1',
      requestId: '00000000-0000-4000-8000-000000000031',
      bootstrap,
      supportedProtocolVersions: ['1'],
      nonce: 'dGhpcy1ub25jZS1oYXMtYXQtbGVhc3QtMTI4LWJpdHM',
      issuedAt: new Date(at - 1000).toISOString(),
      expiresAt: new Date(at + 30_000).toISOString(),
    },
    { trusted: true }
  )
  if (!handshake.ok) throw new Error('handshake refused')
  const channel = {
    identity: { channelId: handshake.channelId, clientCredentialId: handshake.clientCredentialId },
    secret: Buffer.from(handshake.clientSecret, 'base64url'),
  }
  const dispatch = async (generation: number): Promise<DevReply> => {
    const command = makeStatusCommand(WATCHTREE_ID, generation)
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
  return {
    base,
    repoPath,
    events,
    registered,
    dispatch,
    setRecord: (next: typeof record) => {
      record = next
    },
  }
}

describe('production construction (git registrar lane)', () => {
  test('a ready worktree constructs a watcher; a real tree move invalidates through the public status path', async () => {
    const fixture = watcherFixture()
    try {
      // The first git dispatch reconciles the map: the watcher is
      // constructed and started for the ready worktree.
      expect((await fixture.dispatch(1)).ok).toBe(true)
      const snapshot = fixture.registered.statusWatchers.snapshot(WATCHTREE_ID)
      expect(snapshot).toMatchObject({ worktreeId: WATCHTREE_ID, generation: 1 })
      // Production seams: real recursive fs.watch, or the typed degrade.
      expect(['watching', 'degraded']).toContain(snapshot?.mode)
      if (snapshot?.mode !== 'watching') return
      // A real write under the root: fs event → 250 ms coalesce → ONE
      // invalidation → one auto-refresh through the REGISTERED
      // dev.git.status provider (only that dispatch fills the cache).
      writeFileSync(join(fixture.repoPath, 'touched.txt'), 'moved\n')
      await waitUntil(() => fixture.events.some((event) => event.reason === 'tree_changed'))
      await waitUntil(() => fixture.events.some((event) => event.reason === 'refreshed'))
      expect(fixture.registered.statusWatchers.snapshot(WATCHTREE_ID)).toMatchObject({
        generation: 1,
        stale: false,
        cachedGeneration: 1,
      })
      // Every event is fenced to the live generation.
      for (const event of fixture.events) expect(event.generation).toBe(1)
    } finally {
      fixture.registered.statusWatchers.stopAll()
      rmSync(fixture.base, { recursive: true, force: true })
    }
  }, 20_000)

  test('a generation move refences the lane: the old cache dies, events carry the new generation', async () => {
    const clock = manualClock()
    const handle = recordingWatcher()
    const fixture = watcherFixture({ openWatcher: handle.open, schedule: clock.schedule })
    try {
      expect((await fixture.dispatch(1)).ok).toBe(true)
      expect(handle.opened()).toBe(1)
      // A tree event fills the cache under generation 1 (a real status read
      // through the registered provider).
      handle.fire()
      clock.advance(STATUS_WATCHER_LIMITS.coalesceMs)
      await waitUntil(
        () => fixture.registered.statusWatchers.snapshot(WATCHTREE_ID)?.stale === false
      )
      // The live record moves: the next dispatch re-proves and refences.
      fixture.setRecord({
        canonicalRoot: fixture.repoPath,
        rootIdentity: { device: '', inode: '', mtimeNs: '', size: '' } as FileIdentity,
        generation: 2,
        lifecycle: 'ready',
      })
      expect((await fixture.dispatch(2)).ok).toBe(true)
      expect(fixture.registered.statusWatchers.snapshot(WATCHTREE_ID)).toMatchObject({
        generation: 2,
        stale: true,
      })
      expect(
        fixture.events.some((event) => event.reason === 'refenced' && event.generation === 2)
      ).toBe(true)
      // The lane's manual invalidation (the mutation lane) is reachable and
      // emits the fenced tree_changed event.
      fixture.registered.statusWatchers.invalidate(WATCHTREE_ID)
      expect(
        fixture.events.some((event) => event.reason === 'tree_changed' && event.generation === 2)
      ).toBe(true)
    } finally {
      fixture.registered.statusWatchers.stopAll()
      rmSync(fixture.base, { recursive: true, force: true })
    }
  })

  test('a closed or non-ready worktree stops the watcher and drops it from the lane', async () => {
    const clock = manualClock()
    const handle = recordingWatcher()
    const fixture = watcherFixture({ openWatcher: handle.open, schedule: clock.schedule })
    try {
      expect((await fixture.dispatch(1)).ok).toBe(true)
      expect(fixture.registered.statusWatchers.snapshot(WATCHTREE_ID)).toBeDefined()
      // The record disappears: even the refused command reconciles first —
      // the watcher is stopped and its cache discarded with it.
      fixture.setRecord(undefined)
      expect((await fixture.dispatch(1)).ok).toBe(false)
      expect(fixture.registered.statusWatchers.snapshot(WATCHTREE_ID)).toBeUndefined()
      expect(handle.closedCount()).toBe(1)
      // A non-ready lifecycle is equally terminal (no re-construction).
      fixture.setRecord({
        canonicalRoot: fixture.repoPath,
        rootIdentity: { device: '', inode: '', mtimeNs: '', size: '' } as FileIdentity,
        generation: 2,
        lifecycle: 'archived',
      })
      expect((await fixture.dispatch(2)).ok).toBe(false)
      expect(fixture.registered.statusWatchers.snapshot(WATCHTREE_ID)).toBeUndefined()
      expect(handle.closedCount()).toBe(1)
    } finally {
      fixture.registered.statusWatchers.stopAll()
      rmSync(fixture.base, { recursive: true, force: true })
    }
  })

  test('a platform that cannot watch degrades typed and never refuses the command', async () => {
    const fixture = watcherFixture({ openWatcher: () => undefined })
    try {
      // Truthful unavailability: the provider answers normally; the lane
      // reports the typed degraded mode, audibly once.
      expect((await fixture.dispatch(1)).ok).toBe(true)
      expect(fixture.registered.statusWatchers.snapshot(WATCHTREE_ID)?.mode).toBe('degraded')
      expect(
        fixture.events.some((event) => event.reason === 'degraded' && event.generation === 1)
      ).toBe(true)
    } finally {
      fixture.registered.statusWatchers.stopAll()
      rmSync(fixture.base, { recursive: true, force: true })
    }
  })
})
