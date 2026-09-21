/*
 * CodeMirror 6 lifecycle (#399). This module is the only place in the
 * package that touches the @codemirror family; it is reached through a
 * dynamic import from `code-editor.tsx` so the editor rides its own lazy
 * chunk and Chat/Virtual graphs never pull a renderer chunk. Language
 * packages are a later compartment — the state is built so a language
 * compartment can be reconfigured without rebuilding the view.
 */
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  bracketMatching,
  defaultHighlightStyle,
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
      lineNumbers(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      history(),
      languageCompartment.of([]),
      editableCompartment.of(EditorView.editable.of(options.editable)),
      saveKeymap,
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      markEdited,
      EditorView.theme({
        '&': { height: '100%' },
        '.cm-scroller': { overflow: 'auto' },
      }),
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
