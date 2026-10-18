import {
  decodeRuntimeActivityPayload,
  isRuntimeActivityEventKind,
} from '../../../../../../packages/types/src/dev-runtime-activity'
import {
  decodeRuntimeActivityEvent,
  validateRuntimeActivityReplayCandidate,
  encodeCbor,
  type RuntimeActivityEvent,
  type RuntimeEvent,
  type RuntimeEventProvenance,
} from '../../../../../../packages/types/src/dev-runtime-wire'

function samePayload(left: unknown, right: unknown): boolean {
  const first = encodeCbor(left)
  const second = encodeCbor(right)
  return (
    first.byteLength === second.byteLength && first.every((byte, index) => byte === second[index])
  )
}

/** Stored legacy/future opaque data supplies no structured identity fact. */
function retainedPayload(event: RuntimeEvent) {
  if (
    !isRuntimeActivityEventKind(event.kind) ||
    event.payload === null ||
    typeof event.payload !== 'object' ||
    !Object.hasOwn(event.payload, 'schemaVersion') ||
    (event.payload as { schemaVersion: unknown }).schemaVersion !== 1
  )
    return undefined
  return decodeRuntimeActivityPayload(event.payload, event.kind)
}

export function sameActivityReplay(
  left: RuntimeEvent,
  right: RuntimeEvent,
  compareObservedAt: boolean
): boolean {
  const prior = retainedPayload(left)
  return (
    prior !== undefined &&
    left.kind === right.kind &&
    left.runtimeSessionId === right.runtimeSessionId &&
    left.generation === right.generation &&
    left.harnessRunId === right.harnessRunId &&
    left.source === right.source &&
    left.confidence === right.confidence &&
    left.classification === right.classification &&
    (!compareObservedAt || left.occurredAt === right.occurredAt) &&
    samePayload(prior, right.payload)
  )
}

function conflict(
  message = 'different terminal observations share a retained command stream sequence'
): never {
  throw {
    code: 'idempotency_conflict',
    retryable: false,
    message,
  }
}

/** Does not emit, launch, parse terminal text, or calculate counts/statuses. */
export function admitRuntimeActivityEvent(
  candidate: RuntimeEvent,
  provenance: RuntimeEventProvenance,
  retained: readonly RuntimeEvent[],
  compareObservedAt = false
): Readonly<{ duplicate: true }> | Readonly<{ duplicate: false; event: RuntimeActivityEvent }> {
  // A retry creates no frame: validate its facts and ownership first, then
  // compare identities without charging a provisional new host sequence.
  validateRuntimeActivityReplayCandidate(candidate, provenance)
  const snapshot = JSON.parse(JSON.stringify(candidate)) as RuntimeEvent
  validateRuntimeActivityReplayCandidate(snapshot, provenance)
  const sourceDuplicate = retained.find(
    (prior) =>
      prior.runtimeSessionId === snapshot.runtimeSessionId &&
      prior.generation === snapshot.generation &&
      prior.source === snapshot.source &&
      prior.sourceEventId === snapshot.sourceEventId
  )
  if (sourceDuplicate) {
    if (!sameActivityReplay(sourceDuplicate, snapshot, compareObservedAt))
      conflict('a different activity event already exists under this source event identity')
    return { duplicate: true }
  }
  if (snapshot.kind === 'terminal.output') {
    const output = decodeRuntimeActivityPayload(snapshot.payload, snapshot.kind)
    for (const prior of retained) {
      if (
        prior.kind !== snapshot.kind ||
        prior.runtimeSessionId !== snapshot.runtimeSessionId ||
        prior.generation !== snapshot.generation ||
        prior.harnessRunId !== snapshot.harnessRunId ||
        prior.source !== snapshot.source
      )
        continue
      const payload = retainedPayload(prior)
      if (!payload) continue
      const previous = payload as typeof output
      if (
        previous.terminalId !== output.terminalId ||
        previous.commandId !== output.commandId ||
        previous.stream !== output.stream ||
        previous.sequence !== output.sequence
      )
        continue
      if (!sameActivityReplay(prior, snapshot, false)) conflict()
      return { duplicate: true }
    }
  }
  // Every new record must still pass the complete CBOR/hook envelope budget.
  const event = decodeRuntimeActivityEvent(snapshot, provenance)
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return
    for (const entry of Object.values(value)) freeze(entry)
    Object.freeze(value)
  }
  freeze(event)
  return { event, duplicate: false }
}
