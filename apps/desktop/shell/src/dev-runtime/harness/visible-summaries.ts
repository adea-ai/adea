import {
  decodeRuntimeEvent,
  type RuntimeEvent,
} from '../../../../../../packages/types/src/dev-runtime-wire'
import type { Scope } from '../../../../../../packages/types/src/dev-runtime'
import {
  decodeRuntimeVisibleSummary,
  isRuntimeVisibleSummaryKind,
  type RuntimeVisibleSummary,
} from '../../../../../../packages/types/src/dev-runtime-visible-summaries'

/** Verified by the adapter against an authenticated, explicitly user-visible source
 * observation. Never implement this by trusting labels from the event payload.
 */
export type VisibleSummaryObservation = Readonly<{ scope: Scope }> &
  Pick<
    RuntimeEvent,
    | 'runtimeSessionId'
    | 'harnessRunId'
    | 'generation'
    | 'source'
    | 'sourceEventId'
    | 'confidence'
    | 'classification'
    | 'kind'
    | 'payload'
  >
export type VisibleSummaryVerifier = (observation: VisibleSummaryObservation) => boolean

function refuse(message: string): never {
  throw new TypeError(`event.summary: ${message}`)
}
function identity(payload: RuntimeVisibleSummary): string {
  return 'summaryId' in payload
    ? `reasoning:${payload.summaryId}`
    : `method:${payload.methodId}\u0000${payload.stepId}`
}

/** Validate the retained suffix only; snapshots never need an evicted prefix. */
export function assertVisibleSummaryReplay(records: readonly RuntimeEvent[]): void {
  const streams = new Map<string, RuntimeVisibleSummary>()
  const durations = new Map<string, number>()
  const summaries = records.filter((event) => isRuntimeVisibleSummaryKind(event.kind))
  for (const event of summaries) decodeRuntimeEvent(event, { source: event.source })
  for (const event of summaries.toSorted((left, right) =>
    BigInt(left.seq) < BigInt(right.seq) ? -1 : 1
  )) {
    const payload = event.payload as RuntimeVisibleSummary
    const key = JSON.stringify([
      event.runtimeSessionId,
      event.generation,
      event.harnessRunId,
      event.source,
      event.kind,
      identity(payload),
    ])
    const previous = streams.get(key)
    if (previous) {
      if (payload.revision <= previous.revision) refuse('retained snapshot revision must increase')
      if (['completed', 'failed', 'cancelled'].includes(previous.status))
        refuse('retained terminal summary cannot be updated')
      if ('position' in payload && 'position' in previous && payload.position !== previous.position)
        refuse('retained method-step position changed')
    }
    if (payload.durationMs !== undefined) {
      if (payload.durationMs < (durations.get(key) ?? 0)) refuse('retained duration decreased')
      durations.set(key, payload.durationMs)
    }
    streams.set(key, payload)
  }
}

/** Enforce snapshot evolution, then require an independent source observation.
 * This is called after exact duplicate handling and before any durable effect.
 */
export function assertVisibleSummaryAppend(
  event: RuntimeEvent,
  records: readonly RuntimeEvent[],
  scope: Scope,
  verify: VisibleSummaryVerifier | undefined
): void {
  if (!isRuntimeVisibleSummaryKind(event.kind)) return
  decodeRuntimeEvent(event, { source: event.source })
  const next = decodeRuntimeVisibleSummary(event.kind, event.payload)
  const history = records
    .filter(
      (previous) =>
        previous.kind === event.kind &&
        previous.runtimeSessionId === event.runtimeSessionId &&
        previous.harnessRunId === event.harnessRunId &&
        previous.generation === event.generation &&
        previous.source === event.source &&
        identity(previous.payload as RuntimeVisibleSummary) === identity(next)
    )
    .toSorted((left, right) => (BigInt(left.seq) < BigInt(right.seq) ? -1 : 1))
  const latest = history.at(-1)?.payload as RuntimeVisibleSummary | undefined
  if (latest) {
    if (next.revision <= latest.revision) refuse('snapshot revision must increase')
    if (['completed', 'failed', 'cancelled'].includes(latest.status))
      refuse('terminal summary cannot be updated')
    if ('position' in next && 'position' in latest && next.position !== latest.position)
      refuse('method-step position cannot change')
  }
  if (
    next.durationMs !== undefined &&
    history.some(
      (previous) => ((previous.payload as RuntimeVisibleSummary).durationMs ?? 0) > next.durationMs!
    )
  )
    refuse('source-reported duration cannot decrease')
  const observation: VisibleSummaryObservation = {
    scope,
    runtimeSessionId: event.runtimeSessionId,
    harnessRunId: event.harnessRunId,
    generation: event.generation,
    source: event.source,
    sourceEventId: event.sourceEventId,
    confidence: event.confidence,
    classification: event.classification,
    kind: event.kind,
    payload: event.payload,
  }
  // A verifier cannot mutate bytes that have already passed structural checks.
  if (verify?.(structuredClone(observation)) !== true)
    refuse('a verified source-reported user-visible observation is required')
}
