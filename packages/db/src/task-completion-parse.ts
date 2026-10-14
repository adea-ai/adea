/*
 * Parsing and response shape for a task completion's outbound result (#1217). Pure: it
 * imports the database modules as types only, so unit tests load it without the
 * transaction graph. The request-to-effect path that uses it is `task-completion-request`.
 */
import type {
  JobOutboundCompletionOutcome,
  JobOutboundCompletionRequest,
} from './job-outbound-result-store'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OUTBOUND_COMPLETION_KEYS = [
  'artifact',
  'artifactPolicy',
  'channelId',
  'memorySource',
  'summary',
] as const
const MEMORY_SOURCES = ['none', 'private', 'unknown', 'workspace'] as const
const OUTBOUND_SUMMARY_MAX_LENGTH = 16_384

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

/**
 * Strict parse of a completion's outbound result. Unknown keys, a non-UUID channel, an
 * oversize summary, or a malformed artifact name refuse the request before any effect.
 */
export function parseOutboundCompletion(value: unknown): JobOutboundCompletionRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (
    Object.keys(input).some((key) => !(OUTBOUND_COMPLETION_KEYS as readonly string[]).includes(key))
  )
    return null
  if (!isUuid(input.channelId) || typeof input.summary !== 'string') return null
  if (input.summary.length > OUTBOUND_SUMMARY_MAX_LENGTH) return null
  const policy = input.artifactPolicy ?? 'require'
  if (policy !== 'require' && policy !== 'omit_unauthorized') return null
  // Omitted means `none`. A present value outside the closed set refuses the request: the
  // declaration is never guessed at, and the Task is not completed on a malformed one.
  const memory = input.memorySource === undefined ? 'none' : input.memorySource
  if (typeof memory !== 'string' || !(MEMORY_SOURCES as readonly string[]).includes(memory))
    return null
  const memorySource = memory as (typeof MEMORY_SOURCES)[number]
  // Named only when it is not `none`, so a request without the field keeps its exact shape.
  const declared = memorySource === 'none' ? {} : { memorySource }
  const artifact = input.artifact ?? null
  if (artifact === null)
    return {
      artifact: null,
      artifactPolicy: policy,
      channelId: input.channelId,
      ...declared,
      summary: input.summary,
    }
  if (typeof artifact !== 'object' || Array.isArray(artifact)) return null
  const named = artifact as Record<string, unknown>
  if (
    Object.keys(named).length !== 2 ||
    !isUuid(named.artifactId) ||
    typeof named.grantId !== 'string' ||
    !named.grantId.trim() ||
    named.grantId.length > 256
  )
    return null
  return {
    artifact: { artifactId: named.artifactId, grantId: named.grantId },
    artifactPolicy: policy,
    channelId: input.channelId,
    ...declared,
    summary: input.summary,
  }
}

/**
 * The publication as the API reports it. The binding and the artifact identity are
 * never included: a publish names its message, and a hold names its gate and reason.
 */
export type TaskCompletionPublication =
  | Readonly<{
      action: 'publish'
      artifactOmitted: string | null
      messageId: string | null
    }>
  | Readonly<{
      action: 'hold'
      gate: string
      messageId: null
      reason: string
    }>

export function summarizePublication(
  publication: JobOutboundCompletionOutcome['publication']
): TaskCompletionPublication {
  const { decision } = publication
  return decision.action === 'publish'
    ? {
        action: 'publish',
        artifactOmitted: decision.artifactOmitted,
        messageId: publication.messageId,
      }
    : {
        action: 'hold',
        gate: decision.gate,
        messageId: null,
        reason: decision.reason,
      }
}
