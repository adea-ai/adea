/**
 * Per-request Control Plane service credentials (ADR 0013).
 *
 * Adea signs a short-lived Ed25519 JWT for every Control Plane request whose
 * `workspaceIds` hold exactly the request's mapped `wsp_` scope (and
 * `projectIds` the mapped `prj_` scope when the route is project-scoped), with
 * only the scopes the route needs. The private key is a Worker secret that
 * never reaches the client bundle (see start/client-policy.mjs).
 *
 * There is no static-token fallback: a deployment without the signing key
 * has no Control Plane credential and every request fails closed. The
 * runbook is docs/control-plane-credentials.md.
 *
 * No `server-only` marker: Bun-run unit tests import this module directly,
 * and the compiled client-boundary guard keeps `src/server` out of browsers.
 */

/** The service principal the Control Plane registered for Adea. */
export const CONTROL_PLANE_SERVICE_PRINCIPAL_ID = 'svc_agent-hq'
export const CONTROL_PLANE_AUDIENCE = 'control-plane'
/** ADR 0013 caps a signed credential at five minutes. */
export const MAX_CREDENTIAL_LIFETIME_SECONDS = 300
/** Long enough for one proxied hop plus clock skew; well under the cap. */
export const DEFAULT_CREDENTIAL_LIFETIME_SECONDS = 120

const WORKSPACE_ID_PATTERN = /^wsp_[0-9A-HJKMNP-TV-Z]{26}$/u
const PROJECT_ID_PATTERN = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/u
const KEY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u
const SCOPE_PATTERN = /^[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*$/u

export type ControlPlaneServiceScope =
  | 'catalog:manage'
  | 'catalog:publish'
  | 'catalog:read'
  | 'credential:read'
  | 'credential:write'
  | 'marketplace:install'
  | 'marketplace:read'
  | 'marketplace:uninstall'
  | 'project-state:initialize'
  | 'runtime:read'
  | 'profile:resolve'
  | 'system:authenticate'

export type ControlPlaneScopeIds = Readonly<{
  workspaceId: string
  projectId?: string
  beforeMutation?: () => Promise<void>
}>

export type ControlPlaneCredential = Readonly<{
  /** The bearer value for the `Authorization` header. */
  token: string
  /** The Control Plane workspace the envelope must name. */
  workspaceId: string
  projectId?: string
}>

export type ControlPlaneCredentialMode = 'scoped' | 'unconfigured'

export type ControlPlaneCredentialRequest = Readonly<{
  scopes: readonly ControlPlaneServiceScope[]
  /** Resolves the request's mapped Control Plane scope. */
  resolveScope?: () => Promise<ControlPlaneScopeIds | null>
}>

type Environment = Readonly<Record<string, string | undefined>>

/** Raised when no usable credential can be produced; callers fail closed. */
export class ControlPlaneCredentialError extends Error {
  constructor(readonly reason: 'misconfigured' | 'unconfigured' | 'unmapped') {
    super('Control Plane credential unavailable')
    this.name = 'ControlPlaneCredentialError'
  }
}

/**
 * Whether this deployment can sign Control Plane credentials. `unconfigured`
 * means no signing key is bound, so every Control Plane request fails closed.
 */
export function controlPlaneCredentialMode(
  environment: Environment = process.env
): ControlPlaneCredentialMode {
  return environment.CONTROL_PLANE_SIGNING_KEY?.trim() ? 'scoped' : 'unconfigured'
}

/**
 * The signed credential for one Control Plane request. Without a signing key
 * it throws `unconfigured`; a partially configured signer or an unmapped
 * workspace throws too, so every caller fails closed.
 */
export async function controlPlaneCredential(
  request: ControlPlaneCredentialRequest,
  environment: Environment = process.env,
  now: number = Date.now()
): Promise<ControlPlaneCredential> {
  const signingKey = environment.CONTROL_PLANE_SIGNING_KEY?.trim()
  if (!signingKey) throw new ControlPlaneCredentialError('unconfigured')

  const keyId = environment.CONTROL_PLANE_SIGNING_KEY_ID?.trim() ?? ''
  const issuer = environment.CONTROL_PLANE_SIGNING_ISSUER?.trim() ?? ''
  if (!KEY_ID_PATTERN.test(keyId) || !isIssuer(issuer, environment))
    throw new ControlPlaneCredentialError('misconfigured')
  const scope = request.resolveScope ? await request.resolveScope() : null
  if (
    !scope ||
    !WORKSPACE_ID_PATTERN.test(scope.workspaceId) ||
    (scope.projectId !== undefined && !PROJECT_ID_PATTERN.test(scope.projectId))
  )
    throw new ControlPlaneCredentialError('unmapped')

  let privateKey: CryptoKey
  try {
    privateKey = await importSigningKey(signingKey)
  } catch {
    throw new ControlPlaneCredentialError('misconfigured')
  }
  if (
    request.scopes.some((requestedScope) =>
      [
        'catalog:manage',
        'catalog:publish',
        'credential:write',
        'marketplace:install',
        'marketplace:uninstall',
        'project-state:initialize',
      ].includes(requestedScope)
    )
  )
    await scope.beforeMutation?.()
  const token = await mintControlPlaneServiceJwt({
    issuer,
    keyId,
    now,
    privateKey,
    projectIds: scope.projectId ? [scope.projectId] : [],
    scopes: request.scopes,
    workspaceIds: [scope.workspaceId],
  })
  return Object.freeze({
    token,
    workspaceId: scope.workspaceId,
    ...(scope.projectId ? { projectId: scope.projectId } : {}),
  })
}

function isIssuer(value: string, environment: Environment): boolean {
  if (!value || value.length > 512) return false
  try {
    const url = new URL(value)
    if (url.username || url.password) return false
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && environment.NODE_ENV !== 'production')
    )
  } catch {
    return false
  }
}

export type ServiceJwtInput = Readonly<{
  issuer: string
  keyId: string
  privateKey: CryptoKey
  scopes: readonly string[]
  workspaceIds: readonly string[]
  projectIds?: readonly string[]
  now?: number
  lifetimeSeconds?: number
  credentialId?: string
}>

/**
 * Signs one Control Plane service JWT: header `{alg: EdDSA, kid, typ: JWT}`
 * and exactly the claims `ServiceCredentialClaimsSchema` accepts. `kid` and
 * the `keyId` claim are the same value, as the Control Plane verifier
 * requires. Each mint gets its own `credentialId` so a single credential can
 * be revoked or traced.
 */
export async function mintControlPlaneServiceJwt(input: ServiceJwtInput): Promise<string> {
  const lifetime = input.lifetimeSeconds ?? DEFAULT_CREDENTIAL_LIFETIME_SECONDS
  if (!Number.isInteger(lifetime) || lifetime < 1 || lifetime > MAX_CREDENTIAL_LIFETIME_SECONDS)
    throw new ControlPlaneCredentialError('misconfigured')
  const scopes = [...new Set(input.scopes)]
  const workspaceIds = [...new Set(input.workspaceIds)]
  const projectIds = [...new Set(input.projectIds ?? [])]
  if (
    scopes.length < 1 ||
    scopes.length > 64 ||
    !scopes.every((scope) => SCOPE_PATTERN.test(scope)) ||
    workspaceIds.length < 1 ||
    workspaceIds.length > 256 ||
    !workspaceIds.every((id) => WORKSPACE_ID_PATTERN.test(id)) ||
    projectIds.length > 256 ||
    !projectIds.every((id) => PROJECT_ID_PATTERN.test(id)) ||
    !KEY_ID_PATTERN.test(input.keyId)
  )
    throw new ControlPlaneCredentialError('misconfigured')

  const issuedAt = Math.floor(input.now ?? Date.now())
  const header = { alg: 'EdDSA', kid: input.keyId, typ: 'JWT' }
  const claims = {
    audience: CONTROL_PLANE_AUDIENCE,
    credentialId: input.credentialId ?? `adea-web:${crypto.randomUUID()}`,
    credentialKind: 'service',
    expiresAt: new Date(issuedAt + lifetime * 1000).toISOString(),
    issuedAt: new Date(issuedAt).toISOString(),
    issuer: input.issuer,
    keyId: input.keyId,
    principalId: CONTROL_PLANE_SERVICE_PRINCIPAL_ID,
    projectIds,
    scopes,
    workspaceIds,
  }
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`
  const signature = await crypto.subtle.sign(
    { name: 'Ed25519' },
    input.privateKey,
    new TextEncoder().encode(signingInput)
  )
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`
}

let cachedKey: Readonly<{ source: string; key: Promise<CryptoKey> }> | undefined

/**
 * Imports the Ed25519 private key from the Worker secret: PKCS#8 PEM
 * (`-----BEGIN PRIVATE KEY-----`, as `openssl genpkey -algorithm ed25519`
 * writes it) or a private JWK (`{"kty":"OKP","crv":"Ed25519","d":…,"x":…}`).
 * The imported key is non-extractable and cached per isolate.
 */
export function importSigningKey(source: string): Promise<CryptoKey> {
  if (cachedKey?.source === source) return cachedKey.key
  const key = importSigningKeyUncached(source)
  // A failed import is not cached, so a corrected secret takes effect.
  key.catch(() => {
    if (cachedKey?.key === key) cachedKey = undefined
  })
  cachedKey = { key, source }
  return key
}

async function importSigningKeyUncached(source: string): Promise<CryptoKey> {
  const text = source.trim()
  if (text.startsWith('{')) {
    const jwk = JSON.parse(text) as JsonWebKey
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.d !== 'string')
      throw new Error('unsupported key')
    return crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['sign'])
  }
  // Secrets pasted through dashboards or .dev.vars sometimes carry escaped
  // newlines; the PEM body is base64 either way.
  const pem = text.replaceAll('\\n', '\n')
  const match = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/u.exec(pem)
  if (!match?.[1]) throw new Error('unsupported key')
  const der = Uint8Array.from(atob(match[1].replaceAll(/\s+/gu, '')), (character) =>
    character.charCodeAt(0)
  )
  return crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign'])
}

function base64UrlJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)))
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}
