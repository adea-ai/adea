import { describe, expect, test } from 'bun:test'
import { createPublicKey, verify as nodeVerify } from 'node:crypto'

import {
  ControlPlaneCredentialError,
  MAX_CREDENTIAL_LIFETIME_SECONDS,
  controlPlaneCredential,
  controlPlaneCredentialMode,
  mintControlPlaneServiceJwt,
} from '../src/server/control-plane-credential'

const WORKSPACE = 'wsp_01JABCDEF0123456789ABCDEFG'
const PROJECT = 'prj_01JABCDEF0123456789ABCDEFH'
const ISSUER = 'https://adea.example/control-plane'
const KEY_ID = 'adea-web-2026-10-signer'
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0, 0)

type KeyPair = Readonly<{ pem: string; jwk: string; publicKey: CryptoKey; publicX: string }>

async function keyPair(): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  const base64 = Buffer.from(pkcs8).toString('base64')
  const pem = `-----BEGIN PRIVATE KEY-----\n${base64.match(/.{1,64}/gu)!.join('\n')}\n-----END PRIVATE KEY-----\n`
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  return { jwk: JSON.stringify(jwk), pem, publicKey: pair.publicKey, publicX: publicJwk.x! }
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>
}

/** Verifies exactly as the Control Plane does: canonical base64url, EdDSA, kid. */
async function verify(token: string, publicKey: CryptoKey) {
  const [header, payload, signature] = token.split('.')
  for (const segment of [header, payload, signature])
    expect(Buffer.from(segment!, 'base64url').toString('base64url')).toBe(segment!)
  const valid = await crypto.subtle.verify(
    { name: 'Ed25519' },
    publicKey,
    Buffer.from(signature!, 'base64url'),
    new TextEncoder().encode(`${header}.${payload}`)
  )
  return { claims: decodeSegment(payload!), header: decodeSegment(header!), valid }
}

function signingEnvironment(key: string, overrides: Record<string, string | undefined> = {}) {
  return {
    CONTROL_PLANE_SIGNING_ISSUER: ISSUER,
    CONTROL_PLANE_SIGNING_KEY: key,
    CONTROL_PLANE_SIGNING_KEY_ID: KEY_ID,
    ...overrides,
  }
}

describe('Control Plane service JWT', () => {
  test('signs exactly the claims the Control Plane accepts', async () => {
    const keys = await keyPair()
    const credential = await controlPlaneCredential(
      {
        resolveScope: async () => ({ projectId: PROJECT, workspaceId: WORKSPACE }),
        scopes: ['marketplace:read'],
      },
      signingEnvironment(keys.pem),
      NOW
    )
    expect(credential).toMatchObject({ projectId: PROJECT, workspaceId: WORKSPACE })

    const { claims, header, valid } = await verify(credential.token, keys.publicKey)
    expect(valid).toBeTrue()
    expect(header).toEqual({ alg: 'EdDSA', kid: KEY_ID, typ: 'JWT' })
    expect(Object.keys(claims).toSorted()).toEqual([
      'audience',
      'credentialId',
      'credentialKind',
      'expiresAt',
      'issuedAt',
      'issuer',
      'keyId',
      'principalId',
      'projectIds',
      'scopes',
      'workspaceIds',
    ])
    expect(claims).toMatchObject({
      audience: 'control-plane',
      credentialKind: 'service',
      issuedAt: new Date(NOW).toISOString(),
      issuer: ISSUER,
      keyId: KEY_ID,
      principalId: 'svc_agent-hq',
      projectIds: [PROJECT],
      scopes: ['marketplace:read'],
      workspaceIds: [WORKSPACE],
    })
    expect(claims.keyId).toBe(header.kid)
    expect(String(claims.credentialId)).toMatch(/^adea-web:[0-9a-f-]{36}$/u)
    const lifetime = Date.parse(String(claims.expiresAt)) - Date.parse(String(claims.issuedAt))
    expect(lifetime).toBeGreaterThan(0)
    expect(lifetime).toBeLessThanOrEqual(MAX_CREDENTIAL_LIFETIME_SECONDS * 1000)
  })

  test('verifies with the Control Plane trusted-key form (raw base64url x)', async () => {
    // The Control Plane builds the verifier from {kty: OKP, crv: Ed25519, x}
    // with node:crypto; the runbook publishes exactly this `x`.
    const keys = await keyPair()
    expect(keys.publicX).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    const credential = await controlPlaneCredential(
      { resolveScope: async () => ({ workspaceId: WORKSPACE }), scopes: ['system:authenticate'] },
      signingEnvironment(keys.pem),
      NOW
    )
    const [header, payload, signature] = credential.token.split('.')
    const trusted = createPublicKey({
      format: 'jwk',
      key: { crv: 'Ed25519', kty: 'OKP', x: keys.publicX },
    })
    expect(
      nodeVerify(
        null,
        Buffer.from(`${header}.${payload}`),
        trusted,
        Buffer.from(signature!, 'base64url')
      )
    ).toBeTrue()
  })

  test('accepts a private JWK and omits projects for workspace routes', async () => {
    const keys = await keyPair()
    const credential = await controlPlaneCredential(
      { resolveScope: async () => ({ workspaceId: WORKSPACE }), scopes: ['marketplace:install'] },
      signingEnvironment(keys.jwk),
      NOW
    )
    const { claims, valid } = await verify(credential.token, keys.publicKey)
    expect(valid).toBeTrue()
    expect(claims.projectIds).toEqual([])
    expect(claims.workspaceIds).toEqual([WORKSPACE])
    expect(claims.scopes).toEqual(['marketplace:install'])
  })

  test('accepts a PEM with escaped newlines from a dashboard paste', async () => {
    const keys = await keyPair()
    const credential = await controlPlaneCredential(
      { resolveScope: async () => ({ workspaceId: WORKSPACE }), scopes: ['marketplace:read'] },
      signingEnvironment(keys.pem.replaceAll('\n', '\\n')),
      NOW
    )
    expect((await verify(credential.token, keys.publicKey)).valid).toBeTrue()
  })

  test('mints a unique credential id per request', async () => {
    const keys = await keyPair()
    const ids = new Set<unknown>()
    for (let index = 0; index < 5; index += 1) {
      const credential = await controlPlaneCredential(
        { resolveScope: async () => ({ workspaceId: WORKSPACE }), scopes: ['marketplace:read'] },
        signingEnvironment(keys.pem),
        NOW
      )
      ids.add((await verify(credential.token, keys.publicKey)).claims.credentialId)
    }
    expect(ids.size).toBe(5)
  })

  test('refuses lifetimes above five minutes and malformed scopes', async () => {
    const privateKey = (
      (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
        'sign',
        'verify',
      ])) as CryptoKeyPair
    ).privateKey
    const base = { issuer: ISSUER, keyId: KEY_ID, privateKey, workspaceIds: [WORKSPACE] }
    await expect(
      mintControlPlaneServiceJwt({
        ...base,
        lifetimeSeconds: MAX_CREDENTIAL_LIFETIME_SECONDS + 1,
        scopes: ['marketplace:read'],
      })
    ).rejects.toBeInstanceOf(ControlPlaneCredentialError)
    await expect(mintControlPlaneServiceJwt({ ...base, scopes: [] })).rejects.toBeInstanceOf(
      ControlPlaneCredentialError
    )
    await expect(
      mintControlPlaneServiceJwt({ ...base, scopes: ['Marketplace:Read'] })
    ).rejects.toBeInstanceOf(ControlPlaneCredentialError)
    await expect(
      mintControlPlaneServiceJwt({
        ...base,
        scopes: ['marketplace:read'],
        workspaceIds: ['workspace-1'],
      })
    ).rejects.toBeInstanceOf(ControlPlaneCredentialError)
  })

  test('fails closed when signing is configured but incomplete or unmapped', async () => {
    const keys = await keyPair()
    const scope = {
      resolveScope: async () => ({ workspaceId: WORKSPACE }),
      scopes: ['marketplace:read'] as const,
    }
    for (const overrides of [
      { CONTROL_PLANE_SIGNING_KEY_ID: undefined },
      { CONTROL_PLANE_SIGNING_KEY_ID: 'has spaces' },
      { CONTROL_PLANE_SIGNING_ISSUER: undefined },
      { CONTROL_PLANE_SIGNING_ISSUER: 'not a url' },
      { CONTROL_PLANE_SIGNING_ISSUER: 'http://issuer.example', NODE_ENV: 'production' },
      { CONTROL_PLANE_SIGNING_KEY: 'not a key' },
    ]) {
      const failure = await controlPlaneCredential(
        scope,
        signingEnvironment(keys.pem, overrides),
        NOW
      ).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(ControlPlaneCredentialError)
      expect((failure as ControlPlaneCredentialError).reason).toBe('misconfigured')
    }
    for (const resolveScope of [
      undefined,
      async () => null,
      async () => ({ workspaceId: 'workspace-1' }),
      async () => ({ projectId: 'project-1', workspaceId: WORKSPACE }),
    ]) {
      const failure = await controlPlaneCredential(
        { resolveScope, scopes: ['marketplace:read'] },
        signingEnvironment(keys.pem),
        NOW
      ).catch((error: unknown) => error)
      expect((failure as ControlPlaneCredentialError).reason).toBe('unmapped')
    }
  })
})

describe('without a signing key', () => {
  test('fails closed and never resolves a scope, whatever else is configured', async () => {
    let resolved = false
    for (const environment of [
      {},
      { CONTROL_PLANE_SIGNING_KEY: '   ' },
      { CONTROL_PLANE_SIGNING_ISSUER: ISSUER, CONTROL_PLANE_SIGNING_KEY_ID: KEY_ID },
      // A leftover static token from the retired fallback is ignored.
      { CONTROL_PLANE_SCOPE_WORKSPACE_ID: WORKSPACE, CONTROL_PLANE_SERVICE_TOKEN: 'static-token' },
    ]) {
      const failure = await controlPlaneCredential(
        {
          resolveScope: async () => {
            resolved = true
            return { workspaceId: WORKSPACE }
          },
          scopes: ['marketplace:read'],
        },
        environment
      ).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(ControlPlaneCredentialError)
      expect((failure as ControlPlaneCredentialError).reason).toBe('unconfigured')
      expect(controlPlaneCredentialMode(environment)).toBe('unconfigured')
    }
    expect(resolved).toBeFalse()
    expect(controlPlaneCredentialMode({ CONTROL_PLANE_SIGNING_KEY: 'x' })).toBe('scoped')
  })
})
