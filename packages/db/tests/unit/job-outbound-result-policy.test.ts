import { describe, expect, test } from 'bun:test'

import type {
  ArtifactReferenceEvidence,
  ArtifactReferenceGrant,
  ArtifactReferenceGrantState,
  ArtifactReferenceTarget,
} from '@adea-ai/types'
import {
  JOB_OUTBOUND_SUMMARY_MAX_BYTES,
  decideJobOutboundDelivery,
  decideJobOutboundPublication,
  projectJobOutboundRelease,
  sanitizeJobOutboundResult,
  type JobOutboundAccess,
  type JobOutboundArtifactClaim,
  type JobOutboundArtifactCurrent,
  type JobOutboundAudience,
  type JobOutboundDeliveryInput,
  type JobOutboundJobSource,
  type JobOutboundPublication,
  type JobOutboundPublicationInput,
} from '../../src/job-outbound-result-policy'

/**
 * Pure outbound-result suites for M15 #1217. Authority is the job's original
 * actor with current source ownership, over a completed Task. Delivery is bound to
 * the canonical publication: its job, its agent, its unaltered approved body, its
 * exact channel, and the recipient's standing in that channel from before it was
 * published. Group membership is never source authority.
 */

const NOW = '2026-10-08T12:00:00.000Z'
const CHECKSUM = 'a'.repeat(64)
const SOURCE = 'ws-source'
const DEST = 'ws-dest'
const CHANNEL = 'channel-a'
const OTHER_CHANNEL = 'channel-b'
const ACTOR = 'user-actor'
const CANARY = 'CANARY-runtime-node-/private/home/secret'

const destination = { channelId: CHANNEL, workspaceId: DEST }

function job(overrides: Partial<JobOutboundJobSource> = {}): JobOutboundJobSource {
  return {
    completedAt: '2026-10-08T11:00:00.000Z',
    jobId: 'job-1',
    originalActorUserId: ACTOR,
    sourceWorkspaceId: SOURCE,
    ...overrides,
  }
}

const OWNER: JobOutboundAccess = { role: 'owner', workspaceLive: true }
const MEMBER: JobOutboundAccess = { role: 'member', workspaceLive: true }

const PARTICIPANT: JobOutboundAudience = {
  channelId: CHANNEL,
  channelIsGroup: true,
  channelLive: true,
  joinedAt: '2026-10-01T00:00:00.000Z',
  participant: true,
  workspaceLive: true,
}

function target(overrides: Partial<ArtifactReferenceTarget> = {}): ArtifactReferenceTarget {
  return {
    artifactId: 'artifact-1',
    audienceWorkspaceId: DEST,
    checksumSha256: CHECKSUM,
    sourceWorkspaceId: SOURCE,
    version: 3,
    ...overrides,
  }
}

function publication(overrides: Partial<JobOutboundPublication> = {}): JobOutboundPublication {
  return {
    artifact: null,
    artifactLinkCount: 0,
    bodyText: 'Done.',
    channelId: CHANNEL,
    createdAt: '2026-10-08T11:30:00.000Z',
    deleted: false,
    edited: false,
    executionRef: 'job-1',
    messageId: 'message-1',
    senderUserId: ACTOR,
    senderKind: 'user',
    taskId: null,
    workspaceId: DEST,
    ...overrides,
  }
}

function evidence(overrides: Partial<ArtifactReferenceEvidence> = {}): ArtifactReferenceEvidence {
  return {
    availability: 'available',
    checksumSha256: CHECKSUM,
    deletionState: 'active',
    id: 'artifact-1',
    sensitivity: 'workspace',
    version: 3,
    workspaceId: SOURCE,
    ...overrides,
  }
}

function grant(overrides: Partial<ArtifactReferenceGrant> = {}): ArtifactReferenceGrant {
  return {
    artifactId: 'artifact-1',
    audienceWorkspaceId: DEST,
    checksumSha256: CHECKSUM,
    expiresAt: null,
    grantId: 'artifact-grant-1',
    revokedAt: null,
    revision: 1,
    sourceWorkspaceId: SOURCE,
    version: 3,
    ...overrides,
  }
}

function grantState(
  overrides: Partial<ArtifactReferenceGrantState> = {}
): ArtifactReferenceGrantState {
  return {
    artifactId: 'artifact-1',
    audienceWorkspaceIds: [DEST],
    checksumSha256: CHECKSUM,
    expiresAt: null,
    grantId: 'artifact-grant-1',
    revoked: false,
    revision: 1,
    sourceWorkspaceId: SOURCE,
    version: 3,
    ...overrides,
  }
}

function current(overrides: Partial<JobOutboundArtifactCurrent> = {}): JobOutboundArtifactCurrent {
  return { evidence: evidence(), grantState: grantState(), ...overrides }
}

function claim(overrides: Partial<JobOutboundArtifactClaim> = {}): JobOutboundArtifactClaim {
  return { authority: { kind: 'workspace_grant' }, grant: grant(), ...overrides }
}

function delivery(overrides: Partial<JobOutboundDeliveryInput> = {}): JobOutboundDeliveryInput {
  return {
    artifact: null,
    job: job(),
    jobId: 'job-1',
    now: NOW,
    publication: publication(),
    recipientAudience: PARTICIPANT,
    sourceAccess: OWNER,
    ...overrides,
  }
}

function linked(
  state: Partial<JobOutboundArtifactCurrent>,
  grantOverrides: Partial<ArtifactReferenceGrant> = {}
): JobOutboundDeliveryInput {
  return delivery({
    artifact: { ...claim({ grant: grant(grantOverrides) }), ...current(state) },
    publication: publication({ artifact: target(), artifactLinkCount: 1 }),
  })
}

function publish(
  overrides: Partial<JobOutboundPublicationInput> = {}
): JobOutboundPublicationInput {
  return {
    artifact: null,
    destination,
    job: job(),
    jobId: 'job-1',
    now: NOW,
    result: { jobId: 'job-1', summary: 'Done.' },
    sourceAccess: OWNER,
    ...overrides,
  }
}

describe('sanitizeJobOutboundResult', () => {
  test('builds the released shape by allowlist and drops runtime fields', () => {
    const sanitized = sanitizeJobOutboundResult({
      jobId: 'job-1',
      summary: 'Done.',
      filename: CANARY,
      runtimeNodeId: CANARY,
    })
    expect(sanitized).toEqual({
      ok: true,
      result: { artifact: null, jobId: 'job-1', summary: 'Done.' },
    })
    expect(JSON.stringify(sanitized)).not.toContain(CANARY)
  })

  test('removes controls and bidi marks and canonicalizes line breaks in one pass', () => {
    const sanitized = sanitizeJobOutboundResult({
      jobId: 'job-1',
      summary: 'a\u0000b\u001b[31m‮c​\u{feff}\n\td\r\ne\rf',
    })
    expect(sanitized.ok && sanitized.result.summary).toBe('ab[31mc\n\td\ne\nf')
  })

  test('bounds identifiers by visible ASCII and length, per character', () => {
    expect(sanitizeJobOutboundResult({ jobId: 'j'.repeat(128), summary: 'x' }).ok).toBe(true)
    expect(sanitizeJobOutboundResult({ jobId: 'j'.repeat(129), summary: 'x' }).ok).toBe(false)
    expect(sanitizeJobOutboundResult({ jobId: 'jöb', summary: 'x' }).ok).toBe(false)
  })

  test('refuses summaries above the byte bound rather than truncating', () => {
    expect(
      sanitizeJobOutboundResult({
        jobId: 'job-1',
        summary: 'é'.repeat(JOB_OUTBOUND_SUMMARY_MAX_BYTES / 2 + 1),
      })
    ).toEqual({ ok: false, reason: 'result_too_large' })
  })
})

describe('projectJobOutboundRelease', () => {
  test('includes the artifact locator only when it is authorized', () => {
    const sanitized = sanitizeJobOutboundResult({
      artifact: target(),
      jobId: 'job-1',
      summary: 's',
    })
    if (!sanitized.ok) throw new Error('expected a sanitized result')
    expect(projectJobOutboundRelease(sanitized.result, true).artifact).toEqual(target())
    expect(projectJobOutboundRelease(sanitized.result, false).artifact).toBeNull()
  })
})

describe('decideJobOutboundPublication', () => {
  test('publishes for a completed job whose original actor owns the source', () => {
    expect(decideJobOutboundPublication(publish())).toEqual({
      action: 'publish',
      basis: 'source_owner_actor',
      destination,
      jobId: 'job-1',
      result: { artifact: null, jobId: 'job-1', summary: 'Done.' },
    })
  })

  test('holds a member of the source workspace who is not an owner or admin', () => {
    expect(decideJobOutboundPublication(publish({ sourceAccess: MEMBER }))).toMatchObject({
      gate: 'source',
      reason: 'source_access_lost',
    })
  })

  test('holds an artifact bound to a different destination audience', () => {
    expect(
      decideJobOutboundPublication(
        publish({
          artifact: {
            ...claim({ grant: grant({ audienceWorkspaceId: 'ws-elsewhere' }) }),
            ...current(),
          },
          result: {
            artifact: target({ audienceWorkspaceId: 'ws-elsewhere' }),
            jobId: 'job-1',
            summary: 's',
          },
        })
      )
    ).toMatchObject({ gate: 'artifact', reason: 'audience_not_authorized' })
  })
})

describe('decideJobOutboundDelivery', () => {
  test('releases the approved body of the canonical publication, not caller text', () => {
    expect(decideJobOutboundDelivery(delivery())).toEqual({
      action: 'deliver',
      destination,
      jobId: 'job-1',
      messageId: 'message-1',
      result: { artifact: null, jobId: 'job-1', summary: 'Done.' },
    })
  })

  test('denies when there is no canonical publication', () => {
    expect(decideJobOutboundDelivery(delivery({ publication: null }))).toEqual({
      action: 'deny',
      gate: 'publication',
      reason: 'publication_unavailable',
    })
  })

  test('denies an edited or deleted publication', () => {
    expect(
      decideJobOutboundDelivery(delivery({ publication: publication({ edited: true }) }))
    ).toMatchObject({ gate: 'publication', reason: 'publication_altered' })
    expect(
      decideJobOutboundDelivery(delivery({ publication: publication({ deleted: true }) }))
    ).toMatchObject({ gate: 'publication', reason: 'publication_altered' })
  })

  test('denies a publication that belongs to another job, another agent, or a user sender', () => {
    expect(
      decideJobOutboundDelivery(delivery({ publication: publication({ taskId: 'job-2' }) }))
    ).toMatchObject({ gate: 'publication', reason: 'publication_job_mismatch' })
    expect(
      decideJobOutboundDelivery(delivery({ publication: publication({ executionRef: 'job-2' }) }))
    ).toMatchObject({ gate: 'publication', reason: 'publication_job_mismatch' })
    expect(
      decideJobOutboundDelivery(
        delivery({ publication: publication({ senderUserId: 'user-other' }) })
      )
    ).toMatchObject({ gate: 'publication', reason: 'publication_actor_mismatch' })
    expect(
      decideJobOutboundDelivery(
        delivery({ publication: publication({ senderKind: 'system', senderUserId: null }) })
      )
    ).toMatchObject({ gate: 'publication', reason: 'publication_actor_mismatch' })
  })

  test('denies a publication in the job’s own workspace', () => {
    expect(
      decideJobOutboundDelivery(delivery({ publication: publication({ workspaceId: SOURCE }) }))
    ).toMatchObject({ gate: 'publication', reason: 'destination_not_outbound' })
  })

  test('denies release once the original actor loses source ownership, even for a participant', () => {
    expect(decideJobOutboundDelivery(delivery({ sourceAccess: MEMBER }))).toEqual({
      action: 'deny',
      gate: 'source',
      reason: 'source_access_lost',
    })
  })

  test('cross-group substitution: a standing for another channel is refused', () => {
    expect(
      decideJobOutboundDelivery(
        delivery({ recipientAudience: { ...PARTICIPANT, channelId: OTHER_CHANNEL } })
      )
    ).toEqual({ action: 'deny', gate: 'audience', reason: 'destination_channel_mismatch' })
  })

  test('denies a recipient who joined the channel after the publication was written', () => {
    expect(
      decideJobOutboundDelivery(
        delivery({
          recipientAudience: { ...PARTICIPANT, joinedAt: '2026-10-08T11:45:00.000Z' },
        })
      )
    ).toEqual({ action: 'deny', gate: 'audience', reason: 'recipient_joined_after_publication' })
  })

  test('denies a recipient who is not a participant, a non-group channel, or an archived channel', () => {
    expect(
      decideJobOutboundDelivery(
        delivery({ recipientAudience: { ...PARTICIPANT, participant: false, joinedAt: null } })
      )
    ).toMatchObject({ gate: 'audience', reason: 'recipient_not_destination_participant' })
    expect(
      decideJobOutboundDelivery(
        delivery({ recipientAudience: { ...PARTICIPANT, channelIsGroup: false } })
      )
    ).toMatchObject({ gate: 'audience', reason: 'destination_channel_unavailable' })
    expect(
      decideJobOutboundDelivery(
        delivery({ recipientAudience: { ...PARTICIPANT, channelLive: false } })
      )
    ).toMatchObject({ gate: 'audience', reason: 'destination_channel_unavailable' })
  })

  test('denies a job that is missing or not completed at delivery', () => {
    expect(decideJobOutboundDelivery(delivery({ job: null }))).toMatchObject({
      gate: 'job',
      reason: 'job_unavailable',
    })
    expect(decideJobOutboundDelivery(delivery({ job: job({ completedAt: null }) }))).toMatchObject({
      gate: 'job',
      reason: 'job_not_completed',
    })
  })

  test('releases a linked artifact only under the live registration', () => {
    expect(decideJobOutboundDelivery(linked({}))).toMatchObject({
      action: 'deliver',
      result: { artifact: target() },
    })
    expect(
      decideJobOutboundDelivery(linked({ grantState: grantState({ revoked: true }) }))
    ).toMatchObject({
      gate: 'artifact',
      reason: 'grant_revoked',
    })
  })

  test('a publication with more than one linked artifact cannot be represented and is refused', () => {
    expect(
      decideJobOutboundDelivery({
        ...linked({}),
        publication: publication({ artifact: target(), artifactLinkCount: 2 }),
      })
    ).toEqual({ action: 'deny', gate: 'result', reason: 'artifact_claim_mismatch' })
  })

  test('a linked artifact with no claim, or a claim with no link, is refused', () => {
    expect(
      decideJobOutboundDelivery(
        delivery({ publication: publication({ artifact: target(), artifactLinkCount: 1 }) })
      )
    ).toEqual({ action: 'deny', gate: 'result', reason: 'artifact_claim_mismatch' })
    expect(decideJobOutboundDelivery(delivery({ artifact: { ...claim(), ...current() } }))).toEqual(
      { action: 'deny', gate: 'result', reason: 'artifact_claim_mismatch' }
    )
  })

  test('never leaks runtime canaries through a deny decision', () => {
    const decision = decideJobOutboundDelivery(
      delivery({ publication: publication({ bodyText: CANARY, senderUserId: 'user-other' }) })
    )
    expect(JSON.stringify(decision)).not.toContain(CANARY)
  })
})
