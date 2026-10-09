/**
 * Private CP-to-Adea lead management authority verifier (M14.03.1,
 * adea-ai/adea#1215; CP932 coordination contract).
 *
 * The Control Plane signs one immutable, short-lived decision bound to the
 * exact operation, workspace, target and input digest. This module verifies
 * the Ed25519 signature, the operator trust, the audience/scope, the exact
 * workspace and the claim grammar, then returns the parsed decision for the
 * adapter to revalidate against the call it is about to execute.
 *
 * It creates no grants, credentials or keys: trust arrives only from
 * `PI_LEAD_MANAGEMENT_TRUST`, and every failure is a denial.
 *
 * No `server-only` marker: Bun-run unit tests import this module directly.
 */
import {
  managementAuthoritySchemaVersion,
  parseManagementAuthorityDecision,
  type ManagementAuthorityDecision,
  type ManagementOperationId,
} from '@adea-ai/types/management'

const audience = 'adea-lead-management'
const scope = 'management:execute'
const lifetimeMs = 300_000
const maxTokenLength = 8_192

const claimKeys = [
  'actorUserId',
  'audience',
  'authorityRevision',
  'credentialId',
  'credentialKind',
  'decision',
  'decisionId',
  'expiresAt',
  'inputDigest',
  'intentId',
  'issuedAt',
  'issuer',
  'keyId',
  'leadAgentId',
  'operation',
  'principalId',
  'projectIds',
  'scopes',
  'targetId',
  'workspaceIds',
] as const

export type LeadManagementTrust = Readonly<{
  issuer: string
  keyId: string
  publicJwk: Readonly<{
    kty: 'OKP'
    crv: 'Ed25519'
    x: string
    alg?: 'EdDSA' | 'Ed25519'
    kid?: string
    use?: 'sig'
    key_ops?: readonly ['verify']
    ext?: boolean
  }>
  principalId: string
  workspaceIds: readonly string[]
  revokedCredentialIds: readonly string[]
}>

export type LeadManagementServiceEnvironment = Readonly<{ PI_LEAD_MANAGEMENT_TRUST?: string }>
export type LeadManagementServiceVerifier = (
  request: Request
) => Promise<ManagementAuthorityDecision | null>

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Fresh trust/revocation and time checks surround asynchronous verification. */
export function createLeadManagementServiceVerifier(
  environment: LeadManagementServiceEnvironment,
  now: () => number = Date.now
): LeadManagementServiceVerifier {
  return async (request) => {
    try {
      const trust = readTrust(environment)
      if (!trust) return null
      const authorization = request.headers.get('authorization')
      if (!authorization || authorization.length > maxTokenLength + 7) return null
      const bearer = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(
        authorization
      )
      if (!bearer) return null
      const token = bearer[1]!
      if (token.length > maxTokenLength) return null
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
        return null
      const decision = decisionFromClaims(rawClaims, trust, now())
      if (!decision) return null
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
      if (!valid) return null
      const currentTrust = readTrust(environment)
      return currentTrust &&
        currentTrust.publicJwk.x === trust.publicJwk.x &&
        decisionFromClaims(rawClaims, currentTrust, now())
        ? decision
        : null
    } catch {
      // Configuration, parsing and cryptographic failures are all denials.
      return null
    }
  }
}

function decisionFromClaims(
  claims: Record<string, unknown>,
  trust: LeadManagementTrust,
  at: number
): ManagementAuthorityDecision | null {
  if (
    claims.audience !== audience ||
    claims.credentialKind !== 'service' ||
    claims.issuer !== trust.issuer ||
    claims.keyId !== trust.keyId ||
    claims.principalId !== trust.principalId ||
    !trust.revokedCredentialIds.every((id) => id !== claims.credentialId) ||
    claims.decision !== 'allowed'
  )
    return null
  if (
    typeof claims.scopes !== 'object' ||
    !Array.isArray(claims.scopes) ||
    claims.scopes.length !== 1 ||
    claims.scopes[0] !== scope ||
    !Array.isArray(claims.projectIds) ||
    claims.projectIds.length !== 0 ||
    !Array.isArray(claims.workspaceIds) ||
    claims.workspaceIds.length !== 1
  )
    return null
  const workspaceId = claims.workspaceIds[0]
  if (
    typeof workspaceId !== 'string' ||
    !trust.workspaceIds.includes(workspaceId) ||
    typeof claims.authorityRevision !== 'number' ||
    !Number.isSafeInteger(claims.authorityRevision) ||
    claims.authorityRevision < 1 ||
    typeof claims.operation !== 'string' ||
    (claims.targetId !== null && typeof claims.targetId !== 'string') ||
    typeof claims.inputDigest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(claims.inputDigest) ||
    typeof claims.actorUserId !== 'string' ||
    !uuidPattern.test(claims.actorUserId) ||
    typeof claims.issuedAt !== 'string' ||
    typeof claims.expiresAt !== 'string'
  )
    return null
  const issued = Date.parse(claims.issuedAt)
  const expires = Date.parse(claims.expiresAt)
  if (
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    issued > at ||
    expires <= at ||
    expires <= issued ||
    expires - issued > lifetimeMs
  )
    return null
  return parseManagementAuthorityDecision({
    authorityRef: claims.credentialId,
    authorityRevision: claims.authorityRevision,
    binding: {
      inputDigest: claims.inputDigest,
      operation: claims.operation as ManagementOperationId,
      targetId: claims.targetId as string | null,
      workspaceId,
    },
    decision: claims.decision,
    decisionId: claims.decisionId,
    expiresAt: claims.expiresAt,
    intentId: claims.intentId,
    issuedAt: claims.issuedAt,
    leadAgentId: claims.leadAgentId,
    principal: { kind: 'user', userId: claims.actorUserId },
    schemaVersion: managementAuthoritySchemaVersion,
  })
}

function readTrust(environment: LeadManagementServiceEnvironment): LeadManagementTrust | null {
  const source = environment.PI_LEAD_MANAGEMENT_TRUST
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
  if (
    typeof trust.issuer !== 'string' ||
    typeof trust.keyId !== 'string' ||
    typeof trust.principalId !== 'string' ||
    !Array.isArray(trust.workspaceIds) ||
    trust.workspaceIds.length === 0 ||
    trust.workspaceIds.length > 1_024 ||
    trust.workspaceIds.some((id) => typeof id !== 'string' || id.length === 0) ||
    new Set(trust.workspaceIds).size !== trust.workspaceIds.length ||
    !Array.isArray(trust.revokedCredentialIds) ||
    trust.revokedCredentialIds.length > 1_024 ||
    new Set(trust.revokedCredentialIds).size !== trust.revokedCredentialIds.length ||
    trust.revokedCredentialIds.some((id) => typeof id !== 'string' || id.length === 0)
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
    (jwk.alg !== undefined && jwk.alg !== 'EdDSA' && jwk.alg !== 'Ed25519') ||
    (jwk.kid !== undefined && jwk.kid !== trust.keyId) ||
    (jwk.use !== undefined && jwk.use !== 'sig') ||
    (jwk.ext !== undefined && typeof jwk.ext !== 'boolean') ||
    (jwk.key_ops !== undefined &&
      (!Array.isArray(jwk.key_ops) || jwk.key_ops.length !== 1 || jwk.key_ops[0] !== 'verify'))
  )
    return null
  return {
    issuer: trust.issuer,
    keyId: trust.keyId,
    principalId: trust.principalId,
    publicJwk: { ...jwk } as LeadManagementTrust['publicJwk'],
    revokedCredentialIds: [...(trust.revokedCredentialIds as string[])],
    workspaceIds: [...(trust.workspaceIds as string[])],
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
