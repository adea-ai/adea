// Pure run-history presentation model (#400): bounded rows for the Agents /
// History pane built from durable HarnessRun records.
//
// Rows are newest-first, bounded (paged by the caller), and redacted by
// construction: only opaque installation IDs, profile refs, states, and
// caller-clock elapsed times are surfaced — never executable identities,
// host paths, prompts, or credential-shaped values (those do not exist on the
// DTO). Resume lineage is shown as generation counts, matching the
// resume-as-new-generation substrate.
import type { HarnessRun } from '@adea-ai/types/dev-runtime'
import { harnessStatusLabel } from '../agents/harness-status-model'

export type RunHistoryRow = Readonly<{
  runId: string
  runtimeSessionId: string
  installationId: string
  agentProfileId: string
  agentProfileVersion: number
  modelId?: string
  state: HarnessRun['state']
  stateLabel: string
  tone: 'neutral' | 'progress' | 'success' | 'failure' | 'unknown'
  startedAt?: string
  finishedAt?: string
  /** Elapsed ms when both ends are known (caller-clock, presentation only). */
  elapsedMs?: number
  /** Resume lineage: generation 2 is the second run of the same session. */
  generation: number
  /** True when this run is resumable (a terminal, non-cancelled ending). */
  resumable: boolean
  resumeReason: 'available' | 'cancelled' | 'missing_start' | 'non_terminal' | 'unknown_state'
}>

/** Bounded newest-first history rows; `nowMs` is injected for pure tests. */
export function buildRunHistoryRows(
  runs: readonly HarnessRun[],
  options: { nowMs?: number; limit?: number } = {}
): readonly RunHistoryRow[] {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500)
  const nowMs = options.nowMs
  return runs
    .toSorted((left, right) => (right.startedAt ?? '').localeCompare(left.startedAt ?? ''))
    .slice(0, limit)
    .map((run) => ({
      runId: run.id,
      runtimeSessionId: run.runtimeSessionId,
      installationId: run.installationId,
      agentProfileId: run.agentProfile.id,
      agentProfileVersion: run.agentProfile.version,
      ...(run.modelId !== undefined ? { modelId: run.modelId } : {}),
      state: run.state,
      stateLabel: harnessStatusLabel(run.state),
      tone: stateTone(run.state),
      ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
      ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
      ...(run.startedAt !== undefined
        ? {
            elapsedMs: elapsedMs(
              run.startedAt,
              run.finishedAt,
              nowMs !== undefined ? new Date(nowMs).toISOString() : undefined
            ),
          }
        : {}),
      generation: run.generation,
      resumable: isResumable(run),
      resumeReason: resumeReason(run),
    }))
}

function isResumable(run: HarnessRun): boolean {
  return (
    (run.state === 'completed' || run.state === 'disconnected' || run.state === 'failed') &&
    run.startedAt !== undefined
  )
}

function resumeReason(run: HarnessRun): RunHistoryRow['resumeReason'] {
  if (isResumable(run)) return 'available'
  if (run.state === 'cancelled') return 'cancelled'
  if (run.state === 'unknown') return 'unknown_state'
  if (run.startedAt === undefined) return 'missing_start'
  return 'non_terminal'
}

/**
 * Return the visible window for a virtualized history list. The source rows
 * remain the canonical bounded page; this helper only computes the viewport
 * slice and never creates a second retained collection.
 */
export function virtualHistoryRows(
  rows: readonly RunHistoryRow[],
  options: { start: number; visible: number; overscan?: number }
): readonly RunHistoryRow[] {
  const overscan = Math.min(Math.max(options.overscan ?? 8, 0), 50)
  const start = Math.max(options.start - overscan, 0)
  const end = Math.min(options.start + Math.max(options.visible, 0) + overscan, rows.length)
  return rows.slice(start, end)
}

function stateTone(state: HarnessRun['state']): RunHistoryRow['tone'] {
  switch (state) {
    case 'working':
      return 'success'
    case 'awaiting_input':
    case 'awaiting_approval':
    case 'starting':
    case 'resolving':
      return 'progress'
    case 'failed':
    case 'disconnected':
      return 'failure'
    case 'unknown':
      return 'unknown'
    default:
      return 'neutral'
  }
}

function elapsedMs(
  startedAt: string,
  finishedAt: string | undefined,
  nowIso: string | undefined
): number | undefined {
  const end = finishedAt ?? nowIso
  if (end === undefined) return undefined
  const startMs = Date.parse(startedAt)
  const endMs = Date.parse(end)
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) return undefined
  return endMs - startMs
}
