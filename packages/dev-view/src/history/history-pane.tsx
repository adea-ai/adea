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
import { buildHistoryTurns, formatRelativeTime, type HistoryTurn } from './turns-model'
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
  session?: RuntimeSession
  runs: readonly HarnessRun[]
  /** True when retention dropped older events from the window. */
  bounded?: boolean
  /** True while the newest harness run is working or awaiting input/approval. */
  runActive?: boolean
  nowMs?: () => number
  onRetry?: () => void
  /** Show one event or open one session; a result's "Go to" calls it. */
  onGo?: (jump: ConversationSearchJump) => void
  /** Searching the open session or every session; the switch shows with the handler. */
  scope?: HistoryScope
  onScopeChange?: (scope: HistoryScope) => void
  all?: AllSessionsFeed
  /** The bound session's live events replace its scanned window in All sessions. */
  boundSessionId?: string
  onRetryAll?: () => void
  /** Resolves when the resume started; rejects when the runtime refused it. */
  onResume?: (target: ResumeTarget) => Promise<void>
  /** A one-line outcome shown above the list, e.g. a finished resume. */
  notice?: Readonly<{ title: string; detail?: string }>
  /** Reveal this event's turn here; the host has no transcript to scroll. */
  focusEventId?: string
  onFocusResult?: (found: boolean) => void
}>

const SEARCH_PAGE = 100

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

/** The turn an event belongs to: the latest prompt at or before it. */
export function turnIdForEvent(
  turns: readonly HistoryTurn[],
  events: readonly RuntimeEvent[],
  eventId: string
): string | undefined {
  const target = events.find((event) => event.eventId === eventId)
  if (!target) return undefined
  let best: HistoryTurn | undefined
  for (const turn of turns) {
    if (turn.id === eventId) return turn.id
    try {
      if (
        BigInt(turn.jump.sequence ?? '-1') <= BigInt(target.seq) &&
        (!best || BigInt(turn.jump.sequence ?? '-1') > BigInt(best.jump.sequence ?? '-1'))
      )
        best = turn
    } catch {
      continue
    }
  }
  return best?.id
}

const REVEAL_MS = 2_400

export function HistoryPane(props: HistoryPaneProps): JSX.Element {
  const [tab, setTab] = createSignal('turns')
  const [query, setQuery] = createSignal('')
  const [pageCount, setPageCount] = createSignal(1)
  const [highlightedTurn, setHighlightedTurn] = createSignal<string>()
  // A reveal in this list answers a "Go to" without persisting a scope change.
  const [scopeOverride, setScopeOverride] = createSignal<HistoryScope>()
  const scope = () => scopeOverride() ?? props.scope ?? 'session'
  const chooseScope = (next: HistoryScope) => {
    setScopeOverride(undefined)
    props.onScopeChange?.(next)
  }
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

  // The host has no transcript to scroll, so a "Go to" in the bound session
  // shows the event's turn in this list: clear the search, scroll, and mark it.
  createEffect(() => {
    const eventId = props.focusEventId
    if (!eventId || props.status !== 'ready') return
    const turnId = turnIdForEvent(turns(), props.events, eventId)
    if (turnId === undefined) {
      props.onFocusResult?.(false)
      return
    }
    setTab('turns')
    updateQuery('')
    setScopeOverride('session')
    const frame = requestAnimationFrame(() => {
      body?.querySelector(`[id="${idPrefix}-${turnId}-row"]`)?.scrollIntoView({ block: 'center' })
      setHighlightedTurn(turnId)
      props.onFocusResult?.(true)
    })
    const clear = setTimeout(() => setHighlightedTurn(undefined), REVEAL_MS)
    onCleanup(() => {
      cancelAnimationFrame(frame)
      clearTimeout(clear)
    })
  })

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
              when={props.status === 'no_feed'}
              fallback={
                <EmptyState
                  announceAs="status"
                  icon={<History aria-hidden="true" />}
                  title={
                    props.status === 'not_ready'
                      ? 'The runtime is not ready'
                      : props.status === 'stale'
                        ? 'History is out of date'
                        : 'History is unavailable'
                  }
                  detail={
                    props.status === 'not_ready'
                      ? 'History is available once the runtime has connected.'
                      : props.status === 'stale'
                        ? 'Some events were missed or this feed belongs to an older run of the session. Reload to read the current history.'
                        : 'The conversation could not be read from this runtime.'
                  }
                  {...(props.onRetry && props.status !== 'not_ready'
                    ? {
                        action: props.onRetry,
                        actionLabel: props.status === 'stale' ? 'Reload' : 'Try again',
                      }
                    : {})}
                />
              }
            >
              <EmptyState
                icon={<History aria-hidden="true" />}
                title="No prompts recorded"
                detail="This session runs in the terminal without a structured event feed, so prompts and replies are not recorded here. Run history is still available under Runs."
              />
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
                {(row) => (
                  <ResultRow
                    row={row}
                    query={query()}
                    nowMs={nowMs()}
                    {...(props.onGo ? { onGo: props.onGo } : {})}
                  />
                )}
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
        <div role="group" aria-label="History view" class="flex gap-1">
          <Button
            type="button"
            size="sm"
            variant={tab() === 'turns' ? 'secondary' : 'ghost'}
            aria-pressed={tab() === 'turns'}
            onClick={() => setTab('turns')}
          >
            Turns
          </Button>
          <Button
            type="button"
            size="sm"
            variant={tab() === 'runs' ? 'secondary' : 'ghost'}
            aria-pressed={tab() === 'runs'}
            onClick={() => setTab('runs')}
          >
            Runs
          </Button>
        </div>
        <Show when={props.onScopeChange && tab() === 'turns'}>
          <div role="group" aria-label="Search scope" class="flex gap-1">
            <Button
              type="button"
              size="sm"
              variant={scope() !== 'all' ? 'secondary' : 'ghost'}
              aria-pressed={scope() !== 'all'}
              onClick={() => chooseScope('session')}
            >
              This session
            </Button>
            <Button
              type="button"
              size="sm"
              variant={scope() === 'all' ? 'secondary' : 'ghost'}
              aria-pressed={scope() === 'all'}
              onClick={() => chooseScope('all')}
            >
              All sessions
            </Button>
          </div>
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
                <Show when={props.bounded && props.status === 'ready' && !searching()}>
                  <div class="px-3 pt-2">
                    <Text variant="caption" tone="muted" role="status">
                      Showing the latest events only. Older prompts were dropped by retention.
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
              {...(props.boundSessionId ? { boundSessionId: props.boundSessionId } : {})}
              {...(props.session && props.status === 'ready'
                ? { overrides: new Map([[props.session.id, props.events]]) }
                : {})}
              onGo={(jump) => props.onGo?.(jump)}
              {...(props.onResume ? { onResume: props.onResume } : {})}
              onLoadMore={() => setPageCount((count) => count + 1)}
              {...(props.onRetryAll ? { onRetry: props.onRetryAll } : {})}
            />
          </Show>
        </Show>
      </div>
    </div>
  )
}
