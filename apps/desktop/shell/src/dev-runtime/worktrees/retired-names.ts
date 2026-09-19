// Retired worktree-name registry and collision-safe name suggestion.
//
// Retirement is permanent because harness session stores often key their state
// by the worktree's cwd: reissuing a spent name hands the next occupant someone
// else's history. The registry never evicts; it compacts completed tiers into a
// watermark so a repo stays bounded at roughly one pool of entries forever.
//
// Portions substantially translated from Orca (https://github.com/stablyai/orca)
// `src/shared/worktree/retired-name-registry.ts` and
// `src/shared/worktree-name-suggestion.ts`, pinned revision
// 403b62a8d8fa6e896a93acc4c15405be0f0b7dc7, MIT License.
// Copyright (c) 2026 Stably AI, Inc.
import { WORKTREE_NAME_POOL } from './name-pool'

export type RetiredNameRegistry = {
  exhaustedTiers: number
  names: readonly string[]
}

export const EMPTY_RETIRED_NAME_REGISTRY: RetiredNameRegistry = { exhaustedTiers: 0, names: [] }

export const WORKTREE_POOL_NAMES: ReadonlySet<string> = new Set(
  WORKTREE_NAME_POOL.map((name) => name.toLowerCase())
)

// Matches the widest tier `worktreeNameTier` will parse: a watermark past it
// could never be reached by a name, so it would only silence lookups.
const MAX_EXHAUSTED_TIERS = 999_999

/** Tier 1 is the bare pool name; tier N is `name-N`. */
export function worktreeNameAtTier(poolName: string, tier: number): string {
  return tier === 1 ? poolName : `${poolName}-${tier}`
}

/** Null for anything the suggester never emits — a non-pool base, or a
 *  repeat-suffixed collision variant like `nautilus-2-3` — so no watermark can
 *  ever cover those. Load-bearing for user-typed names: `fix-login-2` must not
 *  read as retired just because tier 2 is spent. */
export function worktreeNameTier(name: string): number | null {
  const normalized = name.trim().toLowerCase()
  if (WORKTREE_POOL_NAMES.has(normalized)) {
    return 1
  }
  const match = /^(.+)-([1-9]\d{0,5})$/.exec(normalized)
  if (!match || !WORKTREE_POOL_NAMES.has(match[1])) {
    return null
  }
  // `nautilus-1` is not the tier-1 name — the bare name is — so it stays explicit.
  const tier = Number(match[2])
  return tier >= 2 ? tier : null
}

export function clampExhaustedTiers(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_EXHAUSTED_TIERS)
    : 0
}

/** Membership without reconstructing a compacted tier: at or below the watermark
 *  answers with no lookup at all. Built once per create attempt because the
 *  create loop probes many candidate names. */
export function createRetiredNameLookup(registry: RetiredNameRegistry): (name: string) => boolean {
  const explicit = new Set(registry.names)
  const exhaustedTiers = clampExhaustedTiers(registry.exhaustedTiers)
  return (name) => {
    const normalized = name.trim().toLowerCase()
    if (explicit.has(normalized)) {
      return true
    }
    const tier = worktreeNameTier(normalized)
    return tier !== null && tier <= exhaustedTiers
  }
}

function tierIsComplete(names: ReadonlySet<string>, tier: number): boolean {
  for (const poolName of WORKTREE_POOL_NAMES) {
    if (!names.has(worktreeNameAtTier(poolName, tier))) {
      return false
    }
  }
  return true
}

/** Folds every completed tier into the watermark and drops the names it now
 *  covers. Loops rather than checking one tier: tiers complete out of order,
 *  because a create-time collision can spend `nautilus-2` while tier 1 is still
 *  open. Those higher-tier names wait in the explicit set until their own tier
 *  completes. */
export function compactRetiredNames(registry: RetiredNameRegistry): RetiredNameRegistry {
  let exhaustedTiers = clampExhaustedTiers(registry.exhaustedTiers)
  const names = new Set(registry.names)
  while (exhaustedTiers < MAX_EXHAUSTED_TIERS && tierIsComplete(names, exhaustedTiers + 1)) {
    exhaustedTiers += 1
  }
  for (const name of names) {
    const tier = worktreeNameTier(name)
    if (tier !== null && tier <= exhaustedTiers) {
      names.delete(name)
    }
  }
  return { exhaustedTiers, names: [...names] }
}

/** Returns null when nothing changed, so callers can skip the write. Names must
 *  already have passed the caller's retirement gate — this only does set math. */
export function addRetiredNames(
  registry: RetiredNameRegistry,
  incoming: Iterable<string>
): RetiredNameRegistry | null {
  const isRetired = createRetiredNameLookup(registry)
  const added: string[] = []
  for (const name of incoming) {
    if (!isRetired(name)) {
      added.push(name)
    }
  }
  return added.length === 0
    ? null
    : compactRetiredNames({
        exhaustedTiers: registry.exhaustedTiers,
        names: [...registry.names, ...added],
      })
}

/** Union of two registries. The higher watermark wins and absorbs the other's
 *  names, so peers at different compaction points do not re-expand each other's
 *  spent tiers. */
export function mergeRetiredNameRegistries(
  base: RetiredNameRegistry,
  incoming: RetiredNameRegistry
): RetiredNameRegistry {
  return compactRetiredNames({
    exhaustedTiers: Math.max(base.exhaustedTiers, incoming.exhaustedTiers),
    names: [...base.names, ...incoming.names],
  })
}

export function isEmptyRetiredNameRegistry(registry: RetiredNameRegistry): boolean {
  return registry.exhaustedTiers === 0 && registry.names.length === 0
}

/** Selection core shared by every create path. Both dedupe on the on-disk
 *  directory basename, lowercase to match branch convention, and degrade to
 *  suffixed tiers rather than recycling retired names. Callers assemble
 *  `usedNames` (live names plus retired names) because live names arrive from
 *  the filesystem while retired names arrive from the registry. */
export function selectWorktreeName(
  usedNames: Iterable<string>,
  random: () => number = Math.random,
  exhaustedTiers = 0
): string {
  const used = new Set<string>()
  for (const name of usedNames) {
    used.add(normalizeWorktreeName(name))
  }

  let tier = clampExhaustedTiers(exhaustedTiers) + 1
  while (true) {
    const available = WORKTREE_NAME_POOL.map((name) =>
      worktreeNameAtTier(normalizeWorktreeName(name), tier)
    ).filter((name) => !used.has(name))
    if (available.length > 0) {
      return available[Math.floor(random() * available.length)]
    }
    tier += 1
  }
}

export function normalizeWorktreeName(name: string): string {
  return name.trim().toLowerCase()
}
