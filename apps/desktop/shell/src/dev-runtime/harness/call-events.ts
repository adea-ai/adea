import {
  decodeRuntimeCallEvent,
  isRuntimeCallEventKind,
  type RuntimeCallEvent,
  type RuntimeEvent,
} from '../../../../../../packages/types/src/dev-runtime-wire'

/** Supplied only by the owning structured adapter, using its permission fact. */
export type VerifyCallPermissionEligibility = (event: RuntimeCallEvent) => boolean

/** Detach the bounded JSON so verifier/subscriber code cannot alter admitted facts. */
export function snapshotCallEvent(candidate: RuntimeEvent): RuntimeCallEvent {
  decodeRuntimeCallEvent(candidate, { source: candidate.source })
  const snapshot = decodeRuntimeCallEvent(JSON.parse(JSON.stringify(candidate)), {
    source: candidate.source,
  })
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return
    for (const entry of Object.values(value)) freeze(entry)
    Object.freeze(value)
  }
  freeze(snapshot)
  return snapshot
}

function sameNamespace(left: RuntimeEvent, right: RuntimeEvent): boolean {
  return (
    left.runtimeSessionId === right.runtimeSessionId &&
    left.generation === right.generation &&
    left.harnessRunId === right.harnessRunId &&
    left.source === right.source
  )
}

/** Checks retained facts only. It never fabricates a start, completion or parent. */
export function validateCallEventAdmission(
  candidate: RuntimeEvent,
  retained: readonly RuntimeEvent[],
  verifyPermission?: VerifyCallPermissionEligibility
): void {
  const event = decodeRuntimeCallEvent(candidate, { source: candidate.source })
  if (event.payload.permissionEligibility !== 'unknown' && verifyPermission?.(event) !== true)
    throw new TypeError('event.payload.permissionEligibility: missing verified adapter observation')

  const parents = new Map<string, string | null>()
  for (const previous of retained) {
    if (!sameNamespace(previous, event) || !isRuntimeCallEventKind(previous.kind)) continue
    // A retained legacy opaque row is not a call-identity fact.
    if (
      previous.payload === null ||
      typeof previous.payload !== 'object' ||
      !Object.hasOwn(previous.payload, 'schemaVersion')
    )
      continue
    const prior = decodeRuntimeCallEvent(previous, { source: previous.source })
    if (prior.payload.callId === event.payload.callId) {
      if ((prior.kind === 'subagent.observed') !== (event.kind === 'subagent.observed'))
        throw new TypeError('event.kind: call identity reused across tool and subagent families')
      if (
        prior.payload.parentCallId !== undefined &&
        event.payload.parentCallId !== undefined &&
        prior.payload.parentCallId !== event.payload.parentCallId
      )
        throw new TypeError('event.payload.parentCallId: conflicts with retained call identity')
    }
    if (prior.payload.parentCallId !== undefined)
      parents.set(prior.payload.callId, prior.payload.parentCallId)
  }
  if (event.payload.parentCallId !== undefined)
    parents.set(event.payload.callId, event.payload.parentCallId)
  const visited = new Set<string>()
  let ancestor: string | null | undefined = event.payload.callId
  while (ancestor !== undefined && ancestor !== null) {
    if (visited.has(ancestor))
      throw new TypeError('event.payload.parentCallId: retained parent cycle')
    visited.add(ancestor)
    ancestor = parents.get(ancestor)
  }
}
