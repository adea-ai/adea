/** Privacy projection, not delivery authentication or execution acceptance. */
import { createHash } from 'node:crypto'
import {
  AgentHqExecutionEventEnvelopeSchema,
  ArtifactReferenceSchema,
  UsageEnvelopeSchema,
  canonicalJsonStringify,
  type AgentHqExecutionEventEnvelope,
} from '@adea-ai/contracts'

export const MAX_CONTROL_PLANE_EVENT_BYTES = 24 * 1024
const MAX_SOURCE_DATA_BYTES = 16 * 1024
const MAX_PROJECTION_BYTES = 8 * 1024

const supportedEvents = new Set([
  'execution.accepted',
  'execution.queued',
  'execution.starting',
  'execution.started',
  'execution.running',
  'execution.progressed',
  'execution.awaiting_input',
  'execution.cancelling',
  'execution.completed',
  'execution.failed',
  'execution.cancelled',
  'execution.timed_out',
  'execution.runtime_unavailable',
  'execution.provider_state',
  'execution.reconciliation_required',
  'attempt.queued',
  'attempt.starting',
  'attempt.started',
  'attempt.running',
  'attempt.progressed',
  'attempt.awaiting_input',
  'attempt.cancelling',
  'attempt.completed',
  'attempt.failed',
  'attempt.cancelled',
  'attempt.timed_out',
  'attempt.runtime_unavailable',
  'attempt.provider_state',
  'interaction.requested',
  'interaction.resolved',
  'usage.recorded',
  'artifact.created',
  'artifact.updated',
  'artifact.referenced',
  'reconciliation.required',
  'reconciliation.completed',
  'reconciliation.failed',
])
const states = [
  'accepted',
  'queued',
  'starting',
  'running',
  'awaiting_input',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'reconciliation_required',
] as const
const availabilityStates = ['available', 'degraded', 'unavailable', 'revoked'] as const
const providerStates = [
  'available',
  'degraded',
  'unavailable',
  'rate_limited',
  'authentication_required',
  'revoked',
] as const
const failureClasses = [
  'validation',
  'policy',
  'runtime_unavailable',
  'runtime_error',
  'infrastructure',
  'timeout',
  'cancelled',
  'unknown',
] as const

const envelopeSchema = AgentHqExecutionEventEnvelopeSchema.strict().extend({
  sequence: AgentHqExecutionEventEnvelopeSchema.shape.sequence.max(Number.MAX_SAFE_INTEGER),
  schemaVersion: AgentHqExecutionEventEnvelopeSchema.shape.schemaVersion.max(
    Number.MAX_SAFE_INTEGER
  ),
  correlation: AgentHqExecutionEventEnvelopeSchema.shape.correlation.strict(),
})
const scopeSchema = AgentHqExecutionEventEnvelopeSchema.pick({
  workspaceId: true,
  projectId: true,
  taskId: true,
  agentId: true,
  executionId: true,
}).strict()
const artifactSchema = ArtifactReferenceSchema.pick({
  artifactId: true,
  version: true,
  digest: true,
  sizeBytes: true,
})

export type ControlPlaneEventScope = Readonly<{
  workspaceId: string
  projectId: string
  taskId: string
  agentId: string
  executionId: string
}>
type CloudEventData = Readonly<{
  state?: (typeof states)[number]
  availability?: (typeof availabilityStates)[number]
  providerState?: (typeof providerStates)[number]
  failure?: Readonly<{ classification: (typeof failureClasses)[number]; retryable?: boolean }>
  progress?: Readonly<{ completed: number; total: number }>
  usage?: ReturnType<typeof UsageEnvelopeSchema.shape.usage.parse>
  artifactRefs?: ReadonlyArray<ReturnType<typeof artifactSchema.parse>>
}>
export type CloudSafeControlPlaneExecutionEvent = Readonly<
  Omit<AgentHqExecutionEventEnvelope, 'data'> & { data: CloudEventData; projectionHash: string }
>
type RefusalCode =
  | 'event_too_large'
  | 'invalid_envelope'
  | 'unsupported_schema'
  | 'unsupported_event'
  | 'correlation_mismatch'
  | 'payload_mismatch'
  | 'invalid_projection'
export class ControlPlaneEventProjectionError extends Error {
  constructor(readonly code: RefusalCode) {
    super(code)
    this.name = 'ControlPlaneEventProjectionError'
  }
}
function refuse(code: RefusalCode): never {
  throw new ControlPlaneEventProjectionError(code)
}
function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse('invalid_projection')
  return value as Record<string, unknown>
}
function vocabulary<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) refuse('invalid_projection')
  return value as T
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    refuse('invalid_projection')
  return value
}

/** Bound recursive public-schema/hash work before either sees attacker-controlled JSON. */
function checkStructure(value: unknown): void {
  const pending = [{ value, depth: 0 }]
  let entries = 0
  while (pending.length) {
    const next = pending.pop()!
    entries += 1
    if (entries > 512 || next.depth > 16) refuse('invalid_envelope')
    if (next.value && typeof next.value === 'object') {
      for (const [key, entry] of Object.entries(next.value)) {
        if (key === '__proto__') refuse('invalid_envelope')
        pending.push({ value: entry, depth: next.depth + 1 })
      }
    }
  }
}

function projectData(input: Record<string, unknown>): CloudEventData {
  const data: { -readonly [K in keyof CloudEventData]: CloudEventData[K] } = {}
  if (input.state !== undefined) data.state = vocabulary(input.state, states)
  if (input.availability !== undefined)
    data.availability = vocabulary(input.availability, availabilityStates)
  if (input.providerState !== undefined)
    data.providerState = vocabulary(input.providerState, providerStates)
  if (input.failure !== undefined) {
    const failure = record(input.failure)
    if (failure.retryable !== undefined && typeof failure.retryable !== 'boolean')
      refuse('invalid_projection')
    data.failure = {
      classification: vocabulary(failure.classification, failureClasses),
      ...(failure.retryable === undefined ? {} : { retryable: failure.retryable }),
    }
  }
  if (input.progress !== undefined) {
    const progress = record(input.progress)
    const completed = count(progress.completed)
    const total = count(progress.total)
    if (completed > total) refuse('invalid_projection')
    data.progress = { completed, total }
  }
  if (input.usage !== undefined) {
    const usage = UsageEnvelopeSchema.shape.usage.safeParse(input.usage)
    if (!usage.success) refuse('invalid_projection')
    for (const value of [usage.data.inputTokens, usage.data.outputTokens, usage.data.durationMs])
      count(value)
    if (usage.data.cost && usage.data.cost.amount.length > 64) refuse('invalid_projection')
    data.usage = {
      inputTokens: usage.data.inputTokens,
      outputTokens: usage.data.outputTokens,
      durationMs: usage.data.durationMs,
      ...(usage.data.cost
        ? {
            cost: { amount: usage.data.cost.amount, currency: usage.data.cost.currency },
          }
        : {}),
    }
  }
  if (input.artifactRefs !== undefined) {
    if (!Array.isArray(input.artifactRefs) || input.artifactRefs.length > 32)
      refuse('invalid_projection')
    data.artifactRefs = input.artifactRefs.map((reference) => {
      const artifact = artifactSchema.safeParse(reference)
      if (!artifact.success) refuse('invalid_projection')
      count(artifact.data.version)
      count(artifact.data.sizeBytes)
      return artifact.data
    })
  }
  return data
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/**
 * Expected scope comes from authenticated delivery and retained acceptance metadata,
 * never this input. The public envelope has no selected host/location; this decoder
 * cannot establish that missing binding or authorize artifact access.
 */
export function projectControlPlaneExecutionEvent(
  input: Uint8Array,
  expected: ControlPlaneEventScope
): CloudSafeControlPlaneExecutionEvent {
  if (!(input instanceof Uint8Array)) refuse('invalid_envelope')
  if (input.byteLength > MAX_CONTROL_PLANE_EVENT_BYTES) refuse('event_too_large')
  const scope = scopeSchema.safeParse(expected)
  if (!scope.success) refuse('correlation_mismatch')
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input))
  } catch {
    refuse('invalid_envelope')
  }
  checkStructure(raw)
  const parsed = envelopeSchema.safeParse(raw)
  if (!parsed.success) refuse('invalid_envelope')
  const event = parsed.data
  for (const timestamp of [event.occurredAt, event.recordedAt])
    if (timestamp.length > 32 || !Number.isFinite(Date.parse(timestamp))) refuse('invalid_envelope')
  if (event.contractVersion.major !== 1 || event.schemaVersion !== 1) refuse('unsupported_schema')
  if (!supportedEvents.has(event.eventType)) refuse('unsupported_event')
  for (const key of Object.keys(scope.data) as Array<keyof ControlPlaneEventScope>)
    if (event[key] !== scope.data[key]) refuse('correlation_mismatch')
  if (Buffer.byteLength(canonicalJsonStringify(event.data), 'utf8') > MAX_SOURCE_DATA_BYTES)
    refuse('event_too_large')
  if (hash(event.data) !== event.payloadHash) refuse('payload_mismatch')
  const data = projectData(event.data)
  const [family, phase] = event.eventType.split('.')
  if (
    states.some((state) => state === phase) &&
    ['execution', 'attempt'].includes(family!) &&
    data.state !== undefined &&
    data.state !== phase
  )
    refuse('invalid_projection')
  // A future public schema field cannot be spread into persistence.
  const projected = {
    contractVersion: { major: event.contractVersion.major, minor: event.contractVersion.minor },
    eventId: event.eventId,
    eventType: event.eventType,
    executionId: event.executionId,
    ...(event.attemptId ? { attemptId: event.attemptId } : {}),
    ...(event.workflowId ? { workflowId: event.workflowId } : {}),
    workspaceId: event.workspaceId,
    projectId: event.projectId,
    taskId: event.taskId,
    agentId: event.agentId,
    sequence: event.sequence,
    schemaVersion: event.schemaVersion,
    payloadHash: event.payloadHash,
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
    correlation: {
      requestId: event.correlation.requestId,
      traceId: event.correlation.traceId,
      ...(event.correlation.commandId ? { commandId: event.correlation.commandId } : {}),
    },
    data,
    projectionHash: hash(data),
  }
  if (Buffer.byteLength(JSON.stringify(projected), 'utf8') > MAX_PROJECTION_BYTES)
    refuse('event_too_large')
  return freeze(projected)
}
