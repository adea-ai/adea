/*
 * History pane: what the user asked and what the agent answered, newest first
 * (the Turns tab), a search over the same bounded event window, and the
 * harness Run history (the Runs tab). Everything shown is derived from the
 * canonical event log the caller read; the pane keeps no index and no copy.
 */
import type { HarnessRun, RuntimeEvent, RuntimeSession } from '@adea-ai/types/dev-runtime'
import { ChevronDown, ChevronRight, History, Search, X } from 'lucide-solid'
import { For, Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from 'solid-js'

import { searchConversationHistory, type ConversationSearchJump } from '../chat/search'
import { AllSessionsResults, type AllSessionsFeed } from './all-sessions-results'
import type { ResumeTarget } from './all-sessions-model'
import { Entry, EntryList, ResultRow } from './history-parts'
import {
  buildHistoryTurns,
  formatRelativeTime,
  turnIdForEvent,
  type HistoryTurn,
} from './turns-model'
import { RunHistoryPane } from './run-history-pane'
import { cn } from '@adea-ai/app-ui/lib/utils'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { Button } from '@adea-ai/ui/components/ui/button'
import { EmptyState } from '@adea-ai/ui/components/ui/empty'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Skeleton } from '@adea-ai/ui/components/ui/skeleton'
import { StatusChip, type StatusTone } from '@adea-ai/ui/components/ui/status-chip'
import { Text } from '@adea-ai/ui/components/ui/typography'

export type HistoryPaneStatus =
  | 'loading'
  | 'ready'
  /** The session runs in a terminal and publishes no structured event feed. */
  | 'no_feed'
  /** The stream lost events or belongs to an older generation; reopen to recover. */
  | 'stale'
  | 'unavailable'
  /** The runtime has not connected, so nothing can be read yet. */
  | 'not_ready'

export type HistoryScope = 'session' | 'all'

export type HistoryPaneProps = Readonly<{
  status: HistoryPaneStatus
  events: readonly RuntimeEvent[]
  session?: RuntimeSession | undefined
  runs: readonly HarnessRun[]
  /** True when retention dropped older events from the window. */
  bounded?: boolean
  /** The feed's replay is proven complete; false while it may still be loading. Default: complete. */
  confirmed?: boolean
  /** True while the newest harness run is working or awaiting input/approval. */
  runActive?: boolean
  nowMs?: () => number
  onRetry?: () => void
  /** Show one event or open one session; a result's "Go to" calls it. */
  onGo?: ((jump: ConversationSearchJump) => void) | undefined
  /** Searching the open session or every session; the switch shows with the handler. */
  scope?: HistoryScope | undefined
  onScopeChange?: ((scope: HistoryScope) => void) | undefined
  all?: AllSessionsFeed | undefined
  /** The bound session's live events replace its scanned window in All sessions. */
  boundSessionId?: string | undefined
  onRetryAll?: (() => void) | undefined
  /** Resolves when the resume started; rejects when the runtime refused it. */
  onResume?: ((target: ResumeTarget) => Promise<void>) | undefined
  /** A one-line outcome shown above the list, e.g. a finished resume. */
  notice?: Readonly<{ title: string; detail?: string }> | undefined
  /** Show this event's turn here once the feed is ready; the host has no transcript to scroll. */
  focusEventId?: string | undefined
  onFocusResult?: ((found: boolean) => void) | undefined
}>

const SEARCH_PAGE = 100

// What the pane says when it has no feed to show. No `action` means no retry.
const STATE_COPY: Partial<
  Record<HistoryPaneStatus, { title: string; detail: string; action?: string }>
> = {
  not_ready: {
    title: 'The runtime is not ready',
    detail: 'History is available once the runtime has connected.',
  },
  stale: {
    title: 'History is out of date',
    detail:
      'Some events were missed or this feed belongs to an older run of the session. Reload to read the current history.',
    action: 'Reload',
  },
  unavailable: {
    title: 'History is unavailable',
    detail: 'The conversation could not be read from this runtime.',
    action: 'Try again',
  },
}
const TABS: readonly (readonly ['turns' | 'runs', string])[] = [
  ['turns', 'Turns'],
  ['runs', 'Runs'],
]
const SCOPES: readonly (readonly [HistoryScope, string])[] = [
  ['session', 'This session'],
  ['all', 'All sessions'],
]

const TURN_STATUS: Record<HistoryTurn['state'], { label: string; tone: StatusTone }> = {
  working: { label: 'Working', tone: 'pending' },
  done: { label: 'Done', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  unanswered: { label: 'No reply recorded', tone: 'neutral' },
}

function TurnRow(props: {
  turn: HistoryTurn
  nowMs: number
  id: string
  highlighted: boolean
}): JSX.Element {
  const [expanded, setExpanded] = createSignal(false)
  const status = () => TURN_STATUS[props.turn.state]
  const bodyId = () => `${props.id}-body`
  return (
    <Entry
      id={`${props.id}-row`}
      highlighted={props.highlighted}
      trailing={
        <ActionButton
          type="button"
          variant="ghost"
          size="icon-sm"
          tooltip={expanded() ? 'Show less' : 'Show full prompt and reply'}
          aria-label={expanded() ? 'Show less of this prompt' : 'Show full prompt and reply'}
          aria-expanded={expanded()}
          aria-controls={bodyId()}
          onClick={() => setExpanded((current) => !current)}
        >
          <Show when={expanded()} fallback={<ChevronRight aria-hidden="true" />}>
            <ChevronDown aria-hidden="true" />
          </Show>
        </ActionButton>
      }
    >
      <div id={bodyId()} class="flex min-w-0 flex-col gap-1.5">
        <div class="flex items-baseline gap-2">
          <Text variant="overline">You</Text>
          <Text variant="caption" tone="muted" class="ms-auto">
            <time datetime={props.turn.occurredAt}>
              {formatRelativeTime(props.turn.occurredAt, props.nowMs)}
            </time>
          </Text>
        </div>
        <div class={cn({ 'whitespace-pre-wrap': expanded(), 'line-clamp-2': !expanded() })}>
          <Text as="span" variant="body">
            {props.turn.prompt}
          </Text>
        </div>
        <div class="flex items-baseline gap-2">
          <Text variant="overline">Agent</Text>
          <Show
            when={props.turn.reply}
            fallback={
              <Text variant="caption" tone="muted">
                {props.turn.state === 'working'
                  ? 'Waiting for the agent’s reply…'
                  : 'No reply was recorded for this prompt.'}
              </Text>
            }
          >
            {(reply) => (
              <div class={cn({ 'whitespace-pre-wrap': expanded(), 'line-clamp-2': !expanded() })}>
                <Text as="span" variant="caption" tone="muted">
                  {reply()}
                </Text>
              </div>
            )}
          </Show>
        </div>
        <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <StatusChip label={status().label} tone={status().tone} />
          <Text variant="micro" tone="muted">
            {props.turn.toolCalls} tool call{props.turn.toolCalls === 1 ? '' : 's'}
          </Text>
          <Text variant="micro" tone="muted">
            gen {props.turn.generation}
          </Text>
        </div>
      </div>
    </Entry>
  )
}

// Moved to the pure turns model so tests can reach it without loading this component.
export { turnIdForEvent }

const REVEAL_MS = 2_400

function Segmented<T extends string>(props: {
  label: string
  options: readonly (readonly [T, string])[]
  value: T
  onChange: (value: T) => void
}): JSX.Element {
  return (
    <div role="group" aria-label={props.label} class="flex gap-1">
      <For each={props.options}>
        {([value, text]) => (
          <Button
            type="button"
            size="sm"
            variant={props.value === value ? 'secondary' : 'ghost'}
            aria-pressed={props.value === value}
            onClick={() => props.onChange(value)}
          >
            {text}
          </Button>
        )}
      </For>
    </div>
  )
}

export function HistoryPane(props: HistoryPaneProps): JSX.Element {
  const [tab, setTab] = createSignal<'turns' | 'runs'>('turns')
  const [query, setQuery] = createSignal('')
  const [pageCount, setPageCount] = createSignal(1)
  const [highlightedTurn, setHighlightedTurn] = createSignal<string>()
  // A reveal in this list answers a "Go to" without persisting a scope change.
  const [scopeOverride, setScopeOverride] = createSignal<HistoryScope>()
  const scope = () => scopeOverride() ?? props.scope ?? 'session'
  const nowMs = () => props.nowMs?.() ?? Date.now()
  const idPrefix = `dev-history-${Math.random().toString(36).slice(2, 8)}`
  const allSessions = () => scope() === 'all' && props.all !== undefined && tab() === 'turns'
  let body: HTMLDivElement | undefined
  let searchInput: HTMLInputElement | undefined

  const turns = createMemo(() =>
    buildHistoryTurns(props.events, { runActive: props.runActive === true })
  )
  const searching = () => query().trim().length > 0
  const page = createMemo(() => {
    if (!searching()) return undefined
    const sessionId = props.session?.id ?? props.events[0]?.runtimeSessionId
    const input = {
      sessions: props.session ? [props.session] : [],
      runs: [],
      events: new Map(sessionId ? [[sessionId, props.events]] : []),
      query: query(),
      matchOn: 'preview' as const,
      limit: SEARCH_PAGE,
    }
    // "Load more" extends the list; each page continues from the previous
    // page's cursor, so earlier rows never drop out from under the reader.
    let result = searchConversationHistory(input)
    const items = [...result.items]
    for (let loaded = 1; loaded < pageCount() && result.nextCursor; loaded += 1) {
      result = searchConversationHistory({ ...input, cursor: result.nextCursor })
      items.push(...result.items)
    }
    return { ...result, items }
  })

  const updateQuery = (value: string) => {
    setQuery(value)
    setPageCount(1)
  }

  let highlightEnd: ReturnType<typeof setTimeout> | undefined
  // Waits for the feed of the session the host is opening: until it is ready the
  // events here belong to the session being left, so nothing is judged missing.
  createEffect(() => {
    const eventId = props.focusEventId
    if (!eventId || props.status !== 'ready') return
    const turnId = turnIdForEvent(turns(), props.events, eventId)
    // Absent from a replay that is not proven finished is not absent: wait.
    if (turnId === undefined && props.confirmed === false) return
    if (turnId === undefined) return props.onFocusResult?.(false)
    setTab('turns')
    updateQuery('')
    setScopeOverride('session')
    // The request is consumed once the row is shown: handing it back sooner
    // re-runs this effect and cancels the scroll it scheduled.
    const frame = requestAnimationFrame(() => {
      body?.querySelector(`[id="${idPrefix}-${turnId}-row"]`)?.scrollIntoView({ block: 'center' })
      setHighlightedTurn(turnId)
      clearTimeout(highlightEnd)
      highlightEnd = setTimeout(() => setHighlightedTurn(undefined), REVEAL_MS)
      props.onFocusResult?.(true)
    })
    onCleanup(() => cancelAnimationFrame(frame))
  })
  onCleanup(() => clearTimeout(highlightEnd))

  // Up and Down walk the "Go to" buttons; Enter and Space press the focused one.
  const moveThroughResults = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const buttons = Array.from(body?.querySelectorAll<HTMLElement>('[data-history-go]') ?? [])
    if (buttons.length === 0) return
    const at = buttons.indexOf(document.activeElement as HTMLElement)
    if (at === -1) return
    event.preventDefault()
    const next = at + (event.key === 'ArrowDown' ? 1 : -1)
    if (next < 0) searchInput?.focus()
    else buttons[Math.min(next, buttons.length - 1)]?.focus()
  }
  const enterResults = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown') return
    const first = body?.querySelector<HTMLElement>('[data-history-go]')
    if (!first) return
    event.preventDefault()
    first.focus()
  }

  const turnsBody = (): JSX.Element => (
    <Show
      when={props.status === 'ready'}
      fallback={
        <Show
          when={props.status === 'loading'}
          fallback={
            <Show
              when={STATE_COPY[props.status]}
              fallback={
                <EmptyState
                  icon={<History aria-hidden="true" />}
                  title="No prompts recorded"
                  detail="This session runs in the terminal without a structured event feed, so prompts and replies are not recorded here. Run history is still available under Runs."
                />
              }
            >
              {(copy) => (
                <EmptyState
                  announceAs="status"
                  icon={<History aria-hidden="true" />}
                  title={copy().title}
                  detail={copy().detail}
                  {...(props.onRetry && copy().action
                    ? { action: props.onRetry, actionLabel: copy().action! }
                    : {})}
                />
              )}
            </Show>
          }
        >
          <div class="flex flex-col gap-2 p-3" role="status" aria-label="Loading history">
            <For each={[0, 1, 2]}>{() => <Skeleton class="h-24 w-full" />}</For>
          </div>
        </Show>
      }
    >
      <Show
        when={searching()}
        fallback={
          <Show
            when={turns().length > 0}
            fallback={
              <EmptyState
                icon={<History aria-hidden="true" />}
                title="No prompts yet"
                detail="Prompts and a summary of each reply appear here as you work with the agent."
              />
            }
          >
            <div class="p-3">
              <EntryList label="Prompts and replies, newest first">
                <For each={turns()}>
                  {(turn) => (
                    <TurnRow
                      turn={turn}
                      nowMs={nowMs()}
                      id={`${idPrefix}-${turn.id}`}
                      highlighted={highlightedTurn() === turn.id}
                    />
                  )}
                </For>
              </EntryList>
            </div>
          </Show>
        }
      >
        <Show
          when={(page()?.items.length ?? 0) > 0}
          fallback={
            <EmptyState
              icon={<Search aria-hidden="true" />}
              title="No matching history"
              detail="Search covers prompts, replies, tool calls, approvals and statuses in this conversation."
            />
          }
        >
          <div class="p-3">
            <EntryList label="Search results">
              <For each={page()?.items ?? []}>
                {(row) => <ResultRow row={row} query={query()} nowMs={nowMs()} onGo={props.onGo} />}
              </For>
            </EntryList>
          </div>
          <Show when={page()?.nextCursor}>
            <div class="px-3 pb-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPageCount((count) => count + 1)}
              >
                Load more
              </Button>
            </div>
          </Show>
        </Show>
      </Show>
    </Show>
  )

  return (
    <div class="flex h-full min-h-0 flex-col" aria-label="Conversation history" role="region">
      <div class="flex flex-col gap-2 border-b border-border p-3">
        <div class="flex items-center gap-2">
          <Input
            ref={(element) => (searchInput = element)}
            class="min-w-0 flex-1"
            aria-label={allSessions() ? 'Search all sessions' : 'Search this conversation'}
            placeholder="Search prompts, replies and tools"
            value={query()}
            disabled={!allSessions() && props.status !== 'ready'}
            onInput={(event) => updateQuery(event.currentTarget.value)}
            onKeyDown={enterResults}
          />
          <Show when={searching()}>
            <ActionButton
              type="button"
              variant="ghost"
              size="icon-sm"
              tooltip="Clear search"
              aria-label="Clear search"
              onClick={() => updateQuery('')}
            >
              <X aria-hidden="true" />
            </ActionButton>
          </Show>
        </div>
        <Segmented label="History view" options={TABS} value={tab()} onChange={setTab} />
        <Show when={props.onScopeChange && tab() === 'turns'}>
          <Segmented
            label="Search scope"
            options={SCOPES}
            value={scope()}
            onChange={(next) => {
              setScopeOverride(undefined)
              props.onScopeChange?.(next)
            }}
          />
          <Show when={scope() !== 'all' && searching()}>
            <Text variant="caption" tone="muted">
              Searching this session. Switch to All sessions to search the whole workspace.
            </Text>
          </Show>
        </Show>
      </div>
      <div
        ref={(element) => (body = element)}
        class="min-h-0 flex-1 overflow-y-auto"
        onKeyDown={moveThroughResults}
      >
        <Show when={props.notice}>
          {(notice) => (
            <div class="px-3 pt-2">
              <Text variant="caption" role="status">
                {notice().title}
                <Show when={notice().detail}> {notice().detail}</Show>
              </Text>
            </div>
          )}
        </Show>
        <Show when={tab() === 'turns'} fallback={<RunHistoryPane runs={props.runs} />}>
          <Show
            when={allSessions()}
            fallback={
              <>
                <Show when={searching() && page()}>
                  {(current) => (
                    <div class="px-3 pt-2">
                      <Text variant="caption" tone="muted" role="status">
                        {current().totalMatches} result{current().totalMatches === 1 ? '' : 's'} for
                        “{query().trim()}”
                      </Text>
                    </div>
                  )}
                </Show>
                <Show
                  when={(props.bounded || props.confirmed === false) && props.status === 'ready'}
                >
                  <div class="px-3 pt-2">
                    <Text variant="caption" tone="muted" role="status">
                      {props.bounded
                        ? 'Showing the latest events only. Older prompts were dropped by retention.'
                        : 'Not confirmed complete: earlier prompts may still be loading.'}
                    </Text>
                  </div>
                </Show>
                {turnsBody()}
              </>
            }
          >
            <AllSessionsResults
              feed={props.all!}
              query={query()}
              pageCount={pageCount()}
              nowMs={nowMs()}
              boundSessionId={props.boundSessionId}
              overrides={
                // A feed still replaying holds a partial (even empty) window: the
                // complete scanned one stands until the host proves the replay.
                props.session && props.status === 'ready' && props.confirmed !== false
                  ? new Map([[props.session.id, props.events]])
                  : undefined
              }
              onGo={(jump) => props.onGo?.(jump)}
              onResume={props.onResume}
              onLoadMore={() => setPageCount((count) => count + 1)}
              onRetry={props.onRetryAll}
            />
          </Show>
        </Show>
      </div>
    </div>
  )
}
