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
 * decodes to null.
 */
import { createHash } from 'node:crypto'

export const JOB_OUTBOUND_SENDER_PREFIX = 'job-outbound:v1:'

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

const SHA256_HEX = /^[0-9a-f]{64}$/

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

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/**
 * Decodes a system sender value. Null unless it is exactly the canonical encoding
 * of a well-formed binding, so an alternative spelling or an extra field fails.
 */
export function decodeJobOutboundBinding(value: string | null): JobOutboundBinding | null {
  if (!value || !value.startsWith(JOB_OUTBOUND_SENDER_PREFIX)) return null
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(
      Buffer.from(value.slice(JOB_OUTBOUND_SENDER_PREFIX.length), 'base64url').toString('utf8')
    ) as Record<string, unknown>
  } catch {
    return null
  }
  const artifact = parsed.artifact as Record<string, unknown> | null
  const grant = parsed.grant as Record<string, unknown> | null
  const binding: JobOutboundBinding = {
    actorUserId: parsed.actorUserId as string,
    artifact:
      artifact === null
        ? null
        : {
            artifactId: artifact.artifactId as string,
            checksumSha256: artifact.checksumSha256 as string,
            sourceWorkspaceId: artifact.sourceWorkspaceId as string,
            version: artifact.version as number,
          },
    channelId: parsed.channelId as string,
    channelVersion: parsed.channelVersion as number,
    grant:
      grant === null
        ? null
        : { grantId: grant.grantId as string, revision: grant.revision as number },
    jobId: parsed.jobId as string,
    summarySha256: parsed.summarySha256 as string,
    workspaceId: parsed.workspaceId as string,
  }
  if (
    !nonBlank(binding.actorUserId) ||
    !nonBlank(binding.channelId) ||
    !nonBlank(binding.jobId) ||
    !nonBlank(binding.workspaceId) ||
    !positiveInteger(binding.channelVersion) ||
    !SHA256_HEX.test(binding.summarySha256) ||
    (binding.artifact !== null &&
      (!nonBlank(binding.artifact.artifactId) ||
        !nonBlank(binding.artifact.sourceWorkspaceId) ||
        !SHA256_HEX.test(binding.artifact.checksumSha256) ||
        !positiveInteger(binding.artifact.version))) ||
    (binding.grant !== null &&
      (!nonBlank(binding.grant.grantId) || !positiveInteger(binding.grant.revision))) ||
    (binding.artifact === null) !== (binding.grant === null)
  )
    return null
  const frozen = Object.freeze(binding)
  return encodeJobOutboundBinding(frozen) === value ? frozen : null
}

/**
 * The idempotency key a publication message must carry. It is derived from the
 * binding itself, so an approval is anchored to the message identity: a sender value
 * and an execution reference alone cannot match it.
 */
export function jobOutboundMessageKey(binding: JobOutboundBinding): string {
  return `job-outbound:v1:${binding.jobId}:${createHash('sha256')
    .update(encodeJobOutboundBinding(binding), 'utf8')
    .digest('hex')}`
}
