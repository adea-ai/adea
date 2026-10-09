import { expect, test } from 'bun:test'

import { createLeadManagementServiceVerifier } from '../src/server/lead-management-service-auth'

const workspaceId = '0f3a2e1c-0000-4000-8000-000000000001'
const otherWorkspaceId = '0f3a2e1c-0000-4000-8000-0000000000aa'
const projectId = '0f3a2e1c-0000-4000-8000-000000000002'
const actorUserId = '0f3a2e1c-0000-4000-8000-0000000000bb'
const principalId = 'svc_pi-lead-management'
const at = Date.parse('2026-10-09T12:00:00.000Z')
const issuer = 'https://cp-fixture.invalid'
const keyId = 'synthetic-management-fixture-key'
const digest = `sha256:${'a'.repeat(64)}`

function base64url(value: string | Uint8Array) {
  return Buffer.from(value).toString('base64url')
}

function request(token: string) {
  return new Request('https://adea-fixture.invalid/internal/lead-management', {
    headers: { Authorization: `Bearer ${token}` },
  })
}

async function fixture() {
  // Generated in-memory test keys only; no operator configuration is changed.
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const trust = {
    issuer,
    keyId,
    principalId,
    publicJwk,
    revokedCredentialIds: [] as string[],
    workspaceIds: [workspaceId],
  }
  const claims = {
    actorUserId,
    audience: 'adea-lead-management',
    authorityRevision: 7,
    credentialId: 'synthetic-management-credential',
    credentialKind: 'service',
    decision: 'allowed',
    decisionId: 'decision-1',
    expiresAt: new Date(at + 60_000).toISOString(),
    inputDigest: digest,
    intentId: 'intent-1',
    issuedAt: new Date(at).toISOString(),
    issuer,
    keyId,
    leadAgentId: 'agent-lead-1',
    operation: 'project.update',
    principalId,
    projectIds: [] as string[],
    scopes: ['management:execute'],
    targetId: projectId,
    workspaceIds: [workspaceId],
  }
  const environment: { PI_LEAD_MANAGEMENT_TRUST?: string } = {
    PI_LEAD_MANAGEMENT_TRUST: JSON.stringify(trust),
  }
  const verify = createLeadManagementServiceVerifier(environment, () => at)
  async function signed(
    payload: unknown = claims,
    header: unknown = { alg: 'EdDSA', kid: keyId, typ: 'JWT' }
  ) {
    const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
    const signature = await crypto.subtle.sign(
      'Ed25519',
      pair.privateKey,
      new TextEncoder().encode(input)
    )
    return `${input}.${base64url(new Uint8Array(signature))}`
  }
  return { claims, environment, pair, signed, trust, verify }
}

test('accepts a signed exact-call decision and returns the immutable binding', async () => {
  const f = await fixture()
  const decision = await f.verify(request(await f.signed()))
  expect(decision).toEqual({
    authorityRef: f.claims.credentialId,
    authorityRevision: 7,
    binding: {
      inputDigest: digest,
      operation: 'project.update',
      targetId: projectId,
      workspaceId,
    },
    decision: 'allowed',
    decisionId: 'decision-1',
    expiresAt: f.claims.expiresAt,
    intentId: 'intent-1',
    issuedAt: f.claims.issuedAt,
    leadAgentId: 'agent-lead-1',
    principal: { kind: 'user', userId: actorUserId },
    schemaVersion: 'adea-management-authority/v1',
  })
})

test('absent, malformed or private trust configuration fails closed', async () => {
  const f = await fixture()
  const token = await f.signed()
  const privateJwk = await crypto.subtle.exportKey('jwk', f.pair.privateKey)
  for (const source of [
    undefined,
    '',
    '{}',
    '{invalid',
    JSON.stringify({ ...f.trust, publicJwk: privateJwk }),
    JSON.stringify({ ...f.trust, workspaceIds: [] }),
    JSON.stringify({ ...f.trust, workspaceIds: undefined }),
    JSON.stringify({ ...f.trust, revokedCredentialIds: undefined }),
    JSON.stringify({ ...f.trust, extra: 'ignored-secret' }),
  ]) {
    const verifier = createLeadManagementServiceVerifier(
      { PI_LEAD_MANAGEMENT_TRUST: source },
      () => at
    )
    expect(await verifier(request(token))).toBeNull()
  }
})

test('revocation, key rotation, workspace change and trust removal apply on the next call', async () => {
  const f = await fixture()
  const token = await f.signed()
  expect(await f.verify(request(token))).not.toBeNull()
  for (const changed of [
    { ...f.trust, revokedCredentialIds: [f.claims.credentialId] },
    { ...f.trust, keyId: 'rotated-key' },
    { ...f.trust, workspaceIds: [otherWorkspaceId] },
    { ...f.trust, issuer: 'https://other-issuer.invalid' },
    { ...f.trust, principalId: 'svc_other' },
  ]) {
    f.environment.PI_LEAD_MANAGEMENT_TRUST = JSON.stringify(changed)
    expect(await f.verify(request(token))).toBeNull()
  }
  f.environment.PI_LEAD_MANAGEMENT_TRUST = ''
  expect(await f.verify(request(token))).toBeNull()
})

test('signature forgery and tampered claims are denied', async () => {
  const f = await fixture()
  const token = await f.signed()
  const segments = token.split('.')
  segments[1] = base64url(JSON.stringify({ ...f.claims, operation: 'project.delete' }))
  expect(await f.verify(request(segments.join('.')))).toBeNull()
  const replacement = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  f.environment.PI_LEAD_MANAGEMENT_TRUST = JSON.stringify({
    ...f.trust,
    publicJwk: await crypto.subtle.exportKey('jwk', replacement.publicKey),
  })
  expect(await f.verify(request(token))).toBeNull()
})

test('wrong kind, audience, scope, principal or extra project scope cannot authorize', async () => {
  const f = await fixture()
  for (const change of [
    { credentialKind: 'browser_session' },
    { credentialKind: 'provider' },
    { credentialKind: 'runtime_device' },
    { audience: 'adea-lead-product' },
    { audience: 'control-plane' },
    { principalId: 'svc_other' },
    { projectIds: [projectId] },
    { scopes: ['execution:read'] },
    { scopes: ['management:execute', 'execution:read'] },
    { workspaceIds: [otherWorkspaceId] },
    { workspaceIds: [workspaceId, otherWorkspaceId] },
    { decision: 'denied' },
  ])
    expect(await f.verify(request(await f.signed({ ...f.claims, ...change })))).toBeNull()
})

test('expired, future, overlong or reversed lifetimes are denied', async () => {
  const f = await fixture()
  for (const change of [
    { expiresAt: new Date(at - 1).toISOString() },
    { issuedAt: new Date(at + 1_000).toISOString() },
    { expiresAt: new Date(at + 300_001).toISOString() },
    { expiresAt: new Date(at).toISOString() },
    { issuedAt: 'not-a-time' },
    { expiresAt: 'not-a-time' },
  ])
    expect(await f.verify(request(await f.signed({ ...f.claims, ...change })))).toBeNull()
})

test('malformed binding and identity claims are denied', async () => {
  const f = await fixture()
  for (const change of [
    { operation: 'project.unknown' },
    { operation: 7 },
    { targetId: 7 },
    { inputDigest: 'sha256:abc' },
    { inputDigest: `sha256:${'A'.repeat(64)}` },
    { authorityRevision: 0 },
    { authorityRevision: 1.5 },
    { actorUserId: 'not-a-uuid' },
    { actorUserId: 'user-1' },
    { decisionId: '' },
    { leadAgentId: '' },
    { intentId: '' },
    { credentialId: '' },
    { unexpected: true },
  ])
    expect(await f.verify(request(await f.signed({ ...f.claims, ...change })))).toBeNull()
})

test('a bearer token with the wrong shape is denied before cryptography', async () => {
  const f = await fixture()
  for (const token of ['', 'not-a-token', 'a.b', 'a.b.c.d', `Bearer ${await f.signed()}`])
    expect(await f.verify(request(token))).toBeNull()
})
