import { describe, expect, test } from 'bun:test'

import {
  authorizeArtifactReferencePublication,
  authorizeArtifactReferenceRetrieval,
} from '../../src/artifact-reference-policy'
import type {
  ArtifactReferenceEvidence,
  ArtifactReferenceGrant,
  ArtifactReferenceGrantState,
  ArtifactReferencePublicationInput,
  ArtifactReferenceRetrievalInput,
  ArtifactReferenceTarget,
} from '@adea-ai/types'

/**
 * Pure policy suites for M15.03 (#1180). Evidence, grants, grant state and
 * the clock are injected; no database is involved here. The PostgreSQL lane
 * in `tests/integration` covers the evidence reading through the existing
 * helpers.
 */

const NOW = '2026-10-08T12:00:00.000Z'
const CHECKSUM = 'a'.repeat(64)
const TAMPERED = 'b'.repeat(64)
const SOURCE = 'ws-source'
const DESTINATION = 'ws-destination'
const ELSEWHERE = 'ws-elsewhere'

function target(overrides: Partial<ArtifactReferenceTarget> = {}): ArtifactReferenceTarget {
  return {
    artifactId: 'artifact-1',
    audienceWorkspaceId: DESTINATION,
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
    audienceWorkspaceId: DESTINATION,
    checksumSha256: CHECKSUM,
    expiresAt: null,
    grantId: 'grant-1',
    revokedAt: null,
    revision: 2,
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
    audienceWorkspaceIds: [DESTINATION],
    checksumSha256: CHECKSUM,
    expiresAt: null,
    grantId: 'grant-1',
    revoked: false,
    revision: 2,
    sourceWorkspaceId: SOURCE,
    version: 3,
    ...overrides,
  }
}

function publicationInput(
  overrides: Partial<ArtifactReferencePublicationInput> = {}
): ArtifactReferencePublicationInput {
  return {
    authority: { kind: 'workspace_grant' },
    evidence: evidence(),
    grant: grant(),
    grantState: grantState(),
    now: NOW,
    target: target(),
    ...overrides,
  }
}

function retrievalInput(
  overrides: Partial<ArtifactReferenceRetrievalInput> = {}
): ArtifactReferenceRetrievalInput {
  return { ...publicationInput(), requestingWorkspaceId: DESTINATION, ...overrides }
}

describe('artifact reference policy: exact-match admission (#1180)', () => {
  test('a fully matching reference publishes and delivers the exact target', () => {
    const publication = authorizeArtifactReferencePublication(publicationInput())
    expect(publication).toEqual({
      action: 'publish',
      ok: true,
      stage: 'publication',
      target: target(),
    })
    const retrieval = authorizeArtifactReferenceRetrieval(retrievalInput())
    expect(retrieval).toEqual({
      action: 'deliver',
      ok: true,
      stage: 'retrieval',
      target: target(),
    })
  })

  test('a locator without current evidence proves nothing: no URL or artifact id grants access', () => {
    const held = authorizeArtifactReferencePublication(publicationInput({ evidence: null }))
    expect(held).toEqual({
      action: 'hold',
      ok: false,
      producerEffect: 'unaffected',
      reason: 'evidence_unavailable',
      stage: 'publication',
    })
    const denied = authorizeArtifactReferenceRetrieval(retrievalInput({ evidence: null }))
    expect(denied).toEqual({
      action: 'deny',
      ok: false,
      reason: 'evidence_unavailable',
      stage: 'retrieval',
    })
  })
})

describe('artifact reference policy: cross-workspace isolation', () => {
  test('evidence read from another workspace never matches the claimed source', () => {
    const held = authorizeArtifactReferencePublication(
      publicationInput({ evidence: evidence({ workspaceId: ELSEWHERE }) })
    )
    expect(held.ok).toBe(false)
    if (!held.ok) expect(held.reason).toBe('workspace_mismatch')
    const denied = authorizeArtifactReferenceRetrieval(
      retrievalInput({ evidence: evidence({ workspaceId: ELSEWHERE }) })
    )
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.reason).toBe('workspace_mismatch')
  })

  test('evidence about a different artifact id is a forgery attempt, not a match', () => {
    const held = authorizeArtifactReferencePublication(
      publicationInput({ evidence: evidence({ id: 'artifact-2' }) })
    )
    expect(held.ok).toBe(false)
    if (!held.ok) expect(held.reason).toBe('workspace_mismatch')
  })

  test('a self-referencing audience is not a cross-workspace reference', () => {
    const held = authorizeArtifactReferencePublication(
      publicationInput({ target: target({ audienceWorkspaceId: SOURCE }) })
    )
    expect(held.ok).toBe(false)
    if (!held.ok) expect(held.reason).toBe('reference_malformed')
  })

  test('only the registered audience workspace may retrieve', () => {
    const denied = authorizeArtifactReferenceRetrieval(
      retrievalInput({ requestingWorkspaceId: ELSEWHERE })
    )
    expect(denied).toEqual({
      action: 'deny',
      ok: false,
      reason: 'audience_not_authorized',
      stage: 'retrieval',
    })
  })
})

describe('artifact reference policy: version and digest changes', () => {
  test('a version bump after publication makes every later decision stale', () => {
    const stale = publicationInput({ evidence: evidence({ version: 4 }) })
    const held = authorizeArtifactReferencePublication(stale)
    expect(held.ok).toBe(false)
    if (!held.ok) expect(held.reason).toBe('stale_version')
    const denied = authorizeArtifactReferenceRetrieval(
      retrievalInput({ evidence: evidence({ version: 4 }) })
    )
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.reason).toBe('stale_version')
  })

  test('a tampered digest is rejected at publication and at retrieval', () => {
    for (const targetOverride of [
      { target: target({ checksumSha256: TAMPERED }) },
      { evidence: evidence({ checksumSha256: TAMPERED }) },
    ]) {
      const held = authorizeArtifactReferencePublication(publicationInput(targetOverride))
      expect(held.ok).toBe(false)
      if (!held.ok) expect(held.reason).toBe('digest_mismatch')
      const denied = authorizeArtifactReferenceRetrieval(retrievalInput(targetOverride))
      expect(denied.ok).toBe(false)
      if (!denied.ok) expect(denied.reason).toBe('digest_mismatch')
    }
  })
})

describe('artifact reference policy: deleted, quarantined and unavailable artifacts', () => {
  test('a deleted artifact is refused by name', () => {
    const held = authorizeArtifactReferencePublication(
      publicationInput({ evidence: evidence({ deletionState: 'deleted' }) })
    )
    expect(held.ok).toBe(false)
    if (!held.ok) expect(held.reason).toBe('artifact_deleted')
  })

  test('a quarantined artifact is refused and never delivered', () => {
    const quarantined = evidence({ availability: 'quarantined' })
    const held = authorizeArtifactReferencePublication(publicationInput({ evidence: quarantined }))
    expect(held.ok).toBe(false)
    if (!held.ok) expect(held.reason).toBe('artifact_quarantined')
    const denied = authorizeArtifactReferenceRetrieval(retrievalInput({ evidence: quarantined }))
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.reason).toBe('artifact_quarantined')
  })

  test('pending, failed and unavailable artifacts are not publishable', () => {
    for (const availability of ['pending', 'failed', 'unavailable'] as const) {
      const held = authorizeArtifactReferencePublication(
        publicationInput({ evidence: evidence({ availability }) })
      )
      expect(held.ok).toBe(false)
      if (!held.ok) expect(held.reason).toBe('artifact_not_available')
    }
  })
})

describe('artifact reference policy: malformed, forged and unregistered grants', () => {
  test('a missing or structurally malformed grant is refused', () => {
    for (const grantOverride of [
      null,
      grant({ checksumSha256: 'not-a-digest' }),
      grant({ grantId: ' ' }),
      grant({ revision: 0 }),
    ]) {
      const held = authorizeArtifactReferencePublication(
        publicationInput({ grant: grantOverride as ArtifactReferenceGrant | null })
      )
      expect(held.ok).toBe(false)
      if (!held.ok) expect(held.reason).toBe('grant_malformed')
    }
  })

  test('a grant that binds a different target is a forged locator', () => {
    for (const grantOverride of [
      grant({ artifactId: 'artifact-2' }),
      grant({ sourceWorkspaceId: ELSEWHERE }),
      grant({ checksumSha256: TAMPERED }),
      grant({ audienceWorkspaceId: ELSEWHERE }),
    ]) {
      const held = authorizeArtifactReferencePublication(publicationInput({ grant: grantOverride }))
      expect(held.ok).toBe(false)
      if (!held.ok) expect(held.reason).toBe('target_mismatch')
    }
  })

  test('a grant unknown to the authoritative registration is refused', () => {
    for (const stateOverride of [null, grantState({ grantId: 'grant-unknown' })]) {
      const denied = authorizeArtifactReferenceRetrieval(
        retrievalInput({ grantState: stateOverride })
      )
      expect(denied.ok).toBe(false)
      if (!denied.ok) expect(denied.reason).toBe('grant_not_registered')
    }
  })
})

describe('artifact reference policy: revocation, stale revisions, expiry, audience removal', () => {
  test('a revoked grant refuses both gates', () => {
    for (const overrides of [
      { grant: grant({ revokedAt: '2026-10-01T00:00:00.000Z' }) },
      { grantState: grantState({ revoked: true }) },
    ]) {
      const held = authorizeArtifactReferencePublication(publicationInput(overrides))
      expect(held.ok).toBe(false)
      if (!held.ok) expect(held.reason).toBe('grant_revoked')
      const denied = authorizeArtifactReferenceRetrieval(retrievalInput(overrides))
      expect(denied.ok).toBe(false)
      if (!denied.ok) expect(denied.reason).toBe('grant_revoked')
    }
  })

  test('a presented grant whose revision is superseded is stale, not valid', () => {
    const superseded = { grant: grant({ revision: 2 }), grantState: grantState({ revision: 3 }) }
    const held = authorizeArtifactReferencePublication(publicationInput(superseded))
    expect(held.ok).toBe(false)
    if (!held.ok) expect(held.reason).toBe('grant_revision_stale')
    const denied = authorizeArtifactReferenceRetrieval(retrievalInput(superseded))
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.reason).toBe('grant_revision_stale')
  })

  test('an expired grant is refused at the boundary instant and before it', () => {
    const expiresAt = '2026-10-08T12:00:00.000Z'
    const expired = {
      grant: grant({ expiresAt }),
      grantState: grantState({ expiresAt }),
      now: NOW,
    }
    const held = authorizeArtifactReferencePublication(publicationInput(expired))
    expect(held.ok).toBe(false)
    if (!held.ok) expect(held.reason).toBe('grant_expired')
    const stillValid = authorizeArtifactReferencePublication(
      publicationInput({
        grant: grant({ expiresAt }),
        grantState: grantState({ expiresAt }),
        now: '2026-10-08T11:59:59.999Z',
      })
    )
    expect(stillValid.ok).toBe(true)
  })

  test('an unparseable expiry is a malformed grant and an unverifiable clock fails closed', () => {
    const malformed = authorizeArtifactReferencePublication(
      publicationInput({
        grant: grant({ expiresAt: 'not-a-timestamp' }),
        grantState: grantState({ expiresAt: 'not-a-timestamp' }),
      })
    )
    expect(malformed.ok).toBe(false)
    if (!malformed.ok) expect(malformed.reason).toBe('grant_malformed')
    const expiresAt = '2026-12-01T00:00:00.000Z'
    const failedClock = authorizeArtifactReferencePublication(
      publicationInput({
        grant: grant({ expiresAt }),
        grantState: grantState({ expiresAt }),
        now: 'soon',
      })
    )
    expect(failedClock.ok).toBe(false)
    if (!failedClock.ok) expect(failedClock.reason).toBe('grant_expired')
  })

  test('audience removal refuses while the grant revision itself is current', () => {
    const audienceGone = { grantState: grantState({ audienceWorkspaceIds: [ELSEWHERE] }) }
    const held = authorizeArtifactReferencePublication(publicationInput(audienceGone))
    expect(held.ok).toBe(false)
    if (!held.ok) expect(held.reason).toBe('audience_not_authorized')
    const denied = authorizeArtifactReferenceRetrieval(retrievalInput(audienceGone))
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.reason).toBe('audience_not_authorized')
  })
})

describe('artifact reference policy: unsupported group authority', () => {
  test('a group-authority reference is denied by name before anything else is considered', () => {
    for (const overrides of [
      { target: target({ artifactId: '' }) },
      { evidence: null },
      { grant: null },
    ]) {
      const held = authorizeArtifactReferencePublication({
        ...publicationInput(overrides),
        authority: { groupId: 'group-1', kind: 'group' },
      })
      expect(held.ok).toBe(false)
      if (!held.ok) expect(held.reason).toBe('unsupported_authority')
      const denied = authorizeArtifactReferenceRetrieval({
        ...retrievalInput(overrides),
        authority: { groupId: 'group-1', kind: 'group' },
      })
      expect(denied.ok).toBe(false)
      if (!denied.ok) expect(denied.reason).toBe('unsupported_authority')
    }
  })
})

describe('artifact reference policy: publication and retrieval are separate gates', () => {
  test('the same refusal holds publication but denies retrieval', () => {
    const input = publicationInput({ evidence: evidence({ version: 9 }) })
    const held = authorizeArtifactReferencePublication(input)
    const denied = authorizeArtifactReferenceRetrieval({
      ...input,
      requestingWorkspaceId: DESTINATION,
    })
    expect(held.action).toBe('hold')
    expect(denied.action).toBe('deny')
    expect(held.ok).toBe(false)
    expect(denied.ok).toBe(false)
    if (!held.ok) expect(held.producerEffect).toBe('unaffected')
    if (!held.ok && !denied.ok) expect(denied.reason).toBe(held.reason)
  })

  test('only the retrieval gate knows a requesting workspace', () => {
    // Publication decides from source-side truth alone; a stray requesting
    // workspace field cannot make it hold, while retrieval denies on it.
    const wrongDestination = retrievalInput({ requestingWorkspaceId: ELSEWHERE })
    const published = authorizeArtifactReferencePublication(wrongDestination)
    expect(published.ok).toBe(true)
    const denied = authorizeArtifactReferenceRetrieval(wrongDestination)
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.reason).toBe('audience_not_authorized')
  })
})

describe('artifact reference policy: late publication after revocation', () => {
  test('a result produced before revocation is held, and the producing job stays unaffected', () => {
    const revoked = {
      grant: grant({ revokedAt: '2026-10-08T11:00:00.000Z' }),
      grantState: grantState({ revoked: true }),
    }
    const held = authorizeArtifactReferencePublication(publicationInput(revoked))
    expect(held).toEqual({
      action: 'hold',
      ok: false,
      producerEffect: 'unaffected',
      reason: 'grant_revoked',
      stage: 'publication',
    })
    const denied = authorizeArtifactReferenceRetrieval(retrievalInput(revoked))
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.reason).toBe('grant_revoked')
  })
})

describe('artifact reference policy: sanitized refusals', () => {
  test('a refusal carries only its typed shape and never echoes evidence', () => {
    const secretDigest = 'f'.repeat(64)
    const held = authorizeArtifactReferencePublication(
      publicationInput({
        evidence: evidence({
          availability: 'available',
          checksumSha256: secretDigest,
          sensitivity: 'restricted',
        }),
        target: target({ checksumSha256: TAMPERED }),
      })
    )
    expect(held.ok).toBe(false)
    if (!held.ok) {
      expect(held.reason).toBe('digest_mismatch')
      expect(Object.keys(held).toSorted()).toEqual([
        'action',
        'ok',
        'producerEffect',
        'reason',
        'stage',
      ])
    }
    const denied = authorizeArtifactReferenceRetrieval(
      retrievalInput({
        evidence: evidence({ checksumSha256: secretDigest, sensitivity: 'restricted' }),
        target: target({ checksumSha256: TAMPERED }),
      })
    )
    expect(denied.ok).toBe(false)
    if (!denied.ok)
      expect(Object.keys(denied).toSorted()).toEqual(['action', 'ok', 'reason', 'stage'])
    const serialized = JSON.stringify([held, denied])
    expect(serialized).not.toContain(secretDigest)
    expect(serialized).not.toContain('sensitivity')
    expect(serialized).not.toContain('evidence')
  })

  test('no refusal path ever includes evidence, grant, or target objects', () => {
    const inputs = [
      publicationInput({ evidence: null }),
      publicationInput({ target: target({ version: 99 }) }),
      publicationInput({ grantState: grantState({ revoked: true }) }),
      publicationInput({ authority: { groupId: 'group-1', kind: 'group' } }),
    ]
    for (const input of inputs) {
      for (const decision of [
        authorizeArtifactReferencePublication(input),
        authorizeArtifactReferenceRetrieval({ ...input, requestingWorkspaceId: ELSEWHERE }),
      ]) {
        if (decision.ok) continue
        const serialized = JSON.stringify(decision)
        expect(serialized).not.toContain('checksumSha256')
        expect(serialized).not.toContain('grantId')
        expect(serialized).not.toContain('artifactId')
        expect(serialized).not.toContain(CHECKSUM)
      }
    }
  })
})

describe('artifact reference policy: the presented grant is authenticated in full', () => {
  test('a known grant identity relabelled onto another artifact is refused', () => {
    // The registration retains the grant for artifact-1; the presented grant
    // borrows its live identity (id, revision, audience) to authorize
    // artifact-2, whose current evidence really exists. Every field agrees
    // except the one the registration actually retained.
    const stolen = {
      evidence: evidence({ id: 'artifact-2' }),
      grant: grant({ artifactId: 'artifact-2' }),
      target: target({ artifactId: 'artifact-2' }),
    }
    const held = authorizeArtifactReferencePublication(publicationInput(stolen))
    expect(held.ok).toBe(false)
    if (!held.ok) expect(held.reason).toBe('grant_target_mismatch')
    const denied = authorizeArtifactReferenceRetrieval(retrievalInput(stolen))
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.reason).toBe('grant_target_mismatch')
  })

  test('a known grant identity relabelled onto another source workspace is refused', () => {
    const foreignSource = {
      evidence: evidence({ id: 'artifact-2', workspaceId: ELSEWHERE }),
      grant: grant({ artifactId: 'artifact-2', sourceWorkspaceId: ELSEWHERE }),
      target: target({ artifactId: 'artifact-2', sourceWorkspaceId: ELSEWHERE }),
    }
    const held = authorizeArtifactReferencePublication(publicationInput(foreignSource))
    expect(held.ok).toBe(false)
    if (!held.ok) expect(held.reason).toBe('grant_target_mismatch')
    const denied = authorizeArtifactReferenceRetrieval(retrievalInput(foreignSource))
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.reason).toBe('grant_target_mismatch')
  })

  test('a known grant identity with a substituted digest is refused', () => {
    // Target and evidence agree with the digest the presented grant claims —
    // only the authoritative registration still retains the granted one.
    const digestSwap = {
      evidence: evidence({ checksumSha256: TAMPERED }),
      grant: grant({ checksumSha256: TAMPERED }),
      target: target({ checksumSha256: TAMPERED }),
    }
    const held = authorizeArtifactReferencePublication(publicationInput(digestSwap))
    expect(held.ok).toBe(false)
    if (!held.ok) expect(held.reason).toBe('grant_digest_mismatch')
    const denied = authorizeArtifactReferenceRetrieval(retrievalInput(digestSwap))
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.reason).toBe('grant_digest_mismatch')
  })

  test('a nulled or replaced expiry is refused: the lifetime comes from the registration', () => {
    const expiresAt = '2026-10-01T00:00:00.000Z'
    // Nulling a lapsed registration would otherwise make the grant
    // non-expiring; replacing it postpones the boundary. Both diverge from
    // the retained record and fail closed.
    for (const presented of [null, '2026-12-31T23:59:59.999Z'] as const) {
      const tampered = {
        grant: grant({ expiresAt: presented }),
        grantState: grantState({ expiresAt }),
      }
      const held = authorizeArtifactReferencePublication(publicationInput(tampered))
      expect(held.ok).toBe(false)
      if (!held.ok) expect(held.reason).toBe('grant_expiry_mismatch')
      const denied = authorizeArtifactReferenceRetrieval(retrievalInput(tampered))
      expect(denied.ok).toBe(false)
      if (!denied.ok) expect(denied.reason).toBe('grant_expiry_mismatch')
    }
  })

  test('a v1 grant never authorizes a v2 artifact even when the checksum is unchanged', () => {
    // The registration binds version 3; the artifact is now version 4 with
    // the identical content digest. Whichever version the presented grant
    // claims, substitution fails: claiming v2 diverges from the registration,
    // claiming v1 diverges from the presented target.
    const bumped = {
      evidence: evidence({ version: 4 }),
      grantState: grantState(),
      target: target({ version: 4 }),
    }
    const v2Grant = authorizeArtifactReferencePublication(
      publicationInput({ ...bumped, grant: grant({ version: 4 }) })
    )
    expect(v2Grant.ok).toBe(false)
    if (!v2Grant.ok) expect(v2Grant.reason).toBe('grant_version_mismatch')
    const denied = authorizeArtifactReferenceRetrieval(
      retrievalInput({ ...bumped, grant: grant({ version: 4 }) })
    )
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.reason).toBe('grant_version_mismatch')
    const v1Grant = authorizeArtifactReferencePublication(
      publicationInput({ ...bumped, grant: grant({ version: 3 }) })
    )
    expect(v1Grant.ok).toBe(false)
    if (!v1Grant.ok) expect(v1Grant.reason).toBe('target_mismatch')
  })

  test('a presented grant equal to its retained registration still admits both gates', () => {
    // The happy path is unchanged: artifact, digest, version and expiry all
    // equal to the authoritative record.
    const publication = authorizeArtifactReferencePublication(publicationInput())
    expect(publication.ok).toBe(true)
    const retrieval = authorizeArtifactReferenceRetrieval(retrievalInput())
    expect(retrieval.ok).toBe(true)
  })
})
