import { describe, expect, test } from 'bun:test'

import type {
  ArtifactReferenceEvidence,
  ArtifactReferenceGrant,
  ArtifactReferenceGrantState,
  ArtifactReferenceTarget,
} from '@adea-ai/types'
import {
  encodeJobOutboundBinding,
  jobOutboundMessageKey,
  summarySha256,
  type JobOutboundBinding,
} from '../../src/job-outbound-binding'
import {
  decideJobOutboundDelivery,
  decideJobOutboundPublication,
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
 * Pure outbound-result suites for M15 #1217. The publication is a system-sender
 * message whose sender encodes the binding. Delivery accepts it only when the
 * binding, the message, the job, the actor, the channel revision, the summary and
 * the artifact link and row all still agree. Group membership is never authority.
 */

const NOW = '2026-10-08T12:00:00.000Z'
const CHECKSUM = 'a'.repeat(64)
const SOURCE = 'ws-source'
const DEST = 'ws-dest'
const CHANNEL = 'channel-a'
const ACTOR = 'user-actor'
const SUMMARY = 'Done.'
const CANARY = 'CANARY-runtime-node-/private/home/secret'

const destination = { channelId: CHANNEL, workspaceId: DEST }

const OWNER: JobOutboundAccess = { role: 'owner', workspaceLive: true }
const MEMBER: JobOutboundAccess = { role: 'member', workspaceLive: true }

function job(overrides: Partial<JobOutboundJobSource> = {}): JobOutboundJobSource {
  return {
    completedAt: '2026-10-08T11:00:00.000Z',
    jobId: 'job-1',
    originalActorUserId: ACTOR,
    sourceWorkspaceId: SOURCE,
    ...overrides,
  }
}

function audience(overrides: Partial<JobOutboundAudience> = {}): JobOutboundAudience {
  return {
    channelId: CHANNEL,
    channelIsGroup: true,
    channelLive: true,
    channelVersion: 4,
    participant: true,
    workspaceLive: true,
    workspaceRole: 'member',
    ...overrides,
  }
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

/** The binding a valid publication of `SUMMARY` to the destination would carry. */
function binding(overrides: Partial<JobOutboundBinding> = {}): JobOutboundBinding {
  return {
    actorUserId: ACTOR,
    artifact: null,
    channelId: CHANNEL,
    channelVersion: 4,
    grant: null,
    jobId: 'job-1',
    summarySha256: summarySha256(SUMMARY),
    workspaceId: DEST,
    ...overrides,
  }
}

function publicationRow(overrides: Partial<JobOutboundPublication> = {}): JobOutboundPublication {
  return {
    artifact: null,
    artifactLinkCount: 0,
    bodyText: SUMMARY,
    channelId: CHANNEL,
    deleted: false,
    edited: false,
    executionRef: 'job-1',
    messageId: 'message-1',
    idempotencyKey: jobOutboundMessageKey(binding()),
    senderKind: 'system',
    senderSystemId: encodeJobOutboundBinding(binding()),
    workspaceId: DEST,
    ...overrides,
  }
}

function linkedRow(overrides: Partial<JobOutboundPublication> = {}): JobOutboundPublication {
  const linkedBinding = binding({
    artifact: {
      artifactId: 'artifact-1',
      checksumSha256: CHECKSUM,
      sourceWorkspaceId: SOURCE,
      version: 3,
    },
    grant: { grantId: 'artifact-grant-1', revision: 1 },
  })
  return publicationRow({
    artifact: target(),
    artifactLinkCount: 1,
    idempotencyKey: jobOutboundMessageKey(linkedBinding),
    senderSystemId: encodeJobOutboundBinding(linkedBinding),
    ...overrides,
  })
}

function delivery(overrides: Partial<JobOutboundDeliveryInput> = {}): JobOutboundDeliveryInput {
  return {
    artifact: null,
    job: job(),
    jobId: 'job-1',
    now: NOW,
    publication: publicationRow(),
    recipientAudience: audience(),
    sourceAccess: OWNER,
    ...overrides,
  }
}

function linked(
  state: Partial<JobOutboundArtifactCurrent> = {},
  row: Partial<JobOutboundPublication> = {},
  claimOverrides: Partial<JobOutboundArtifactClaim> = {}
): JobOutboundDeliveryInput {
  return delivery({
    artifact: { ...claim(claimOverrides), ...current(state) },
    publication: linkedRow(row),
  })
}

function publish(
  overrides: Partial<JobOutboundPublicationInput> = {}
): JobOutboundPublicationInput {
  return {
    artifact: null,
    artifactPolicy: 'require',
    audience: audience(),
    destination,
    job: job(),
    jobId: 'job-1',
    now: NOW,
    result: { jobId: 'job-1', summary: SUMMARY },
    sourceAccess: OWNER,
    ...overrides,
  }
}

describe('sanitizeJobOutboundResult', () => {
  test('builds the released shape by allowlist and drops runtime fields', () => {
    const sanitized = sanitizeJobOutboundResult({
      filename: CANARY,
      jobId: 'job-1',
      runtimeNodeId: CANARY,
      summary: SUMMARY,
    })
    expect(sanitized).toEqual({
      ok: true,
      result: { artifact: null, jobId: 'job-1', summary: SUMMARY },
    })
    expect(JSON.stringify(sanitized)).not.toContain(CANARY)
  })

  test('refuses malformed identifiers and oversize summaries', () => {
    expect(sanitizeJobOutboundResult({ jobId: 'job 1', summary: 'x' }).ok).toBe(false)
    expect(sanitizeJobOutboundResult({ jobId: 'job-1', summary: 'x'.repeat(40_000) })).toEqual({
      ok: false,
      reason: 'result_too_large',
    })
  })
})

describe('decideJobOutboundPublication', () => {
  test('publishes a binding of the actor, the exact channel and its revision, and the summary hash', () => {
    const decision = decideJobOutboundPublication(publish())
    expect(decision).toMatchObject({
      action: 'publish',
      binding: { actorUserId: ACTOR, channelId: CHANNEL, channelVersion: 4, workspaceId: DEST },
      destination,
    })
    if (decision.action !== 'publish') throw new Error('expected publish')
    expect(decision.binding.summarySha256).toBe(summarySha256(SUMMARY))
  })

  test('holds a source member who is not an owner or admin', () => {
    expect(decideJobOutboundPublication(publish({ sourceAccess: MEMBER }))).toMatchObject({
      gate: 'source',
      reason: 'source_access_lost',
    })
  })

  test('holds an inexact destination: another channel, a non-group channel, or no revision', () => {
    expect(
      decideJobOutboundPublication(publish({ audience: audience({ channelId: 'channel-b' }) }))
    ).toMatchObject({ gate: 'destination', reason: 'destination_channel_mismatch' })
    expect(
      decideJobOutboundPublication(publish({ audience: audience({ channelIsGroup: false }) }))
    ).toMatchObject({ gate: 'destination', reason: 'destination_channel_unavailable' })
    expect(
      decideJobOutboundPublication(publish({ audience: audience({ channelVersion: null }) }))
    ).toMatchObject({ gate: 'destination', reason: 'destination_channel_unavailable' })
  })

  test('holds an artifact claim without a grant, rather than publishing it as summary-only', () => {
    expect(
      decideJobOutboundPublication(
        publish({
          artifact: { ...claim({ grant: null }), ...current() },
          result: { artifact: target(), jobId: 'job-1', summary: SUMMARY },
        })
      )
    ).toMatchObject({ gate: 'artifact', reason: 'grant_malformed' })
  })

  test('holds an artifact bound to a different audience', () => {
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
            summary: SUMMARY,
          },
        })
      )
    ).toMatchObject({ gate: 'artifact', reason: 'audience_not_authorized' })
  })
})

function forged(value: JobOutboundBinding) {
  return delivery({
    publication: publicationRow({
      idempotencyKey: jobOutboundMessageKey(value),
      senderSystemId: encodeJobOutboundBinding(value),
    }),
  })
}

describe('decideJobOutboundDelivery', () => {
  test('releases the approved body of a binding-verified publication', () => {
    expect(decideJobOutboundDelivery(delivery())).toEqual({
      action: 'deliver',
      destination,
      jobId: 'job-1',
      messageId: 'message-1',
      result: { artifact: null, jobId: 'job-1', summary: SUMMARY },
    })
  })

  test('an ordinary message that names the job and the actor does not qualify', () => {
    expect(
      decideJobOutboundDelivery(
        delivery({ publication: publicationRow({ senderKind: 'user', senderSystemId: null }) })
      )
    ).toEqual({ action: 'deny', gate: 'publication', reason: 'publication_unavailable' })
    expect(
      decideJobOutboundDelivery(
        delivery({
          publication: publicationRow({
            senderKind: 'user',
            senderSystemId: encodeJobOutboundBinding(binding()),
          }),
        })
      )
    ).toEqual({ action: 'deny', gate: 'publication', reason: 'publication_unavailable' })
  })

  test('denies a binding that names another job, another actor, or another destination', () => {
    expect(decideJobOutboundDelivery(forged(binding({ jobId: 'job-2' })))).toMatchObject({
      gate: 'publication',
      reason: 'publication_job_mismatch',
    })
    expect(decideJobOutboundDelivery(forged(binding({ actorUserId: 'user-other' })))).toMatchObject(
      {
        gate: 'publication',
        reason: 'publication_actor_mismatch',
      }
    )
    expect(decideJobOutboundDelivery(forged(binding({ workspaceId: 'ws-other' })))).toMatchObject({
      gate: 'publication',
      reason: 'publication_destination_mismatch',
    })
  })

  test('denies a publication whose body changed after it was bound (summary hash mismatch)', () => {
    expect(
      decideJobOutboundDelivery(delivery({ publication: publicationRow({ bodyText: 'Altered.' }) }))
    ).toMatchObject({ gate: 'publication', reason: 'publication_altered' })
  })

  test('denies an edited or deleted publication', () => {
    expect(
      decideJobOutboundDelivery(delivery({ publication: publicationRow({ edited: true }) }))
    ).toMatchObject({
      reason: 'publication_altered',
    })
    expect(
      decideJobOutboundDelivery(delivery({ publication: publicationRow({ deleted: true }) }))
    ).toMatchObject({
      reason: 'publication_altered',
    })
  })

  test('denies release once the actor loses source ownership', () => {
    expect(decideJobOutboundDelivery(delivery({ sourceAccess: MEMBER }))).toEqual({
      action: 'deny',
      gate: 'source',
      reason: 'source_access_lost',
    })
  })

  test('cross-group substitution: a standing for another channel is refused', () => {
    expect(
      decideJobOutboundDelivery(
        delivery({ recipientAudience: audience({ channelId: 'channel-b' }) })
      )
    ).toMatchObject({ gate: 'audience', reason: 'destination_channel_mismatch' })
  })

  test('denies a recipient who is not a participant of the exact channel', () => {
    expect(
      decideJobOutboundDelivery(delivery({ recipientAudience: audience({ participant: false }) }))
    ).toMatchObject({ gate: 'audience', reason: 'recipient_not_destination_participant' })
  })

  test('denies when the channel revision moved since publication, even for a participant', () => {
    expect(
      decideJobOutboundDelivery(delivery({ recipientAudience: audience({ channelVersion: 5 }) }))
    ).toEqual({ action: 'deny', gate: 'audience', reason: 'audience_revision_changed' })
  })

  test('an unchanged channel revision releases to a participant (membership join time is not a revision)', () => {
    expect(decideJobOutboundDelivery(delivery({ recipientAudience: audience() }))).toMatchObject({
      action: 'deliver',
    })
  })

  test('a link whose artifact row is missing fails closed, not as an artifact-free summary', () => {
    expect(
      decideJobOutboundDelivery(
        delivery({
          artifact: { ...claim(), ...current() },
          publication: linkedRow({ artifact: null, artifactLinkCount: 1 }),
        })
      )
    ).toEqual({ action: 'deny', gate: 'artifact', reason: 'artifact_unavailable' })
  })

  test('a binding with an artifact but no link, or a link with no binding, is refused', () => {
    expect(
      decideJobOutboundDelivery({
        ...linked(),
        publication: linkedRow({ artifact: null, artifactLinkCount: 0 }),
      })
    ).toMatchObject({ gate: 'artifact', reason: 'artifact_unavailable' })
    expect(
      decideJobOutboundDelivery(
        delivery({ publication: publicationRow({ artifact: target(), artifactLinkCount: 1 }) })
      )
    ).toMatchObject({ gate: 'result', reason: 'artifact_claim_mismatch' })
  })

  test('a null claim with a linked artifact is refused, never released as summary-only', () => {
    expect(
      decideJobOutboundDelivery({
        ...delivery({ publication: linkedRow() }),
        artifact: null,
      })
    ).toMatchObject({ gate: 'result', reason: 'artifact_claim_mismatch' })
  })

  test('a linked artifact row that no longer matches the binding is refused', () => {
    expect(
      decideJobOutboundDelivery(linked({}, { artifact: target({ version: 4 }) }))
    ).toMatchObject({
      gate: 'artifact',
      reason: 'artifact_binding_mismatch',
    })
  })

  test('a claim for a different grant identity or revision than the binding is refused', () => {
    expect(
      decideJobOutboundDelivery(linked({}, {}, { grant: grant({ grantId: 'artifact-grant-2' }) }))
    ).toMatchObject({ gate: 'artifact', reason: 'artifact_binding_mismatch' })
    expect(
      decideJobOutboundDelivery(linked({}, {}, { grant: grant({ revision: 2 }) }))
    ).toMatchObject({ gate: 'artifact', reason: 'artifact_binding_mismatch' })
  })

  test('releases a linked artifact under the live registration, and denies a revoked one', () => {
    expect(decideJobOutboundDelivery(linked())).toMatchObject({
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

  test('never leaks runtime canaries through a deny decision', () => {
    const decision = decideJobOutboundDelivery(
      delivery({
        publication: publicationRow({ bodyText: CANARY, senderKind: 'user', senderSystemId: null }),
      })
    )
    expect(JSON.stringify(decision)).not.toContain(CANARY)
  })
})

describe('artifact-free summaries (#1217 root review)', () => {
  test('omit_unauthorized publishes the summary without the artifact, and binds no artifact identity', () => {
    const decision = decideJobOutboundPublication(
      publish({
        artifact: { ...claim({ grant: grant({ revision: 2 }) }), ...current() },
        artifactPolicy: 'omit_unauthorized',
        result: { artifact: target(), jobId: 'job-1', summary: SUMMARY },
      })
    )
    expect(decision).toMatchObject({
      action: 'publish',
      artifactOmitted: 'grant_revision_stale',
      binding: { artifact: null, grant: null },
      result: { artifact: null, summary: SUMMARY },
    })
    expect(JSON.stringify(decision)).not.toContain('artifact-1')
    expect(JSON.stringify(decision)).not.toContain('artifact-grant-1')
  })

  test('a quarantined artifact is omitted by name, not released or held when the policy allows it', () => {
    const decision = decideJobOutboundPublication(
      publish({
        artifact: {
          ...claim(),
          ...current({ evidence: evidence({ availability: 'quarantined' }) }),
        },
        artifactPolicy: 'omit_unauthorized',
        result: { artifact: target(), jobId: 'job-1', summary: SUMMARY },
      })
    )
    expect(decision).toMatchObject({ action: 'publish', artifactOmitted: 'artifact_quarantined' })
  })

  test('omission is not a way around claim, job, or destination checks', () => {
    expect(
      decideJobOutboundPublication(
        publish({
          artifactPolicy: 'omit_unauthorized',
          result: { artifact: target(), jobId: 'job-1', summary: SUMMARY },
        })
      )
    ).toMatchObject({ action: 'hold', gate: 'result', reason: 'artifact_claim_mismatch' })
    expect(
      decideJobOutboundPublication(
        publish({
          artifact: { ...claim({ grant: grant({ sourceWorkspaceId: 'ws-other' }) }), ...current() },
          artifactPolicy: 'omit_unauthorized',
          result: {
            artifact: target({ sourceWorkspaceId: 'ws-other' }),
            jobId: 'job-1',
            summary: SUMMARY,
          },
        })
      )
    ).toMatchObject({ action: 'hold', gate: 'job', reason: 'job_source_mismatch' })
  })

  test('require (the default) still holds an unauthorized artifact, with nothing published', () => {
    expect(
      decideJobOutboundPublication(
        publish({
          artifact: { ...claim(), ...current({ grantState: grantState({ revoked: true }) }) },
          artifactPolicy: 'require',
          result: { artifact: target(), jobId: 'job-1', summary: SUMMARY },
        })
      )
    ).toMatchObject({ action: 'hold', gate: 'artifact', reason: 'grant_revoked' })
  })
})

describe('membership fencing and approval anchoring (#1217 root review)', () => {
  test('publish holds an actor who is no longer a destination member', () => {
    expect(
      decideJobOutboundPublication(publish({ audience: audience({ workspaceRole: null }) }))
    ).toMatchObject({
      action: 'hold',
      gate: 'destination',
      reason: 'recipient_not_destination_member',
    })
  })

  test('delivery denies a recipient whose destination membership was removed', () => {
    expect(
      decideJobOutboundDelivery(delivery({ recipientAudience: audience({ workspaceRole: null }) }))
    ).toEqual({ action: 'deny', gate: 'audience', reason: 'recipient_not_destination_member' })
  })

  test('a valid-looking binding whose stored key is not the key it derives is altered, never approved', () => {
    const decision = decideJobOutboundDelivery(
      delivery({
        publication: publicationRow({ idempotencyKey: 'job-outbound:v1:job-1:forged' }),
      })
    )
    expect(decision).toEqual({ action: 'deny', gate: 'publication', reason: 'publication_altered' })
  })

  test('sender identity and executionRef alone never authorize: a user message with both is refused', () => {
    expect(
      decideJobOutboundDelivery(
        delivery({
          publication: publicationRow({
            idempotencyKey: jobOutboundMessageKey(binding()),
            senderKind: 'user',
          }),
        })
      )
    ).toEqual({ action: 'deny', gate: 'publication', reason: 'publication_unavailable' })
  })
})
