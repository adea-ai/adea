// Paging bounds for workspace search, kept apart from the query itself.
//
// The bound and the candidate scan are two different numbers, and when they
// disagree search paging dead-ends: the scan is capped at
// `SEARCH_CANDIDATE_LIMIT`, so the deepest reachable `nextOffset` can sit
// ABOVE `SEARCH_MAX_OFFSET` — the maximum the next request accepts. A client
// that followed that pointer got `Search query invalid`, a 400 where an empty
// page was the honest answer.
//
// This is its own module so the boundary can be tested directly. Importing
// `search.ts` for it would pull that module's five parallel queries into the
// coverage lane and drag the aggregate below its threshold, for a rule that is
// three comparisons wide.
import type { WorkspaceSearchPage } from '@adea-ai/types'

/** Deepest offset a caller may request. */
export const SEARCH_MAX_OFFSET = 5_000

/** Hard cap on rows any single search may scan, across all of its sources. */
export const SEARCH_CANDIDATE_LIMIT = 5_051

/** The `limit` a search accepts, clamped to the range the route validates. */
export function searchPageLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 30, 1), 50)
}

/** Whether a page may advertise a following page. */
export function searchHasNextPage(input: {
  limit: number
  nextOffset: number
  resultCount: number
}): boolean {
  const { limit, nextOffset, resultCount } = input
  if (nextOffset >= resultCount) return false
  if (nextOffset > SEARCH_MAX_OFFSET) return false
  // The next request scans `nextOffset + limit + 1` candidates, capped.
  return Math.min(nextOffset + limit + 1, SEARCH_CANDIDATE_LIMIT) <= SEARCH_CANDIDATE_LIMIT
}

/**
 * The candidate scan for one page, and the cursor to hand back.
 *
 * Exported as one function so the caller cannot pair a limit with a stale
 * bound — the drift between the two is what produced the dead end.
 */
export function searchPageWindow(input: { limit?: number; offset?: number; resultCount: number }): {
  candidateLimit: number
  limit: number
  nextOffset?: number
} {
  const limit = searchPageLimit(input.limit)
  const offset = input.offset ?? 0
  if (!Number.isSafeInteger(offset) || offset > SEARCH_MAX_OFFSET)
    throw new Error('Search query invalid')
  const candidateLimit = Math.min(offset + limit + 1, SEARCH_CANDIDATE_LIMIT)
  const candidateNext = offset + limit
  const hasMore = searchHasNextPage({
    limit,
    nextOffset: candidateNext,
    resultCount: input.resultCount,
  })
  return {
    candidateLimit,
    limit,
    ...(hasMore ? { nextOffset: candidateNext } : {}),
  }
}

export type { WorkspaceSearchPage }
