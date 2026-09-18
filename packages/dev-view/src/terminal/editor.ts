// Bottom input editor state for the terminal (issue #396): multiline
// drafting, per-worktree history navigation, paste confirmation for
// multiline/control text, and the raw direct-keyboard escape hatch that
// lets full-screen TUIs receive every key. Pure reducer; the Solid
// component owns focus and IME composition.
export type EditorMode = 'compose' | 'raw'

export type EditorState = Readonly<{
  mode: EditorMode
  draft: string
  /** History newest-first; navigation moves the cursor without mutating it. */
  history: readonly string[]
  historyIndex: number | null
  draftBeforeHistory: string | null
  /** Multiline or control-character pastes require explicit confirmation. */
  pendingPaste?: string
  sendLabel: string
}>

const MAX_HISTORY = 500
const MAX_DRAFT = 64 * 1024

export function createEditorState(history: readonly string[] = []): EditorState {
  return {
    mode: 'compose',
    draft: '',
    history: history.slice(0, MAX_HISTORY),
    historyIndex: null,
    draftBeforeHistory: null,
    sendLabel: 'Send to active terminal',
  }
}

/** Control characters (excluding tab/newline) that make a paste suspicious. */
function hasControlCharacters(text: string): boolean {
  // oxlint-disable-next-line no-control-regex
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)
}

/** Multiline or control-character text needs explicit user confirmation. */
export function pasteNeedsConfirmation(text: string): boolean {
  return text.includes('\n') || hasControlCharacters(text)
}

export function editorChangeDraft(state: EditorState, draft: string): EditorState {
  return { ...state, draft: draft.slice(0, MAX_DRAFT) }
}

export function editorStagePaste(state: EditorState, pasted: string): EditorState {
  if (!pasteNeedsConfirmation(pasted)) {
    return editorChangeDraft(state, state.draft + pasted)
  }
  return { ...state, pendingPaste: pasted.slice(0, MAX_DRAFT) }
}

export function editorConfirmPaste(state: EditorState): EditorState {
  if (state.pendingPaste === undefined) return state
  const next = editorChangeDraft(state, state.draft + state.pendingPaste)
  return { ...next, pendingPaste: undefined }
}

export function editorRejectPaste(state: EditorState): EditorState {
  return { ...state, pendingPaste: undefined }
}

/** Up/Down through history; a fresh navigation stashes the in-progress draft. */
export function editorHistoryStep(state: EditorState, direction: 'up' | 'down'): EditorState {
  if (state.history.length === 0) return state
  if (direction === 'up') {
    if (state.historyIndex === null) {
      return {
        ...state,
        historyIndex: 0,
        draftBeforeHistory: state.draft,
        draft: state.history[0]!,
      }
    }
    const next = Math.min(state.historyIndex + 1, state.history.length - 1)
    if (next === state.historyIndex) return state
    return { ...state, historyIndex: next, draft: state.history[next]! }
  }
  if (state.historyIndex === null) return state
  if (state.historyIndex === 0) {
    return {
      ...state,
      historyIndex: null,
      draft: state.draftBeforeHistory ?? '',
      draftBeforeHistory: null,
    }
  }
  const next = state.historyIndex - 1
  return { ...state, historyIndex: next, draft: state.history[next]! }
}

/** Send commits the draft to history (newest first, deduplicated, bounded). */
export function editorSend(state: EditorState): { state: EditorState; payload: string } | null {
  const payload = state.draft
  if (payload.length === 0) return null
  const history = [payload, ...state.history.filter((entry) => entry !== payload)].slice(
    0,
    MAX_HISTORY
  )
  return {
    state: {
      ...state,
      draft: '',
      history,
      historyIndex: null,
      draftBeforeHistory: null,
      pendingPaste: undefined,
    },
    payload,
  }
}

export function editorToggleMode(state: EditorState): EditorState {
  return {
    ...state,
    mode: state.mode === 'compose' ? 'raw' : 'compose',
    // A staged paste belongs to the compose session that requested it.
    pendingPaste: undefined,
  }
}
