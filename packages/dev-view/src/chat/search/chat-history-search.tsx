import type { HarnessRun, RuntimeEvent, RuntimeSession } from '@adea-ai/types/dev-runtime'
import { For, Show, createMemo, createSignal, type JSX } from 'solid-js'

import {
  searchConversationHistory,
  type ConversationSearchJump,
  type ConversationSearchRow,
} from './conversation-search-model'
import './chat-history-search.css'

export type ChatHistorySearchProps = Readonly<{
  sessions: readonly RuntimeSession[]
  runs: readonly HarnessRun[]
  events: ReadonlyMap<string, readonly RuntimeEvent[]>
  onJump?: (jump: ConversationSearchJump) => void
  onResume?: (row: ConversationSearchRow) => void
}>

export function ChatHistorySearch(props: ChatHistorySearchProps): JSX.Element {
  const [query, setQuery] = createSignal('')
  const [cursor, setCursor] = createSignal<string | undefined>()
  const [pageSize] = createSignal(100)
  const page = createMemo(() =>
    searchConversationHistory({
      sessions: props.sessions,
      runs: props.runs,
      events: props.events,
      query: query(),
      cursor: cursor(),
      limit: pageSize(),
    })
  )

  const updateQuery = (value: string) => {
    setQuery(value)
    setCursor(undefined)
  }

  return (
    <section aria-label="Conversation history search" class="dev-history-search">
      <label for="dev-history-search-input">Search conversations and runtime events</label>
      <input
        id="dev-history-search-input"
        value={query()}
        placeholder="Search prompts, tools, approvals, and statuses"
        onInput={(event) => updateQuery(event.currentTarget.value)}
      />
      <p role="status">
        {page().totalMatches} result{page().totalMatches === 1 ? '' : 's'}
      </p>
      <Show when={page().items.length > 0} fallback={<p>No matching history.</p>}>
        <ol aria-label="Conversation history results">
          <For each={page().items}>
            {(row) => (
              <li>
                <button type="button" onClick={() => props.onJump?.(row.jump)}>
                  <span>{row.title}</span>
                  <span>{row.kind}</span>
                  <span>{row.preview}</span>
                </button>
                <Show when={row.resumable}>
                  <button type="button" onClick={() => props.onResume?.(row)}>
                    Resume generation {row.generation}
                  </button>
                </Show>
                <Show when={!row.resumable && row.kind === 'run'}>
                  <span>Not resumable ({row.resumeReason?.replace('_', ' ')})</span>
                </Show>
              </li>
            )}
          </For>
        </ol>
      </Show>
      <Show when={page().nextCursor}>
        {(next) => (
          <button type="button" onClick={() => setCursor(next())}>
            Load more
          </button>
        )}
      </Show>
    </section>
  )
}
