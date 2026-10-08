import { describe, expect, test } from 'bun:test'

import {
  artifactReferenceRefusalReasons,
  isArtifactReferenceGrant,
  isArtifactReferenceRefusalReason,
  isArtifactReferenceTarget,
  isChecksumSha256,
  type ArtifactReferenceGrant,
  type ArtifactReferenceTarget,
} from '../src/artifact-reference'

const checksum = 'a'.repeat(64)

function target(overrides: Partial<ArtifactReferenceTarget> = {}): ArtifactReferenceTarget {
  return {
    artifactId: 'artifact-1',
    audienceWorkspaceId: 'ws-destination',
    checksumSha256: checksum,
    sourceWorkspaceId: 'ws-source',
    version: 3,
    ...overrides,
  }
}

function grant(overrides: Partial<ArtifactReferenceGrant> = {}): ArtifactReferenceGrant {
  return {
    artifactId: 'artifact-1',
    audienceWorkspaceId: 'ws-destination',
    checksumSha256: checksum,
    expiresAt: null,
    grantId: 'grant-1',
    revokedAt: null,
    revision: 2,
    sourceWorkspaceId: 'ws-source',
    version: 3,
    ...overrides,
  }
}

describe('artifact reference checksum guard', () => {
  test('accepts a lowercase 64-character hex sha-256 digest', () => {
    expect(isChecksumSha256(checksum)).toBe(true)
  })

  test('rejects uppercase, short, and non-hex values', () => {
    expect(isChecksumSha256('A'.repeat(64))).toBe(false)
    expect(isChecksumSha256('a'.repeat(63))).toBe(false)
    expect(isChecksumSha256('g'.repeat(64))).toBe(false)
    expect(isChecksumSha256(42)).toBe(false)
    expect(isChecksumSha256(null)).toBe(false)
  })
})

describe('artifact reference target guard', () => {
  test('accepts a well-formed exact locator', () => {
    expect(isArtifactReferenceTarget(target())).toBe(true)
  })

  test('rejects blank identifiers and a zero or fractional version', () => {
    expect(isArtifactReferenceTarget(target({ artifactId: ' ' }))).toBe(false)
    expect(isArtifactReferenceTarget(target({ sourceWorkspaceId: '' }))).toBe(false)
    expect(isArtifactReferenceTarget(target({ audienceWorkspaceId: '' }))).toBe(false)
    expect(isArtifactReferenceTarget(target({ version: 0 }))).toBe(false)
    expect(isArtifactReferenceTarget(target({ version: 1.5 }))).toBe(false)
  })

  test('rejects a tampered or absent digest', () => {
    expect(isArtifactReferenceTarget(target({ checksumSha256: 'zz' }))).toBe(false)
    expect(
      isArtifactReferenceTarget(target({ checksumSha256: undefined as unknown as string }))
    ).toBe(false)
  })

  test('rejects non-objects and extra fields', () => {
    expect(isArtifactReferenceTarget(null)).toBe(false)
    expect(isArtifactReferenceTarget('artifact-1')).toBe(false)
    expect(isArtifactReferenceTarget({ ...target(), location: '/private/secret' })).toBe(false)
  })
})

describe('artifact reference grant guard', () => {
  test('accepts a well-formed grant', () => {
    expect(isArtifactReferenceGrant(grant())).toBe(true)
    expect(isArtifactReferenceGrant(grant({ expiresAt: '2026-12-01T00:00:00.000Z' }))).toBe(true)
    expect(isArtifactReferenceGrant(grant({ revokedAt: '2026-10-01T00:00:00.000Z' }))).toBe(true)
  })

  test('rejects blank identifiers and non-positive revisions', () => {
    expect(isArtifactReferenceGrant(grant({ grantId: '' }))).toBe(false)
    expect(isArtifactReferenceGrant(grant({ audienceWorkspaceId: ' ' }))).toBe(false)
    expect(isArtifactReferenceGrant(grant({ revision: 0 }))).toBe(false)
  })

  test('binds the granted artifact version: zero, fractional or absent is malformed', () => {
    expect(isArtifactReferenceGrant(grant({ version: 0 }))).toBe(false)
    expect(isArtifactReferenceGrant(grant({ version: 1.5 }))).toBe(false)
    expect(isArtifactReferenceGrant(grant({ version: undefined as unknown as number }))).toBe(false)
    expect(isArtifactReferenceGrant(grant({ version: 7 }))).toBe(true)
  })

  test('requires explicit null or a timestamp for expiry and revocation', () => {
    expect(isArtifactReferenceGrant(grant({ expiresAt: undefined as unknown as null }))).toBe(false)
    expect(isArtifactReferenceGrant(grant({ revokedAt: undefined as unknown as null }))).toBe(false)
  })

  test('rejects non-objects and extra fields', () => {
    expect(isArtifactReferenceGrant(null)).toBe(false)
    expect(isArtifactReferenceGrant({ ...grant(), token: 'secret-token' })).toBe(false)
  })
})

describe('artifact reference refusal reasons', () => {
  test('the catalogue is frozen and every reason is recognized', () => {
    for (const reason of artifactReferenceRefusalReasons)
      expect(isArtifactReferenceRefusalReason(reason)).toBe(true)
  })

  test('unknown or non-string values are not refusal reasons', () => {
    expect(isArtifactReferenceRefusalReason('artifact_missing')).toBe(false)
    expect(isArtifactReferenceRefusalReason(7)).toBe(false)
    expect(isArtifactReferenceRefusalReason(undefined)).toBe(false)
  })
})
