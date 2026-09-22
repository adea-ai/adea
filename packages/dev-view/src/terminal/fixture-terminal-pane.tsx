import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js'

import type { DevStreamFrame } from '@adea-ai/types/dev-runtime'

import { createTerminalTransport, type TerminalStreamSocket } from './transport'
import type { ShellObservation } from './blocks'

/**
 * Small fixture renderer for the authenticated terminal journey.
 *
 * The production TerminalPane stays behind its own package entry and keeps the
 * full xterm/WebGL implementation. The fixture route only needs to exercise
 * the authenticated transport, observation authority, reconnect, and pane
 * accessibility contract; shipping xterm into every Dev View client chunk
 * would waste the 1.6 MB client budget before a real terminal is opened.
 */
export type FixtureTerminalPaneProps = Readonly<{
  connect: (handlers: {
    onFrame: (frame: DevStreamFrame) => void
    onClose: () => void
  }) => TerminalStreamSocket
  fromSequence: string
  subscribeToObservations?: (handler: (observation: ShellObservation) => void) => () => void
  worktreeLabel?: string
  write?: (bytes: Uint8Array) => boolean
}>

export function FixtureTerminalPane(props: FixtureTerminalPaneProps) {
  const [connection, setConnection] = createSignal('connecting')
  const [output, setOutput] = createSignal('')
  const [observations, setObservations] = createSignal<ShellObservation[]>([])
  const [searchOpen, setSearchOpen] = createSignal(false)
  const [query, setQuery] = createSignal('')
  const [searchInput, setSearchInput] = createSignal<HTMLInputElement>()

  const transport = createTerminalTransport({
    connect: props.connect,
    onOutput: (_sequence, bytes) => {
      setOutput((current) => current + new TextDecoder().decode(bytes))
    },
    onConnectionState: setConnection,
  })

  const cwd = createMemo(() => {
    const latest = observations()
      .toReversed()
      .find((observation) => observation.kind === 'cwd')
    return latest?.kind === 'cwd' ? latest.cwd : undefined
  })
  const searchMatches = createMemo(() => {
    const needle = query().trim()
    if (!needle) return 0
    return output().toLowerCase().split(needle.toLowerCase()).length - 1
  })

  function onKeyDown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      setSearchOpen(true)
      requestAnimationFrame(() => searchInput()?.focus())
    }
  }

  onMount(() => {
    transport.start(props.fromSequence)
    const unsubscribe = props.subscribeToObservations?.((observation) =>
      setObservations((current) => [...current, observation])
    )
    onCleanup(unsubscribe ?? (() => undefined))
  })

  onCleanup(() => transport.dispose())

  return (
    <section
      aria-label={
        props.worktreeLabel ? `Integrated terminal — ${props.worktreeLabel}` : 'Integrated terminal'
      }
      class="dev-terminal-pane"
      data-attach-from={props.fromSequence}
      data-renderer="dom"
      onKeyDown={onKeyDown}
      role="region"
      tabIndex={0}
    >
      <div class="dev-terminal-pane-status" data-state={connection()}>
        {connection() === 'reconnecting' ? 'reconnecting' : connection()}
      </div>
      <div
        class="dev-terminal-pane-integration"
        data-status={observations().length ? 'active' : 'pending'}
      >
        {observations().length
          ? 'Authenticated shell integration'
          : 'Waiting for shell integration'}
      </div>
      <div class="dev-terminal-pane-cwd" data-cwd-source={cwd() ? 'authenticated' : 'pending'}>
        {cwd() ?? 'Awaiting authenticated cwd'}
      </div>
      <div aria-label="Terminal output" class="dev-terminal-surface" tabIndex={0}>
        <pre>{output()}</pre>
      </div>
      <ul aria-label="Command blocks">
        <For each={observations().filter((observation) => observation.kind === 'precmd')}>
          {(observation) => (
            <li
              aria-label={`${observation.kind === 'precmd' ? `printf fixture, exit ${observation.exitCode}` : ''}`}
            >
              {observation.kind === 'precmd' ? `printf fixture, exit ${observation.exitCode}` : ''}
            </li>
          )}
        </For>
      </ul>
      <Show when={searchOpen()}>
        <div aria-label="Search terminal" class="dev-terminal-search" role="search">
          <input
            aria-label="Search terminal"
            ref={setSearchInput}
            type="search"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          <span class="dev-terminal-search-count">
            {searchMatches()} {searchMatches() === 1 ? 'match' : 'matches'}
          </span>
          <button type="button" aria-label="Close search" onClick={() => setSearchOpen(false)}>
            Close
          </button>
        </div>
      </Show>
      <input
        aria-label="Compose terminal input"
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          const target = event.currentTarget
          props.write?.(new TextEncoder().encode(`${target.value}\n`))
          target.value = ''
        }}
        type="text"
      />
    </section>
  )
}
