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
}>

export function createSearchState(): SearchState {
  return { open: false, query: '', caseSensitive: false }
}

export function searchOpen(state: SearchState): SearchState {
  return { ...state, open: true }
}

export function searchToggle(state: SearchState): SearchState {
  return { ...state, open: !state.open }
}

export function searchClose(state: SearchState): SearchState {
  return { ...state, open: false, results: undefined, requested: undefined }
}

export function searchSetQuery(state: SearchState, query: string): SearchState {
  return { ...state, query, results: undefined, requested: undefined }
}

export function searchToggleCaseSensitive(state: SearchState): SearchState {
  return { ...state, caseSensitive: !state.caseSensitive, results: undefined }
}

export function searchStep(state: SearchState, direction: SearchDirection): SearchState {
  if (state.query === '') return state
  return { ...state, requested: direction }
}

/** The pane consumes a pending step request after executing it. */
export function searchConsumeStep(state: SearchState): SearchState {
  if (state.requested === undefined) return state
  return { ...state, requested: undefined }
}

export function searchSetResults(state: SearchState, results: SearchResults): SearchState {
  return { ...state, results }
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
  const { resultCount, resultIndex } = state.results
  if (resultCount === 0) return { count: 'No matches', steppable: false }
  const ordinal = Math.min(Math.max(resultIndex + 1, 1), resultCount)
  return { count: `${ordinal} of ${resultCount} matches`, steppable: true }
}
