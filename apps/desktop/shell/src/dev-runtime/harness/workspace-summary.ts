// Counts-only cross-workspace run summary (ADR 0011 "Counts-only
// cross-workspace status"): the pure fold behind `dev.summary.workspaces`.
//
// The input is the shared harness run registry (`dev-runtime/harness/runs.json`)
// — the one durable file that already holds every scope's runs on this device.
// The fold never opens a project/session authority partition or any other
// per-scope file, so a collapsed workspace can show "running" and "needs you"
// without the active scope reading another scope's records:
// - only scopes whose accountId AND runtimeNodeId equal the active scope's
//   are counted (another account's or node's runs never appear);
// - only non-terminal, observed-live states count: resolving/starting/working
//   are `running`, awaiting_input/awaiting_approval are `needsInput`;
//   terminal states and the `unknown` holding state count as neither;
// - archive state lives in each scope's authority partition, which this read
//   must not open. The active scope's own partition is already open, so its
//   archived (or unresolvable) sessions are excluded; another scope's runs are
//   counted by run state alone;
// - the reply carries the workspace id and two integers — no names, paths,
//   session or run ids, or content.
import type {
  HarnessRun,
  HarnessRunState,
  Scope,
  WorkspaceRunSummary,
  WorkspaceRunSummaryItem,
} from '../../../../../../packages/types/src/dev-runtime'
import { MAX_WORKSPACE_RUN_SUMMARY_ITEMS } from '../../../../../../packages/types/src/dev-runtime'

/** Observed live, no user action needed. */
export const SUMMARY_RUNNING_STATES: ReadonlySet<HarnessRunState> = new Set([
  'resolving',
  'starting',
  'working',
])
/** Observed waiting on the user. */
export const SUMMARY_NEEDS_INPUT_STATES: ReadonlySet<HarnessRunState> = new Set([
  'awaiting_input',
  'awaiting_approval',
])

export type SummaryRun = Pick<HarnessRun, 'scope' | 'runtimeSessionId' | 'state'>

/** Same account and runtime node; the workspace may differ. */
export function sameAccountAndNode(left: Scope, right: Scope): boolean {
  return left.accountId === right.accountId && left.runtimeNodeId === right.runtimeNodeId
}

/**
 * Folds run records into per-workspace counts for the active scope's account
 * and runtime node. `isActiveSessionLive` answers only for the active scope's
 * sessions (from its already-open authority); it is never asked about another
 * workspace's session. Items are sorted by workspace id (code point) and
 * contain only workspaces with at least one counted run, bounded by
 * MAX_WORKSPACE_RUN_SUMMARY_ITEMS.
 */
export function summarizeWorkspaceRuns(input: {
  runs: readonly SummaryRun[]
  activeScope: Scope
  isActiveSessionLive: (runtimeSessionId: string) => boolean
  observedAt: string
}): WorkspaceRunSummary {
  const counts = new Map<string, { running: number; needsInput: number }>()
  for (const run of input.runs) {
    if (!sameAccountAndNode(run.scope, input.activeScope)) continue
    const running = SUMMARY_RUNNING_STATES.has(run.state)
    const needsInput = SUMMARY_NEEDS_INPUT_STATES.has(run.state)
    if (!running && !needsInput) continue
    if (
      run.scope.workspaceId === input.activeScope.workspaceId &&
      !input.isActiveSessionLive(run.runtimeSessionId)
    )
      continue
    const entry = counts.get(run.scope.workspaceId) ?? { running: 0, needsInput: 0 }
    if (running) entry.running += 1
    else entry.needsInput += 1
    counts.set(run.scope.workspaceId, entry)
  }
  const items: WorkspaceRunSummaryItem[] = [...counts.entries()]
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .slice(0, MAX_WORKSPACE_RUN_SUMMARY_ITEMS)
    .map(([workspaceId, entry]) => ({ workspaceId, ...entry }))
  return { items, observedAt: input.observedAt }
}
