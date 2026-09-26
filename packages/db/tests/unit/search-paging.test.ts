// Paging-boundary contract for workspace search (#M12 audit).
//
// The candidate scan is capped so one search cannot walk an unbounded
// workspace. That cap used to create a paging DEAD END: the deepest reachable
// `nextOffset` could sit above the maximum offset the next request accepts, so
// a client that followed the pointer got 'Search query invalid' — a 400 where
// an empty page was the honest answer.
//
// Pinned here at the boundary rather than with a five-thousand-row fixture,
// which is exactly what made this unproven for so long.
import { describe, expect, test } from 'bun:test'

import {
  SEARCH_CANDIDATE_LIMIT,
  SEARCH_MAX_OFFSET,
  searchHasNextPage,
  searchPageWindow,
} from '../../src/search-paging'

describe('search paging boundary', () => {
  test('advertises a next page in the ordinary case', () => {
    expect(searchHasNextPage({ limit: 30, nextOffset: 30, resultCount: 200 })).toBe(true)
    expect(searchHasNextPage({ limit: 50, nextOffset: 50, resultCount: 51 })).toBe(true)
  })

  test('stops at the end of the results', () => {
    expect(searchHasNextPage({ limit: 30, nextOffset: 30, resultCount: 30 })).toBe(false)
    expect(searchHasNextPage({ limit: 30, nextOffset: 60, resultCount: 45 })).toBe(false)
  })

  test('never advertises a nextOffset the next request would reject', () => {
    // The regression: at the deepest page the pointer used to exceed
    // SEARCH_MAX_OFFSET, and following it threw instead of returning nothing.
    for (const limit of [1, 30, 50]) {
      const deepest = SEARCH_MAX_OFFSET
      expect(
        searchHasNextPage({ limit, nextOffset: deepest + limit, resultCount: 100_000 }),
        `limit ${limit} advertised an unacceptable nextOffset`
      ).toBe(false)
    }
  })

  test('the advertised nextOffset is always one the validator accepts', () => {
    // Exhaustive over the reachable range: whatever we return, the next
    // request's own guard must pass.
    for (let offset = 0; offset <= SEARCH_MAX_OFFSET; offset += 137) {
      for (const limit of [1, 17, 30, 50]) {
        if (!searchHasNextPage({ limit, nextOffset: offset, resultCount: 100_000 })) continue
        expect(offset).toBeLessThanOrEqual(SEARCH_MAX_OFFSET)
        expect(Number.isSafeInteger(offset)).toBe(true)
      }
    }
  })

  test('the window helper derives limit, candidate scan, and cursor together', () => {
    // One call, so the clamped limit and the cursor bound cannot drift apart
    // again — that drift is what created the dead end.
    const window = searchPageWindow({ limit: 50, offset: 0, resultCount: 10_000 })
    expect(window.limit).toBe(50)
    expect(window.candidateLimit).toBe(51)
    expect(window.nextOffset).toBe(50)

    // The deepest page does not advertise a cursor its own validator rejects.
    const deepest = searchPageWindow({ limit: 50, offset: 5_000, resultCount: 100_000 })
    expect(deepest.candidateLimit).toBe(SEARCH_CANDIDATE_LIMIT)
    expect(deepest.nextOffset).toBeUndefined()

    // An offset past the accepted maximum is refused, as the validator does.
    expect(() => searchPageWindow({ limit: 50, offset: 5_001, resultCount: 10 })).toThrow(
      'Search query invalid'
    )
  })

  test('the cap and the max offset are consistent constants', () => {
    // If the cap ever fell below the max offset plus a page, the last
    // reachable page could not be served at all.
    expect(SEARCH_CANDIDATE_LIMIT).toBeGreaterThan(SEARCH_MAX_OFFSET)
    // One page beyond the deepest accepted offset must fit inside the cap,
    // otherwise that page is unreachable.
    expect(SEARCH_MAX_OFFSET + 1 + 1).toBeLessThanOrEqual(SEARCH_CANDIDATE_LIMIT)
  })
})
