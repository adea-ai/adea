// Live worktree facts for cleanup-policy evaluation (#424).
//
// The adapter answers one worktree at a time from read-only sources only: the
// worktree service's durable record, the lease store's live views, and
// fixed-argv read-only git observation (`status --porcelain`,
// `rev-parse --verify`, `rev-list --count`) over the worktree's canonical
// root — the same argv-only, prompt-free, optional-locks-free discipline the
// worktree service's own fact observation uses. Nothing here mutates git
// state, leases, or records.
//
// Truthfulness bar: a fact is reported only when it was actually observed.
// An unknown worktree returns undefined (the policy authority fails the whole
// evaluation closed); a git command that fails, or push state that cannot be
// proven (no branch ref), leaves that fact absent — and every cleanup
// predicate over an absent fact fails closed, so an unprovable state can
// never satisfy an automatic policy. Facts this read-only adapter cannot
// prove (PR merge state, attached owned resources) stay absent by design
// until their owning slices expose a provable source.
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

export type CleanupWorktreeFactsInput = Readonly<{
  worktrees: CleanupWorktreeSource
  scope: Scope
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

/**
 * The cleanup-policy facts seam: `(worktreeId) => facts | undefined`.
 * Unknown worktrees return undefined; known worktrees return exactly the
 * facts the read-only sources proved at call time.
 */
export function createCleanupWorktreeFacts(
  input: CleanupWorktreeFactsInput
): (worktreeId: string) => CleanupFacts | undefined {
  const run = input.runGit ?? defaultRunGit
  const clock = input.clock ?? (() => new Date())
  return (worktreeId) => {
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
    const archivedSeconds = archivedSecondsFact(record, clock().getTime())
    if (archivedSeconds !== undefined) facts['archived_seconds'] = archivedSeconds
    return facts
  }
}
