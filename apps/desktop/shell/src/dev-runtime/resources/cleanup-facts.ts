// Live worktree facts for cleanup-policy evaluation (#424).
//
// The adapter answers one worktree at a time from read-only sources only: the
// worktree service's durable record, the lease store's live views, the merge
// service's durable merge journal (pure read), the live owned-resource census
// the composition builds from the registries the shell already holds, and
// fixed-argv read-only git observation (`status --porcelain`,
// `rev-parse --verify`, `rev-list --count`, `merge-base --is-ancestor`) over
// the worktree's canonical root or the recorded repository root — the same
// argv-only, prompt-free, optional-locks-free discipline the worktree
// service's own fact observation uses. Nothing here mutates git state,
// leases, journals, or records.
//
// Truthfulness bar: a fact is reported only when it was actually observed,
// and every fact carries its provenance. An unknown worktree returns
// undefined (the policy authority fails the whole evaluation closed); a git
// command that fails, or push state that cannot be proven (no branch ref),
// leaves that fact absent — and every cleanup predicate over an absent fact
// fails closed, so an unprovable state can never satisfy an automatic policy.
//
// The two facts this slice added provable sources for:
// - `pr_merged` — the durable merge-back journal (`merge-records.json`, the
//   merge service's own fsynced records) is cited by record token, and the
//   recorded published SHA is verified against the recorded target ref right
//   now with fixed-argv read-only git. A GitHub-side PR merge has no durable
//   journal in this runtime yet, so it stays absent (fail closed) until the
//   provider slice journals its merges.
// - `active_owned_resources` — the live census seam (running terminals from
//   the terminal registrar's census, active harness runs and browser lanes
//   joined through their runtime-session records) counts resources attached
//   to this worktree; each counted resource is cited by registry record id
//   and binding generation in the `owned_resources` provenance fact.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Scope } from '../../../../../../packages/types/src/dev-runtime'
import { gitChildEnv } from '../worktrees/git-run'
import type { LeaseView } from '../worktrees/leases'
import type { WorktreeRecord } from '../worktrees/service'
import type { CleanupFacts } from './policy'

export const GIT_FACT_TIMEOUT_MS = 5_000

/** Narrow read-only view of the worktree service this adapter consumes. */
export type CleanupWorktreeSource = Readonly<{
  getWorktree(scope: Scope, worktreeId: string): WorktreeRecord | undefined
  leases: Readonly<{ list(worktreeId: string): readonly LeaseView[] }>
}>

/** Injectable read-only git transport: fixed argv plus cwd in, observed
 *  output out. Tests script this; production spawns `git` verbatim. */
export type GitFactRunner = (
  args: readonly string[],
  cwd: string
) => { exitCode: number; stdout: string } | undefined

/** One live owned-resource record the census observed, cited by registry
 *  record id and the generation its binding carries. */
export type OwnedResourceRef = Readonly<{
  /** The owning registry's record id (terminal id, harness run id, lane id). */
  id: string
  /** The owning lane kind, named exactly as the registry names it. */
  kind: string
  worktreeId: string
  /** The generation the resource's worktree binding carries. */
  generation: number
}>

/** Live owned-resource census: what the shell's registries prove attached
 *  right now. Production builds it in the composition from the terminal
 *  registrar's census, the durable harness run history, the browser lane
 *  registry, and the project-session records; tests script it. */
export type OwnedResourceCensus = () =>
  | readonly OwnedResourceRef[]
  | Promise<readonly OwnedResourceRef[]>

export type CleanupWorktreeFactsInput = Readonly<{
  worktrees: CleanupWorktreeSource
  scope: Scope
  /** The merge service's durable journal file (`merge-records.json`);
   *  absent leaves `pr_merged` unprovable. Pure read — never rewritten. */
  mergeRecordsPath?: string
  /** Live owned-resource census; absent leaves `active_owned_resources`
   *  unprovable (the predicate fails closed). */
  census?: OwnedResourceCensus
  runGit?: GitFactRunner
  clock?: () => Date
}>

function defaultRunGit(
  args: readonly string[],
  cwd: string
): { exitCode: number; stdout: string } | undefined {
  const proc = Bun.spawnSync(['git', ...args], {
    cwd,
    env: gitChildEnv(),
    stdout: 'pipe',
    stderr: 'ignore',
    timeout: GIT_FACT_TIMEOUT_MS,
  })
  return { exitCode: proc.exitCode ?? 1, stdout: proc.stdout.toString() }
}

function cleanFact(run: GitFactRunner, cwd: string): string | undefined {
  const status = run(['status', '--porcelain'], cwd)
  if (!status || status.exitCode !== 0) return undefined
  return status.stdout.trim().length === 0 ? 'true' : 'false'
}

/** Push state from the upstream comparison; falls back to the local
 *  no-remote-reachable count when no upstream is configured. */
function pushedFact(run: GitFactRunner, cwd: string, branch: string): string | undefined {
  const upstream = run(['rev-parse', '--verify', '--quiet', `${branch}@{upstream}`], cwd)
  if (upstream && upstream.exitCode === 0) {
    const count = run(
      ['rev-list', '--left-right', '--count', `${branch}...${branch}@{upstream}`],
      cwd
    )
    if (!count || count.exitCode !== 0) return undefined
    const ahead = count.stdout.trim().split('\t')[0] ?? ''
    return /^\d+$/.test(ahead) ? (ahead === '0' ? 'true' : 'false') : undefined
  }
  const unpushed = run(['rev-list', '--count', branch, '--not', '--remotes'], cwd)
  if (!unpushed || unpushed.exitCode !== 0) return undefined
  const count = unpushed.stdout.trim()
  return /^\d+$/.test(count) ? (count === '0' ? 'true' : 'false') : undefined
}

function leaseFact(
  leases: CleanupWorktreeSource['leases'],
  worktreeId: string
): string | undefined {
  let views: readonly LeaseView[]
  try {
    views = leases.list(worktreeId)
  } catch {
    return undefined
  }
  // Suspect leases still hold the worktree: only released/expired views free it.
  const live = views.filter(
    (view) => view.effectiveState === 'active' || view.effectiveState === 'suspect'
  ).length
  return String(live)
}

function archivedSecondsFact(record: WorktreeRecord, atMs: number): string | undefined {
  if (!record.archived) return '0'
  const archivedAt = Date.parse(record.updatedAt)
  if (!Number.isFinite(archivedAt)) return undefined
  return String(Math.max(0, Math.floor((atMs - archivedAt) / 1000)))
}

// ─── pr_merged: durable merge journal + verified ref state ──────────────────

/** The merge journal record shape this adapter reads (the merge service's
 *  durable `MergeRecord`); unknown extra fields are ignored. */
export type MergeJournalRecord = Readonly<{
  token?: unknown
  worktreeId?: unknown
  state?: unknown
  sourceBranch?: unknown
  targetRef?: unknown
  publishedSha?: unknown
  repoPath?: unknown
  updatedAt?: unknown
}>

/** A journal record that proved `merged` with every field the fact needs. */
type MergedJournalRecord = Readonly<{
  token: string
  sourceBranch: string
  targetRef: string
  publishedSha: string
  repoPath: string
  updatedAt: string
}>

function asMergedRecord(
  record: MergeJournalRecord,
  worktreeId: string,
  branchRef: string
): MergedJournalRecord | undefined {
  if (record.state !== 'merged' || record.worktreeId !== worktreeId) return undefined
  if (record.sourceBranch !== branchRef) return undefined
  if (
    typeof record.token !== 'string' ||
    record.token.length === 0 ||
    typeof record.sourceBranch !== 'string' ||
    typeof record.targetRef !== 'string' ||
    typeof record.publishedSha !== 'string' ||
    record.publishedSha.length === 0 ||
    typeof record.repoPath !== 'string' ||
    record.repoPath.length === 0 ||
    typeof record.updatedAt !== 'string'
  )
    return undefined
  return {
    token: record.token,
    sourceBranch: record.sourceBranch,
    targetRef: record.targetRef,
    publishedSha: record.publishedSha,
    repoPath: record.repoPath,
    updatedAt: record.updatedAt,
  }
}

/**
 * Pure read of the merge journal: an envelope `{ schemaVersion: 1,
 * records: [...] }`. A missing, corrupt, or drifted file contributes nothing
 * and is never rewritten from here (the owning merge service owns recovery) —
 * `pr_merged` simply stays unprovable.
 */
export function readMergeJournal(path: string): readonly MergeJournalRecord[] {
  if (!existsSync(path)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
  const envelope = parsed as { schemaVersion?: unknown; records?: unknown } | null
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    envelope.schemaVersion !== 1 ||
    !Array.isArray(envelope.records)
  )
    return []
  return envelope.records.filter(
    (entry): entry is MergeJournalRecord =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry)
  )
}

/**
 * `pr_merged` from a durable merge record plus the ref state it verified:
 * the newest `merged` journal record for this worktree whose recorded source
 * branch is still the worktree's branch, cited by token, with the recorded
 * published SHA verified against the recorded target ref right now (fixed-
 * argv read-only git in the recorded repository root). Exit 0 proves
 * containment (`'true'`), exit 1 proves the target ref no longer contains it
 * (`'false'` — a provable negative), anything else leaves the fact absent.
 * Provenance lands in `pr_merged_source` as `merge-record:<token>`.
 */
export function prMergedFact(input: {
  run: GitFactRunner
  records: readonly MergeJournalRecord[]
  worktreeId: string
  branchRef: string
}): { merged: string; source: string } | undefined {
  const record = input.records
    .flatMap((entry) => {
      const merged = asMergedRecord(entry, input.worktreeId, input.branchRef)
      return merged ? [merged] : []
    })
    .toSorted(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || right.token.localeCompare(left.token)
    )[0]
  if (!record) return undefined
  const verified = input.run(
    ['merge-base', '--is-ancestor', record.publishedSha, record.targetRef],
    record.repoPath
  )
  if (!verified) return undefined
  if (verified.exitCode !== 0 && verified.exitCode !== 1) return undefined
  return {
    merged: verified.exitCode === 0 ? 'true' : 'false',
    source: `merge-record:${record.token}`,
  }
}

// ─── active_owned_resources: live census ────────────────────────────────────

async function ownedResourceFacts(
  census: OwnedResourceCensus,
  worktreeId: string
): Promise<{ count: string; detail: string } | undefined> {
  let observed: readonly OwnedResourceRef[]
  try {
    observed = await census()
  } catch {
    return undefined
  }
  const mine = observed
    .filter((entry) => entry.worktreeId === worktreeId)
    .filter(
      (entry) =>
        typeof entry.id === 'string' &&
        entry.id.length > 0 &&
        typeof entry.kind === 'string' &&
        Number.isSafeInteger(entry.generation)
    )
    .toSorted((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))
  return {
    count: String(mine.length),
    // Provenance: every counted resource cites its registry record id and
    // its binding generation (bounded so the fact string stays a fact line).
    detail: mine
      .slice(0, 32)
      .map((entry) => `${entry.kind}:${entry.id}@${entry.generation}`)
      .join(';'),
  }
}

/**
 * The cleanup-policy facts seam: `(worktreeId) => facts | undefined`.
 * Unknown worktrees return undefined; known worktrees return exactly the
 * facts the read-only sources proved at call time. The census seam is
 * observed asynchronously, so the returned function resolves a promise only
 * when a census is composed — the policy authority awaits either shape.
 */
export function createCleanupWorktreeFacts(
  input: CleanupWorktreeFactsInput
): (worktreeId: string) => CleanupFacts | undefined | Promise<CleanupFacts | undefined> {
  const run = input.runGit ?? defaultRunGit
  const clock = input.clock ?? (() => new Date())
  return (worktreeId) => {
    const { census } = input
    const observe = (): CleanupFacts | undefined => {
      let record: WorktreeRecord | undefined
      try {
        record = input.worktrees.getWorktree(input.scope, worktreeId)
      } catch {
        return undefined
      }
      if (!record) return undefined
      const facts: Record<string, string> = {}
      const leases = leaseFact(input.worktrees.leases, worktreeId)
      if (leases !== undefined) facts['active_leases'] = leases
      // Git facts are only observable for a real checkout on disk.
      const clean = cleanFact(run, join(record.canonicalRoot))
      if (clean !== undefined) facts['clean'] = clean
      const branch = record.branchRef?.replace('refs/heads/', '')
      if (branch) {
        const pushed = pushedFact(run, record.canonicalRoot, branch)
        if (pushed !== undefined) facts['pushed'] = pushed
      }
      // The journal is re-read per observation so a merge that landed after
      // this adapter was composed is still provable (pure read, bounded file).
      if (record.branchRef && input.mergeRecordsPath) {
        const merged = prMergedFact({
          run,
          records: readMergeJournal(input.mergeRecordsPath),
          worktreeId,
          branchRef: record.branchRef,
        })
        if (merged !== undefined) {
          facts['pr_merged'] = merged.merged
          facts['pr_merged_source'] = merged.source
        }
      }
      const archivedSeconds = archivedSecondsFact(record, clock().getTime())
      if (archivedSeconds !== undefined) facts['archived_seconds'] = archivedSeconds
      return facts
    }
    if (census === undefined) return observe()
    return ownedResourceFacts(census, worktreeId).then((owned) => {
      if (owned === undefined) return observe()
      const facts = observe()
      if (facts === undefined) return undefined
      return {
        ...facts,
        active_owned_resources: owned.count,
        ...(owned.detail.length > 0 ? { owned_resources: owned.detail } : {}),
      }
    })
  }
}
