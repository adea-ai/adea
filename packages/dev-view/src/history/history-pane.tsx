/*
 * History pane: what the user asked and what the agent answered, newest first
 * (the Turns tab), a search over the same bounded event window, and the
 * harness Run history (the Runs tab). Everything shown is derived from the
 * canonical event log the caller read; the pane keeps no index and no copy.
 */
import type { HarnessRun, RuntimeEvent, RuntimeSession } from '@adea-ai/types/dev-runtime'
import { ChevronDown, ChevronRight, History, Search, X } from 'lucide-solid'
import { For, Show, createMemo, createSignal, type JSX } from 'solid-js'

import {
  conversationSearchRowLabel,
  searchConversationHistory,
  type ConversationSearchJump,
  type ConversationSearchKind,
  type ConversationSearchRow,
} from '../chat/search'
import { buildHistoryTurns, formatRelativeTime, type HistoryTurn } from './turns-model'
import { RunHistoryPane } from './run-history-pane'
import { cn } from '@adea-ai/app-ui/lib/utils'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Button } from '@adea-ai/ui/components/ui/button'
import { EmptyState } from '@adea-ai/ui/components/ui/empty'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@adea-ai/ui/components/ui/input-group'
import { ItemGroup, ItemGroupEntry } from '@adea-ai/ui/components/ui/item'
import { Skeleton } from '@adea-ai/ui/components/ui/skeleton'
import { StatusChip, type StatusTone } from '@adea-ai/ui/components/ui/status-chip'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@adea-ai/ui/components/ui/tabs'
import { Text } from '@adea-ai/ui/components/ui/typography'

export type HistoryPaneStatus =
  | 'loading'
  | 'ready'
  /** The session runs in a terminal and publishes no structured event feed. */
  | 'no_feed'
  /** The stream lost events or belongs to an older generation; reopen to recover. */
  | 'stale'
  | 'unavailable'

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
  /** Only hosts that can reveal an event (Chat) supply it; Dev shows no jump. */
  onJump?: (jump: ConversationSearchJump) => void
}>

const SEARCH_PAGE = 100

const KIND_LABELS: Record<ConversationSearchKind, string> = {
  prompt: 'Prompt',
  result: 'Reply',
  tool: 'Tool',
  approval: 'Approval',
  question: 'Question',
  status: 'Status',
  run: 'Run',
}

const TURN_STATUS: Record<HistoryTurn['state'], { label: string; tone: StatusTone }> = {
  working: { label: 'Working', tone: 'pending' },
  done: { label: 'Done', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  unanswered: { label: 'No reply recorded', tone: 'neutral' },
}

function Highlighted(props: { text: string; query: string }): JSX.Element {
  const parts = createMemo(() => {
    const needle = props.query.trim()
    if (needle.length === 0) return [{ text: props.text, match: false }]
    const lower = props.text.toLocaleLowerCase()
    const target = needle.toLocaleLowerCase()
    const out: { text: string; match: boolean }[] = []
    let from = 0
    for (let at = lower.indexOf(target); at !== -1; at = lower.indexOf(target, from)) {
      if (at > from) out.push({ text: props.text.slice(from, at), match: false })
      out.push({ text: props.text.slice(at, at + target.length), match: true })
      from = at + target.length
    }
    if (from < props.text.length) out.push({ text: props.text.slice(from), match: false })
    return out
  })
  return (
    <For each={parts()}>
      {(part) =>
        part.match ? <mark class="bg-primary-subtle text-foreground">{part.text}</mark> : part.text
      }
    </For>
  )
}

function TurnRow(props: { turn: HistoryTurn; nowMs: number; id: string }): JSX.Element {
  const [expanded, setExpanded] = createSignal(false)
  const status = () => TURN_STATUS[props.turn.state]
  const bodyId = () => `${props.id}-body`
  return (
    <ItemGroupEntry
      variant="outline"
      size="sm"
      class="items-start"
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
    </ItemGroupEntry>
  )
}

function ResultRow(props: {
  row: ConversationSearchRow
  query: string
  nowMs: number
  onJump?: (jump: ConversationSearchJump) => void
}): JSX.Element {
  return (
    <ItemGroupEntry
      variant="outline"
      size="sm"
      class="items-start"
      trailing={
        <Show when={props.onJump}>
          {(jump) => (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={`Jump to ${conversationSearchRowLabel(props.row)}`}
              onClick={() => jump()(props.row.jump)}
            >
              Jump
            </Button>
          )}
        </Show>
      }
    >
      <div class="flex min-w-0 flex-col gap-1.5">
        <div class="flex items-center gap-2">
          <Badge variant="outline">{KIND_LABELS[props.row.kind]}</Badge>
          <Show when={props.row.occurredAt}>
            {(at) => (
              <Text variant="caption" tone="muted" class="ms-auto">
                <time datetime={at()}>{formatRelativeTime(at(), props.nowMs)}</time>
              </Text>
            )}
          </Show>
        </div>
        <div class="line-clamp-3">
          <Text as="span" variant="body">
            <Highlighted text={props.row.preview} query={props.query} />
          </Text>
        </div>
      </div>
    </ItemGroupEntry>
  )
}

export function HistoryPane(props: HistoryPaneProps): JSX.Element {
  const [tab, setTab] = createSignal('turns')
  const [query, setQuery] = createSignal('')
  const [pageCount, setPageCount] = createSignal(1)
  const nowMs = () => props.nowMs?.() ?? Date.now()
  const idPrefix = `dev-history-${Math.random().toString(36).slice(2, 8)}`

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
                    props.status === 'stale' ? 'History is out of date' : 'History is unavailable'
                  }
                  detail={
                    props.status === 'stale'
                      ? 'Some events were missed or this feed belongs to an older run of the session. Reload to read the current history.'
                      : 'The conversation could not be read from this runtime.'
                  }
                  {...(props.onRetry
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
              <ItemGroup listLabel="Prompts and replies, newest first">
                <For each={turns()}>
                  {(turn) => <TurnRow turn={turn} nowMs={nowMs()} id={`${idPrefix}-${turn.id}`} />}
                </For>
              </ItemGroup>
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
            <ItemGroup listLabel="Search results">
              <For each={page()?.items ?? []}>
                {(row) => (
                  <ResultRow
                    row={row}
                    query={query()}
                    nowMs={nowMs()}
                    {...(props.onJump ? { onJump: props.onJump } : {})}
                  />
                )}
              </For>
            </ItemGroup>
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
    <Tabs value={tab()} onChange={setTab} class="h-full" aria-label="Conversation history">
      <div class="flex flex-col gap-2 border-b border-border p-3">
        <InputGroup class="w-full">
          <InputGroupAddon>
            <Search aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search this conversation"
            placeholder="Search prompts, replies and tools"
            value={query()}
            disabled={props.status !== 'ready'}
            onInput={(event) => updateQuery(event.currentTarget.value)}
          />
          <Show when={searching()}>
            <InputGroupAddon align="end">
              <InputGroupButton aria-label="Clear search" onClick={() => updateQuery('')}>
                <X aria-hidden="true" />
              </InputGroupButton>
            </InputGroupAddon>
          </Show>
        </InputGroup>
        <TabsList appearance="segmented" aria-label="History view">
          <TabsTrigger appearance="segmented" value="turns">
            Turns
          </TabsTrigger>
          <TabsTrigger appearance="segmented" value="runs">
            Runs
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="turns" class="overflow-y-auto">
        <Show when={searching() && page()}>
          {(current) => (
            <div class="px-3 pt-2">
              <Text variant="caption" tone="muted" role="status">
                {current().totalMatches} result{current().totalMatches === 1 ? '' : 's'} for “
                {query().trim()}”
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
      </TabsContent>
      <TabsContent value="runs" class="overflow-y-auto">
        <RunHistoryPane runs={props.runs} />
      </TabsContent>
    </Tabs>
  )
}
