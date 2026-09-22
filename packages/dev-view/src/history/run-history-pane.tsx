/*
 * Run history pane (#400): bounded, newest-first HarnessRun history built by
 * the pure model. Rows are redacted by construction (opaque IDs, no paths or
 * prompts), paged via a bounded limit (the list is virtualization-ready;
 * M12 renders the newest window), and offer resume/jump affordances through
 * caller-owned callbacks only.
 */
import type { HarnessRun } from '@adea-ai/types/dev-runtime'
import { For, Show, type JSX } from 'solid-js'

import { buildRunHistoryRows, type RunHistoryRow } from './run-history-model'

export function RunHistoryPane(props: {
  runs: readonly HarnessRun[]
  limit?: number
  nowMs?: number
  onResume?: (row: RunHistoryRow) => void
  onJumpToSession?: (row: RunHistoryRow) => void
  onJumpToTerminal?: (row: RunHistoryRow) => void
}) {
  const rows = (): readonly RunHistoryRow[] =>
    buildRunHistoryRows(props.runs, {
      limit: props.limit,
      ...(props.nowMs !== undefined ? { nowMs: props.nowMs } : {}),
    })

  const body = (): JSX.Element => (
    <ol aria-label="Harness run history">
      <For each={rows()}>
        {(row) => (
          <li>
            <span>{row.stateLabel}</span>
            <span aria-hidden="true"> · </span>
            <span>
              gen {row.generation}
              <Show when={row.modelId}> · {row.modelId}</Show>
            </span>
            <Show when={row.elapsedMs !== undefined}>
              <span aria-hidden="true"> · </span>
              <span>{formatElapsed(row.elapsedMs!)}</span>
            </Show>
            <Show when={row.resumable && props.onResume}>
              <button
                type="button"
                onClick={() => props.onResume?.(row)}
                aria-label={`Resume harness run generation ${row.generation}`}
              >
                Resume
              </button>
            </Show>
            <Show when={!row.resumable}>
              <span aria-label={`Run is not resumable: ${row.resumeReason}`}>
                Not resumable ({row.resumeReason.replace('_', ' ')})
              </span>
            </Show>
            <Show when={props.onJumpToSession}>
              <button
                type="button"
                onClick={() => props.onJumpToSession?.(row)}
                aria-label={`Open conversation for run generation ${row.generation}`}
              >
                Conversation
              </button>
            </Show>
            <Show when={props.onJumpToTerminal}>
              <button
                type="button"
                onClick={() => props.onJumpToTerminal?.(row)}
                aria-label={`Open terminal for run generation ${row.generation}`}
              >
                Terminal
              </button>
            </Show>
          </li>
        )}
      </For>
    </ol>
  )

  return (
    <section aria-label="Run history">
      <Show when={rows().length > 0} fallback={<p>No harness runs yet.</p>}>
        {body()}
      </Show>
    </section>
  )
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}
