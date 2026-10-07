/*
 * CodeMirror 6 lifecycle (#399). This module is the only place in the
 * package that touches the @codemirror family; it is reached through a
 * dynamic import from `code-editor.tsx` so the editor rides its own lazy
 * chunk and Chat/Virtual graphs never pull a renderer chunk. Language
 * packages are a later compartment — the state is built so a language
 * compartment can be reconfigured without rebuilding the view.
 *
 * Theming: the surface follows the active theme instead of CodeMirror's
 * light-only defaults. The theme provider writes the catalogue's `--editor-*`
 * syntax ramp and the semantic roles onto `<html>` for whichever theme
 * (light, dark, accent) is active, so every colour below is a `var()` —
 * the editor re-colours on a theme switch with no reconfiguration, and the
 * catalogue's 4.5:1 syntax floor holds in both appearances.
 */
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

export type MirrorOptions = Readonly<{
  parent: HTMLElement
  initialText: string
  editable: boolean
  onDocChanged(edited: boolean): void
  onSave(): void
}>

export type MirrorHandle = Readonly<{
  getText(): string
  setEditable(editable: boolean): void
  destroy(): void
}>

const languageCompartment = new Compartment()
const editableCompartment = new Compartment()

/** One entry of the highlight table: tags plus their token-driven styling. */
type HighlightSpec = Parameters<typeof HighlightStyle.define>[0][number]

/**
 * The syntax palette, as Lezer-tag specs over the theme provider's
 * `--editor-*` ramp (the catalogue's per-theme syntax projection, written to
 * `<html>` on every theme switch — see `themeCssVariables`). Punctuation and
 * constants stay at the plain foreground on purpose: the published editor
 * palette projects no role for them. Exported so the token wiring stays
 * pinned by `tests/editor-mirror.test.ts`.
 */
export const EDITOR_HIGHLIGHT_SPECS: readonly HighlightSpec[] = [
  { tag: t.comment, color: 'var(--editor-comment)' },
  { tag: [t.keyword, t.modifier], color: 'var(--editor-keyword)' },
  { tag: t.string, color: 'var(--editor-string)' },
  { tag: t.number, color: 'var(--editor-number)' },
  { tag: t.function(t.variableName), color: 'var(--editor-function)' },
  { tag: t.variableName, color: 'var(--editor-variable)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--editor-type)' },
  { tag: t.tagName, color: 'var(--editor-tag)' },
  { tag: t.attributeName, color: 'var(--editor-attribute)' },
  { tag: t.operator, color: 'var(--editor-operator)' },
  { tag: t.heading, color: 'var(--editor-heading)', fontWeight: 'bold' },
  { tag: t.link, color: 'var(--editor-link)', textDecoration: 'underline' },
  { tag: t.invalid, color: 'var(--destructive)' },
  { tag: t.inserted, color: 'var(--editor-diff-add)' },
  { tag: t.deleted, color: 'var(--editor-diff-delete)' },
]

/**
 * The editor chrome, as CodeMirror theme specs over the semantic roles.
 * `&`-prefixed selectors match the `&light`/`&dark` base-theme rules at equal
 * specificity and win on mount order, replacing the hardcoded light greys
 * (selection `#d9d9d9`, gutters `#f5f5f5`, active line `#cceeff44`, black
 * caret/cursor) that made the surface render as light in dark themes.
 * Exported so the token wiring stays pinned by `tests/editor-mirror.test.ts`.
 */
export const EDITOR_CHROME_SPEC = {
  '&': {
    height: '100%',
    backgroundColor: 'var(--background)',
    color: 'var(--foreground)',
  },
  '.cm-scroller': { overflow: 'auto' },
  '& .cm-content': { caretColor: 'var(--foreground)' },
  '& .cm-cursor, & .cm-dropCursor': { borderLeftColor: 'var(--foreground)' },
  '& .cm-selectionBackground': { backgroundColor: 'var(--secondary)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--primary-subtle)',
  },
  '& .cm-gutters': {
    backgroundColor: 'var(--background)',
    color: 'var(--muted-foreground)',
    borderColor: 'var(--border)',
  },
  '& .cm-activeLine': {
    backgroundColor: 'color-mix(in srgb, var(--muted) 55%, transparent)',
  },
  '& .cm-selectionMatch': { backgroundColor: 'var(--editor-search-match)' },
  '& .cm-panels': {
    backgroundColor: 'var(--popover)',
    color: 'var(--popover-foreground)',
  },
  '& .cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '& .cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '& .cm-button': {
    backgroundColor: 'var(--secondary)',
    color: 'var(--secondary-foreground)',
    border: '1px solid var(--border)',
    borderRadius: '0.35rem',
  },
  '& .cm-textfield': {
    backgroundColor: 'var(--background)',
    color: 'var(--foreground)',
    border: '1px solid var(--border)',
    borderRadius: '0.35rem',
  },
} satisfies Record<string, unknown>

const editorChromeTheme = EditorView.theme(EDITOR_CHROME_SPEC)
const editorSyntaxHighlighting = syntaxHighlighting(
  HighlightStyle.define(EDITOR_HIGHLIGHT_SPECS),
  // Still a fallback: a later language compartment can override per grammar.
  { fallback: true }
)

export function createMirror(options: MirrorOptions): MirrorHandle {
  const markEdited = EditorView.updateListener.of((update) => {
    if (update.docChanged) options.onDocChanged(true)
  })
  const saveKeymap = keymap.of([
    {
      key: 'Mod-s',
      preventDefault: true,
      run: () => {
        options.onSave()
        return true
      },
    },
  ])
  const state = EditorState.create({
    doc: options.initialText,
    extensions: [
      editorChromeTheme,
      editorSyntaxHighlighting,
      lineNumbers(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      history(),
      languageCompartment.of([]),
      editableCompartment.of(EditorView.editable.of(options.editable)),
      saveKeymap,
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      markEdited,
    ],
  })
  const view = new EditorView({ state, parent: options.parent })
  return {
    getText: () => view.state.doc.toString(),
    setEditable: (editable: boolean) => {
      view.dispatch({
        effects: editableCompartment.reconfigure(EditorView.editable.of(editable)),
      })
    },
    destroy: () => view.destroy(),
  }
}
