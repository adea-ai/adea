// In-pane search state for the terminal (issue #396): a real search bar
// replaces any window-prompt flow, with next/previous stepping, a live match
// count, and Esc-to-close. Pure reducer; the pane performs the actual
// SearchAddon calls and receives the addon's result events back.
export type SearchDirection = 'next' | 'previous'

export type SearchResults = Readonly<{ resultCount: number; resultIndex: number }>

export type SearchState = Readonly<{
  open: boolean
  query: string
  /** Latest addon results while the query is active; undefined until reported. */
  results?: SearchResults
  /** The most recent stepping request the pane has not consumed. */
  requested?: SearchDirection
  /** Case-sensitive matching toggle. */
  caseSensitive: boolean
  /**
   * The pane-owned active-match ordinal (0-based). The addon derives its own
   * `resultIndex` by matching the selected decoration against its highlight
   * decorations, and reports -1 when that bookkeeping misses — which rendered
   * as a frozen "1 of N" after stepping (#594). The pane drives stepping, so
   * its ordinal is the authority and the addon's index only seeds it.
   */
  activeIndex: number
}>

export function createSearchState(): SearchState {
  return { open: false, query: '', caseSensitive: false, activeIndex: 0 }
}

export function searchOpen(state: SearchState): SearchState {
  return { ...state, open: true }
}

export function searchToggle(state: SearchState): SearchState {
  return { ...state, open: !state.open }
}

export function searchClose(state: SearchState): SearchState {
  return { ...state, open: false, results: undefined, requested: undefined, activeIndex: 0 }
}

export function searchSetQuery(state: SearchState, query: string): SearchState {
  return { ...state, query, results: undefined, requested: undefined, activeIndex: 0 }
}

export function searchToggleCaseSensitive(state: SearchState): SearchState {
  return {
    ...state,
    caseSensitive: !state.caseSensitive,
    results: undefined,
    activeIndex: 0,
  }
}

export function searchStep(state: SearchState, direction: SearchDirection): SearchState {
  if (state.query === '') return state
  const count = state.results?.resultCount ?? 0
  if (count === 0) return { ...state, requested: direction }
  // Stepping advances the ordinal in the same motion as the addon's
  // highlight, wrapping at both ends, so the count can never disagree with the
  // match the pane just moved to.
  const activeIndex =
    direction === 'next' ? (state.activeIndex + 1) % count : (state.activeIndex - 1 + count) % count
  return { ...state, requested: direction, activeIndex }
}

/** The pane consumes a pending step request after executing it. */
export function searchConsumeStep(state: SearchState): SearchState {
  if (state.requested === undefined) return state
  return { ...state, requested: undefined }
}

export function searchSetResults(state: SearchState, results: SearchResults): SearchState {
  const { resultCount, resultIndex } = results
  if (resultCount === 0) return { ...state, results, activeIndex: 0 }
  // The addon's index is trusted only for the first report of a query, where
  // its fresh "first match" position is authoritative; an out-of-range index
  // is never adopted. After that the ordinal is the pane's, clamped to the
  // count the addon reports.
  const seeded =
    state.results === undefined && resultIndex >= 0 && resultIndex < resultCount
      ? resultIndex
      : state.activeIndex
  return { ...state, results, activeIndex: Math.min(Math.max(seeded, 0), resultCount - 1) }
}

export type SearchPresentation = Readonly<{
  /** Live-region text for the match count; empty while quiet. */
  count: string
  /** Whether stepping is meaningful right now. */
  steppable: boolean
}>

export function searchPresentation(state: SearchState): SearchPresentation {
  if (state.query === '') return { count: '', steppable: false }
  if (state.results === undefined) return { count: 'Searching…', steppable: false }
  const { resultCount } = state.results
  if (resultCount === 0) return { count: 'No matches', steppable: false }
  const ordinal = Math.min(Math.max(state.activeIndex, 0), resultCount - 1) + 1
  return { count: `${ordinal} of ${resultCount} matches`, steppable: true }
}
