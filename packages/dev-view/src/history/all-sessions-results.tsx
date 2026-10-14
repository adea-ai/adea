// The History pane's "All sessions" body (#716): search results grouped by
// session with a jump and resume per group, the most recent prompts when
// nothing is typed, and the resume confirmation. Pure presentation over the
// scan the section read; every action is a caller-owned callback.
import type { RuntimeEvent } from '@adea-ai/types/dev-runtime'
import { History, Search } from 'lucide-solid'
import { For, Show, createMemo, createSignal, onCleanup, type JSX } from 'solid-js'

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
import { formatRelativeTime } from './turns-model'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { Button } from '@adea-ai/ui/components/ui/button'
import { EmptyState } from '@adea-ai/ui/components/ui/empty'
import { ModalDialog } from '@adea-ai/ui/components/ui/modal-dialog'
import { Skeleton } from '@adea-ai/ui/components/ui/skeleton'
import { Text } from '@adea-ai/ui/components/ui/typography'

export type AllSessionsFeed = Readonly<{
  status: 'loading' | 'ready' | 'unavailable'
  scan?: AllSessionsScan
}>

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`
}

function ResumeFact(props: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <div class="flex gap-3">
      <Text as="dt" variant="overline" class="w-16 shrink-0">
        {props.label}
      </Text>
      <Text as="dd" variant="body" class="m-0 min-w-0">
        {props.children}
      </Text>
    </div>
  )
}

function ResumeDialog(props: {
  target: ResumeTarget | undefined
  nowMs: number
  onResume: (target: ResumeTarget) => Promise<void>
  onClose: () => void
}): JSX.Element {
  const [phase, setPhase] = createSignal<'idle' | 'starting' | 'failed'>('idle')
  const [refusal, setRefusal] = createSignal('the runtime did not accept the request.')
  let alive = true
  onCleanup(() => {
    alive = false
  })
  const close = () => {
    if (phase() === 'starting') return
    setPhase('idle')
    props.onClose()
  }
  const start = async (target: ResumeTarget) => {
    setPhase('starting')
    try {
      await props.onResume(target)
      if (!alive) return
      setPhase('idle')
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
  return (
    <ModalDialog
      open={props.target !== undefined}
      onClose={close}
      title={`Resume “${props.target?.title ?? ''}”?`}
      description="This starts a new generation in the same session. Nothing already recorded is changed."
    >
      <Show when={props.target}>
        {(target) => (
          <div class="flex flex-col gap-3">
            <dl class="m-0 flex flex-col gap-2">
              <ResumeFact label="Session">{target().title}</ResumeFact>
              <ResumeFact label="Run">
                Run {target().runNumber} · gen {target().runGeneration} ·{' '}
                {target().stateLabel.toLowerCase()}
                <Show when={target().startedAt}>
                  {(at) => <> {formatRelativeTime(at(), props.nowMs)}</>}
                </Show>
              </ResumeFact>
              <ResumeFact label="Stays">
                Prompts, replies and tool history. The worktree and its files.
              </ResumeFact>
              <ResumeFact label="Starts">
                Generation {target().nextGeneration} of run {target().runNumber} in this session.
                The harness, from the run’s recorded start.
              </ResumeFact>
            </dl>
            <Show when={phase() === 'failed'}>
              <Alert variant="destructive">
                <AlertDescription>The run could not be resumed: {refusal()}</AlertDescription>
              </Alert>
            </Show>
            <div class="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={phase() === 'starting'}
                onClick={close}
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={phase() === 'starting'}
                aria-busy={phase() === 'starting'}
                onClick={() => void start(target())}
              >
                {phase() === 'starting'
                  ? 'Resuming'
                  : phase() === 'failed'
                    ? 'Try again'
                    : 'Resume'}
              </Button>
            </div>
          </div>
        )}
      </Show>
    </ModalDialog>
  )
}

function GroupHeader(props: {
  group: SessionGroup
  recent: boolean
  bound: boolean
  onOpen: (jump: ConversationSearchJump) => void
  onResume: ((target: ResumeTarget) => void) | undefined
}): JSX.Element {
  return (
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
      <div class="min-w-0 truncate">
        <Text variant="strong">{props.group.title}</Text>
      </div>
      <Show when={!props.bound}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Open session ${props.group.title}`}
          onClick={() => props.onOpen({ runtimeSessionId: props.group.runtimeSessionId })}
        >
          Open session
        </Button>
      </Show>
      <Text variant="caption" tone="muted" class="ms-auto">
        {props.recent
          ? `${props.group.matches.toLocaleString()} recent`
          : plural(props.group.matches, 'match', 'matches')}
      </Text>
      <Show when={props.group.resume}>
        {(resume) => (
          <Show
            when={resume().kind === 'available' && props.onResume}
            fallback={
              <Show when={resume().kind === 'blocked'}>
                <Text variant="caption" tone="muted" class="basis-full">
                  {(resume() as { reason: string }).reason}
                </Text>
              </Show>
            }
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={`Resume ${props.group.title}`}
              onClick={() => props.onResume?.((resume() as { target: ResumeTarget }).target)}
            >
              Resume
            </Button>
          </Show>
        )}
      </Show>
    </div>
  )
}

export function AllSessionsResults(props: {
  feed: AllSessionsFeed
  query: string
  pageCount: number
  nowMs: number
  boundSessionId?: string
  /** The bound session's live events replace its scanned window. */
  overrides?: ReadonlyMap<string, readonly RuntimeEvent[]>
  onGo: (jump: ConversationSearchJump) => void
  onResume?: (target: ResumeTarget) => Promise<void>
  onLoadMore: () => void
  onRetry?: () => void
}): JSX.Element {
  const [confirming, setConfirming] = createSignal<ResumeTarget>()
  const view = createMemo(() => {
    const scan = props.feed.scan
    return props.feed.status === 'ready' && scan
      ? buildAllSessionsView(scan, props.query, props.pageCount * RESULT_PAGE, props.overrides)
      : undefined
  })
  const searching = () => props.query.trim().length > 0
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
                <Text variant="caption" tone="muted" role="status">
                  {current().mode === 'recent'
                    ? current().shown > 0
                      ? 'Recent prompts across your sessions'
                      : ''
                    : `${plural(current().total, 'result', 'results')} in ${plural(
                        current().groups.length,
                        'session',
                        'sessions'
                      )}`}
                </Text>
                <Show when={current().partial}>
                  <Text variant="caption" tone="muted">
                    Searched the most recent events of{' '}
                    {plural(current().searched, 'session', 'sessions')}. Searching older history is
                    not available yet.
                  </Text>
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
                            onOpen={props.onGo}
                            onResume={props.onResume ? setConfirming : undefined}
                          />
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
                    <Text variant="caption" tone="muted" role="status">
                      {current().capped && current().shown >= RESULT_CAP
                        ? `Showing the first ${RESULT_CAP.toLocaleString()} of ${current().total.toLocaleString()} matches`
                        : `Showing ${current().shown.toLocaleString()} of ${current().total.toLocaleString()} matches`}
                    </Text>
                    <Show
                      when={current().shown < RESULT_CAP}
                      fallback={
                        <Text variant="caption" tone="muted">
                          Narrow your search to see the rest.
                        </Text>
                      }
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
      <Show when={props.onResume}>
        {(resume) => (
          <ResumeDialog
            target={confirming()}
            nowMs={props.nowMs}
            onResume={resume()}
            onClose={() => setConfirming(undefined)}
          />
        )}
      </Show>
    </>
  )
}
