// The History pane's "All sessions" body (#716): search results grouped by
// session with a jump and resume per group, the most recent prompts when
// nothing is typed, and the resume confirmation. Pure presentation over the
// scan the section read; every action is a caller-owned callback.
import type { RuntimeEvent } from '@adea-ai/types/dev-runtime'
import { History, Search } from 'lucide-solid'
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js'

import type { ConversationSearchJump } from '../chat/search'
import {
  RESULT_CAP,
  RESULT_PAGE,
  ResumeRefusedError,
  buildAllSessionsView,
  type ResumeTarget,
  type SessionGroup,
} from './all-sessions-model'
import type { AllSessionsScan } from './all-sessions-scan'
import { EntryList, ResultRow } from './history-parts'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Button } from '@adea-ai/ui/components/ui/button'
import { EmptyState } from '@adea-ai/ui/components/ui/empty'
import { Skeleton } from '@adea-ai/ui/components/ui/skeleton'
import { Text } from '@adea-ai/ui/components/ui/typography'

export type AllSessionsFeed = Readonly<{
  status: 'loading' | 'ready' | 'unavailable'
  scan?: AllSessionsScan
}>

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`
}

// Caption-sized muted line the results and the confirmation share.
function Note(props: { class?: string; role?: 'status'; children: JSX.Element }): JSX.Element {
  return (
    <Text
      variant="caption"
      tone="muted"
      {...(props.class ? { class: props.class } : {})}
      role={props.role}
    >
      {props.children}
    </Text>
  )
}

// Confirmation sits in the group it resumes, so the narrow pane keeps its place.
function ResumeConfirm(props: {
  target: ResumeTarget
  nowMs: number
  onResume: (target: ResumeTarget) => Promise<void>
  onClose: () => void
}): JSX.Element {
  // The confirmation is keyed to one target, so its facts are read once.
  const { target } = props
  const [phase, setPhase] = createSignal<'idle' | 'starting' | 'failed'>('idle')
  const [refusal, setRefusal] = createSignal('the runtime did not accept the request.')
  let alive = true
  let cancel: HTMLButtonElement | undefined
  onCleanup(() => {
    alive = false
  })
  onMount(() => cancel?.focus())
  const start = async () => {
    setPhase('starting')
    try {
      await props.onResume(target)
      if (!alive) return
      props.onClose()
    } catch (error) {
      if (!alive) return
      setRefusal(
        error instanceof ResumeRefusedError
          ? error.message
          : 'the runtime did not accept the request.'
      )
      setPhase('failed')
    }
  }
  const heading = `Resume “${target.title}”?`
  return (
    <div
      role="group"
      aria-label={heading}
      class="flex flex-col gap-3 rounded-md border border-border p-3"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && phase() !== 'starting') {
          event.stopPropagation()
          props.onClose()
        }
      }}
    >
      <Text variant="strong">{heading}</Text>
      <Note>
        {`Starts generation ${target.nextGeneration} of run ${target.runNumber} in this session. Nothing already recorded is changed.`}
      </Note>
      <Show when={phase() === 'failed'}>
        <Alert variant="destructive">
          <AlertDescription>The run could not be resumed: {refusal()}</AlertDescription>
        </Alert>
      </Show>
      <div class="flex justify-end gap-2">
        <Button
          ref={(element) => (cancel = element)}
          type="button"
          variant="ghost"
          size="sm"
          disabled={phase() === 'starting'}
          onClick={props.onClose}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={phase() === 'starting'}
          aria-busy={phase() === 'starting'}
          onClick={() => void start()}
        >
          {phase() === 'starting' ? 'Resuming' : phase() === 'failed' ? 'Try again' : 'Resume'}
        </Button>
      </div>
    </div>
  )
}

function GroupHeader(props: {
  group: SessionGroup
  recent: boolean
  bound: boolean
  onResume: ((target: ResumeTarget) => void) | undefined
}): JSX.Element {
  const resume = () => props.group.resume
  const count = () =>
    props.recent
      ? `${props.group.matches.toLocaleString()} recent`
      : plural(props.group.matches, 'match', 'matches')
  return (
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
      <div class="min-w-0 truncate">
        <Text variant="strong">{props.group.title}</Text>
      </div>
      <Show when={props.bound}>
        <Badge variant="outline">Open session</Badge>
      </Show>
      <Note class="ms-auto">{count()}</Note>
      <Show when={props.onResume && resume()?.kind === 'available' && resume()}>
        {(available) => (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Resume ${props.group.title}`}
            onClick={() => props.onResume?.((available() as { target: ResumeTarget }).target)}
          >
            Resume
          </Button>
        )}
      </Show>
      <Show when={resume()?.kind === 'blocked' && resume()}>
        {(blocked) => <Note class="basis-full">{(blocked() as { reason: string }).reason}</Note>}
      </Show>
    </div>
  )
}

export function AllSessionsResults(props: {
  feed: AllSessionsFeed
  query: string
  pageCount: number
  nowMs: number
  boundSessionId?: string | undefined
  /** The bound session's live events replace its scanned window. */
  overrides?: ReadonlyMap<string, readonly RuntimeEvent[]> | undefined
  onGo: (jump: ConversationSearchJump) => void
  onResume?: ((target: ResumeTarget) => Promise<void>) | undefined
  onLoadMore: () => void
  onRetry?: (() => void) | undefined
}): JSX.Element {
  const [confirming, setConfirming] = createSignal<ResumeTarget>()
  const view = createMemo(() => {
    const scan = props.feed.scan
    return props.feed.status === 'ready' && scan
      ? buildAllSessionsView(scan, props.query, props.pageCount * RESULT_PAGE, props.overrides)
      : undefined
  })
  createEffect(
    on(
      () => props.query,
      () => setConfirming(undefined),
      { defer: true }
    )
  )
  const searching = () => props.query.trim().length > 0
  const confirmingIn = (group: SessionGroup) => {
    const target = confirming()
    return target?.runtimeSessionId === group.runtimeSessionId ? target : undefined
  }
  return (
    <>
      <Show
        when={props.feed.status === 'ready'}
        fallback={
          <Show
            when={props.feed.status === 'loading'}
            fallback={
              <EmptyState
                announceAs="status"
                icon={<History aria-hidden="true" />}
                title="History search is unavailable"
                detail="The sessions could not be searched from this runtime."
                {...(props.onRetry ? { action: props.onRetry, actionLabel: 'Try again' } : {})}
              />
            }
          >
            <div class="flex flex-col gap-2 p-3" role="status" aria-label="Searching all sessions">
              <For each={[0, 1, 2]}>{() => <Skeleton class="h-24 w-full" />}</For>
            </div>
          </Show>
        }
      >
        <Show when={view()}>
          {(current) => (
            <>
              <div class="flex flex-col gap-1 px-3 pt-2">
                <Note role="status">
                  {current().mode === 'recent'
                    ? current().shown > 0
                      ? 'Recent prompts across your sessions'
                      : ''
                    : `${plural(current().total, 'result', 'results')} in ${plural(
                        current().groups.length,
                        'session',
                        'sessions'
                      )}`}
                </Note>
                <Show when={current().partial}>
                  <Note>
                    Searched the most recent events of{' '}
                    {plural(current().searched, 'session', 'sessions')}. Older history, and any
                    session that has not finished loading, may not be included.
                  </Note>
                </Show>
              </div>
              <Show
                when={current().groups.length > 0}
                fallback={
                  <EmptyState
                    icon={
                      searching() ? <Search aria-hidden="true" /> : <History aria-hidden="true" />
                    }
                    title={
                      searching()
                        ? `No matches in ${plural(current().searched, 'session', 'sessions')}`
                        : 'No prompts yet'
                    }
                    detail={
                      searching()
                        ? 'Search covers prompts, replies, tool calls, approvals and statuses.'
                        : 'Prompts from your open sessions appear here as you work with the agent.'
                    }
                  />
                }
              >
                <div class="p-3">
                  <EntryList label="Matches in all sessions">
                    <For each={current().groups}>
                      {(group) => (
                        <li class="flex flex-col gap-2">
                          <GroupHeader
                            group={group}
                            recent={current().mode === 'recent'}
                            bound={group.runtimeSessionId === props.boundSessionId}
                            onResume={props.onResume ? setConfirming : undefined}
                          />
                          <Show when={props.onResume && confirmingIn(group)}>
                            {(target) => (
                              <ResumeConfirm
                                target={target()}
                                nowMs={props.nowMs}
                                onResume={props.onResume!}
                                onClose={() => setConfirming(undefined)}
                              />
                            )}
                          </Show>
                          <EntryList label={`Matches in ${group.title}`}>
                            <For each={group.rows}>
                              {(row) => (
                                <ResultRow
                                  row={row}
                                  query={props.query}
                                  nowMs={props.nowMs}
                                  onGo={props.onGo}
                                />
                              )}
                            </For>
                          </EntryList>
                        </li>
                      )}
                    </For>
                  </EntryList>
                </div>
                <Show when={searching() && current().total > current().shown}>
                  <div class="flex flex-col items-start gap-2 px-3 pb-3">
                    <Note role="status">
                      {current().capped && current().shown >= RESULT_CAP
                        ? `Showing the first ${RESULT_CAP.toLocaleString()} of ${current().total.toLocaleString()} matches`
                        : `Showing ${current().shown.toLocaleString()} of ${current().total.toLocaleString()} matches`}
                    </Note>
                    <Show
                      when={current().shown < RESULT_CAP}
                      fallback={<Note>Narrow your search to see the rest.</Note>}
                    >
                      <Button type="button" variant="outline" size="sm" onClick={props.onLoadMore}>
                        Load more
                      </Button>
                    </Show>
                  </div>
                </Show>
              </Show>
            </>
          )}
        </Show>
      </Show>
    </>
  )
}
