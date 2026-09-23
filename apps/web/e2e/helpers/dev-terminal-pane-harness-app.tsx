// Browser-side harness for the REAL dev-view terminal pane (#538 Playwright
// lane). This module is served through the app's own Vite dev server (loaded
// via /@fs/ so vite-plugin-solid compiles it exactly like application code)
// and mounts packages/dev-view/src/terminal/terminal-pane.tsx against a
// scripted terminal-bytes-v1 socket the spec drives through
// window.__adeaTerminalPaneHarness. It is never imported by the Playwright
// runner itself; the spec-side half is dev-terminal-pane-harness.ts.
//
// The scripted socket mirrors the fixture journey's contract (opened → data …,
// input frames back) so the pane sees the same surface the Dev Runtime stream
// provides, including a close/reopen cycle that stands in for a sidecar
// restart: the pane's transport reconnects with a fresh grant and a bumped
// generation, exactly as it would against a restarted sidecar.
import { render } from 'solid-js/web'

import { TerminalPane, type TerminalPaneProps } from '@adea-ai/dev-view/terminal'
import type { DevStreamFrame, ShellProfile } from '@adea-ai/types/dev-runtime'

type ConnectHandlers = Parameters<TerminalPaneProps['connect']>[0]
type StreamSocket = ReturnType<TerminalPaneProps['connect']>
type ObservationHandler = Parameters<NonNullable<TerminalPaneProps['subscribeToObservations']>>[0]
type ShellObservation = Parameters<ObservationHandler>[0]

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const state = {
  /** Next output sequence the scripted sidecar will emit. */
  nextSeq: 0,
  generation: 1,
  socketSerial: 0,
  activeSocketSerial: 0,
  handlers: null as ConnectHandlers | null,
  inputsByGeneration: new Map<number, string[]>(),
  resizes: [] as Array<{ cols: number; rows: number; generation: number }>,
  copies: [] as string[],
  restarts: 0,
  dataFramesEmitted: 0,
  echo: true,
}

function recordInput(generation: number, bytes: Uint8Array): void {
  const list = state.inputsByGeneration.get(generation) ?? []
  list.push(decoder.decode(bytes))
  state.inputsByGeneration.set(generation, list)
}

/** One scripted sidecar connection; a restart retires the previous one. */
function scriptedConnect(handlers: ConnectHandlers): StreamSocket {
  state.handlers = handlers
  const serial = ++state.socketSerial
  state.activeSocketSerial = serial
  const generation = state.generation
  let open = true
  const socket = {
    get open() {
      return open && state.activeSocketSerial === serial
    },
    bufferedAmount: 0,
    send: (frame: DevStreamFrame) => {
      if (frame.type !== 'input') return
      recordInput(generation, frame.bytes)
      // A real PTY echoes what it receives; the scripted sidecar mirrors that
      // so the round trip is observable for every input seam — the compose
      // editor's `write` prop and the surface's transport queue alike.
      if (state.echo) writeOutput(decoder.decode(frame.bytes))
    },
    close: () => {
      open = false
    },
  }
  queueMicrotask(() => {
    handlers.onFrame({
      type: 'opened',
      protocol: 'terminal-bytes-v1',
      generation,
      nextSequence: String(state.nextSeq),
    })
    // Replay the durable anchor line so attach-time rendering is observable.
    handlers.onFrame({
      type: 'data',
      sequence: String(state.nextSeq++),
      bytes: encoder.encode('scripted sidecar attached (generation ' + generation + ')\r\n'),
    })
  })
  return socket as unknown as StreamSocket
}

/** Emits one data frame with the next sequence, like the live PTY stream. */
function writeOutput(text: string): void {
  if (!state.handlers) return
  state.dataFramesEmitted += 1
  state.handlers.onFrame({
    type: 'data',
    sequence: String(state.nextSeq++),
    bytes: encoder.encode(text),
  })
}

/** Closes the live socket; the pane's transport reconnects (new grant). */
function restartSidecar(): void {
  state.restarts += 1
  state.generation += 1
  const handlers = state.handlers
  state.handlers = null
  state.activeSocketSerial = 0
  handlers?.onClose()
}

function subscribeToObservations(handler: ObservationHandler): () => void {
  const at = new Date().toISOString()
  const observations: ShellObservation[] = [
    { kind: 'preexec', command: 'printf fixture', at, sequence: '0' },
    { kind: 'cwd', cwd: '/fixture/runtime', at },
    { kind: 'precmd', exitCode: 0, at, sequence: '0' },
  ]
  queueMicrotask(() => {
    for (const observation of observations) handler(observation)
  })
  return () => undefined
}

const harness = {
  write: writeOutput,
  restart: restartSidecar,
  setEcho(on: boolean) {
    state.echo = on
  },
  report() {
    return {
      generation: state.generation,
      sockets: state.socketSerial,
      restarts: state.restarts,
      dataFramesEmitted: state.dataFramesEmitted,
      inputsByGeneration: Object.fromEntries(state.inputsByGeneration),
      resizes: state.resizes,
      copies: state.copies,
    }
  },
}

export type TerminalPaneHarness = typeof harness

declare global {
  interface Window {
    __adeaTerminalPaneHarness: TerminalPaneHarness
  }
}

function mount() {
  const container = document.getElementById('harness-root')
  if (!container) throw new Error('harness root missing')
  const shellProfiles: readonly ShellProfile[] = [{ id: 'sh', label: 'sh', argv: ['/bin/sh'] }]
  render(
    () => (
      <TerminalPane
        connect={scriptedConnect}
        fromSequence="0"
        subscribeToObservations={subscribeToObservations}
        write={(bytes) => {
          recordInput(state.generation, bytes)
          if (state.echo) writeOutput(decoder.decode(bytes))
          return true
        }}
        resize={(cols, rows) => {
          state.resizes.push({ cols, rows, generation: state.generation })
        }}
        copyText={async (text) => {
          state.copies.push(text)
          return 'granted'
        }}
        worktreeId="fixture-worktree"
        worktreeLabel="Example project"
        shellProfiles={shellProfiles}
        preferredShell="/bin/sh"
      />
    ),
    container
  )
  window.__adeaTerminalPaneHarness = harness
}

mount()
