/*
 * Pure activity model for the #424 Activity section (#424 Agents pane).
 * Rows derive from `dev.harness.runs` (event provenance: the harness
 * substrate's own run records) and never fabricate state: a run without a
 * `startedAt` reports no elapsed time, and terminal runs keep their last
 * state. Attention states (`awaiting_input` / `awaiting_approval`) sort
 * first so the pane answers "what needs me?" without terminal scrolling.
 */
import type { HarnessRun } from '@adea-ai/types/dev-runtime'

export type ActivityRow = Readonly<{
  id: string
  runtimeSessionId: string
  agent: string
  modelId?: string
  state: HarnessRun['state']
  /** The run is waiting on the user (input or an approval). */
  attention: boolean
  /** The run is resolving/starting/working. */
  running: boolean
  elapsedMs?: number
  startedAt?: string
  finishedAt?: string
}>

const ATTENTION_STATES: ReadonlySet<HarnessRun['state']> = new Set([
  'awaiting_input',
  'awaiting_approval',
])
const RUNNING_STATES: ReadonlySet<HarnessRun['state']> = new Set([
  'resolving',
  'starting',
  'working',
])

/** Attention runs first, then running, then terminal runs (stable by id). */
function attentionRank(row: ActivityRow): 0 | 1 | 2 {
  return row.attention ? 0 : row.running ? 1 : 2
}

export function activityRows(runs: readonly HarnessRun[], now: number): readonly ActivityRow[] {
  return runs
    .map((run) => {
      const startedMs = run.startedAt !== undefined ? Date.parse(run.startedAt) : Number.NaN
      const elapsedMs = Number.isFinite(startedMs) && now >= startedMs ? now - startedMs : undefined
      return {
        id: run.id,
        runtimeSessionId: run.runtimeSessionId,
        agent: run.agentProfile.displayName,
        ...(run.modelId !== undefined ? { modelId: run.modelId } : {}),
        state: run.state,
        attention: ATTENTION_STATES.has(run.state),
        running: RUNNING_STATES.has(run.state),
        ...(elapsedMs !== undefined ? { elapsedMs } : {}),
        ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
        ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
      }
    })
    .toSorted((left, right) => {
      const leftRank = attentionRank(left)
      const rightRank = attentionRank(right)
      if (leftRank !== rightRank) return leftRank - rightRank
      return left.id.localeCompare(right.id)
    })
}

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export const ACTIVITY_STATE_LABELS: Record<HarnessRun['state'], string> = {
  resolving: 'Resolving',
  starting: 'Starting',
  working: 'Working',
  awaiting_input: 'Waiting for input',
  awaiting_approval: 'Needs approval',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  disconnected: 'Disconnected',
  unknown: 'Unknown',
}
