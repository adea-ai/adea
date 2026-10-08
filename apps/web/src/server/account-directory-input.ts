// Request-boundary parsing for the account-wide directory and inbox routes
// (M11.03). Pure on purpose: the server-only request module composes this,
// and unit tests run it without a database the way `read-state-input` is run.

export type AccountDirectoryPageQuery = Readonly<{
  after?: string
  includeArchived?: boolean
  limit?: number
}>

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** A stable account-scoped resource id; anything else never reaches a query. */
export function parseAccountResourceId(value: string | undefined): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null
}

// Opaque cursors are base64url JSON emitted by the query layer; the route
// only bound-checks them here so oversized or hostile values never reach the
// decoder. `limit` mirrors the query layer's 1..100 clamp so an out-of-range
// value is a client error, not a silent re-clamp.
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,1024}$/

function parsePageLimit(value: string): number | null {
  if (!/^[0-9]+$/.test(value)) return null
  const limit = Number(value)
  // The query layer clamps, but an out-of-range request is a client error,
  // not a silently accepted page size.
  return limit >= 1 && limit <= 100 ? limit : null
}

/**
 * Parses the page query exactly: unknown parameters, malformed numbers, and
 * ambiguous markers are rejected as a whole, returning `null` for the route
 * to answer `invalid_request`. Present-but-empty values are rejected.
 */
export function parseAccountDirectoryPageQuery(
  searchParams: URLSearchParams
): AccountDirectoryPageQuery | null {
  const known = new Set(['after', 'includeArchived', 'limit'])
  for (const key of searchParams.keys()) if (!known.has(key)) return null

  const limit = searchParams.get('limit')
  const parsedLimit = limit === null ? null : parsePageLimit(limit)
  if (limit !== null && parsedLimit === null) return null

  const after = searchParams.get('after')
  if (after !== null && !CURSOR_PATTERN.test(after)) return null

  const includeArchived = searchParams.get('includeArchived')
  if (includeArchived !== null && !['true', 'false'].includes(includeArchived)) return null

  return {
    ...(after !== null ? { after } : {}),
    ...(includeArchived !== null ? { includeArchived: includeArchived === 'true' } : {}),
    ...(parsedLimit !== null ? { limit: parsedLimit } : {}),
  }
}
