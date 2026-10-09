import { describe, expect, test } from 'bun:test'

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
  type JobOutboundDestination,
  type JobOutboundJobSource,
  type JobOutboundPublicationInput,
} from '../../src/job-outbound-result-policy'
import type {
  ArtifactReferenceEvidence,
  ArtifactReferenceGrant,
  ArtifactReferenceGrantState,
  ArtifactReferenceTarget,
} from '@adea-ai/types'

/**
 * Pure outbound-result suites for M15 #1217. Authority is the job's original
 * actor with current source ownership, over a completed Task. Group membership is
 * never source authority. It only decides the exact destination audience.
 */

const NOW = '2026-10-08T12:00:00.000Z'
const CHECKSUM = 'a'.repeat(64)
const SOURCE = 'ws-source'
const DEST = 'ws-dest'
const CHANNEL = 'channel-a'
const OTHER_CHANNEL = 'channel-b'
const ACTOR = 'user-actor'
const CANARY = 'CANARY-runtime-node-/private/home/secret'

const destination: JobOutboundDestination = { channelId: CHANNEL, workspaceId: DEST }

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

function result(overrides: Record<string, unknown> = {}) {
  return { jobId: 'job-1', summary: 'Done.', ...overrides }
}

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
const ADMIN: JobOutboundAccess = { role: 'admin', workspaceLive: true }
const MEMBER: JobOutboundAccess = { role: 'member', workspaceLive: true }

/** A participant of the exact destination group channel in a live destination workspace. */
const PARTICIPANT: JobOutboundAudience = {
  channelId: CHANNEL,
  channelIsGroup: true,
  channelLive: true,
  participant: true,
  workspaceLive: true,
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

function publication(
  overrides: Partial<JobOutboundPublicationInput> = {}
): JobOutboundPublicationInput {
  return {
    artifact: null,
    destination,
    job: job(),
    jobId: 'job-1',
    now: NOW,
    result: result(),
    sourceAccess: OWNER,
    ...overrides,
  }
}

function withArtifact(
  state: Partial<JobOutboundArtifactCurrent>,
  grantOverrides: Partial<ArtifactReferenceGrant> = {}
): JobOutboundPublicationInput {
  return publication({
    artifact: { ...claim({ grant: grant(grantOverrides) }), ...current(state) },
    result: result({ artifact: target() }),
  })
}

function delivery(overrides: Partial<JobOutboundDeliveryInput> = {}): JobOutboundDeliveryInput {
  return {
    artifact: null,
    destination,
    job: job(),
    jobId: 'job-1',
    now: NOW,
    published: result(),
    recipientAudience: PARTICIPANT,
    sourceAccess: OWNER,
    ...overrides,
  }
}

describe('sanitizeJobOutboundResult', () => {
  test('builds the released shape by allowlist and drops runtime fields', () => {
    const sanitized = sanitizeJobOutboundResult(
      result({
        controlPlane: { projectId: CANARY },
        filename: CANARY,
        location: { reference: CANARY },
        provenance: { taskId: CANARY },
        runtimeNodeId: CANARY,
      })
    )
    expect(sanitized).toEqual({
      ok: true,
      result: { artifact: null, jobId: 'job-1', summary: 'Done.' },
    })
    expect(JSON.stringify(sanitized)).not.toContain(CANARY)
  })

  test('removes controls, bidi overrides and zero-width marks; canonicalizes CRLF and lone CR', () => {
    const sanitized = sanitizeJobOutboundResult(
      result({ summary: 'a\u0000b\u001b[31m‮c​\u{feff}\n\td\r\ne\rf' })
    )
    expect(sanitized).toEqual({
      ok: true,
      result: { artifact: null, jobId: 'job-1', summary: 'ab[31mc\n\td\ne\nf' },
    })
  })

  test('normalizes to NFC before measuring the summary', () => {
    const sanitized = sanitizeJobOutboundResult(result({ summary: 'é' }))
    expect(sanitized.ok && sanitized.result.summary).toBe('é')
  })

  test('bounds identifiers by visible ASCII and length, checked per character', () => {
    expect(sanitizeJobOutboundResult(result({ jobId: 'j'.repeat(128) })).ok).toBe(true)
    expect(sanitizeJobOutboundResult(result({ jobId: 'j'.repeat(129) }))).toEqual({
      ok: false,
      reason: 'result_malformed',
    })
    expect(sanitizeJobOutboundResult(result({ jobId: 'jöb' }))).toEqual({
      ok: false,
      reason: 'result_malformed',
    })
    expect(sanitizeJobOutboundResult(result({ jobId: 'job 1' }))).toEqual({
      ok: false,
      reason: 'result_malformed',
    })
  })

  test('refuses malformed results with typed reasons', () => {
    expect(sanitizeJobOutboundResult(null)).toEqual({ ok: false, reason: 'result_malformed' })
    expect(sanitizeJobOutboundResult(['job-1'])).toEqual({ ok: false, reason: 'result_malformed' })
    expect(sanitizeJobOutboundResult(result({ jobId: '' }))).toEqual({
      ok: false,
      reason: 'result_malformed',
    })
    expect(sanitizeJobOutboundResult(result({ summary: 42 }))).toEqual({
      ok: false,
      reason: 'result_malformed',
    })
    expect(sanitizeJobOutboundResult(result({ summary: '​ \u0000' }))).toEqual({
      ok: false,
      reason: 'result_malformed',
    })
    expect(sanitizeJobOutboundResult(result({ artifact: { artifactId: 'artifact-1' } }))).toEqual({
      ok: false,
      reason: 'artifact_reference_malformed',
    })
    expect(
      sanitizeJobOutboundResult(result({ artifact: { ...target(), location: CANARY } }))
    ).toEqual({ ok: false, reason: 'artifact_reference_malformed' })
  })

  test('bounds summaries by bytes and refuses rather than truncating', () => {
    const atLimit = 'a'.repeat(JOB_OUTBOUND_SUMMARY_MAX_BYTES)
    expect(sanitizeJobOutboundResult(result({ summary: atLimit })).ok).toBe(true)
    expect(sanitizeJobOutboundResult(result({ summary: `${atLimit}a` }))).toEqual({
      ok: false,
      reason: 'result_too_large',
    })
    // 4,097 two-byte characters: under the character guard, over the byte bound.
    expect(sanitizeJobOutboundResult(result({ summary: 'é'.repeat(4097) }))).toEqual({
      ok: false,
      reason: 'result_too_large',
    })
    expect(sanitizeJobOutboundResult(result({ summary: 'a'.repeat(40_000) }))).toEqual({
      ok: false,
      reason: 'result_too_large',
    })
  })
})

describe('projectJobOutboundRelease', () => {
  test('includes the artifact locator only when the destination is authorized to retrieve it', () => {
    const sanitized = sanitizeJobOutboundResult(result({ artifact: target() }))
    if (!sanitized.ok) throw new Error('expected a sanitized result')
    expect(projectJobOutboundRelease(sanitized.result, true).artifact).toEqual(target())
    expect(projectJobOutboundRelease(sanitized.result, false)).toEqual({
      artifact: null,
      jobId: 'job-1',
      summary: 'Done.',
    })
  })
})

describe('decideJobOutboundPublication', () => {
  test('publishes a released shape for a completed job whose original actor owns the source', () => {
    expect(decideJobOutboundPublication(publication())).toEqual({
      action: 'publish',
      basis: 'source_owner_actor',
      destination,
      jobId: 'job-1',
      result: { artifact: null, jobId: 'job-1', summary: 'Done.' },
    })
  })

  test('admin source access is as authoritative as owner access', () => {
    expect(decideJobOutboundPublication(publication({ sourceAccess: ADMIN })).action).toBe(
      'publish'
    )
  })

  test('holds results that do not belong to the job or disagree with the artifact claim', () => {
    expect(
      decideJobOutboundPublication(publication({ result: result({ jobId: 'job-2' }) }))
    ).toMatchObject({ action: 'hold', gate: 'result', reason: 'result_job_mismatch' })
    expect(
      decideJobOutboundPublication(publication({ result: result({ artifact: target() }) }))
    ).toMatchObject({ action: 'hold', gate: 'result', reason: 'artifact_claim_mismatch' })
    expect(
      decideJobOutboundPublication(publication({ artifact: { ...claim(), ...current() } }))
    ).toMatchObject({ action: 'hold', gate: 'result', reason: 'artifact_claim_mismatch' })
  })

  test('holds an unknown, mismatched or uncompleted job without a decision', () => {
    expect(decideJobOutboundPublication(publication({ job: null }))).toEqual({
      action: 'hold',
      gate: 'job',
      jobId: 'job-1',
      producerEffect: 'unaffected',
      reason: 'job_unavailable',
    })
    expect(
      decideJobOutboundPublication(publication({ job: job({ jobId: 'job-2' }) }))
    ).toMatchObject({ gate: 'job', reason: 'job_unavailable' })
    expect(
      decideJobOutboundPublication(publication({ job: job({ completedAt: null }) }))
    ).toMatchObject({ gate: 'job', reason: 'job_not_completed' })
    expect(
      decideJobOutboundPublication(
        publication({ job: job({ completedAt: '2026-10-09T00:00:00.000Z' }) })
      )
    ).toMatchObject({ gate: 'job', reason: 'job_not_completed' })
  })

  test('holds when the original actor no longer holds source ownership', () => {
    expect(decideJobOutboundPublication(publication({ sourceAccess: MEMBER }))).toMatchObject({
      gate: 'source',
      reason: 'source_access_lost',
    })
    expect(
      decideJobOutboundPublication(
        publication({ sourceAccess: { ...OWNER, workspaceLive: false } })
      )
    ).toMatchObject({ gate: 'source', reason: 'source_access_lost' })
    expect(decideJobOutboundPublication(publication({ sourceAccess: null }))).toMatchObject({
      gate: 'source',
      reason: 'source_access_lost',
    })
  })

  test('holds a destination that is blank or in the job’s own workspace', () => {
    expect(
      decideJobOutboundPublication(
        publication({ destination: { channelId: CHANNEL, workspaceId: '' } })
      )
    ).toMatchObject({ gate: 'destination', reason: 'destination_not_outbound' })
    expect(
      decideJobOutboundPublication(
        publication({ destination: { channelId: CHANNEL, workspaceId: SOURCE } })
      )
    ).toMatchObject({ gate: 'destination', reason: 'destination_not_outbound' })
  })

  test('publishes an artifact reference only under current evidence and an effective grant', () => {
    expect(decideJobOutboundPublication(withArtifact(current()))).toMatchObject({
      action: 'publish',
      result: { artifact: target(), jobId: 'job-1' },
    })
  })

  test('holds an artifact whose audience is not the destination workspace', () => {
    const elsewhere = withArtifact(
      current({ grantState: grantState({ audienceWorkspaceIds: ['ws-elsewhere'] }) }),
      { audienceWorkspaceId: 'ws-elsewhere' }
    )
    expect(
      decideJobOutboundPublication({
        ...elsewhere,
        result: result({ artifact: target({ audienceWorkspaceId: 'ws-elsewhere' }) }),
      })
    ).toMatchObject({ gate: 'artifact', reason: 'audience_not_authorized' })
  })

  test('holds an artifact whose source is not the job’s source workspace', () => {
    const otherSource = publication({
      artifact: {
        ...claim({ grant: grant({ sourceWorkspaceId: 'ws-other' }) }),
        ...current({ evidence: evidence({ workspaceId: 'ws-other' }) }),
      },
      result: result({ artifact: target({ sourceWorkspaceId: 'ws-other' }) }),
    })
    expect(decideJobOutboundPublication(otherSource)).toMatchObject({
      gate: 'job',
      reason: 'job_source_mismatch',
    })
  })

  test('holds an artifact whose grant is revoked, superseded or whose version is stale', () => {
    expect(
      decideJobOutboundPublication(withArtifact({ grantState: grantState({ revoked: true }) }))
    ).toEqual({
      action: 'hold',
      gate: 'artifact',
      jobId: 'job-1',
      producerEffect: 'unaffected',
      reason: 'grant_revoked',
    })
    expect(
      decideJobOutboundPublication(withArtifact({ grantState: grantState({ revision: 2 }) }))
    ).toMatchObject({ gate: 'artifact', reason: 'grant_revision_stale' })
    expect(decideJobOutboundPublication(withArtifact({ evidence: null }))).toMatchObject({
      gate: 'artifact',
      reason: 'evidence_unavailable',
    })
    expect(
      decideJobOutboundPublication(withArtifact({ evidence: evidence({ version: 4 }) }))
    ).toMatchObject({ gate: 'artifact', reason: 'stale_version' })
  })

  test('never leaks runtime canaries through a hold decision', () => {
    const decision = decideJobOutboundPublication(
      publication({ sourceAccess: MEMBER, result: result({ filename: CANARY, summary: CANARY }) })
    )
    expect(JSON.stringify(decision)).not.toContain(CANARY)
  })

  test('does not mutate the job it reads', () => {
    const source = job()
    const before = JSON.stringify(source)
    decideJobOutboundPublication(publication({ job: source, sourceAccess: MEMBER }))
    expect(JSON.stringify(source)).toBe(before)
  })
})

describe('decideJobOutboundDelivery', () => {
  test('delivers the released shape to a participant of the exact channel while source ownership holds', () => {
    expect(decideJobOutboundDelivery(delivery({ published: result({ extra: CANARY }) }))).toEqual({
      action: 'deliver',
      destination,
      jobId: 'job-1',
      result: { artifact: null, jobId: 'job-1', summary: 'Done.' },
    })
  })

  test('group membership alone grants no release once the original actor loses source ownership', () => {
    expect(decideJobOutboundDelivery(delivery({ sourceAccess: MEMBER }))).toEqual({
      action: 'deny',
      gate: 'source',
      reason: 'source_access_lost',
    })
    expect(decideJobOutboundDelivery(delivery({ sourceAccess: null }))).toMatchObject({
      gate: 'source',
      reason: 'source_access_lost',
    })
  })

  test('refuses a participant standing read for a different channel (cross-group substitution)', () => {
    expect(
      decideJobOutboundDelivery(
        delivery({ recipientAudience: { ...PARTICIPANT, channelId: OTHER_CHANNEL } })
      )
    ).toEqual({ action: 'deny', gate: 'audience', reason: 'destination_channel_mismatch' })
  })

  test('denies a recipient who is not a participant of the destination group channel', () => {
    expect(
      decideJobOutboundDelivery(
        delivery({ recipientAudience: { ...PARTICIPANT, participant: false } })
      )
    ).toEqual({ action: 'deny', gate: 'audience', reason: 'recipient_not_destination_participant' })
  })

  test('denies a destination that is not a group channel, not live or in a deleted workspace', () => {
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
    expect(
      decideJobOutboundDelivery(
        delivery({ recipientAudience: { ...PARTICIPANT, workspaceLive: false } })
      )
    ).toMatchObject({ gate: 'audience', reason: 'destination_workspace_unavailable' })
    expect(decideJobOutboundDelivery(delivery({ recipientAudience: null }))).toMatchObject({
      gate: 'audience',
      reason: 'destination_workspace_unavailable',
    })
  })

  test('denies a job that is missing, uncompleted or reassigned at delivery', () => {
    expect(decideJobOutboundDelivery(delivery({ job: null }))).toEqual({
      action: 'deny',
      gate: 'job',
      reason: 'job_unavailable',
    })
    expect(decideJobOutboundDelivery(delivery({ job: job({ completedAt: null }) }))).toMatchObject({
      gate: 'job',
      reason: 'job_not_completed',
    })
  })

  test('denies a tampered or oversized published record before any access check', () => {
    expect(decideJobOutboundDelivery(delivery({ published: { jobId: 'job-1' } }))).toMatchObject({
      action: 'deny',
      gate: 'result',
      reason: 'result_malformed',
    })
    expect(
      decideJobOutboundDelivery(
        delivery({ published: result({ summary: 'a'.repeat(JOB_OUTBOUND_SUMMARY_MAX_BYTES + 1) }) })
      )
    ).toMatchObject({ gate: 'result', reason: 'result_too_large' })
    expect(
      decideJobOutboundDelivery(delivery({ published: result({ jobId: 'job-2' }) }))
    ).toMatchObject({ gate: 'result', reason: 'result_job_mismatch' })
  })

  test('releases an artifact only through the retrieval gate with the destination workspace as audience', () => {
    const artifactDelivery = (
      destinationWorkspaceId: string,
      state = grantState(),
      audience: JobOutboundAudience = PARTICIPANT
    ) =>
      delivery({
        artifact: { ...claim(), ...current({ grantState: state }) },
        destination: { channelId: CHANNEL, workspaceId: destinationWorkspaceId },
        published: result({ artifact: target() }),
        recipientAudience: { ...audience, workspaceLive: true },
      })
    expect(decideJobOutboundDelivery(artifactDelivery(DEST))).toMatchObject({
      action: 'deliver',
      result: { artifact: target() },
    })
    expect(decideJobOutboundDelivery(artifactDelivery('ws-elsewhere'))).toEqual({
      action: 'deny',
      gate: 'artifact',
      reason: 'audience_not_authorized',
    })
    expect(
      decideJobOutboundDelivery(artifactDelivery(DEST, grantState({ revoked: true })))
    ).toMatchObject({ gate: 'artifact', reason: 'grant_revoked' })
  })

  test('refuses an artifact whose source has moved away from the job’s source workspace', () => {
    expect(
      decideJobOutboundDelivery(
        delivery({
          artifact: { ...claim(), ...current() },
          job: job({ sourceWorkspaceId: 'ws-other' }),
          published: result({ artifact: target() }),
        })
      )
    ).toMatchObject({ gate: 'job', reason: 'job_source_mismatch' })
  })

  test('refuses a delivery whose artifact claim disagrees with the published record', () => {
    expect(
      decideJobOutboundDelivery(
        delivery({ artifact: { ...claim(), ...current() }, published: result() })
      )
    ).toEqual({ action: 'deny', gate: 'result', reason: 'artifact_claim_mismatch' })
  })
})
