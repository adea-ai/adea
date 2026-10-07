import { describe, expect, test } from 'bun:test'
import type { ApiCatalogItem, ApiCloudConnection } from '@adea-ai/api-client'

import {
  canChangeConnection,
  canRetire,
  catalogItemDetail,
  cloudConnectionDraftProblem,
  connectionDetail,
  connectionStatusLabel,
  connectionStatusTone,
  controlPlaneActionNotice,
  controlPlaneLoadNotice,
  defaultConnectorRef,
  lifecycleLabel,
  lifecycleTone,
  parseSkillDraft,
  secretProblem,
} from '../../src/control-plane-settings-model'

const version = {
  contentDigest: `sha256:${'c'.repeat(64)}`,
  createdAt: '2026-10-06T12:00:00.000Z',
  lifecycle: 'published',
  revision: 2,
  version: '1.0.0',
  versionId: 'skv_1',
} as const
const item: ApiCatalogItem = {
  createdAt: '2026-10-06T12:00:00.000Z',
  displayName: 'Release notes',
  id: 'skl_1',
  kind: 'skill',
  latestVersion: version,
  owner: 'workspace',
  readOnly: false,
}
const connection: ApiCloudConnection = {
  connectorRef: 'connector:github',
  createdAt: '2026-10-06T12:00:00.000Z',
  credentialId: 'crd_1',
  provider: 'github',
  revision: 1,
  status: 'active',
}

describe('skills presentation', () => {
  test('labels lifecycle and ownership, and offers retirement only for workspace items', () => {
    expect(lifecycleLabel(item)).toBe('Published')
    expect(lifecycleTone(item)).toBe('success')
    expect(catalogItemDetail(item)).toBe('This workspace · 1.0.0 · revision 2')
    expect(
      catalogItemDetail({ ...item, kind: 'profile', latestVersion: { ...version, version: '3' } })
    ).toBe('This workspace · v3 · revision 2 · skl_1 · skv_1')
    expect(lifecycleLabel({ ...item, latestVersion: undefined })).toBe('No versions')
    expect(lifecycleTone({ ...item, latestVersion: undefined })).toBe('outline')
    expect(catalogItemDetail({ ...item, latestVersion: undefined, owner: 'system' })).toBe(
      'System · No published version'
    )
    expect(canRetire(item, 'deprecate')).toBe(true)
    expect(canRetire(item, 'revoke')).toBe(true)
    expect(canRetire({ ...item, owner: 'system', readOnly: true }, 'revoke')).toBe(false)
    const deprecated = { ...item, latestVersion: { ...version, lifecycle: 'deprecated' as const } }
    expect(canRetire(deprecated, 'deprecate')).toBe(false)
    expect(canRetire(deprecated, 'revoke')).toBe(true)
    const revoked = { ...item, latestVersion: { ...version, lifecycle: 'revoked' as const } }
    expect(canRetire(revoked, 'revoke')).toBe(false)
    expect(lifecycleTone(revoked)).toBe('destructive')
  })

  test('shape-checks a pasted skill before it is sent', () => {
    const manifest = JSON.stringify({ semanticVersion: '1.0.0' })
    const content = JSON.stringify({ instructions: 'Summarize merged changes.' })
    expect(parseSkillDraft({ content, displayName: ' Notes ', manifest })).toEqual({
      ok: true,
      value: {
        content: { instructions: 'Summarize merged changes.' },
        displayName: 'Notes',
        manifest: { semanticVersion: '1.0.0' },
      },
    })
    expect(parseSkillDraft({ content, displayName: '', manifest }).ok).toBe(false)
    expect(parseSkillDraft({ content, displayName: 'x', manifest: '[]' }).ok).toBe(false)
    expect(parseSkillDraft({ content, displayName: 'x', manifest: '{}' }).ok).toBe(false)
    expect(parseSkillDraft({ content: '{', displayName: 'x', manifest }).ok).toBe(false)
    expect(
      parseSkillDraft({ content: '{"instructions":" "}', displayName: 'x', manifest }).ok
    ).toBe(false)
  })
})

describe('cloud connections presentation', () => {
  test('describes status and history without secret material', () => {
    expect(connectionStatusLabel(connection)).toBe('Active')
    expect(connectionStatusTone(connection)).toBe('success')
    expect(connectionDetail(connection)).toBe('connector:github · revision 1 · added 2026-10-06')
    expect(
      connectionDetail({
        ...connection,
        expiresAt: '2027-01-01T00:00:00.000Z',
        revision: 2,
        rotatedAt: '2026-10-07T00:00:00.000Z',
      })
    ).toBe('connector:github · revision 2 · rotated 2026-10-07 · expires 2027-01-01')
    expect(connectionStatusLabel({ ...connection, status: 'secret_required' })).toBe(
      'Secret required'
    )
    expect(canChangeConnection(connection)).toBe(true)
    expect(canChangeConnection({ ...connection, status: 'revoked' })).toBe(false)
  })

  test('validates a draft the way the vault will', () => {
    expect(defaultConnectorRef(' github ')).toBe('connector:github')
    const valid = { connectorRef: '', provider: 'github', secret: 'long-enough-secret' }
    expect(cloudConnectionDraftProblem(valid)).toBeNull()
    expect(cloudConnectionDraftProblem({ ...valid, provider: 'GitHub' })).toContain('lowercase')
    expect(cloudConnectionDraftProblem({ ...valid, connectorRef: '-bad' })).toContain(
      'connector reference'
    )
    expect(secretProblem('short')).toContain('at least 8')
    expect(secretProblem('line\nbreak-secret')).toContain('control characters')
    expect(secretProblem('x'.repeat(65_537))).toContain('too long')
  })

  test('maps failures to fixed text that never echoes the server', () => {
    const unavailable = { code: 'CONTROL_PLANE_UNAVAILABLE', status: 503 }
    expect(controlPlaneLoadNotice('Skills', unavailable)).toContain('unavailable')
    expect(controlPlaneLoadNotice('Skills', { status: 503 })).toContain('unavailable')
    expect(controlPlaneLoadNotice('Cloud connections', { code: 'NOT_FOUND', status: 404 })).toBe(
      'This Control Plane does not offer cloud connections yet.'
    )
    expect(controlPlaneLoadNotice('Skills', { status: 401 })).toBe('Sign in to see this.')
    expect(controlPlaneLoadNotice('Skills', new Error('boom'))).toBe(
      'Skills could not be loaded. Try again.'
    )
    expect(controlPlaneActionNotice('Revoking x', { code: 'CATALOG_ITEM_READ_ONLY' })).toContain(
      'read-only'
    )
    for (const code of [
      'CATALOG_CONTENT_INVALID',
      'CATALOG_CREDENTIAL_INPUT_REJECTED',
      'CATALOG_DISPLAY_NAME_CONFLICT',
      'CREDENTIAL_SECRET_INVALID',
      'CREDENTIAL_EXISTS',
    ])
      expect(controlPlaneActionNotice('Adding', { code })).not.toContain(code)
    expect(controlPlaneActionNotice('Adding', { status: 403 })).toContain('owners and admins')
    expect(controlPlaneActionNotice('Adding', { status: 409 })).toContain('conflicted')
    expect(controlPlaneActionNotice('Adding', { status: 422 })).toContain('rejected')
    expect(controlPlaneActionNotice('Adding', { status: 404 })).toContain('no longer exists')
    expect(controlPlaneActionNotice('Adding', { status: 503 })).toContain('unavailable')
    expect(controlPlaneActionNotice('Adding', null)).toBe('Adding failed. Try again.')
  })
})
