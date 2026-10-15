import {
  decodeRuntimeActivityPayload,
  isRuntimeActivityEventKind,
} from '../../../../../../packages/types/src/dev-runtime-activity'
import {
  decodeRuntimeActivityEvent,
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
    left.harnessRunId === right.harnessRunId &&
    left.source === right.source &&
    left.confidence === right.confidence &&
    left.classification === right.classification &&
    (!compareObservedAt || left.occurredAt === right.occurredAt) &&
    samePayload(prior, right.payload)
  )
}

function conflict(): never {
  throw {
    code: 'idempotency_conflict',
    retryable: false,
    message: 'different terminal observations share a retained command stream sequence',
  }
}

/** Does not emit, launch, parse terminal text, or calculate counts/statuses. */
export function admitRuntimeActivityEvent(
  candidate: RuntimeEvent,
  provenance: RuntimeEventProvenance,
  retained: readonly RuntimeEvent[]
): Readonly<{ event: RuntimeActivityEvent; duplicate: boolean }> {
  decodeRuntimeActivityEvent(candidate, provenance)
  const event = decodeRuntimeActivityEvent(JSON.parse(JSON.stringify(candidate)), provenance)
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return
    for (const entry of Object.values(value)) freeze(entry)
    Object.freeze(value)
  }
  freeze(event)
  if (event.kind !== 'terminal.output') return { event, duplicate: false }
  for (const prior of retained) {
    if (
      prior.kind !== event.kind ||
      prior.runtimeSessionId !== event.runtimeSessionId ||
      prior.generation !== event.generation ||
      prior.harnessRunId !== event.harnessRunId ||
      prior.source !== event.source
    )
      continue
    const payload = retainedPayload(prior)
    if (!payload) continue
    // The kind check above narrows the retained payload's schema, not its source authority.
    const previous = payload as typeof event.payload
    if (
      previous.terminalId !== event.payload.terminalId ||
      previous.commandId !== event.payload.commandId ||
      previous.stream !== event.payload.stream ||
      previous.sequence !== event.payload.sequence
    )
      continue
    if (!sameActivityReplay(prior, event, false)) conflict()
    return { event, duplicate: true }
  }
  return { event, duplicate: false }
}
