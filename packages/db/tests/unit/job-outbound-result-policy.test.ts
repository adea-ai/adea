import { describe, expect, test } from 'bun:test'

import {
  JOB_OUTBOUND_SUMMARY_MAX_BYTES,
  decideJobOutboundDelivery,
  decideJobOutboundPublication,
  sanitizeJobOutboundResult,
  type JobOutboundArtifactClaim,
  type JobOutboundArtifactCurrent,
  type JobOutboundDeliveryInput,
  type JobOutboundPublicationInput,
} from '../../src/job-outbound-result-policy'
import type {
  ArtifactReferenceEvidence,
  ArtifactReferenceGrant,
  ArtifactReferenceGrantState,
  ArtifactReferenceTarget,
  GroupAdmission,
  GroupCompletedJob,
} from '@adea-ai/types'

/**
 * Pure outbound-result suites for M15 #1217. Current admissions, artifact
 * evidence, grant state and the clock are injected; no database is involved.
 */

const NOW = '2026-10-08T12:00:00.000Z'
const CHECKSUM = 'a'.repeat(64)
const GROUP = 'group-1'
const SOURCE = 'ws-source'
const AUDIENCE = 'ws-audience'
const OWNER = { kind: 'user', userId: 'user-owner' } as const
const OTHER = { kind: 'user', userId: 'user-other' } as const
const RECIPIENT = { kind: 'user', userId: 'user-recipient' } as const
const AGENT = { kind: 'agent', agentId: 'agent-1' } as const
const CANARY = 'CANARY-runtime-node-/private/home/secret'

function target(overrides: Partial<ArtifactReferenceTarget> = {}): ArtifactReferenceTarget {
  return {
    artifactId: 'artifact-1',
    audienceWorkspaceId: AUDIENCE,
    checksumSha256: CHECKSUM,
    sourceWorkspaceId: SOURCE,
    version: 3,
    ...overrides,
  }
}

function result(overrides: Record<string, unknown> = {}) {
  return { jobId: 'job-1', summary: 'Done.', ...overrides }
}

function job(overrides: Partial<GroupCompletedJob> = {}): GroupCompletedJob {
  return {
    authorization: { groupId: GROUP, grantId: 'grant-owner', revision: 2 },
    completedAt: '2026-10-08T11:00:00.000Z',
    jobId: 'job-1',
    participant: OWNER,
    ...overrides,
  }
}

function admission(
  participant: GroupAdmission['participant'],
  grantId: string,
  grantOverrides: Partial<GroupAdmission['grant']> = {},
  authorizationOverrides: Partial<GroupAdmission['authorization']> = {}
): GroupAdmission {
  return {
    authorization: { groupId: GROUP, grantId, revision: 2, ...authorizationOverrides },
    grant: {
      expiresAt: null,
      issuedAt: '2026-10-01T00:00:00.000Z',
      revokedAt: null,
      ...grantOverrides,
    },
    joinPoint: { joinedAt: '2026-10-01T00:00:00.000Z', joinedSequence: 0 },
    participant,
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
    audienceWorkspaceId: AUDIENCE,
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
    audienceWorkspaceIds: [AUDIENCE],
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
    admission: admission(OWNER, 'grant-owner'),
    artifact: null,
    job: job(),
    now: NOW,
    publisher: OWNER,
    result: result(),
    ...overrides,
  }
}

function publicationWithArtifact(
  state: Partial<JobOutboundArtifactCurrent>,
  grantOverrides: Partial<ArtifactReferenceGrant> = {}
): JobOutboundPublicationInput {
  return publication({
    artifact: {
      authority: { kind: 'workspace_grant' },
      grant: grant(grantOverrides),
      ...current(state),
    },
    result: result({ artifact: target() }),
  })
}

function delivery(overrides: Partial<JobOutboundDeliveryInput> = {}): JobOutboundDeliveryInput {
  return {
    admission: admission(RECIPIENT, 'grant-recipient', {}, { revision: 1 }),
    artifact: null,
    now: NOW,
    published: result(),
    recipient: { groupId: GROUP, participant: RECIPIENT, workspaceId: AUDIENCE },
    ...overrides,
  }
}

describe('sanitizeJobOutboundResult', () => {
  test('builds the outbound shape by allowlist and drops runtime fields', () => {
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

  test('removes controls, bidi overrides and zero-width marks while keeping tab and newline', () => {
    const sanitized = sanitizeJobOutboundResult(
      result({ summary: 'a\u0000b\u001b[31m‮c​\u{feff}\n\td\r\ne' })
    )
    expect(sanitized).toEqual({
      ok: true,
      result: { artifact: null, jobId: 'job-1', summary: 'ab[31mc\n\td\ne' },
    })
  })

  test('normalizes to NFC before measuring the summary', () => {
    const sanitized = sanitizeJobOutboundResult(result({ summary: 'é' }))
    expect(sanitized.ok && sanitized.result.summary).toBe('é')
  })

  test('refuses malformed results with typed reasons', () => {
    expect(sanitizeJobOutboundResult(null)).toEqual({ ok: false, reason: 'result_malformed' })
    expect(sanitizeJobOutboundResult(['job-1'])).toEqual({ ok: false, reason: 'result_malformed' })
    expect(sanitizeJobOutboundResult(result({ jobId: '' }))).toEqual({
      ok: false,
      reason: 'result_malformed',
    })
    expect(sanitizeJobOutboundResult(result({ jobId: 'job 1' }))).toEqual({
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

describe('decideJobOutboundPublication', () => {
  test('publishes a sanitized result from the job owner with a current admission', () => {
    const decision = decideJobOutboundPublication(publication())
    expect(decision).toEqual({
      action: 'publish',
      basis: 'participant_authorized',
      jobId: 'job-1',
      result: { artifact: null, jobId: 'job-1', summary: 'Done.' },
    })
  })

  test('holds results that do not belong to the job or disagree with the artifact claim', () => {
    expect(
      decideJobOutboundPublication(publication({ result: result({ jobId: 'job-2' }) }))
    ).toMatchObject({
      action: 'hold',
      gate: 'result',
      producerEffect: 'unaffected',
      reason: 'result_job_mismatch',
    })
    expect(
      decideJobOutboundPublication(publication({ result: result({ artifact: target() }) }))
    ).toMatchObject({ action: 'hold', gate: 'result', reason: 'artifact_claim_mismatch' })
    expect(
      decideJobOutboundPublication(publication({ artifact: { ...claim(), ...current() } }))
    ).toMatchObject({ action: 'hold', gate: 'result', reason: 'artifact_claim_mismatch' })
  })

  test('holds a job publisher who is not the job owner without touching the job', () => {
    const owned = job()
    const snapshot = JSON.stringify(owned)
    const decision = decideJobOutboundPublication(
      publication({ admission: admission(OTHER, 'grant-other'), job: owned, publisher: OTHER })
    )
    expect(decision).toEqual({
      action: 'hold',
      gate: 'group',
      jobId: 'job-1',
      producerEffect: 'unaffected',
      reason: 'publication_authority_mismatch',
    })
    expect(JSON.stringify(owned)).toBe(snapshot)
  })

  test('holds without a current admission, with a revoked admission, or with a superseded binding', () => {
    expect(decideJobOutboundPublication(publication({ admission: null }))).toMatchObject({
      gate: 'group',
      reason: 'publication_unauthorized_at_completion',
    })
    expect(
      decideJobOutboundPublication(
        publication({ admission: admission(OWNER, 'grant-owner', { revokedAt: NOW }) })
      )
    ).toMatchObject({ gate: 'group', reason: 'publication_participation_revoked' })
    expect(
      decideJobOutboundPublication(
        publication({ admission: admission(OWNER, 'grant-owner', {}, { revision: 3 }) })
      )
    ).toMatchObject({ gate: 'group', reason: 'publication_binding_mismatch' })
    expect(
      decideJobOutboundPublication(publication({ job: job({ authorization: null }) }))
    ).toMatchObject({ gate: 'group', reason: 'publication_binding_mismatch' })
  })

  test('publishes an artifact reference only under current evidence and an effective grant', () => {
    const decision = decideJobOutboundPublication(
      publication({
        artifact: { ...claim(), ...current() },
        result: result({ artifact: target() }),
      })
    )
    expect(decision).toMatchObject({
      action: 'publish',
      result: { artifact: target(), jobId: 'job-1' },
    })
  })

  test('holds an artifact reference whose grant is revoked, superseded or whose version is stale', () => {
    expect(
      decideJobOutboundPublication(
        publicationWithArtifact({ grantState: grantState({ revoked: true }) })
      )
    ).toEqual({
      action: 'hold',
      gate: 'artifact',
      jobId: 'job-1',
      producerEffect: 'unaffected',
      reason: 'grant_revoked',
    })
    expect(
      decideJobOutboundPublication(
        publicationWithArtifact({ grantState: grantState({ revision: 2 }) })
      )
    ).toMatchObject({ gate: 'artifact', reason: 'grant_revision_stale' })
    expect(decideJobOutboundPublication(publicationWithArtifact({ evidence: null }))).toMatchObject(
      {
        gate: 'artifact',
        reason: 'evidence_unavailable',
      }
    )
    expect(
      decideJobOutboundPublication(publicationWithArtifact({ evidence: evidence({ version: 4 }) }))
    ).toMatchObject({ gate: 'artifact', reason: 'stale_version' })
  })

  test('never leaks runtime canaries through a hold decision', () => {
    const decision = decideJobOutboundPublication(
      publication({ admission: null, result: result({ filename: CANARY, summary: CANARY }) })
    )
    expect(JSON.stringify(decision)).not.toContain(CANARY)
  })
})

describe('decideJobOutboundDelivery', () => {
  test('delivers the re-sanitized result to a currently effective recipient', () => {
    expect(decideJobOutboundDelivery(delivery({ published: result({ extra: CANARY }) }))).toEqual({
      action: 'deliver',
      result: { artifact: null, jobId: 'job-1', summary: 'Done.' },
    })
  })

  test('denies a recipient who is absent, of another identity, or of another kind', () => {
    expect(decideJobOutboundDelivery(delivery({ admission: null }))).toEqual({
      action: 'deny',
      gate: 'audience',
      reason: 'recipient_not_admitted',
    })
    expect(
      decideJobOutboundDelivery(
        delivery({ admission: admission(OTHER, 'grant-x', {}, { revision: 1 }) })
      )
    ).toMatchObject({ gate: 'audience', reason: 'recipient_not_admitted' })
    expect(
      decideJobOutboundDelivery(
        delivery({ admission: admission(AGENT, 'grant-x', {}, { revision: 1 }) })
      )
    ).toMatchObject({ gate: 'audience', reason: 'recipient_not_admitted' })
  })

  test('denies an admission bound to another group or to an unprovable revision', () => {
    expect(
      decideJobOutboundDelivery(
        delivery({
          admission: admission(RECIPIENT, 'grant-r', {}, { groupId: 'group-2', revision: 1 }),
        })
      )
    ).toMatchObject({ gate: 'audience', reason: 'recipient_binding_invalid' })
    expect(
      decideJobOutboundDelivery(
        delivery({ admission: admission(RECIPIENT, 'grant-r', {}, { revision: 0 }) })
      )
    ).toMatchObject({ gate: 'audience', reason: 'recipient_binding_invalid' })
    expect(
      decideJobOutboundDelivery(
        delivery({ admission: admission(RECIPIENT, ' ', {}, { revision: 1 }) })
      )
    ).toMatchObject({ gate: 'audience', reason: 'recipient_binding_invalid' })
  })

  test('denies a revoked or lapsed recipient at the next delivery', () => {
    expect(
      decideJobOutboundDelivery(
        delivery({
          admission: admission(RECIPIENT, 'grant-r', { revokedAt: NOW }, { revision: 1 }),
        })
      )
    ).toMatchObject({ gate: 'audience', reason: 'recipient_participation_revoked' })
    expect(
      decideJobOutboundDelivery(
        delivery({
          admission: admission(
            RECIPIENT,
            'grant-r',
            { expiresAt: '2026-10-08T11:59:00.000Z' },
            { revision: 1 }
          ),
        })
      )
    ).toMatchObject({ gate: 'audience', reason: 'recipient_participation_stale' })
  })

  test('denies a tampered or oversized published record before any audience check', () => {
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
  })

  test('re-runs the exact retrieval gate for an artifact with the recipient workspace as audience', () => {
    const artifactDelivery = (recipientWorkspaceId: string, state = grantState()) =>
      delivery({
        artifact: { ...claim(), ...current({ grantState: state }) },
        published: result({ artifact: target() }),
        recipient: { groupId: GROUP, participant: RECIPIENT, workspaceId: recipientWorkspaceId },
      })
    expect(decideJobOutboundDelivery(artifactDelivery(AUDIENCE))).toMatchObject({
      action: 'deliver',
      result: { artifact: target() },
    })
    expect(decideJobOutboundDelivery(artifactDelivery('ws-elsewhere'))).toEqual({
      action: 'deny',
      gate: 'artifact',
      reason: 'audience_not_authorized',
    })
    expect(
      decideJobOutboundDelivery(artifactDelivery(AUDIENCE, grantState({ revoked: true })))
    ).toMatchObject({ gate: 'artifact', reason: 'grant_revoked' })
  })

  test('refuses a delivery whose artifact claim disagrees with the published record', () => {
    expect(
      decideJobOutboundDelivery(
        delivery({ artifact: { ...claim(), ...current() }, published: result() })
      )
    ).toEqual({ action: 'deny', gate: 'result', reason: 'artifact_claim_mismatch' })
  })
})
