// Watcher-driven git status invalidation (#399 residue): a bounded watcher
// per worktree root that invalidates the pane's status cache when the tree
// changes underneath it, so file status refreshes because the tree moved —
// never because a poll loop burned subprocesses.
//
// Contract (docs/specs/dev-runtime.md, "Consolidated limits registry",
// "watcher/status" row, and the project-scanner watcher rules this lane
// shares): bursts coalesce for 250 ms into ONE invalidation and at most one
// refresh; refresh concurrency is capped (4 across the gate shared by a
// host's watchers); when the watcher is unavailable the lane degrades to a
// stat-fingerprint check no faster than once per 60 seconds — demand-driven
// on reads, never a steady per-row subprocess poll.
//
// Fencing: every cache entry, event, and in-flight refresh carries the
// worktree generation it was produced under. A `refence` (worktree
// recreated/moved) invalidates everything cached under the old generation
// and discards in-flight results from it — a stale generation never
// publishes. Detection is `fs.watch` on the worktree root through an
// injectable handle factory with deprecation-safe recursive handling: a
// platform that cannot watch (or that errors mid-stream) degrades, it never
// crashes. The git provider itself is untouched — status bytes are read
// through the injected `readStatus` seam (the composition binds the
// provider's public status path).
import { statSync, watch } from 'node:fs'
import { join } from 'node:path'

/** Named watcher/status limits (spec: "Consolidated limits registry").
 *  Tightening is allowed; relaxing one requires a spec change. */
export const STATUS_WATCHER_LIMITS = {
  /** Events within one window collapse into a single invalidation. */
  coalesceMs: 250,
  /** Concurrent status refreshes across the gate shared by watchers. */
  maxRefreshConcurrency: 4,
  /** Degraded-lane fingerprint check floor (spec: "no faster than"). */
  fingerprintMinIntervalMs: 60_000,
} as const

export type StatusWatchEvent = Readonly<{
  worktreeId: string
  generation: number
  /** Monotonic invalidation counter for this watcher. */
  revision: number
  reason:
    | 'tree_changed'
    | 'refreshed'
    | 'degraded'
    | 'refenced'
    /** `stopped` fires once when the watcher closes holding cached state. */
    | 'stopped'
}>

export type WatcherHandle = Readonly<{ close(): void }>

export type OpenWatcher = (
  handlers: Readonly<{ onEvent(): void; onFailed(): void }>
) => WatcherHandle | undefined

export type Scheduler = (fn: () => void, ms: number) => () => void

export type StatusWatcherSnapshot = Readonly<{
  worktreeId: string
  generation: number
  mode: 'watching' | 'degraded' | 'stopped'
  stale: boolean
  revision: number
  cachedGeneration?: number | undefined
  refreshInFlight: boolean
}>

/**
 * Bounded refresh semaphore shared by a host's watchers (spec: refresh
 * concurrency 4). `acquire` resolves with the slot's release; there is no
 * cancel-by-design — slots free on completion and each watcher dedupes its
 * own in-flight refresh, so at most one waiter exists per watcher.
 */
export function createRefreshGate(limit: number): {
  acquire(): Promise<() => void>
  readonly active: number
  readonly waiting: number
} {
  let active = 0
  const waiters: Array<() => void> = []
  return {
    get active() {
      return active
    },
    get waiting() {
      return waiters.length
    },
    async acquire(): Promise<() => void> {
      if (active >= limit) {
        await new Promise<void>((resolve) => waiters.push(resolve))
      }
      active += 1
      let released = false
      return () => {
        if (released) return
        released = true
        active -= 1
        waiters.shift()?.()
      }
    },
  }
}

export type StatusWatcherInput<T> = {
  worktreeId: string
  /** The live worktree generation; every cache entry is fenced by it. */
  generation: number
  canonicalRoot: string
  /** Injected status read (the git provider's public path). Optional: a
   *  watcher without one is a pure invalidation source. A failed read
   *  resolves undefined — the cache stays honestly empty. */
  readStatus?: () => Promise<T | undefined>
  /** Change notifications (invalidation and refresh completion). */
  onChange?: (event: StatusWatchEvent) => void
  /** Injected watcher handle factory; production wraps `fs.watch` recursive
   *  and returns undefined when the platform cannot. */
  openWatcher?: OpenWatcher
  /** Shared refresh gate; defaults to one gate per watcher. */
  gate?: ReturnType<typeof createRefreshGate>
  now?: () => number
  schedule?: Scheduler
  limits?: typeof STATUS_WATCHER_LIMITS
}

/** Production handle factory: recursive watch with deprecation-safe
 *  handling — unsupported platforms and mid-stream failures both degrade. */
export function openRecursiveFsWatcher(
  canonicalRoot: string,
  handlers: Readonly<{ onEvent(): void; onFailed(): void }>
): WatcherHandle | undefined {
  try {
    const watcher = watch(canonicalRoot, { recursive: true }, () => handlers.onEvent())
    watcher.on('error', handlers.onFailed)
    return { close: () => watcher.close() }
  } catch {
    return undefined
  }
}

/** Cheap, bounded degraded-lane fingerprint: the stat facts that move when a
 *  worktree's status could have moved. No subprocess, no traversal. */
export function worktreeStatusFingerprint(canonicalRoot: string): string {
  const facts: string[] = []
  for (const relative of ['.', '.git/HEAD', '.git/index']) {
    try {
      const stats = statSync(join(canonicalRoot, relative))
      facts.push(`${stats.size}:${stats.mtimeMs}`)
    } catch {
      facts.push('absent')
    }
  }
  return facts.join('|')
}

export function createWorktreeStatusWatcher<T>(input: StatusWatcherInput<T>) {
  const limits = input.limits ?? STATUS_WATCHER_LIMITS
  const now = input.now ?? Date.now
  const schedule =
    input.schedule ??
    ((fn: () => void, ms: number): (() => void) => {
      const timer = setTimeout(fn, ms)
      timer.unref?.()
      return () => clearTimeout(timer)
    })
  const openWatcher =
    input.openWatcher ??
    ((handlers: Readonly<{ onEvent(): void; onFailed(): void }>) =>
      openRecursiveFsWatcher(input.canonicalRoot, handlers))
  const gate = input.gate ?? createRefreshGate(limits.maxRefreshConcurrency)

  let generation = input.generation
  let mode: 'watching' | 'degraded' | 'stopped' = 'stopped'
  let revision = 0
  let stopped = false
  let handle: WatcherHandle | undefined
  let coalesceCancel: (() => void) | undefined
  let fingerprint = ''
  let lastFingerprintAt = -Number.POSITIVE_INFINITY

  type CacheEntry = Readonly<{ status: T; generation: number }>
  let cache: CacheEntry | undefined
  let refreshInFlight: Promise<T | undefined> | undefined

  const listeners = new Set<(event: StatusWatchEvent) => void>()
  if (input.onChange) listeners.add(input.onChange)

  function emit(reason: StatusWatchEvent['reason']): void {
    const event: StatusWatchEvent = {
      worktreeId: input.worktreeId,
      generation,
      revision,
      reason,
    }
    // Set iteration tolerates a listener unsubscribing mid-emit.
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {
        /* a listener never breaks the watcher */
      }
    }
  }

  function invalidate(reason: StatusWatchEvent['reason']): void {
    revision += 1
    cache = undefined
    emit(reason)
  }

  /** One refresh per burst: the coalesce window is scheduled only when no
   *  window is already pending, so a thousand-event burst ticks once. */
  function onTreeEvent(): void {
    if (stopped || mode !== 'watching') return
    if (coalesceCancel) return
    coalesceCancel = schedule(() => {
      coalesceCancel = undefined
      if (stopped || mode !== 'watching') return
      invalidate('tree_changed')
      if (input.readStatus) void refreshDeduped()
    }, limits.coalesceMs)
  }

  /** One read at a time per watcher: concurrent calls join the in-flight
   *  read. Internal callers (burst tick, degraded fingerprint) share it. */
  function refreshDeduped(): Promise<T | undefined> {
    if (refreshInFlight) return refreshInFlight
    return runRefresh()
  }

  /** The watcher died mid-stream: degrade once, audibly to listeners. */
  function onWatcherFailed(): void {
    if (stopped || mode !== 'watching') return
    try {
      handle?.close()
    } catch {
      /* already gone */
    }
    handle = undefined
    fingerprint = worktreeStatusFingerprint(input.canonicalRoot)
    lastFingerprintAt = now()
    mode = 'degraded'
    revision += 1
    emit('degraded')
  }

  /** Degraded lane: at most one fingerprint check per minimum interval,
   *  demand-driven from reads — never a timer, never a subprocess. */
  function checkDegradedFingerprint(): void {
    if (mode !== 'degraded' || stopped) return
    const at = now()
    if (at - lastFingerprintAt < limits.fingerprintMinIntervalMs) return
    lastFingerprintAt = at
    const next = worktreeStatusFingerprint(input.canonicalRoot)
    if (next === fingerprint) return
    fingerprint = next
    invalidate('tree_changed')
    if (input.readStatus) void refreshDeduped()
  }

  function runRefresh(): Promise<T | undefined> {
    const read = input.readStatus
    if (!read) return Promise.resolve(undefined)
    const fencedGeneration = generation
    const attempt = (async () => {
      const release = await gate.acquire()
      // Fenced while waiting for a slot: the result would describe a
      // generation this watcher no longer serves.
      if (stopped || fencedGeneration !== generation) {
        release()
        return undefined
      }
      try {
        return await read()
      } catch {
        // The provider owns typed failures; the cache simply stays empty
        // rather than publishing a stale value as fresh.
        return undefined
      } finally {
        release()
      }
    })()
    const tracked = attempt.then((status) => {
      if (refreshInFlight === tracked) refreshInFlight = undefined
      if (status === undefined || stopped || fencedGeneration !== generation) return undefined
      cache = { status, generation: fencedGeneration }
      revision += 1
      emit('refreshed')
      return status
    })
    refreshInFlight = tracked
    return tracked
  }

  return {
    /** Starts watching; idempotent, restartable after stop. A platform that
     *  cannot watch degrades to the fingerprint lane, never throws. */
    start(): void {
      if (mode !== 'stopped') return
      stopped = false
      fingerprint = worktreeStatusFingerprint(input.canonicalRoot)
      lastFingerprintAt = now()
      handle = openWatcher({ onEvent: onTreeEvent, onFailed: onWatcherFailed })
      mode = handle ? 'watching' : 'degraded'
      revision += 1
      if (mode === 'degraded') emit('degraded')
    },

    /** Closes the handle and cancels any pending coalesce window. */
    stop(): void {
      if (mode === 'stopped') return
      stopped = true
      coalesceCancel?.()
      coalesceCancel = undefined
      try {
        handle?.close()
      } catch {
        /* already gone */
      }
      handle = undefined
      const hadCache = cache !== undefined
      mode = 'stopped'
      cache = undefined
      if (hadCache) {
        revision += 1
        emit('stopped')
      }
    },

    subscribe(listener: (event: StatusWatchEvent) => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    /** Re-fences to a new worktree generation: cached state and in-flight
     *  results from the old generation are discarded, never published. */
    refence(nextGeneration: number): void {
      if (nextGeneration === generation) return
      generation = nextGeneration
      revision += 1
      cache = undefined
      emit('refenced')
    },

    /** The cached status, or undefined once invalidated — a miss is a miss,
     *  never a stale value labeled fresh. */
    cached(): T | undefined {
      checkDegradedFingerprint()
      return cache?.status
    },

    /** Forces one refresh. Concurrent calls dedupe onto the in-flight read;
     *  every result is fenced against the generation it started under. */
    refresh(): Promise<T | undefined> {
      checkDegradedFingerprint()
      return refreshDeduped()
    },

    /** Manual invalidation — a mutation lane that already knows the tree
     *  moved (stage/commit/status replies) skips the watcher latency. */
    invalidate(): void {
      if (mode === 'stopped') return
      invalidate('tree_changed')
    },

    snapshot(): StatusWatcherSnapshot {
      return {
        worktreeId: input.worktreeId,
        generation,
        mode,
        stale: cache === undefined,
        revision,
        ...(cache !== undefined ? { cachedGeneration: cache.generation } : {}),
        refreshInFlight: refreshInFlight !== undefined,
      }
    },
  }
}

export type WorktreeStatusWatcher<T = unknown> = ReturnType<typeof createWorktreeStatusWatcher<T>>
