/*
 * Publication binding for job outbound results (M15 #1217).
 *
 * The canonical publication is a channel message whose sender is the system
 * sender `job-outbound:v1:<base64url JSON>`. The message route always sets the
 * sender to the authenticated principal, so only server code can write a system
 * sender. The encoded binding names the exact approved facts: the job, the
 * original actor, the destination workspace and channel, the channel revision at
 * publication, the sha-256 of the approved summary, the linked artifact identity,
 * and the grant identity and revision. Delivery decodes it and verifies every
 * fact against current state. Anything that is not exactly this canonical form
 * decodes to null. Decoding never throws.
 */
import { createHash } from 'node:crypto'

export const JOB_OUTBOUND_SENDER_PREFIX = 'job-outbound:v1:'

/** An encoded sender value longer than this is refused before any decoding. */
export const JOB_OUTBOUND_SENDER_MAX_LENGTH = 4096

const MAX_ID_LENGTH = 256
const SHA256_HEX = /^[0-9a-f]{64}$/
const TOP_LEVEL_KEYS = [
  'actorUserId',
  'artifact',
  'channelId',
  'channelVersion',
  'grant',
  'jobId',
  'summarySha256',
  'workspaceId',
] as const
const ARTIFACT_KEYS = ['artifactId', 'checksumSha256', 'sourceWorkspaceId', 'version'] as const
const GRANT_KEYS = ['grantId', 'revision'] as const

export type JobOutboundBindingArtifact = Readonly<{
  artifactId: string
  checksumSha256: string
  sourceWorkspaceId: string
  version: number
}>

export type JobOutboundBinding = Readonly<{
  actorUserId: string
  artifact: JobOutboundBindingArtifact | null
  channelId: string
  channelVersion: number
  grant: Readonly<{ grantId: string; revision: number }> | null
  jobId: string
  summarySha256: string
  workspaceId: string
}>

export function summarySha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function canonical(binding: JobOutboundBinding) {
  return {
    actorUserId: binding.actorUserId,
    artifact: binding.artifact
      ? {
          artifactId: binding.artifact.artifactId,
          checksumSha256: binding.artifact.checksumSha256,
          sourceWorkspaceId: binding.artifact.sourceWorkspaceId,
          version: binding.artifact.version,
        }
      : null,
    channelId: binding.channelId,
    channelVersion: binding.channelVersion,
    grant: binding.grant
      ? { grantId: binding.grant.grantId, revision: binding.grant.revision }
      : null,
    jobId: binding.jobId,
    summarySha256: binding.summarySha256,
    workspaceId: binding.workspaceId,
  }
}

/** The system sender value for a binding. Keys are written in one fixed order. */
export function encodeJobOutboundBinding(binding: JobOutboundBinding): string {
  return (
    JOB_OUTBOUND_SENDER_PREFIX +
    Buffer.from(JSON.stringify(canonical(binding))).toString('base64url')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Exactly these keys, each present once, and nothing else. */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function boundedId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_ID_LENGTH
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** `undefined` marks a malformed value; `null` is the legitimate absent form. */
function decodeArtifact(value: unknown): JobOutboundBindingArtifact | null | undefined {
  if (value === null) return null
  if (!isRecord(value) || !hasExactKeys(value, ARTIFACT_KEYS)) return undefined
  const { artifactId, checksumSha256, sourceWorkspaceId, version } = value
  if (!boundedId(artifactId) || !boundedId(sourceWorkspaceId)) return undefined
  if (typeof checksumSha256 !== 'string' || !SHA256_HEX.test(checksumSha256)) return undefined
  if (!positiveInteger(version)) return undefined
  return { artifactId, checksumSha256, sourceWorkspaceId, version }
}

function decodeGrant(
  value: unknown
): Readonly<{ grantId: string; revision: number }> | null | undefined {
  if (value === null) return null
  if (!isRecord(value) || !hasExactKeys(value, GRANT_KEYS)) return undefined
  const { grantId, revision } = value
  if (!boundedId(grantId) || !positiveInteger(revision)) return undefined
  return { grantId, revision }
}

/**
 * Decodes a system sender value. Null unless it is exactly the canonical encoding
 * of a well-formed binding: the length is bounded first, the decoded value must be
 * an object with exactly the expected keys, every nested value is validated before
 * it is read, and the result must re-encode to the input. Never throws.
 */
export function decodeJobOutboundBinding(value: unknown): JobOutboundBinding | null {
  if (typeof value !== 'string' || value.length > JOB_OUTBOUND_SENDER_MAX_LENGTH) return null
  if (!value.startsWith(JOB_OUTBOUND_SENDER_PREFIX)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(
      Buffer.from(value.slice(JOB_OUTBOUND_SENDER_PREFIX.length), 'base64url').toString('utf8')
    )
  } catch {
    return null
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, TOP_LEVEL_KEYS)) return null
  const artifact = decodeArtifact(parsed.artifact)
  const grant = decodeGrant(parsed.grant)
  if (artifact === undefined || grant === undefined) return null
  const {
    actorUserId,
    channelId,
    channelVersion,
    jobId,
    summarySha256: digest,
    workspaceId,
  } = parsed
  if (
    !boundedId(actorUserId) ||
    !boundedId(channelId) ||
    !boundedId(jobId) ||
    !boundedId(workspaceId) ||
    !positiveInteger(channelVersion) ||
    typeof digest !== 'string' ||
    !SHA256_HEX.test(digest)
  )
    return null
  if ((artifact === null) !== (grant === null)) return null
  const binding: JobOutboundBinding = Object.freeze({
    actorUserId,
    artifact,
    channelId,
    channelVersion,
    grant,
    jobId,
    summarySha256: digest,
    workspaceId,
  })
  return encodeJobOutboundBinding(binding) === value ? binding : null
}

/**
 * The idempotency key a publication message must carry. It is derived from the
 * binding itself, so an approval is anchored to the message identity: a sender value
 * and an execution reference alone cannot match it.
 */
export function jobOutboundMessageKeyPrefix(jobId: string): string {
  return `job-outbound:v1:${jobId}:`
}

export function jobOutboundMessageKey(binding: JobOutboundBinding): string {
  return `${jobOutboundMessageKeyPrefix(binding.jobId)}${createHash('sha256')
    .update(encodeJobOutboundBinding(binding), 'utf8')
    .digest('hex')}`
}

/** Whether a message sender value belongs to the job-outbound publication family (any spelling). */
export function isJobOutboundSenderValue(value: string | null): boolean {
  return typeof value === 'string' && value.startsWith(JOB_OUTBOUND_SENDER_PREFIX)
}
