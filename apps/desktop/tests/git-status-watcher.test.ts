// Watcher-driven git status invalidation (#399 residue): bursts coalesce
// into one invalidation and at most one refresh (injected scheduler, no real
// sleeps), every cache entry and in-flight refresh is generation-fenced, a
// watcher that cannot open or that fails mid-stream degrades to the bounded
// stat-fingerprint lane (no faster than the 60-second floor), concurrent
// refreshes dedupe through the bounded gate, and stop/restart is clean. All
// clocks and timers are injected.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  STATUS_WATCHER_LIMITS,
  createRefreshGate,
  createWorktreeStatusWatcher,
  worktreeStatusFingerprint,
  type OpenWatcher,
  type StatusWatchEvent,
  type WatcherHandle,
} from '../shell/src/dev-runtime/git/status-watcher'

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
