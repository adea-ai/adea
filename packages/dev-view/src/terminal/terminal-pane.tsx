// The terminal pane (issue #396): xterm renderer with lazy WebGL and DOM
// recovery, the authenticated transport, the command-block rail, the bottom
// input editor, and the pane UX depth — OSC 7/133 stream parsing with typed
// shell-integration availability, selection + permissioned clipboard copy,
// consented external links, in-pane search with match counts, confirmed
// multiline paste (bracketed), IME-safe shortcuts, raw-mode TUI pass-through,
// per-worktree identity, and the typed fallback shell chooser. Composition
// only — every decision lives in the tested pure modules beside this file.
import {
  createEffect,
  createMemo,
  createRenderEffect,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from 'solid-js'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'

import type { DevStreamFrame, ShellProfile } from '@adea-ai/types/dev-runtime'
import {
  applyObservation,
  blockExportText,
  createBlocksState,
  visibleBlocks,
  type ShellObservation,
} from './blocks'
import {
  applyCopyOutcome,
  classifyClipboardFailure,
  clipboardPresentation,
  createClipboardState,
  type ClipboardOutcome,
} from './clipboard'
import {
  createEditorState,
  editorChangeDraft,
  editorConfirmPaste,
  editorHistoryStep,
  editorRejectPaste,
  editorSend,
  editorStagePaste,
  editorToggleMode,
  pasteNeedsConfirmation,
} from './editor'
import {
  createIntegrationState,
  integrationAnnouncement,
  integrationPresentation,
  reduceIntegration,
} from './integration'
import { isImeComposing, routePaneKey } from './pane-keys'
import { createRendererPolicy } from './renderer-policy'
import {
  createSearchState,
  searchClose,
  searchConsumeStep,
  searchOpen as searchOpenState,
  searchPresentation,
  searchSetQuery,
  searchSetResults,
  searchStep,
  searchToggleCaseSensitive,
} from './search-model'
import {
  chooseShellProfile,
  createShellSelection,
  profileIntegrationNote,
  shellSelectionPresentation,
} from './shell-fallback'
import { parseOsc133Marker, parseOsc7Cwd } from './shell-events'
import { createTerminalTransport, type TerminalStreamSocket } from './transport'
import './terminal-pane.css'

export type TerminalPaneProps = {
  /** Opens one authenticated terminal-bytes-v1 stream (new grant per call). */
  connect: (handlers: {
    onFrame: (frame: DevStreamFrame) => void
    onClose: () => void
  }) => TerminalStreamSocket
  /** The grant's starting sequence for this attach; replay restores scrollback. */
  fromSequence: string
  /**
   * Subscribes to authenticated shell-protocol observations from the host
   * wrapper (OSC 133/7, MAC-verified server-side). Returns the unsubscribe
   * function. This is the ONLY authority for command blocks and exit codes.
   */
  subscribeToObservations?: (handler: (observation: ShellObservation) => void) => () => void
  /** Multiline, history-aware send path into the active terminal. */
  write: (bytes: Uint8Array) => boolean
  resize: (cols: number, rows: number) => void
  /**
   * The permissioned clipboard seam (#471 substrate). When absent the pane
   * degrades to the browser clipboard with typed denial handling.
   */
  copyText?: (text: string) => Promise<ClipboardOutcome>
  /**
   * The consented external-open seam. When absent, links are reported as
   * unavailable — the pane never opens a URL on its own authority.
   */
  openExternal?: (url: string) => Promise<ClipboardOutcome>
  /** Wrapper feature set the host declared for this terminal (may be empty). */
  hostFeatures?: readonly string[]
  /** Per-worktree identity for the pane header and DOM (tab identity). */
  worktreeId?: string
  worktreeLabel?: string
  /**
   * Host-advertised shell profiles (each backed by an installed wrapper).
   * Provided together with `onShellProfileSelected`, they power the typed
   * fallback chooser when the preferred shell is missing.
   */
  shellProfiles?: readonly ShellProfile[]
  /** The user's preferred shell ($SHELL), when the host knows it. */
  preferredShell?: string
  /** Reports the user's confirmed shell choice; never called automatically. */
  onShellProfileSelected?: (profileId: string) => void
  /** Per-worktree seed for the bottom editor's command history. */
  commandHistory?: readonly string[]
  onClose?: () => void
}

const THEME = {
  cursor: '#e6e6e6',
  cursorAccent: '#111111',
  selectionBackground: '#3b4252',
} as const

const SEARCH_DECORATIONS = {
  matchBackground: '#3b4252',
  matchOverviewRuler: '#88c0d0',
  activeMatchBackground: '#4c566a',
  activeMatchColorOverviewRuler: '#ebcb8b',
} as const

export function TerminalPane(props: TerminalPaneProps) {
  const [surface, setSurface] = createSignal<HTMLDivElement | null>(null)
  const policy = createRendererPolicy()
  const [policyVersion, setPolicyVersion] = createSignal(0)
  const [blocks, setBlocks] = createSignal(createBlocksState())
  const [editor, setEditor] = createSignal(createEditorState(props.commandHistory ?? []))
  const [connection, setConnection] = createSignal('connecting')
  const [clipboard, setClipboard] = createSignal(createClipboardState())
  const [search, setSearch] = createSignal(createSearchState())
  const [integration, setIntegration] = createSignal(
    createIntegrationState(props.hostFeatures ?? [])
  )
  const [cwd, setCwd] = createSignal<
    { cwd: string; source: 'authenticated' | 'stream' } | undefined
  >(undefined)
  const [hasSelection, setHasSelection] = createSignal(false)
  const [surfacePaste, setSurfacePaste] = createSignal<string | undefined>(undefined)
  const [announcement, setAnnouncement] = createSignal('')
  const [linkStatus, setLinkStatus] = createSignal('')
  const [shellSelection, setShellSelection] = createSignal(
    createShellSelection({
      preferredShell: props.preferredShell,
      profiles: props.shellProfiles ?? [],
    })
  )

  const terminal = new Terminal({
    theme: THEME,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    allowProposedApi: true,
    // OSC 8 hyperlinks open only through the consented seam below.
    linkHandler: {
      activate: (_event, text) => {
        void openWithConsent(text)
      },
    },
  })
  const fit = new FitAddon()
  const searchAddon = new SearchAddon()
  const serialize = new SerializeAddon()
  terminal.loadAddon(fit)
  terminal.loadAddon(searchAddon)
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
    setIntegration((state) => reduceIntegration(state, { type: 'observation' }))
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
    setCwd({ cwd: observation.cwd, source: 'authenticated' })
  }

  // ── Permissioned clipboard copy ───────────────────────────────────────────

  async function copyThroughSeam(text: string): Promise<ClipboardOutcome> {
    if (props.copyText) return props.copyText(text)
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return 'unavailable'
    try {
      await navigator.clipboard.writeText(text)
      return 'granted'
    } catch (error) {
      return classifyClipboardFailure(error)
    }
  }

  async function copySelection(): Promise<void> {
    const text = terminal.hasSelection() ? terminal.getSelection() : ''
    if (text === '') return
    const outcome = await copyThroughSeam(text)
    setClipboard(applyCopyOutcome(clipboard(), outcome))
  }

  const clipboardPresent = createMemo(() => clipboardPresentation(clipboard()))

  // ── Consented external links (OSC 8 + URL detection) ─────────────────────

  async function openWithConsent(url: string): Promise<void> {
    if (!/^https?:\/\//i.test(url)) {
      setLinkStatus('Link not opened: only http and https links are supported')
      return
    }
    if (!props.openExternal) {
      setLinkStatus('Link not opened: no external-open permission is bound')
      return
    }
    const outcome = await props.openExternal(url)
    setLinkStatus(
      outcome === 'granted'
        ? `Opened link: ${url}`
        : outcome === 'denied'
          ? 'Link not opened: external open was denied'
          : 'Link not opened: external open is unavailable'
    )
  }

  // ── Key routing (IME-safe, TUI pass-through) ──────────────────────────────

  function runPaneKeyAction(action: ReturnType<typeof routePaneKey>, event: Event): boolean {
    if (action === 'search') {
      event.preventDefault()
      setSearch((state) => searchOpenState(state))
      return true
    }
    if (action === 'copy-selection') {
      event.preventDefault()
      void copySelection()
      return true
    }
    return false
  }

  function onSectionKeyDown(event: KeyboardEvent): void {
    // The terminal's own textarea bubbles keydowns here; its path is owned by
    // the custom key handler below, so only editor/chooser targets route here.
    if (event.target === terminal.textarea) return
    runPaneKeyAction(routePaneKey(event, editor().mode), event)
  }

  // ── In-pane search ────────────────────────────────────────────────────────

  let searchInputElement: HTMLInputElement | undefined

  function runFind(
    state: ReturnType<typeof createSearchState>,
    direction: 'next' | 'previous'
  ): void {
    const options = {
      caseSensitive: state.caseSensitive,
      decorations: SEARCH_DECORATIONS,
      noScroll: false,
    }
    if (direction === 'next') void searchAddon.findNext(state.query, options)
    else void searchAddon.findPrevious(state.query, options)
  }

  // The search signal changes on every results event too, so the effect must
  // not blindly re-find on each of its own updates: it would fight the
  // Previous stepper (every step's findPrevious is undone by the effect's
  // findNext) and eventually overflow the stack. Re-find only when the search
  // inputs themselves changed. (Found by the dev-view-terminal-pane
  // Playwright lane, #538.)
  let lastFindKey = ''
  createEffect(() => {
    const state = search()
    const key = `${state.open}\u0000${state.query}\u0000${state.caseSensitive}`
    if (key === lastFindKey) return
    lastFindKey = key
    if (!state.open) {
      searchAddon.clearDecorations()
      return
    }
    if (state.query === '') {
      searchAddon.clearDecorations()
      return
    }
    runFind(state, 'next')
    if (searchInputElement) searchInputElement.focus()
  })

  // ── Multiline paste (bracketed) with confirmation ─────────────────────────

  function onSurfacePaste(event: ClipboardEvent): void {
    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (text === '') return
    // The pane owns every surface paste: bracketed-paste framing is applied
    // by terminal.paste, and multiline or control-bearing text confirms first.
    event.preventDefault()
    if (pasteNeedsConfirmation(text)) {
      setSurfacePaste(text)
      return
    }
    terminal.paste(text)
  }

  function confirmSurfacePaste(): void {
    const text = surfacePaste()
    setSurfacePaste(undefined)
    if (text !== undefined) terminal.paste(text)
    terminal.focus()
  }

  function rejectSurfacePaste(): void {
    setSurfacePaste(undefined)
    terminal.focus()
  }

  // ── Typed fallback shell selection ────────────────────────────────────────

  const shellPresent = createMemo(() => shellSelectionPresentation(shellSelection()))

  function pickShellProfile(profileId: string): void {
    const profiles = props.shellProfiles ?? []
    const next = chooseShellProfile(shellSelection(), profiles, profileId)
    if (!next.confirmed) return
    setShellSelection(next)
    props.onShellProfileSelected?.(profileId)
  }

  // ── Integration announcements ─────────────────────────────────────────────

  const integrationPresent = createMemo(() => integrationPresentation(integration()))
  let previousIntegration = integrationPresent()
  createRenderEffect(() => {
    const after = integrationPresent()
    const message = integrationAnnouncement(previousIntegration, after)
    if (message) setAnnouncement(message)
    previousIntegration = after
  })

  onMount(() => {
    const element = surface()
    if (!element) return
    terminal.open(element)
    terminal.focus()
    // The resize observer must actually observe the surface: without this the
    // fit/refit ladder never runs and props.resize can never fire (found by
    // the dev-view-terminal-pane Playwright lane, #538).
    observer.observe(element)
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
    // OSC 7 and standard OSC 133 arrive in the display stream only when the
    // user's own shell emits them (the Adea wrapper's frames are verified and
    // stripped server-side). They feed the cwd hint and the integration
    // detector — never command blocks.
    terminal.parser.registerOscHandler(7, (data) => {
      const parsed = parseOsc7Cwd(data)
      if (!parsed) return false
      setIntegration((state) => reduceIntegration(state, { type: 'stream-cwd' }))
      setCwd((current) =>
        current?.source === 'authenticated' ? current : { cwd: parsed.cwd, source: 'stream' }
      )
      return false
    })
    terminal.parser.registerOscHandler(133, (data) => {
      const parsed = parseOsc133Marker(data)
      if (!parsed) return false
      setIntegration((state) => reduceIntegration(state, { type: 'stream-marker' }))
      return false
    })
    // URL detection rides the consented open seam; OSC 8 hyperlinks go through
    // the linkHandler above.
    terminal.loadAddon(new WebLinksAddon((_event, uri) => void openWithConsent(uri)))
    terminal.onSelectionChange(() => setHasSelection(terminal.hasSelection()))
    searchAddon.onDidChangeResults((results) => {
      setSearch((state) => searchSetResults(state, results))
    })
    terminal.attachCustomKeyEventHandler(
      (event) => !runPaneKeyAction(routePaneKey(event, editor().mode), event)
    )
    // Captured before xterm's textarea: the pane owns the paste path.
    element.addEventListener('paste', onSurfacePaste, true)
    onCleanup(() => element.removeEventListener('paste', onSurfacePaste, true))
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

  function sendDraft(): void {
    const result = editorSend(editor())
    if (!result) return
    setEditor(result.state)
    props.write(new TextEncoder().encode(`${result.payload}\n`))
  }

  function closeSearch(): void {
    setSearch((state) => searchClose(state))
    terminal.focus()
  }

  function onSearchInputKeyDown(event: KeyboardEvent): void {
    if (isImeComposing(event)) return
    if (event.key === 'Enter') {
      event.preventDefault()
      const direction = event.shiftKey ? 'previous' : 'next'
      const stepped = searchStep(search(), direction)
      setSearch(stepped)
      if (stepped.requested !== undefined) {
        runFind(stepped, stepped.requested)
        setSearch(searchConsumeStep(stepped))
      }
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      closeSearch()
    }
  }

  const searchPresent = createMemo(() => searchPresentation(search()))

  return (
    <section
      class="dev-terminal-pane"
      aria-label={
        props.worktreeLabel ? `Integrated terminal — ${props.worktreeLabel}` : 'Integrated terminal'
      }
      data-policy-version={policyVersion()}
      data-renderer={policy.snapshot().active}
      data-worktree-id={props.worktreeId}
      data-attach-from={props.fromSequence}
      onKeyDown={onSectionKeyDown}
    >
      <header class="dev-terminal-pane-header">
        <span class="dev-terminal-pane-status" data-state={connection()}>
          {connection()}
        </span>
        <Show when={props.worktreeLabel}>
          <span class="dev-terminal-pane-worktree">{props.worktreeLabel}</span>
        </Show>
        <span
          class="dev-terminal-pane-integration"
          data-status={integrationPresent().status}
          title={integrationPresent().detail}
        >
          {integrationPresent().label}
        </span>
        <Show when={cwd()}>
          {(current) => (
            <span
              class="dev-terminal-pane-cwd"
              data-cwd-source={current().source}
              title={current().cwd}
            >
              {current().cwd}
            </span>
          )}
        </Show>
        <button
          type="button"
          class="dev-terminal-copy-button"
          data-degraded={clipboardPresent().degraded ? 'true' : undefined}
          disabled={!hasSelection()}
          onClick={() => void copySelection()}
        >
          {clipboardPresent().label}
        </button>
        <Show when={clipboardPresent().hint}>
          <span class="dev-terminal-hint">{clipboardPresent().hint}</span>
        </Show>
      </header>
      <div class="dev-terminal-blocks" role="list" aria-label="Command blocks">
        {visibleBlocks(blocks())
          .slice(-8)
          .map((block) => (
            <div
              role="listitem"
              class="dev-terminal-block"
              data-state={block.state}
              aria-label={
                block.state === 'completed'
                  ? `${block.command}, exit ${block.exitCode}, ${block.durationMs} milliseconds`
                  : `${block.command}, running`
              }
            >
              <code>{block.command}</code>
              <Show when={block.state === 'completed'}>
                <span class="dev-terminal-block-exit" data-exit={block.exitCode}>
                  exit {block.exitCode} · {block.durationMs}ms
                </span>
              </Show>
              <Show when={blockExportText(block)}>
                {(text) => (
                  <button
                    type="button"
                    class="dev-terminal-copy-button"
                    onClick={() =>
                      void copyThroughSeam(text()).then((outcome) => {
                        setClipboard(applyCopyOutcome(clipboard(), outcome))
                      })
                    }
                  >
                    Copy
                  </button>
                )}
              </Show>
            </div>
          ))}
      </div>
      <div class="dev-terminal-surface-anchor">
        <div class="dev-terminal-surface" ref={setSurface} />
        <Show when={search().open}>
          <div class="dev-terminal-search" role="search" aria-label="Search terminal">
            <input
              ref={(element) => (searchInputElement = element)}
              type="text"
              placeholder="Search terminal"
              aria-label="Search terminal"
              value={search().query}
              onKeyDown={onSearchInputKeyDown}
              onInput={(event) => setSearch(searchSetQuery(search(), event.currentTarget.value))}
            />
            <button
              type="button"
              aria-label="Previous match"
              disabled={!searchPresent().steppable}
              onClick={() => {
                const stepped = searchStep(search(), 'previous')
                setSearch(stepped)
                if (stepped.requested !== undefined) {
                  runFind(stepped, stepped.requested)
                  setSearch(searchConsumeStep(stepped))
                }
              }}
            >
              ↑
            </button>
            <button
              type="button"
              aria-label="Next match"
              disabled={!searchPresent().steppable}
              onClick={() => {
                const stepped = searchStep(search(), 'next')
                setSearch(stepped)
                if (stepped.requested !== undefined) {
                  runFind(stepped, stepped.requested)
                  setSearch(searchConsumeStep(stepped))
                }
              }}
            >
              ↓
            </button>
            <button type="button" aria-label="Close search" onClick={closeSearch}>
              ×
            </button>
            <span class="dev-terminal-search-count" aria-live="polite">
              {searchPresent().count}
            </span>
            <label class="dev-terminal-search-case">
              <input
                type="checkbox"
                checked={search().caseSensitive}
                onChange={() => setSearch(searchToggleCaseSensitive(search()))}
              />
              Aa
            </label>
          </div>
        </Show>
        <Show when={surfacePaste !== undefined}>
          <div class="dev-terminal-paste-confirm" role="alertdialog" aria-label="Confirm paste">
            <span>Paste contains multiple lines or control characters. Send anyway?</span>
            <button type="button" onClick={confirmSurfacePaste}>
              Paste
            </button>
            <button type="button" onClick={rejectSurfacePaste}>
              Cancel
            </button>
          </div>
        </Show>
      </div>
      <Show
        when={editor().mode === 'compose'}
        fallback={
          <div class="dev-terminal-raw-note">
            <p>
              Raw keyboard mode — every key reaches the terminal. Paste with the system shortcut;
              multiline pastes ask first.
            </p>
            <button type="button" onClick={() => setEditor(editorToggleMode(editor()))}>
              Compose mode
            </button>
          </div>
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
              if (isImeComposing(event)) return
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
      <Show when={shellPresent().showChooser}>
        <div class="dev-terminal-shell-chooser" role="group" aria-label={shellPresent().heading}>
          <h2>{shellPresent().heading}</h2>
          <p>{shellPresent().detail}</p>
          <ul>
            {(props.shellProfiles ?? []).map((profile) => (
              <li>
                <button
                  type="button"
                  onClick={() => pickShellProfile(profile.id)}
                  aria-pressed={shellSelection().selectedProfileId === profile.id}
                >
                  {profile.label}
                  <span class="dev-terminal-shell-path">{profile.argv.join(' ')}</span>
                </button>
                <Show when={profileIntegrationNote(profile)}>
                  {(note) => <p class="dev-terminal-hint">{note()}</p>}
                </Show>
              </li>
            ))}
          </ul>
        </div>
      </Show>
      <span class="dev-terminal-sr" aria-live="polite">
        {announcement() || linkStatus()}
      </span>
    </section>
  )
}
