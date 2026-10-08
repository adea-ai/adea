import { ServiceCredentialClaimsSchema, type ServiceCredentialClaims } from '@adea-ai/contracts'

export type LeadProductServiceEnvironment = Readonly<{ PI_LEAD_PRODUCT_TRUST?: string }>
export type LeadProductServiceVerifier = (
  request: Request,
  workspaceId: string,
  principalId: string
) => Promise<boolean>
export type LeadProductServicePublicJwk = Readonly<{
  kty: 'OKP'
  crv: 'Ed25519'
  x: string
  alg?: 'EdDSA' | 'Ed25519'
  kid?: string
  use?: 'sig'
  key_ops?: readonly ['verify']
  ext?: boolean
}>

/** Operator-supplied public trust only; no credentials or grants are created here. */
export type LeadProductServiceTrust = Readonly<{
  issuer: string
  keyId: string
  publicJwk: LeadProductServicePublicJwk
  principalId: string
  workspaceIds: readonly string[]
  revokedCredentialIds: readonly string[]
}>

const audience = 'adea-lead-product'
const lifetimeMs = 300_000
const maxTokenLength = 8_192
const claimKeys = [
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
] as const

/** Fresh trust/revocation and time checks surround asynchronous verification. */
export function createLeadProductServiceVerifier(
  environment: LeadProductServiceEnvironment,
  now: () => number = Date.now
): LeadProductServiceVerifier {
  return async (request, workspaceId, principalId) => {
    try {
      const trust = readTrust(environment)
      if (!trust) return false
      const authorization = request.headers.get('authorization')
      if (!authorization || authorization.length > maxTokenLength + 7) return false
      const bearer = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(
        authorization
      )
      if (!bearer) return false
      const token = bearer[1]!
      if (token.length > maxTokenLength) return false
      const [encodedHeader, encodedClaims, encodedSignature] = token.split('.') as [
        string,
        string,
        string,
      ]
      const header = decodedJson(encodedHeader, 1_024)
      const rawClaims = decodedJson(encodedClaims, 6_144)
      const signature = decodeCanonical(encodedSignature, 86)
      if (
        !header ||
        !exactKeys(header, ['alg', 'typ', 'kid']) ||
        header.alg !== 'EdDSA' ||
        header.typ !== 'JWT' ||
        header.kid !== trust.keyId ||
        !rawClaims ||
        !exactKeys(rawClaims, claimKeys) ||
        !signature ||
        signature.byteLength !== 64
      )
        return false
      const parsed = ServiceCredentialClaimsSchema.safeParse(rawClaims)
      if (!parsed.success || !authorized(parsed.data, trust, workspaceId, principalId, now()))
        return false
      const key = await crypto.subtle.importKey(
        'jwk',
        { kty: 'OKP', crv: 'Ed25519', x: trust.publicJwk.x },
        'Ed25519',
        false,
        ['verify']
      )
      const valid = await crypto.subtle.verify(
        'Ed25519',
        key,
        signature,
        new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`)
      )
      if (!valid) return false
      const currentTrust = readTrust(environment)
      return Boolean(
        currentTrust &&
        currentTrust.publicJwk.x === trust.publicJwk.x &&
        authorized(parsed.data, currentTrust, workspaceId, principalId, now())
      )
    } catch {
      // Configuration, parsing and cryptographic failures are all denials.
      return false
    }
  }
}

function authorized(
  claims: ServiceCredentialClaims,
  trust: LeadProductServiceTrust,
  workspaceId: string,
  principalId: string,
  at: number
): boolean {
  const issued = Date.parse(claims.issuedAt)
  const expires = Date.parse(claims.expiresAt)
  return (
    Number.isSafeInteger(at) &&
    at >= 0 &&
    claims.audience === audience &&
    claims.credentialKind === 'service' &&
    claims.issuer === trust.issuer &&
    claims.keyId === trust.keyId &&
    claims.principalId === trust.principalId &&
    principalId === trust.principalId &&
    trust.workspaceIds.includes(workspaceId) &&
    claims.workspaceIds.length === 1 &&
    claims.workspaceIds[0] === workspaceId &&
    claims.projectIds.length === 0 &&
    claims.scopes.includes('execution:read') &&
    !trust.revokedCredentialIds.includes(claims.credentialId) &&
    Number.isFinite(issued) &&
    Number.isFinite(expires) &&
    issued <= at &&
    expires > at &&
    expires > issued &&
    expires - issued <= lifetimeMs
  )
}

function readTrust(environment: LeadProductServiceEnvironment): LeadProductServiceTrust | null {
  const source = environment.PI_LEAD_PRODUCT_TRUST
  if (typeof source !== 'string' || !source || source.length > 65_536) return null
  const trust = record(JSON.parse(source))
  if (
    !trust ||
    !exactKeys(trust, [
      'issuer',
      'keyId',
      'publicJwk',
      'principalId',
      'workspaceIds',
      'revokedCredentialIds',
    ])
  )
    return null
  const shape = ServiceCredentialClaimsSchema.shape
  if (
    !shape.issuer.safeParse(trust.issuer).success ||
    !shape.keyId.safeParse(trust.keyId).success ||
    !shape.principalId.safeParse(trust.principalId).success ||
    !shape.workspaceIds.safeParse(trust.workspaceIds).success ||
    !Array.isArray(trust.revokedCredentialIds) ||
    trust.revokedCredentialIds.length > 1_024 ||
    new Set(trust.revokedCredentialIds).size !== trust.revokedCredentialIds.length ||
    !trust.revokedCredentialIds.every((id) => shape.credentialId.safeParse(id).success)
  )
    return null
  const jwk = record(trust.publicJwk)
  const allowedJwkKeys = ['kty', 'crv', 'x', 'alg', 'kid', 'use', 'key_ops', 'ext']
  if (
    !jwk ||
    Object.keys(jwk).some((key) => !allowedJwkKeys.includes(key)) ||
    jwk.kty !== 'OKP' ||
    jwk.crv !== 'Ed25519' ||
    typeof jwk.x !== 'string' ||
    decodeCanonical(jwk.x, 43)?.byteLength !== 32 ||
    // WebCrypto exports use Ed25519; JOSE public JWKs also use EdDSA.
    (jwk.alg !== undefined && jwk.alg !== 'EdDSA' && jwk.alg !== 'Ed25519') ||
    (jwk.kid !== undefined && jwk.kid !== trust.keyId) ||
    (jwk.use !== undefined && jwk.use !== 'sig') ||
    (jwk.ext !== undefined && typeof jwk.ext !== 'boolean') ||
    (jwk.key_ops !== undefined &&
      (!Array.isArray(jwk.key_ops) || jwk.key_ops.length !== 1 || jwk.key_ops[0] !== 'verify'))
  )
    return null
  return {
    issuer: trust.issuer as string,
    keyId: trust.keyId as string,
    publicJwk: { ...jwk } as LeadProductServicePublicJwk,
    principalId: trust.principalId as string,
    workspaceIds: [...(trust.workspaceIds as string[])],
    revokedCredentialIds: [...(trust.revokedCredentialIds as string[])],
  }
}

function decodedJson(value: string, maxLength: number): Record<string, unknown> | null {
  const bytes = decodeCanonical(value, maxLength)
  if (!bytes) return null
  return record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
}

function decodeCanonical(value: string, maxLength: number): Uint8Array<ArrayBuffer> | null {
  if (!value || value.length > maxLength || !/^[A-Za-z0-9_-]+$/.test(value)) return null
  const decoded = Buffer.from(value, 'base64url')
  return decoded.toString('base64url') === value ? new Uint8Array(decoded) : null
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}
