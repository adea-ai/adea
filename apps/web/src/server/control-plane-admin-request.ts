/**
 * Strict decoders for the workspace Skills and Cloud connections routes
 * (ADR 0013). Unknown keys, wrong types and out-of-range values are rejected
 * rather than ignored, and every bound mirrors the Control Plane contract so
 * a request that passes here is not rejected upstream for its shape.
 */
import { isRecord } from './control-plane-client'

const CROCKFORD_ID = '[0-9A-HJKMNP-TV-Z]{26}'
const SKILL_ID_PATTERN = new RegExp(`^skl_${CROCKFORD_ID}$`, 'u')
const SKILL_VERSION_ID_PATTERN = new RegExp(`^skv_${CROCKFORD_ID}$`, 'u')
const PROFILE_ID_PATTERN = new RegExp(`^prf_${CROCKFORD_ID}$`, 'u')
const PROFILE_VERSION_ID_PATTERN = new RegExp(`^pfv_${CROCKFORD_ID}$`, 'u')
const CREDENTIAL_ID_PATTERN = new RegExp(`^crd_${CROCKFORD_ID}$`, 'u')
const CURSOR_PATTERN = /^cur_[A-Za-z0-9_-]{4,508}$/u
// Room for the operation prefix the proxy adds inside the 128-character limit.
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,96}$/u
const PROVIDER_PATTERN = /^[a-z][a-z0-9.-]{0,127}$/u
const CONNECTOR_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u
const SECRET_MIN_LENGTH = 8
const SECRET_MAX_LENGTH = 65_536
const DISPLAY_NAME_LIMIT = 128
const REASON_LIMIT = 512
/** Serialized manifest plus content; generous for instructions, bounded for the Worker. */
const SKILL_CONTENT_LIMIT = 256 * 1024

export const catalogIdPatterns = {
  profile: PROFILE_ID_PATTERN,
  skill: SKILL_ID_PATTERN,
} as const

export function isCredentialId(value: unknown): value is string {
  return typeof value === 'string' && CREDENTIAL_ID_PATTERN.test(value)
}

/** `?cursor=` only; any other query parameter is a malformed request. */
export function parseListQuery(request: Request): Readonly<{ cursor?: string }> | null {
  const url = new URL(request.url)
  const keys = [...url.searchParams.keys()]
  if (keys.some((key) => key !== 'cursor') || keys.length > 1) return null
  const cursor = url.searchParams.get('cursor')
  if (cursor === null) return {}
  return CURSOR_PATTERN.test(cursor) ? { cursor } : null
}

function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(body).every((key) => allowed.includes(key))
}

function idempotencyKey(value: unknown): string | null {
  return typeof value === 'string' && IDEMPOTENCY_KEY_PATTERN.test(value) ? value : null
}

function trimmedText(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text.length > 0 && text.length <= limit ? text : null
}

export type ParsedCatalogLifecycle = Readonly<{
  idempotencyKey: string
  reason: string
  versionId?: string
  expectedRevision?: number
}>

export function parseCatalogLifecycle(
  kind: 'profile' | 'skill',
  body: unknown
): ParsedCatalogLifecycle | null {
  if (!isRecord(body)) return null
  if (!onlyKeys(body, ['expectedRevision', 'idempotencyKey', 'reason', 'versionId'])) return null
  const key = idempotencyKey(body.idempotencyKey)
  const reason = trimmedText(body.reason, REASON_LIMIT)
  if (!key || !reason) return null
  const hasVersion = body.versionId !== undefined
  const hasRevision = body.expectedRevision !== undefined
  if (hasVersion !== hasRevision) return null
  if (!hasVersion) return { idempotencyKey: key, reason }
  const versionPattern = kind === 'skill' ? SKILL_VERSION_ID_PATTERN : PROFILE_VERSION_ID_PATTERN
  if (typeof body.versionId !== 'string' || !versionPattern.test(body.versionId)) return null
  const revision = body.expectedRevision
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return null
  return {
    expectedRevision: revision,
    idempotencyKey: key,
    reason,
    versionId: body.versionId,
  }
}

export type ParsedSkillPublish = Readonly<{
  idempotencyKey: string
  skillId?: string
  displayName: string
  manifest: Record<string, unknown>
  content: Record<string, unknown>
}>

export function parseSkillPublish(body: unknown): ParsedSkillPublish | null {
  if (!isRecord(body)) return null
  if (!onlyKeys(body, ['content', 'displayName', 'idempotencyKey', 'manifest', 'skillId']))
    return null
  const key = idempotencyKey(body.idempotencyKey)
  const displayName = trimmedText(body.displayName, DISPLAY_NAME_LIMIT)
  if (!key || !displayName || !isRecord(body.manifest) || !isRecord(body.content)) return null
  if (
    body.skillId !== undefined &&
    (typeof body.skillId !== 'string' || !SKILL_ID_PATTERN.test(body.skillId))
  )
    return null
  if (JSON.stringify([body.manifest, body.content]).length > SKILL_CONTENT_LIMIT) return null
  return {
    content: body.content,
    displayName,
    idempotencyKey: key,
    manifest: body.manifest,
    ...(typeof body.skillId === 'string' ? { skillId: body.skillId } : {}),
  }
}

/**
 * The write-only secret, mirroring the vault's own bounds: 8–65,536
 * characters and no control characters (so it can never inject a header or
 * a log line where a connector uses it). Never trimmed: whitespace may be
 * part of a secret.
 */
function secretValue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (value.length < SECRET_MIN_LENGTH || value.length > SECRET_MAX_LENGTH) return null
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return null
  }
  return value
}

export type ParsedCloudConnectionCreate = Readonly<{
  idempotencyKey: string
  provider: string
  connectorRef: string
  secret: string
  expiresAt?: string
}>

export function parseCloudConnectionCreate(
  body: unknown,
  now: number = Date.now()
): ParsedCloudConnectionCreate | null {
  if (!isRecord(body)) return null
  if (!onlyKeys(body, ['connectorRef', 'expiresAt', 'idempotencyKey', 'provider', 'secret']))
    return null
  const key = idempotencyKey(body.idempotencyKey)
  const secret = secretValue(body.secret)
  const { connectorRef, provider } = body
  if (!key || !secret) return null
  if (typeof provider !== 'string' || !PROVIDER_PATTERN.test(provider)) return null
  if (typeof connectorRef !== 'string' || !CONNECTOR_REF_PATTERN.test(connectorRef)) return null
  let expiresAt: string | undefined
  if (body.expiresAt !== undefined) {
    if (typeof body.expiresAt !== 'string' || body.expiresAt.length > 64) return null
    const time = Date.parse(body.expiresAt)
    if (!Number.isFinite(time) || time <= now) return null
    expiresAt = new Date(time).toISOString()
  }
  return {
    connectorRef,
    idempotencyKey: key,
    provider,
    secret,
    ...(expiresAt ? { expiresAt } : {}),
  }
}

export type ParsedCloudConnectionRotate = Readonly<{
  idempotencyKey: string
  expectedRevision: number
  secret: string
}>

export function parseCloudConnectionRotate(body: unknown): ParsedCloudConnectionRotate | null {
  if (!isRecord(body)) return null
  if (!onlyKeys(body, ['expectedRevision', 'idempotencyKey', 'secret'])) return null
  const key = idempotencyKey(body.idempotencyKey)
  const secret = secretValue(body.secret)
  const revision = body.expectedRevision
  if (!key || !secret) return null
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return null
  return { expectedRevision: revision, idempotencyKey: key, secret }
}

export function parseCloudConnectionRevoke(
  body: unknown
): Readonly<{ idempotencyKey: string }> | null {
  if (!isRecord(body) || !onlyKeys(body, ['idempotencyKey'])) return null
  const key = idempotencyKey(body.idempotencyKey)
  return key ? { idempotencyKey: key } : null
}
