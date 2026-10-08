import { Buffer } from 'node:buffer'

// Keyset-paging primitives for the account-wide agent directory and
// conversation inbox (M11.03), kept apart from the queries themselves so the
// codec can be unit-tested without a database, the way `search-paging.ts` is.
//
// A cursor is base64url JSON carrying the stable sort key of the last row of
// the page it came from. Offsets are deliberately not supported: rows can be
// inserted, edited or revoked between pages, and an offset would then skip or
// repeat them. A keyset cursor only ever moves past rows the caller has
// already seen, whatever happens around them.

/** The `limit` an account-wide page accepts, clamped to the route's range. */
export function accountDirectoryPageLimit(limit: number | undefined): number {
  const requested = typeof limit === 'number' && Number.isFinite(limit) ? Math.trunc(limit) : 50
  return Math.min(Math.max(requested, 1), 100)
}

/** A stable resource id (`entityId()`); cursors and lookups validate it. */
export function isAccountResourceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
}

export type AccountDirectoryCursor = Readonly<{
  id: string
  name: string
  workspaceId: string
}>

export type AccountInboxCursor = Readonly<{
  id: string
  updatedAt: string
}>

const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,1024}$/

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodeCursor<T>(
  cursor: string,
  invalid: string,
  validate: (value: Record<string, unknown>) => T | null
): T {
  if (!CURSOR_PATTERN.test(cursor)) throw new Error(invalid)
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new Error(invalid)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(invalid)
  const decoded = validate(parsed as Record<string, unknown>)
  if (!decoded) throw new Error(invalid)
  return decoded
}

function hasStringFields(value: Record<string, unknown>, fields: readonly string[]) {
  return (
    value.v === 1 &&
    fields.every((field) => {
      const entry = value[field]
      return typeof entry === 'string' && entry.length > 0 && entry.length <= 1024
    })
  )
}

/**
 * The directory cursor is the `(workspace_id, name, id)` sort key of the last
 * listed Agent, so pages survive same-name Agents in one or many workspaces.
 */
export function encodeAccountDirectoryCursor(cursor: AccountDirectoryCursor): string {
  return encodeCursor({ ...cursor, v: 1 })
}

export function decodeAccountDirectoryCursor(cursor: string): AccountDirectoryCursor {
  return decodeCursor(cursor, 'Directory cursor invalid', (value) => {
    if (
      !hasStringFields(value, ['id', 'name', 'workspaceId']) ||
      !isAccountResourceId(value.id) ||
      !isAccountResourceId(value.workspaceId)
    )
      return null
    return {
      id: value.id as string,
      name: value.name as string,
      workspaceId: value.workspaceId as string,
    }
  })
}

/**
 * The inbox cursor is the `(updated_at, id)` sort key of the last listed
 * conversation, newest first. The id breaks `updated_at` ties, so a page
 * boundary is always a strict step in a total order.
 */
export function encodeAccountInboxCursor(cursor: AccountInboxCursor): string {
  return encodeCursor({ ...cursor, v: 1 })
}

export function decodeAccountInboxCursor(cursor: string): AccountInboxCursor {
  return decodeCursor(cursor, 'Inbox cursor invalid', (value) => {
    if (!hasStringFields(value, ['id', 'updatedAt']) || !isAccountResourceId(value.id)) return null
    const updatedAt = new Date(value.updatedAt as string)
    if (Number.isNaN(updatedAt.getTime())) return null
    return { id: value.id as string, updatedAt: updatedAt.toISOString() }
  })
}
