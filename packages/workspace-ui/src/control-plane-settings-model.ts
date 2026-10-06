// Pure presentation and validation for Workspace settings › Skills and
// › Connections › Cloud (ADR 0013). No Solid, no network: the panes import
// these and the unit suite exercises them directly.
import type {
  ApiCatalogItem,
  ApiCatalogLifecycle,
  ApiCloudConnection,
  ApiCloudConnectionStatus,
} from '@adea-ai/api-client'

export type StatusTone = 'destructive' | 'outline' | 'secondary' | 'success' | 'warning'

const lifecycleLabels: Readonly<Record<ApiCatalogLifecycle, string>> = {
  deprecated: 'Deprecated',
  draft: 'Draft',
  published: 'Published',
  revoked: 'Revoked',
  superseded: 'Superseded',
}

const lifecycleTones: Readonly<Record<ApiCatalogLifecycle, StatusTone>> = {
  deprecated: 'warning',
  draft: 'secondary',
  published: 'success',
  revoked: 'destructive',
  superseded: 'outline',
}

export function lifecycleLabel(item: ApiCatalogItem): string {
  return item.latestVersion ? lifecycleLabels[item.latestVersion.lifecycle] : 'No versions'
}

export function lifecycleTone(item: ApiCatalogItem): StatusTone {
  return item.latestVersion ? lifecycleTones[item.latestVersion.lifecycle] : 'outline'
}

/** One line under the item name: owner, version and revision. */
export function catalogItemDetail(item: ApiCatalogItem): string {
  const owner = item.owner === 'system' ? 'System' : 'This workspace'
  const version = item.latestVersion
    ? `${item.kind === 'profile' ? 'v' : ''}${item.latestVersion.version} · revision ${item.latestVersion.revision}`
    : 'No published version'
  return `${owner} · ${version}`
}

/** Deprecate and revoke apply to workspace items that still have something to retire. */
export function canRetire(item: ApiCatalogItem, action: 'deprecate' | 'revoke'): boolean {
  if (item.readOnly || item.owner !== 'workspace' || !item.latestVersion) return false
  const lifecycle = item.latestVersion.lifecycle
  if (lifecycle === 'revoked') return false
  return action === 'revoke' || lifecycle !== 'deprecated'
}

const connectionStatusLabels: Readonly<Record<ApiCloudConnectionStatus, string>> = {
  active: 'Active',
  expired: 'Expired',
  revoked: 'Revoked',
  secret_required: 'Secret required',
}

const connectionStatusTones: Readonly<Record<ApiCloudConnectionStatus, StatusTone>> = {
  active: 'success',
  expired: 'warning',
  revoked: 'destructive',
  secret_required: 'warning',
}

export function connectionStatusLabel(connection: ApiCloudConnection): string {
  return connectionStatusLabels[connection.status]
}

export function connectionStatusTone(connection: ApiCloudConnection): StatusTone {
  return connectionStatusTones[connection.status]
}

export function connectionDetail(connection: ApiCloudConnection): string {
  const parts = [connection.connectorRef, `revision ${connection.revision}`]
  if (connection.rotatedAt) parts.push(`rotated ${shortDate(connection.rotatedAt)}`)
  else parts.push(`added ${shortDate(connection.createdAt)}`)
  if (connection.expiresAt && connection.status !== 'revoked')
    parts.push(`expires ${shortDate(connection.expiresAt)}`)
  return parts.join(' · ')
}

function shortDate(value: string): string {
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : value
}

/** Rotate and revoke apply to connections the vault still holds. */
export function canChangeConnection(connection: ApiCloudConnection): boolean {
  return connection.status !== 'revoked'
}

type ErrorLike = Readonly<{ code?: unknown; status?: unknown }>

function errorFields(error: unknown): ErrorLike {
  return typeof error === 'object' && error !== null ? (error as ErrorLike) : {}
}

/** Text for a list that could not load; never echoes server text. */
export function controlPlaneLoadNotice(subject: string, error: unknown): string {
  const { code, status } = errorFields(error)
  if (code === 'CONTROL_PLANE_UNSCOPED')
    return `${subject} need per-workspace Control Plane credentials, which this deployment has not enabled yet.`
  if (code === 'CONTROL_PLANE_UNAVAILABLE' || status === 503)
    return 'The Control Plane is unavailable right now. Try again later.'
  if (status === 404 && code !== 'workspace_unavailable')
    return `This Control Plane does not offer ${subject.toLowerCase()} yet.`
  if (status === 401) return 'Sign in to see this.'
  return `${subject} could not be loaded. Try again.`
}

/** Text for a failed change; `action` names what was attempted. */
export function controlPlaneActionNotice(action: string, error: unknown): string {
  const { code, status } = errorFields(error)
  switch (code) {
    case 'CONTROL_PLANE_UNSCOPED':
      return `${action} needs per-workspace Control Plane credentials, which this deployment has not enabled yet.`
    case 'CATALOG_ITEM_READ_ONLY':
      return 'System items are read-only for workspaces.'
    case 'CATALOG_CONTENT_INVALID':
      return 'The Control Plane rejected the skill: its manifest or content does not match the skill schema.'
    case 'CATALOG_CREDENTIAL_INPUT_REJECTED':
      return 'Skills cannot contain credentials. Remove secrets from the manifest and content.'
    case 'CATALOG_DISPLAY_NAME_CONFLICT':
      return 'Another skill in this workspace already uses that name.'
    case 'CREDENTIAL_SECRET_INVALID':
      return 'The vault did not accept that secret.'
    case 'CREDENTIAL_CONNECTOR_IN_USE':
    case 'CREDENTIAL_EXISTS':
      return 'A cloud connection for that connector already exists. Rotate it instead.'
    default:
      break
  }
  if (status === 403) return 'Only workspace owners and admins can change this.'
  if (status === 409)
    return `${action} conflicted with a newer change. The list was refreshed; try again.`
  if (status === 400 || status === 422)
    return `${action} was rejected. Check the fields and try again.`
  if (status === 404) return `${action} failed: the item no longer exists or is not offered yet.`
  if (code === 'CONTROL_PLANE_UNAVAILABLE' || status === 503)
    return 'The Control Plane is unavailable right now. Try again later.'
  return `${action} failed. Try again.`
}

const PROVIDER_PATTERN = /^[a-z][a-z0-9.-]{0,127}$/u
const CONNECTOR_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u

export type CloudConnectionDraft = Readonly<{
  provider: string
  connectorRef: string
  secret: string
}>

/** The default connector reference for a provider, as the vault fixtures name them. */
export function defaultConnectorRef(provider: string): string {
  return `connector:${provider.trim()}`
}

/** A user-facing problem with a secret, or null when the vault would accept it. */
export function secretProblem(secret: string): string | null {
  if (secret.length < 8) return 'The secret must be at least 8 characters.'
  if (secret.length > 65_536) return 'The secret is too long.'
  for (const character of secret) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f)
      return 'The secret cannot contain line breaks or control characters.'
  }
  return null
}

export function cloudConnectionDraftProblem(draft: CloudConnectionDraft): string | null {
  if (!PROVIDER_PATTERN.test(draft.provider.trim()))
    return 'Use a lowercase provider name such as github or openai.'
  const connectorRef = draft.connectorRef.trim() || defaultConnectorRef(draft.provider)
  if (!CONNECTOR_REF_PATTERN.test(connectorRef))
    return 'The connector reference may use letters, numbers and . _ : / -'
  return secretProblem(draft.secret)
}

export type SkillDraft = Readonly<{ displayName: string; manifest: string; content: string }>

export type ParsedSkillDraft = Readonly<{
  displayName: string
  manifest: Record<string, unknown>
  content: Record<string, unknown>
}>

function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * Shape-checks a pasted skill before it leaves the browser: a name, a JSON
 * object manifest with a `semanticVersion`, and a JSON object content with
 * `instructions`. The Control Plane validates the full versioned schema.
 */
export function parseSkillDraft(
  draft: SkillDraft
): Readonly<{ ok: true; value: ParsedSkillDraft } | { ok: false; problem: string }> {
  const displayName = draft.displayName.trim()
  if (!displayName || displayName.length > 128)
    return { ok: false, problem: 'Name the skill (up to 128 characters).' }
  const manifest = jsonObject(draft.manifest)
  if (!manifest) return { ok: false, problem: 'The manifest must be a JSON object.' }
  if (typeof manifest.semanticVersion !== 'string' || !manifest.semanticVersion)
    return { ok: false, problem: 'The manifest needs a semanticVersion, such as "1.0.0".' }
  const content = jsonObject(draft.content)
  if (!content) return { ok: false, problem: 'The content must be a JSON object.' }
  if (typeof content.instructions !== 'string' || !content.instructions.trim())
    return { ok: false, problem: 'The content needs instructions text.' }
  if (JSON.stringify([manifest, content]).length > 256 * 1024)
    return { ok: false, problem: 'The skill is larger than 256 KB.' }
  return { ok: true, value: { content, displayName, manifest } }
}
