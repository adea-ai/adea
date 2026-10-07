// Machine-wide janitor authority (owner follow-up #3): the stateful half of
// the janitor over the pure model — the scan cache, lazy bounded sizing, and
// the explicit plan/commit cleanup pair.
//
// The safety contract lives in the model's header; this module adds the
// authority mechanics: a scan bumps the observation generation a plan binds;
// the plan digests the named items' proven identities; the commit is single
// use, re-proves every identity immediately before its disposal, moves
// recoverable items into the user's Trash, and reports one typed outcome per
// item — skipped or failed items never fail the whole run silently, and a
// changed identity is never disposed.
import { lstatSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type {
  JanitorCommitResult,
  JanitorItem,
  JanitorMeasurePage,
  JanitorPlan,
  JanitorScanReport,
  Scope,
} from '../../../../../../packages/types/src/dev-runtime'

import {
  identityMatches,
  janitorItemId,
  janitorPathLabel,
  janitorPlanDigest,
  janitorSectionRoots,
  janitorWorktreeCandidates,
  measureBytes,
  modifiedAtOf,
  parseWorktreePorcelain,
  trashDestinationName,
  type JanitorFs,
  type JanitorScanEntry,
  type JanitorSectionKind,
} from './janitor-model'

const MEASURE_FRESH_MS = 15 * 60_000
const MEASURE_ITEM_BUDGET_MS = 2_000
const MEASURE_GLOBAL_BUDGET_MS = 6_000
const MEASURE_MAX_ENTRIES = 200_000
const MEASURE_MAX_DEPTH = 12
const MAX_ITEMS = 2048
const PLAN_TTL_MS = 10 * 60_000

export type JanitorError = Readonly<{ code: string; message: string; retryable?: boolean }>

function janitorError(code: string, message: string): JanitorError {
  return { code, message, retryable: false }
}

export type CreateJanitorAuthorityInput = Readonly<{
  /** The command scope the plan binds. */
  scope: Scope
  /** Fixed-argv `git worktree list --porcelain` for one root; a failing or
   * missing git contributes no worktree items (truthful absence). */
  gitWorktreeList?(root: string): Promise<string> | string
  /** Fixed-argv `git worktree prune` for one repository root. */
  gitWorktreePrune?(root: string): Promise<void> | void
  /** Canonical roots Adea registers; those keep their own lifecycle. */
  registeredRoots(): readonly string[]
  /** The configured scan roots; the composition defaults these to the
   * register's authorized repository roots. */
  scanRoots(): readonly string[]
  home?: string
  fs?: JanitorFs
  now?: () => number
  randomId?: () => string
}>

type CachedItem = Readonly<{
  entry: JanitorScanEntry
  /** Measured size state, updated by measure. */
  bytes: number | undefined
  itemState: 'discovered' | 'measuring' | 'measured' | 'stale' | 'unreadable'
  measuredAt: number | undefined
  /** The repository root a prune item belongs to. */
  repoRoot?: string
}>

type PlanEntry = Readonly<{
  planId: string
  digest: string
  generation: number
  items: readonly CachedItem[]
  expiresAt: number
}>

/** The node filesystem narrowed to the janitor's read/move surface. */
export const nodeJanitorFs: JanitorFs = {
  lstat(path) {
    const presented = lstatSync(path, { throwIfNoEntry: false })
    if (!presented) return undefined
    return {
      isDirectory: presented.isDirectory(),
      isFile: presented.isFile(),
      isSymbolicLink: presented.isSymbolicLink(),
      identity: { device: String(presented.dev), inode: String(presented.ino) },
      // Allocated blocks where reported (sparse-honest), else apparent size.
      bytes:
        presented.blocks !== undefined && presented.blocks > 0
          ? presented.blocks * 512
          : presented.size,
      mtimeMs: presented.mtimeMs,
    }
  },
  readdir(path) {
    return readdirSync(path)
  },
  rename(from, to) {
    renameSync(from, to)
  },
  removeRecursive(path) {
    rmSync(path, { recursive: true, force: false })
  },
}

export function createJanitorAuthority(input: CreateJanitorAuthorityInput): {
  scan(): Promise<JanitorScanReport>
  measure(ids: readonly string[]): Promise<JanitorMeasurePage>
  plan(
    body: Readonly<{
      itemIds: readonly string[]
      expectedGeneration: number
    }>
  ): Promise<JanitorPlan>
  commit(
    body: Readonly<{ planId: string; planDigest: string }>,
    resource: Readonly<{ kind: string; id: string; generation: number }>
  ): Promise<JanitorCommitResult>
} {
  const home = input.home ?? homedir()
  const fs = input.fs ?? nodeJanitorFs
  const now = input.now ?? Date.now
  const randomId =
    input.randomId ?? (() => Math.random().toString(16).slice(2) + Date.now().toString(16))
  const sectionRoots = janitorSectionRoots(home)

  let items = new Map<string, CachedItem>()
  let observationGeneration = 0

  function toCached(entry: JanitorScanEntry, repoRoot?: string): CachedItem {
    return {
      entry,
      bytes: undefined,
      itemState: 'discovered',
      measuredAt: undefined,
      ...(repoRoot !== undefined ? { repoRoot } : {}),
    }
  }

  function toItem(cached: CachedItem): JanitorItem {
    const { entry } = cached
    return {
      id: entry.id,
      section: entry.section,
      label: entry.label,
      pathLabel: entry.pathLabel,
      ...(cached.bytes !== undefined ? { bytes: String(cached.bytes) } : {}),
      state: cached.itemState,
      ...(entry.modifiedAt !== undefined ? { modifiedAt: entry.modifiedAt } : {}),
      disposal: entry.disposal,
      ...(entry.worktree !== undefined ? { worktree: entry.worktree } : {}),
      observedAt: new Date(now()).toISOString(),
    }
  }

  async function scan(): Promise<JanitorScanReport> {
    const next = new Map<string, CachedItem>()

    // The four well-known junk roots: first-level entries only, symlinks and
    // non-directories skipped except in the Trash, where files are junk too.
    for (const [section, root] of Object.entries(sectionRoots) as readonly [
      Exclude<JanitorSectionKind, 'worktree'>,
      string,
    ][]) {
      const rootEntry = fs.lstat(root)
      if (!rootEntry || rootEntry.isSymbolicLink || !rootEntry.isDirectory) continue
      let names: readonly string[]
      try {
        names = fs.readdir(root)
      } catch {
        continue
      }
      for (const name of names.slice(0, MAX_ITEMS)) {
        if (name.startsWith('.adea-')) continue // Adea's own quarantine trash.
        const path = join(root, name)
        const presented = fs.lstat(path)
        if (!presented || presented.isSymbolicLink) continue
        const isDir = presented.isDirectory
        if (!isDir && section !== 'trash') continue
        const entry: JanitorScanEntry = {
          id: janitorItemId(path),
          section,
          canonicalPath: path,
          pathLabel: janitorPathLabel(home, path),
          label: name,
          disposal: section === 'trash' ? 'trash_empty' : 'trash',
          identity: presented.identity,
          ...(modifiedAtOf(presented.mtimeMs, now)
            ? { modifiedAt: modifiedAtOf(presented.mtimeMs, now) }
            : {}),
          isDirectory: isDir,
          worktree: undefined,
        }
        next.set(entry.id, toCached(entry))
      }
    }

    // Worktree discovery under the configured scan roots (a repository root
    // contributes its unregistered worktrees; everything else is silent).
    for (const root of input.scanRoots()) {
      if (!input.gitWorktreeList) break
      let stdout: string
      try {
        stdout = await input.gitWorktreeList(root)
      } catch {
        continue // A non-repository root contributes no worktree items.
      }
      const candidates = janitorWorktreeCandidates({
        entries: parseWorktreePorcelain(stdout),
        root,
        registeredRoots: input.registeredRoots(),
        home,
      })
      for (const candidate of candidates) {
        const presented = fs.lstat(candidate.canonicalPath)
        // A healthy unregistered worktree is a move-to-Trash candidate: the
        // directory must exist for the list to show it. Git's prunable
        // entries are the opposite — their registry line is the junk.
        if (candidate.disposal === 'trash' && (!presented || presented.isSymbolicLink)) continue
        const entry: JanitorScanEntry = {
          id: janitorItemId(candidate.canonicalPath),
          section: 'worktree',
          canonicalPath: candidate.canonicalPath,
          pathLabel: candidate.pathLabel,
          label: candidate.label,
          disposal: candidate.disposal,
          ...(presented
            ? {
                identity: presented.identity,
                ...(modifiedAtOf(presented.mtimeMs, now)
                  ? { modifiedAt: modifiedAtOf(presented.mtimeMs, now) }
                  : {}),
              }
            : { identity: { device: 'missing', inode: 'missing' } }),
          isDirectory: presented?.isDirectory ?? false,
          worktree: {
            registered: false,
            ...(candidate.branchLabel !== undefined ? { branchLabel: candidate.branchLabel } : {}),
            ...(candidate.prunableReason !== undefined
              ? { prunableReason: candidate.prunableReason }
              : {}),
          },
        }
        next.set(entry.id, toCached(entry, root))
      }
    }

    items = next
    observationGeneration += 1
    return {
      items: [...items.values()].map(toItem),
      observationGeneration,
      observedAt: new Date(now()).toISOString(),
    }
  }

  async function measure(ids: readonly string[]): Promise<JanitorMeasurePage> {
    const deadline = now() + MEASURE_GLOBAL_BUDGET_MS
    const measured: JanitorItem[] = []
    for (const id of ids) {
      const cached = items.get(id)
      if (!cached) continue // Unknown ids read as absent, never as zero.
      if (
        cached.itemState === 'measured' &&
        cached.measuredAt !== undefined &&
        now() - cached.measuredAt < MEASURE_FRESH_MS
      ) {
        measured.push(toItem(cached))
        continue
      }
      if (now() > deadline) break
      const outcome = measureBytes(
        fs,
        cached.entry.canonicalPath,
        {
          deadlineMs: Math.min(deadline, now() + MEASURE_ITEM_BUDGET_MS),
          maxEntries: MEASURE_MAX_ENTRIES,
          maxDepth: MEASURE_MAX_DEPTH,
        },
        now
      )
      let updated: CachedItem
      if (outcome.state === 'measured') {
        updated = { ...cached, bytes: outcome.bytes, itemState: 'measured', measuredAt: now() }
      } else if (outcome.state === 'stale') {
        updated = {
          ...cached,
          ...(outcome.bytes !== undefined ? { bytes: outcome.bytes } : {}),
          itemState: 'stale',
          measuredAt: now(),
        }
      } else {
        updated = { ...cached, bytes: undefined, itemState: 'unreadable', measuredAt: now() }
      }
      items = new Map(items).set(id, updated)
      measured.push(toItem(updated))
    }
    return { items: measured, observedAt: new Date(now()).toISOString() }
  }

  async function plan(
    body: Readonly<{ itemIds: readonly string[]; expectedGeneration: number }>
  ): Promise<JanitorPlan> {
    if (observationGeneration === 0 || items.size === 0) {
      throw janitorError('invalid_state', 'scan before planning a cleanup')
    }
    if (body.expectedGeneration !== observationGeneration) {
      throw janitorError('stale_generation', 'the sheet scanned an older machine state')
    }
    const planned: CachedItem[] = []
    for (const id of body.itemIds) {
      const cached = items.get(id)
      if (!cached) throw janitorError('not_found', `unknown janitor item ${id}`)
      planned.push(cached)
    }
    if (planned.length === 0) throw janitorError('invalid_state', 'plan at least one item')
    const digest = janitorPlanDigest(
      planned.map((cached) => ({
        id: cached.entry.id,
        disposal: cached.entry.disposal,
        identity: cached.entry.identity,
      })),
      observationGeneration
    )
    const planId = randomId()
    const expiresAt = now() + PLAN_TTL_MS
    const janitorPlan: JanitorPlan = {
      plan: {
        id: planId,
        operation: 'dev.resources.janitorCommit',
        scope: { ...input.scope },
        resource: { kind: 'janitor_plan', id: planId, generation: observationGeneration },
        factVersions: { itemsDigest: digest },
        steps: planned.map((cached, index) => ({
          id: `item-${index}`,
          kind: cached.entry.disposal,
          targetId: cached.entry.id,
          dependsOn: [],
        })),
        blockers: [],
        requiredApprovalIds: [],
        digest,
        expiresAt: new Date(expiresAt).toISOString(),
      },
      items: planned.map(toItem),
      ...(!planned.some((cached) => cached.bytes === undefined)
        ? {
            totalBytes: String(planned.reduce((sum, cached) => sum + (cached.bytes ?? 0), 0)),
          }
        : {}),
      observedAt: new Date(now()).toISOString(),
    }
    plans.set(planId, {
      planId,
      digest,
      generation: observationGeneration,
      items: planned,
      expiresAt,
    })
    return janitorPlan
  }

  async function commit(
    body: Readonly<{ planId: string; planDigest: string }>,
    resource: Readonly<{ kind: string; id: string; generation: number }>
  ): Promise<JanitorCommitResult> {
    const entry = plans.get(body.planId)
    if (!entry || entry.expiresAt <= now()) {
      plans.delete(body.planId)
      throw janitorError('plan_stale', 'the plan is unknown, expired, or already consumed')
    }
    // The envelope binds the single-use plan itself: kind, id, and the scan
    // generation the plan was minted under (a rescan invalidates the plan).
    if (resource.kind !== 'janitor_plan' || resource.id !== body.planId) {
      throw janitorError('identity_mismatch', 'resource binding does not name the staged plan')
    }
    if (resource.generation !== entry.generation) {
      throw janitorError('stale_generation', 'the plan is bound to another scan generation')
    }
    if (entry.digest !== body.planDigest) {
      throw janitorError('invalid_state', 'the plan digest does not match the staged plan')
    }
    plans.delete(body.planId) // Single use.
    const outcomes: Array<JanitorCommitResult['outcomes'][number]> = []
    for (const cached of entry.items) {
      outcomes.push(await commitItem(cached))
    }
    return { outcomes, observedAt: new Date(now()).toISOString() }
  }

  async function commitItem(cached: CachedItem): Promise<JanitorCommitResult['outcomes'][number]> {
    const { entry } = cached
    if (entry.disposal === 'prune') {
      // Git's own prunable reason said the directory is gone at scan time;
      // re-prove that immediately before the prune so a reappeared checkout
      // is never pruned.
      const presented = fs.lstat(entry.canonicalPath)
      if (presented && !presented.isSymbolicLink) {
        return { itemId: entry.id, outcome: 'skipped', detail: 'the worktree directory exists' }
      }
      if (!input.gitWorktreePrune || !cached.repoRoot) {
        return { itemId: entry.id, outcome: 'failed', detail: 'prune is unavailable' }
      }
      try {
        await input.gitWorktreePrune(cached.repoRoot)
        return { itemId: entry.id, outcome: 'pruned' }
      } catch (error) {
        return {
          itemId: entry.id,
          outcome: 'failed',
          detail: (error as Error).message.slice(0, 512),
        }
      }
    }
    // Identity re-proof immediately before the disposal.
    const presented = fs.lstat(entry.canonicalPath)
    if (!presented) {
      return { itemId: entry.id, outcome: 'skipped', detail: 'already gone' }
    }
    if (!identityMatches(presented, entry.identity, entry.isDirectory)) {
      return { itemId: entry.id, outcome: 'skipped', detail: 'changed on disk since the scan' }
    }
    if (entry.disposal === 'trash_empty') {
      // Only ever reached for entries discovered inside the Trash: the OS
      // already classified them deleted, so this is the permanent step.
      try {
        fs.removeRecursive(entry.canonicalPath)
        return { itemId: entry.id, outcome: 'emptied' }
      } catch (error) {
        return {
          itemId: entry.id,
          outcome: 'failed',
          detail: (error as Error).message.slice(0, 512),
        }
      }
    }
    // Move into the user's Trash (recoverable), same volume in practice; a
    // cross-volume rename fails the item instead of deleting anything.
    const trashRoot = sectionRoots.trash
    let existing: readonly string[] = []
    try {
      existing = fs.readdir(trashRoot)
    } catch {
      return { itemId: entry.id, outcome: 'failed', detail: 'the Trash is unavailable' }
    }
    const destination = join(trashRoot, trashDestinationName(existing, entry.label))
    try {
      fs.rename(entry.canonicalPath, destination)
    } catch (error) {
      return {
        itemId: entry.id,
        outcome: 'failed',
        detail: `move to Trash failed: ${(error as Error).message.slice(0, 400)}`,
      }
    }
    // Post-move revalidation: the moved entry must be the same directory.
    const moved = fs.lstat(destination)
    if (!identityMatches(moved, entry.identity, entry.isDirectory)) {
      return { itemId: entry.id, outcome: 'failed', detail: 'the moved entry changed identity' }
    }
    return {
      itemId: entry.id,
      outcome: 'trashed',
      detail: janitorPathLabel(home, destination),
    }
  }

  const plans = new Map<string, PlanEntry>()

  return { scan, measure, plan, commit }
}
