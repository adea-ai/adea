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
}>

/** Bounded newest-first history rows; `nowMs` is injected for pure tests. */
export function buildRunHistoryRows(
  runs: readonly HarnessRun[],
  options: { nowMs?: number; limit?: number } = {}
): readonly RunHistoryRow[] {
  const limit = options.limit ?? 100
  const nowMs = options.nowMs
  return runs
    .toSorted((left, right) => (right.startedAt ?? '').localeCompare(left.startedAt ?? ''))
    .slice(0, limit)
    .map((run) => ({
      runId: run.id,
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
      resumable:
        (run.state === 'completed' || run.state === 'disconnected' || run.state === 'failed') &&
        run.startedAt !== undefined,
    }))
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
