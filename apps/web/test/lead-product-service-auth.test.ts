import { expect, test } from 'bun:test'
import { ServiceCredentialClaimsSchema } from '@adea-ai/contracts'
import { createLeadProductServiceVerifier } from '../src/server/lead-product-service-auth'

const workspaceId = `wsp_${'0'.repeat(26)}`
const otherWorkspaceId = `wsp_${'1'.repeat(26)}`
const principalId = 'svc_pi-lead-product'
const at = Date.parse('2026-10-08T12:00:00.000Z')
const issuer = 'https://cp-fixture.invalid'
const keyId = 'synthetic-fixture-key'
const audience = 'adea-lead-product'

function base64url(value: string | Uint8Array) {
  return Buffer.from(value).toString('base64url')
}

function request(token: string) {
  return new Request('https://adea-fixture.invalid/internal/lead-product', {
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
    publicJwk,
    principalId,
    workspaceIds: [workspaceId],
    revokedCredentialIds: [] as string[],
  }
  const claims = ServiceCredentialClaimsSchema.parse({
    audience,
    credentialId: 'synthetic-fixture-credential',
    credentialKind: 'service',
    expiresAt: new Date(at + 300_000).toISOString(),
    issuedAt: new Date(at).toISOString(),
    issuer,
    keyId,
    principalId,
    projectIds: [],
    scopes: ['execution:read'],
    workspaceIds: [workspaceId],
  })
  const environment = { PI_LEAD_PRODUCT_TRUST: JSON.stringify(trust) }
  const verify = createLeadProductServiceVerifier(environment, () => at)
  async function signed(
    payload: unknown = claims,
    header: unknown = { alg: 'EdDSA', typ: 'JWT', kid: keyId }
  ) {
    const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
    const signature = await crypto.subtle.sign(
      'Ed25519',
      pair.privateKey,
      new TextEncoder().encode(input)
    )
    return `${input}.${base64url(new Uint8Array(signature))}`
  }
  return { pair, trust, claims, environment, verify, signed, request }
}

test('accepts a cryptographically signed exact-workspace service credential using the actual CP claim grammar', async () => {
  const f = await fixture()
  expect(await f.verify(f.request(await f.signed()), workspaceId, principalId)).toBe(true)
})

test('absent, invalid or private trust configuration fails closed', async () => {
  const f = await fixture()
  const token = await f.signed()
  const privateJwk = await crypto.subtle.exportKey('jwk', f.pair.privateKey)
  for (const source of [
    undefined,
    '',
    '{}',
    '{invalid',
    JSON.stringify({ ...f.trust, publicJwk: privateJwk }),
    JSON.stringify({ ...f.trust, workspaceIds: undefined }),
    JSON.stringify({ ...f.trust, revokedCredentialIds: undefined }),
    JSON.stringify({ ...f.trust, extra: 'ignored-secret' }),
  ]) {
    const verifier = createLeadProductServiceVerifier({ PI_LEAD_PRODUCT_TRUST: source }, () => at)
    expect(await verifier(f.request(token), workspaceId, principalId)).toBe(false)
  }
})

test('revocation, key rotation, trust removal and workspace access changes apply to the same verifier on the next call', async () => {
  const f = await fixture()
  const token = await f.signed()
  expect(await f.verify(f.request(token), workspaceId, principalId)).toBe(true)
  for (const changed of [
    { ...f.trust, revokedCredentialIds: [f.claims.credentialId] },
    { ...f.trust, keyId: 'rotated-key' },
    { ...f.trust, workspaceIds: [otherWorkspaceId] },
    { ...f.trust, issuer: 'https://other-issuer.invalid' },
  ]) {
    f.environment.PI_LEAD_PRODUCT_TRUST = JSON.stringify(changed)
    expect(await f.verify(f.request(token), workspaceId, principalId)).toBe(false)
  }
  f.environment.PI_LEAD_PRODUCT_TRUST = ''
  expect(await f.verify(f.request(token), workspaceId, principalId)).toBe(false)
})

test('signature forgery and a same-kid replacement public key are denied', async () => {
  const f = await fixture()
  const token = await f.signed()
  const segments = token.split('.')
  segments[1] = base64url(JSON.stringify({ ...f.claims, credentialId: 'forged' }))
  expect(await f.verify(f.request(segments.join('.')), workspaceId, principalId)).toBe(false)
  const replacement = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  f.environment.PI_LEAD_PRODUCT_TRUST = JSON.stringify({
    ...f.trust,
    publicJwk: await crypto.subtle.exportKey('jwk', replacement.publicKey),
  })
  expect(await f.verify(f.request(token), workspaceId, principalId)).toBe(false)
})

test('user/browser/provider credentials and wrong audience, issuer, principal or workspace cannot read the product', async () => {
  const f = await fixture()
  for (const change of [
    { credentialKind: 'browser_session' },
    { credentialKind: 'provider' },
    { credentialKind: 'runtime_device' },
    { principalId: 'user:fixture' },
    { principalId: 'svc_other' },
    { audience: 'control-plane' },
    { issuer: 'https://other.invalid' },
    { workspaceIds: [otherWorkspaceId] },
    { workspaceIds: [workspaceId, otherWorkspaceId] },
    { projectIds: [`prj_${'0'.repeat(26)}`] },
    { scopes: ['execution:cancel'] },
  ])
    expect(
      await f.verify(
        f.request(await f.signed({ ...f.claims, ...change })),
        workspaceId,
        principalId
      )
    ).toBe(false)
  expect(await f.verify(f.request(await f.signed()), workspaceId, 'svc_other')).toBe(false)
  expect(await f.verify(f.request(await f.signed()), otherWorkspaceId, principalId)).toBe(false)
})

test('expiry and issuance windows are exact and the maximum lifetime is five minutes', async () => {
  const f = await fixture()
  for (const change of [
    { issuedAt: new Date(at + 1).toISOString() },
    { expiresAt: new Date(at).toISOString() },
    { expiresAt: new Date(at + 300_001).toISOString() },
    { issuedAt: new Date(at - 300_000).toISOString(), expiresAt: new Date(at + 1).toISOString() },
    { issuedAt: 'invalid' },
  ])
    expect(
      await f.verify(
        f.request(await f.signed({ ...f.claims, ...change })),
        workspaceId,
        principalId
      )
    ).toBe(false)
  const expired = createLeadProductServiceVerifier(f.environment, () => at + 300_000)
  expect(await expired(f.request(await f.signed()), workspaceId, principalId)).toBe(false)
  const invalidClock = createLeadProductServiceVerifier(f.environment, () => Number.NaN)
  expect(await invalidClock(f.request(await f.signed()), workspaceId, principalId)).toBe(false)
})

test('JWT header is exactly EdDSA JWT with a matching kid and no key or URL overrides', async () => {
  const f = await fixture()
  for (const header of [
    { alg: 'HS256', typ: 'JWT', kid: keyId },
    { alg: 'EdDSA', typ: 'jwt', kid: keyId },
    { alg: 'EdDSA', typ: 'JWT', kid: 'other' },
    { alg: 'EdDSA', typ: 'JWT', kid: keyId, jku: 'https://attacker.invalid/keys' },
    { alg: 'EdDSA', typ: 'JWT', kid: keyId, jwk: f.trust.publicJwk },
    { alg: 'EdDSA', typ: 'JWT', kid: keyId, x5u: 'https://attacker.invalid/cert' },
    { alg: 'EdDSA', typ: 'JWT', kid: keyId, crit: ['b64'], b64: false },
  ])
    expect(
      await f.verify(f.request(await f.signed(f.claims, header)), workspaceId, principalId)
    ).toBe(false)
})

test('noncanonical base64url, padded tokens, extra segments and oversize credentials are denied', async () => {
  const f = await fixture()
  const token = await f.signed()
  const [header, payload, signature] = token.split('.') as [string, string, string]
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const alternateSignature =
    signature.slice(0, -1) + alphabet[alphabet.indexOf(signature.at(-1)!) + 1]
  expect(Buffer.from(alternateSignature, 'base64url')).toEqual(Buffer.from(signature, 'base64url'))
  for (const malformed of [
    `${header}.${payload}.${alternateSignature}`,
    `${header}.${payload}.${signature}=`,
    `${token}.extra`,
    `${header}.${payload}`,
    `${header}..${signature}`,
    'a'.repeat(16_384),
  ])
    expect(await f.verify(f.request(malformed), workspaceId, principalId)).toBe(false)
})

test('missing or browser authorization has no static bearer or cookie fallback', async () => {
  const f = await fixture()
  for (const candidateRequest of [
    new Request('https://fixture.invalid'),
    new Request('https://fixture.invalid', {
      headers: { Cookie: 'session=synthetic-browser-session' },
    }),
    new Request('https://fixture.invalid', {
      headers: { Authorization: 'Bearer synthetic-static-token' },
    }),
    new Request('https://fixture.invalid', {
      headers: { Authorization: `Basic ${await f.signed()}` },
    }),
  ])
    expect(await f.verify(candidateRequest, workspaceId, principalId)).toBe(false)
})

test('unknown claim fields and malformed claim arrays are not silently stripped by the CP schema', async () => {
  const f = await fixture()
  for (const change of [
    { credentialRef: 'secret-reference' },
    { workspaceIds: [workspaceId, workspaceId] },
    { scopes: ['execution:read', 'execution:read'] },
    { projectIds: undefined },
    { expiresAt: undefined },
  ])
    expect(
      await f.verify(
        f.request(await f.signed({ ...f.claims, ...change })),
        workspaceId,
        principalId
      )
    ).toBe(false)
})

test('revocation and expiry are rechecked after asynchronous signature verification', async () => {
  const f = await fixture()
  let reads = 0
  const changingEnvironment = {
    get PI_LEAD_PRODUCT_TRUST() {
      reads++
      return JSON.stringify(
        reads === 1 ? f.trust : { ...f.trust, revokedCredentialIds: [f.claims.credentialId] }
      )
    },
  }
  expect(
    await createLeadProductServiceVerifier(changingEnvironment, () => at)(
      f.request(await f.signed()),
      workspaceId,
      principalId
    )
  ).toBe(false)
  let clockReads = 0
  const movingClock = () => (++clockReads === 1 ? at : at + 300_000)
  expect(
    await createLeadProductServiceVerifier(f.environment, movingClock)(
      f.request(await f.signed()),
      workspaceId,
      principalId
    )
  ).toBe(false)
})

test('strict trust arrays and public JWK grammar reject broader or malformed configuration', async () => {
  const f = await fixture()
  const token = await f.signed()
  const x = f.trust.publicJwk.x!
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const noncanonicalX = x.slice(0, -1) + alphabet[alphabet.indexOf(x.at(-1)!) + 1]
  expect(Buffer.from(noncanonicalX, 'base64url')).toEqual(Buffer.from(x, 'base64url'))
  const malformedKeys = [
    { ...f.trust.publicJwk, x: noncanonicalX },
    { ...f.trust.publicJwk, x: `${x}=` },
    { ...f.trust.publicJwk, alg: 'RS256' },
    { ...f.trust.publicJwk, crv: 'X25519' },
    { ...f.trust.publicJwk, kid: 'other' },
    { ...f.trust.publicJwk, use: 'enc' },
    { ...f.trust.publicJwk, key_ops: ['sign', 'verify'] },
    { ...f.trust.publicJwk, ext: 'true' },
    { ...f.trust.publicJwk, jku: 'https://attacker.invalid/keys' },
  ]
  for (const publicJwk of malformedKeys) {
    f.environment.PI_LEAD_PRODUCT_TRUST = JSON.stringify({ ...f.trust, publicJwk })
    expect(await f.verify(f.request(token), workspaceId, principalId)).toBe(false)
  }
  for (const change of [
    { workspaceIds: [] },
    { workspaceIds: [workspaceId, workspaceId] },
    { workspaceIds: ['invalid'] },
    { revokedCredentialIds: [1] },
    { revokedCredentialIds: ['same', 'same'] },
    { principalId: 'user:fixture' },
    { issuer: 'not-a-url' },
  ]) {
    f.environment.PI_LEAD_PRODUCT_TRUST = JSON.stringify({ ...f.trust, ...change })
    expect(await f.verify(f.request(token), workspaceId, principalId)).toBe(false)
  }
})

test('both standard public JWK algorithm labels verify only an EdDSA JWT', async () => {
  const f = await fixture()
  const token = await f.signed()
  for (const publicJwk of [
    { kty: 'OKP', crv: 'Ed25519', x: f.trust.publicJwk.x },
    { ...f.trust.publicJwk, alg: 'EdDSA' },
    { ...f.trust.publicJwk, alg: 'Ed25519' },
  ]) {
    f.environment.PI_LEAD_PRODUCT_TRUST = JSON.stringify({ ...f.trust, publicJwk })
    expect(await f.verify(f.request(token), workspaceId, principalId)).toBe(true)
  }
})
