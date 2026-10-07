import {
  workspaceAccentIds,
  type WorkspaceAccentId,
  type WorkspaceLogo,
  type WorkspaceSceneId,
  type WorkspaceUpdate,
} from '@adea-ai/types'

const WORKSPACE_NAME_LIMIT = 80
const EMOJI_PATTERN = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})/u

export type ParsedWorkspaceUpdate = Readonly<{ expectedVersion: number; update: WorkspaceUpdate }>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function graphemeCount(value: string): number {
  return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].length
}

function parseLogo(value: unknown): WorkspaceLogo | null {
  if (!isRecord(value)) return null
  if (
    (value.kind === 'monogram' || value.kind === 'home' || value.kind === 'box') &&
    Object.keys(value).length === 1
  )
    return { kind: value.kind }
  if (value.kind !== 'emoji' || Object.keys(value).length !== 2) return null
  const emoji = value.value
  if (typeof emoji !== 'string' || emoji.length === 0 || emoji.length > 16) return null
  if (graphemeCount(emoji) !== 1 || !EMOJI_PATTERN.test(emoji)) return null
  return { kind: 'emoji', value: emoji }
}

/**
 * Strictly decodes a workspace PATCH body. Unknown keys, an empty update and
 * out-of-range values are rejected rather than ignored, so a client never
 * believes a field changed when it did not.
 */
export function parseWorkspaceUpdate(body: unknown): ParsedWorkspaceUpdate | null {
  if (!isRecord(body)) return null
  const allowed = new Set(['accent', 'expectedVersion', 'logo', 'name', 'scene'])
  if (Object.keys(body).some((key) => !allowed.has(key))) return null

  const { expectedVersion } = body
  if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion)) return null
  if (expectedVersion < 1) return null

  const update: {
    accent?: WorkspaceAccentId | null
    logo?: WorkspaceLogo
    name?: string
    scene?: WorkspaceSceneId
  } = {}

  if ('name' in body) {
    if (typeof body.name !== 'string') return null
    const name = body.name.trim()
    if (name.length === 0 || name.length > WORKSPACE_NAME_LIMIT) return null
    update.name = name
  }
  if ('scene' in body) {
    if (body.scene !== 'home' && body.scene !== 'work') return null
    update.scene = body.scene
  }
  if ('accent' in body) {
    if (body.accent !== null && !workspaceAccentIds.includes(body.accent as WorkspaceAccentId))
      return null
    update.accent = body.accent as WorkspaceAccentId | null
  }
  if ('logo' in body) {
    const logo = parseLogo(body.logo)
    if (!logo) return null
    update.logo = logo
  }

  if (Object.keys(update).length === 0) return null
  return { expectedVersion, update }
}

/** Strict member-list ordering; presentation capabilities cannot change root identity. */
export function parseWorkspaceOrder(body: unknown): readonly string[] | null {
  if (!isRecord(body) || Object.keys(body).length !== 1 || !Array.isArray(body.workspaceIds))
    return null
  const ids: unknown[] = body.workspaceIds
  if (
    ids.some(
      (id) => typeof id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
    ) ||
    new Set(ids).size !== ids.length
  )
    return null
  return ids as string[]
}
