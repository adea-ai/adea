/*
 * Generation-fenced git status cache (#399 residue): the client twin of the
 * shell's watcher-driven status invalidation lane (see the "Watcher-driven
 * status invalidation" section of the dev-runtime spec). The source-control
 * pane's status cache and the files pane's marker cache both follow this one
 * contract:
 *
 * - An invalidation (tree moved, refresh failed, worktree re-fenced) turns
 *   the entry UNDEFINED — a miss is a miss, never a stale value labeled
 *   fresh.
 * - Every entry carries the worktree generation it was read under; a context
 *   whose generation moved refences the cache (the old entry dies with its
 *   generation).
 * - Refresh always re-reads through the capability-checked dispatch
 *   (`executeOperation`); the cache itself never serves bytes — it only
 *   decides whether the pane is displaying provably-current state.
 *
 * Pure data work — no DOM, no runtime access.
 */

export type StatusCacheSnapshot<T> = Readonly<{
  /** The cached value, or undefined once invalidated — undefined is the
   *  honest state, not a placeholder. */
  value: T | undefined
  /** The worktree generation the entry (or the last miss) is fenced by. */
  generation: number
  /** True while the pane cannot prove the displayed state is current. */
  stale: boolean
}>

/** A cache that knows nothing yet, fenced to the resolved context. */
export function emptyStatusCache<T>(generation: number): StatusCacheSnapshot<T> {
  return { value: undefined, generation, stale: true }
}

/** Admit a freshly dispatched reply: the value publishes under the
 *  generation it was read at, replacing whatever the cache held — an old
 *  generation's entry never survives a new generation's successful read. */
export function cacheStatus<T>(value: T, generation: number): StatusCacheSnapshot<T> {
  return { value, generation, stale: false }
}

/** Invalidation: the tree moved (or a refresh failed) — the entry goes
 *  undefined and the cache reports stale until a fresh dispatch repopulates
 *  it. The generation fence is unchanged. */
export function invalidateStatus<T>(snapshot: StatusCacheSnapshot<T>): StatusCacheSnapshot<T> {
  return { value: undefined, generation: snapshot.generation, stale: true }
}

/** Re-fence to a worktree generation the cache was not read under: cached
 *  state from the old generation is discarded, never displayed as current. */
export function refenceStatusCache<T>(
  snapshot: StatusCacheSnapshot<T>,
  generation: number
): StatusCacheSnapshot<T> {
  if (generation === snapshot.generation && !snapshot.stale) return snapshot
  return { value: undefined, generation, stale: true }
}
