// The terminal pane (issue #396): xterm renderer with lazy WebGL and DOM
// recovery, the authenticated transport, the command-block rail, and the
// bottom input editor. Composition only — every decision lives in the tested
// pure modules beside this file.
import { createSignal, onCleanup, onMount, Show } from 'solid-js'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { WebglAddon } from '@xterm/addon-webgl'

import type { DevStreamFrame } from '@adea-ai/types/dev-runtime'
import {
  applyObservation,
  blockExportText,
  createBlocksState,
  visibleBlocks,
  type ShellObservation,
} from './blocks'
import {
  createEditorState,
  editorChangeDraft,
  editorConfirmPaste,
  editorHistoryStep,
  editorRejectPaste,
  editorSend,
  editorStagePaste,
  editorToggleMode,
} from './editor'
import { createRendererPolicy } from './renderer-policy'
import { createTerminalTransport, type TerminalStreamSocket } from './transport'

export type TerminalPaneProps = {
  /** Opens one authenticated terminal-bytes-v1 stream (new grant per call). */
  connect: (handlers: {
    onFrame: (frame: DevStreamFrame) => void
    onClose: () => void
  }) => TerminalStreamSocket
  /** The grant's starting sequence for this attach. */
  fromSequence: string
  /**
   * Subscribes to authenticated shell-protocol observations from the host
   * wrapper (OSC 133/7, MAC-verified server-side). Returns the unsubscribe
   * function.
   */
  subscribeToObservations?: (handler: (observation: ShellObservation) => void) => () => void
  /** Multiline, history-aware send path into the active terminal. */
  write: (bytes: Uint8Array) => boolean
  resize: (cols: number, rows: number) => void
  onClose?: () => void
}

const THEME = {
  cursor: '#e6e6e6',
  cursorAccent: '#111111',
  selectionBackground: '#3b4252',
} as const

export function TerminalPane(props: TerminalPaneProps) {
  const [surface, setSurface] = createSignal<HTMLDivElement | null>(null)
  const policy = createRendererPolicy()
  const [policyVersion, setPolicyVersion] = createSignal(0)
  const [blocks, setBlocks] = createSignal(createBlocksState())
  const [editor, setEditor] = createSignal(createEditorState())
  const [connection, setConnection] = createSignal('connecting')

  const terminal = new Terminal({
    theme: THEME,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    allowProposedApi: true,
  })
  const fit = new FitAddon()
  const search = new SearchAddon()
  const serialize = new SerializeAddon()
  terminal.loadAddon(fit)
  terminal.loadAddon(search)
  terminal.loadAddon(serialize)

  const transport = createTerminalTransport({
    connect: props.connect,
    onOutput: (_sequence, bytes) => {
      terminal.write(bytes)
    },
    onConnectionState: setConnection,
    onSequenceGap: () => transport.resyncFrom('0'),
    onResyncRequired: (checkpointSequence) => transport.resyncFrom(checkpointSequence),
    onInputOverflow: () => {
      terminal.writeln('\r\n[adea: input queue full — backpressure]')
    },
  })

  function recordObservation(observation: ShellObservation, sequence: string): void {
    const at = new Date().toISOString()
    if (observation.kind === 'preexec') {
      setBlocks(
        applyObservation(blocks(), { kind: 'preexec', command: observation.command, at, sequence })
      )
      return
    }
    if (observation.kind === 'precmd') {
      setBlocks(
        applyObservation(blocks(), { kind: 'precmd', exitCode: observation.exitCode, at, sequence })
      )
      return
    }
    setBlocks(applyObservation(blocks(), { kind: 'cwd', cwd: observation.cwd, at }))
  }

  onMount(() => {
    const element = surface()
    if (!element) return
    terminal.open(element)
    terminal.focus()
    // Lazy WebGL first; DOM is the fallback on any failure or context loss.
    const next = policy.mounted()
    setPolicyVersion((version) => version + 1)
    if (next.active === 'webgl') {
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => {
          const result = policy.contextLost()
          webgl.dispose()
          setPolicyVersion((version) => version + 1)
          if (result.retryWebgl) {
            try {
              terminal.loadAddon(new WebglAddon())
              policy.webglRestored()
              setPolicyVersion((version) => version + 1)
            } catch {
              /* stays on DOM */
            }
          }
        })
        terminal.loadAddon(webgl)
      } catch {
        policy.webglInitFailed('addon unavailable')
        setPolicyVersion((version) => version + 1)
      }
    }
    fit.fit()
    transport.start(props.fromSequence)
    const unsubscribe = props.subscribeToObservations?.((observation) =>
      recordObservation(observation, transport.snapshot().nextOutputSeq)
    )
    onCleanup(unsubscribe ?? (() => undefined))
  })

  const observer = new ResizeObserver(() => {
    const element = surface()
    if (!element) return
    const cols = terminal.cols
    const rows = terminal.rows
    fit.fit()
    if (terminal.cols !== cols || terminal.rows !== rows) {
      props.resize(terminal.cols, terminal.rows)
    }
  })
  onCleanup(() => {
    observer.disconnect()
    transport.dispose()
    terminal.dispose()
  })

  function onSurfaceKeyDown(event: KeyboardEvent): void {
    if (event.key === 'f' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      const query = window.prompt?.('Search terminal')
      if (query) search.findNext(query)
    }
  }

  function sendDraft(): void {
    const result = editorSend(editor())
    if (!result) return
    setEditor(result.state)
    props.write(new TextEncoder().encode(`${result.payload}\n`))
  }

  return (
    <section
      class="dev-terminal-pane"
      aria-label="Integrated terminal"
      data-policy-version={policyVersion()}
    >
      <header class="dev-terminal-pane-header">
        <span class="dev-terminal-pane-status" data-state={connection()}>
          {connection()}
        </span>
        <Show when={blocks().cwd}>
          <span class="dev-terminal-pane-cwd">{blocks().cwd}</span>
        </Show>
      </header>
      <div class="dev-terminal-blocks" role="list" aria-label="Command blocks">
        {visibleBlocks(blocks())
          .slice(-8)
          .map((block) => (
            <div role="listitem" class="dev-terminal-block" data-state={block.state}>
              <code>{block.command}</code>
              <Show when={block.state === 'completed'}>
                <span>
                  exit {block.exitCode} · {block.durationMs}ms
                </span>
              </Show>
              <Show when={blockExportText(block)}>
                {(text) => (
                  <button type="button" onClick={() => void navigator.clipboard?.writeText(text())}>
                    Copy
                  </button>
                )}
              </Show>
            </div>
          ))}
      </div>
      <div class="dev-terminal-surface" ref={setSurface} onKeyDown={onSurfaceKeyDown} />
      <Show
        when={editor().mode === 'compose'}
        fallback={
          <p class="dev-terminal-raw-note">Raw keyboard mode — press the toggle to compose.</p>
        }
      >
        <div class="dev-terminal-editor">
          <textarea
            rows={2}
            aria-label="Compose terminal input"
            value={editor().draft}
            onInput={(event) => setEditor(editorChangeDraft(editor(), event.currentTarget.value))}
            onPaste={(event) => {
              const text = event.clipboardData?.getData('text') ?? ''
              if (editor().pendingPaste !== undefined) return
              const staged = editorStagePaste(editor(), text)
              if (staged.pendingPaste !== undefined) event.preventDefault()
              setEditor(staged)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                sendDraft()
                return
              }
              if (event.key === 'ArrowUp' && event.altKey) {
                event.preventDefault()
                setEditor(editorHistoryStep(editor(), 'up'))
                return
              }
              if (event.key === 'ArrowDown' && event.altKey) {
                event.preventDefault()
                setEditor(editorHistoryStep(editor(), 'down'))
              }
            }}
          />
          <Show when={editor().pendingPaste !== undefined}>
            <div class="dev-terminal-paste-confirm" role="alertdialog" aria-label="Confirm paste">
              <span>Paste contains multiple lines or control characters. Send anyway?</span>
              <button type="button" onClick={() => setEditor(editorConfirmPaste(editor()))}>
                Paste
              </button>
              <button type="button" onClick={() => setEditor(editorRejectPaste(editor()))}>
                Cancel
              </button>
            </div>
          </Show>
          <footer>
            <button type="button" onClick={sendDraft}>
              {editor().sendLabel}
            </button>
            <button type="button" onClick={() => setEditor(editorToggleMode(editor()))}>
              Raw mode
            </button>
          </footer>
        </div>
      </Show>
      <Show when={editor().mode === 'raw'}>
        <button type="button" onClick={() => setEditor(editorToggleMode(editor()))}>
          Compose mode
        </button>
      </Show>
    </section>
  )
}
