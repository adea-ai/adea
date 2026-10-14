import { z } from 'zod'
import { ServiceCallerAssertionSchema } from './authentication.js'
import { IdentifierSchemas } from './identifiers.js'
import { ContractVersionSchema } from './versioning.js'

const TimestampSchema = z.iso.datetime()
const OperationSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/)
const IdempotencyKeySchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)

export const CorrelationMetadataSchema = z.object({
  traceId: IdentifierSchemas.traceId,
  causationCommandId: IdentifierSchemas.commandId.optional(),
  parentEventId: IdentifierSchemas.eventId.optional(),
})

export type CorrelationMetadata = z.infer<typeof CorrelationMetadataSchema>

const RequestIdentitySchema = z.object({
  caller: ServiceCallerAssertionSchema.optional(),
  contractVersion: ContractVersionSchema,
  requestId: IdentifierSchemas.requestId,
  workspaceId: IdentifierSchemas.workspaceId,
  projectId: IdentifierSchemas.projectId.optional(),
  correlation: CorrelationMetadataSchema,
})

export const ReadRequestEnvelopeSchema = RequestIdentitySchema.extend({
  operation: OperationSchema,
  requestedAt: TimestampSchema,
  parameters: z.unknown(),
})

export type ReadRequestEnvelope = z.infer<typeof ReadRequestEnvelopeSchema>

export const StateChangingCommandEnvelopeSchema = RequestIdentitySchema.extend({
  commandId: IdentifierSchemas.commandId,
  idempotencyKey: IdempotencyKeySchema,
  payloadHash: Sha256Schema,
  operation: OperationSchema,
  issuedAt: TimestampSchema,
  payload: z.unknown(),
})

export type StateChangingCommandEnvelope = z.infer<typeof StateChangingCommandEnvelopeSchema>

const ResponseIdentitySchema = z.object({
  contractVersion: ContractVersionSchema,
  requestId: IdentifierSchemas.requestId,
  correlation: CorrelationMetadataSchema,
})

export const SuccessResponseEnvelopeSchema = ResponseIdentitySchema.extend({
  data: z.unknown(),
})

export const ErrorClassSchema = z.enum([
  'validation',
  'authentication',
  'authorization',
  'conflict',
  'stale_reference',
  'capability_mismatch',
  'runtime_unavailable',
  'internal',
])

export type ErrorClass = z.infer<typeof ErrorClassSchema>

export const NormalizedErrorSchema = z.object({
  class: ErrorClassSchema,
  code: z
    .string()
    .min(1)
    .max(96)
    .regex(/^[A-Z][A-Z0-9_]*$/),
  message: z.string().min(1).max(512),
  retryable: z.boolean(),
  source: z.enum([
    'client',
    'auth',
    'policy',
    'runtime',
    'provider',
    'persistence',
    'workflow',
    'system',
  ]),
  remediation: z.string().min(1).max(256).optional(),
  details: z
    .record(z.string().max(64), z.unknown())
    .refine((details) => Object.keys(details).length <= 32)
    .optional(),
})

export type NormalizedError = z.infer<typeof NormalizedErrorSchema>

export const ErrorResponseEnvelopeSchema = ResponseIdentitySchema.extend({
  error: NormalizedErrorSchema,
})

export const ResponseEnvelopeSchema = z.union([
  SuccessResponseEnvelopeSchema,
  ErrorResponseEnvelopeSchema,
])

export type ResponseEnvelope = z.infer<typeof ResponseEnvelopeSchema>

export const EventEnvelopeSchema = z.object({
  contractVersion: ContractVersionSchema,
  eventId: IdentifierSchemas.eventId,
  eventType: OperationSchema,
  occurredAt: TimestampSchema,
  workspaceId: IdentifierSchemas.workspaceId,
  projectId: IdentifierSchemas.projectId.optional(),
  correlation: CorrelationMetadataSchema,
  data: z.unknown(),
})

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>

export const AgentHqExecutionEventEnvelopeSchema = z.object({
  contractVersion: ContractVersionSchema,
  eventId: IdentifierSchemas.eventId,
  eventType: z
    .string()
    .regex(/^(?:execution|attempt|interaction|usage|artifact|reconciliation)\.[a-z][a-z0-9_-]*$/),
  executionId: IdentifierSchemas.executionId,
  attemptId: IdentifierSchemas.attemptId.optional(),
  workflowId: IdentifierSchemas.workflowId.optional(),
  workspaceId: IdentifierSchemas.workspaceId,
  projectId: IdentifierSchemas.projectId,
  taskId: IdentifierSchemas.taskId,
  agentId: IdentifierSchemas.agentId,
  sequence: z.number().int().positive(),
  schemaVersion: z.number().int().positive(),
  payloadHash: Sha256Schema,
  occurredAt: TimestampSchema,
  recordedAt: TimestampSchema,
  correlation: z.object({
    requestId: IdentifierSchemas.requestId,
    commandId: IdentifierSchemas.commandId.optional(),
    traceId: IdentifierSchemas.traceId,
  }),
  data: z.record(z.string(), z.json()),
})

export type AgentHqExecutionEventEnvelope = z.infer<typeof AgentHqExecutionEventEnvelopeSchema>

export const UsageEnvelopeSchema = z.object({
  contractVersion: ContractVersionSchema,
  requestId: IdentifierSchemas.requestId,
  workspaceId: IdentifierSchemas.workspaceId,
  executionId: IdentifierSchemas.executionId.optional(),
  recordedAt: TimestampSchema,
  correlation: CorrelationMetadataSchema,
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    cost: z
      .object({
        amount: z.string().regex(/^\d+(?:\.\d+)?$/),
        currency: z.string().regex(/^[A-Z]{3}$/),
      })
      .optional(),
  }),
})

export type UsageEnvelope = z.infer<typeof UsageEnvelopeSchema>

export const ArtifactReferenceSchema = z.object({
  contractVersion: ContractVersionSchema,
  artifactId: IdentifierSchemas.artifactId,
  version: z.number().int().positive(),
  mediaType: z.string().min(1).max(128),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
  locator: z.string().min(1).max(512),
})

export type ArtifactReference = z.infer<typeof ArtifactReferenceSchema>

export const RuntimeReadModelEnvelopeSchema = z.object({
  contractVersion: ContractVersionSchema,
  runtimeNodeRefId: IdentifierSchemas.runtimeNodeRefId,
  runtimeConnectionId: IdentifierSchemas.runtimeConnectionId.optional(),
  status: z.enum(['available', 'degraded', 'unavailable', 'revoked']),
  observedAt: TimestampSchema,
  readModel: z.record(z.string(), z.unknown()),
})

export type RuntimeReadModelEnvelope = z.infer<typeof RuntimeReadModelEnvelopeSchema>
