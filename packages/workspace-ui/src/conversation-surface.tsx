import type {
  AgentSummary,
  ArtifactSummary,
  ChannelSummary,
  MessageSummary,
  TaskSummary,
} from '@adea-ai/types'
import type { AgentHqApiClient, ApiLeadTurnStatus } from '@adea-ai/api-client'
import { useWorkspaceState, workspaceStore } from '@adea-ai/state'
import {
  settledConversationPage,
  useCreateMessageMutation,
  useMessageListQuery,
  usePrefetchThreadMessages,
} from '@adea-ai/data'
import { Info, MailOpen, Search } from 'lucide-solid'
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'

import type { ConversationReadingPosition } from '@adea-ai/ui/components/conversation'
import {
  ConversationPane,
  ConversationSurface as SharedConversationSurface,
  MessageDayDivider,
  ThreadPanel as SharedThreadPanel,
} from '@adea-ai/ui/components/conversation'
import { cn } from '@adea-ai/app-ui/lib/utils'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { keyedRows } from './keyed-rows'
import { isWorkspaceLeadConversation, messageSubmissionOutcome } from './lead-conversation-model'
import { LeadTurnControls } from './lead-turn-controls'
import {
  MessageComposer,
  type ComposerSubmission,
  type ComposerSubmissionOutcome,
} from './message-composer'
import { MessageRow } from './message-row'
import { ThreadPanel } from './thread-panel'
import { WorkspaceEmpty, WorkspaceError, WorkspaceSkeleton } from './workspace-states'
import type { PrivateContentResolver, TranscriptionProvider } from './platform'
import { AgentStatusBadge } from './agent-status'
import { ConversationAvatar } from './conversation-avatar'
import { Button } from '@adea-ai/ui/components/ui/button'

/**
 * Merged transcripts per channel, kept across selection changes so revisiting
 * a conversation renders its last-known history immediately while the refetch
 * merges fresher pages in. Scroll position rides along in the same entry so
 * revisit restores where the user left off. Bounded: the least recently
 * touched channel drops out once the map outgrows the working set a user
 * realistically flips between.
 */
const transcriptCache = new Map<
  string,
  {
    workspaceId: string
    audienceEpoch: number
    messages: readonly MessageSummary[]
    readingPosition: ConversationReadingPosition
  }
>()
const TRANSCRIPT_CACHE_LIMIT = 12

function rememberTranscript(
  workspaceId: string,
  audienceEpoch: number,
  channelId: string,
  messages: readonly MessageSummary[],
  readingPosition: ConversationReadingPosition
) {
  if ((workspaceStore.getState().conversationAudienceEpochs[workspaceId] ?? 0) !== audienceEpoch)
    return
  const key = `${workspaceId}:${channelId}`
  transcriptCache.delete(key)
  transcriptCache.set(key, { workspaceId, audienceEpoch, messages, readingPosition })
  while (transcriptCache.size > TRANSCRIPT_CACHE_LIMIT) {
    transcriptCache.delete(transcriptCache.keys().next().value!)
  }
}

function cachedTranscript(workspaceId: string, audienceEpoch: number, channelId: string) {
  const cached = transcriptCache.get(`${workspaceId}:${channelId}`)
  return cached?.audienceEpoch === audienceEpoch ? cached : undefined
}

const dayFormatter = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long' })

type ConversationPerson = Readonly<{
  active: boolean
  id: string
  label: string
  kind: 'agent' | 'user'
  avatarRef?: string
}>

function peopleForConversation(
  channel: ChannelSummary,
  agents: readonly AgentSummary[],
  directAgent?: AgentSummary
): ConversationPerson[] {
  const participantIds = new Set(
    channel.participants
      .filter(
        (participant): participant is { kind: 'agent'; agentId: string } =>
          participant.kind === 'agent'
      )
      .map(({ agentId }) => agentId)
  )
  if (directAgent) participantIds.add(directAgent.id)
  if (channel.kind === 'project' && participantIds.size === 0) {
    for (const agent of agents)
      if (agent.projectId === channel.projectId) participantIds.add(agent.id)
  }
  const activeAgentId = directAgent?.id ?? participantIds.values().next().value
  const people: ConversationPerson[] = [
    { active: false, id: 'current-user', kind: 'user', label: 'You' },
  ]
  for (const agent of agents) {
    if (!participantIds.has(agent.id)) continue
    people.push({
      active: activeAgentId === agent.id,
      id: agent.id,
      kind: 'agent',
      label: agent.name,
      ...(agent.avatarRef ? { avatarRef: agent.avatarRef } : {}),
    })
  }
  return people
}

function formatMessageDay(value: string): string {
  return dayFormatter.format(new Date(value))
}

export function ConversationSurface(props: {
  agents: readonly AgentSummary[]
  artifacts: readonly ArtifactSummary[]
  channel?: ChannelSummary
  client: AgentHqApiClient
  draft: string
  onDraftChange: (value: string) => void
  onOpenDetails: () => void
  onOpenSearch: () => void
  onOpenTask: (taskId: string) => void
  onMarkRead: (lastReadSequence: number) => Promise<void>
  onMarkThreadRead: (rootId: string, lastReadSequence: number) => Promise<void>
  onMarkThreadUnread: (rootId: string) => Promise<void>
  onMarkUnread: () => Promise<void>
  onThreadDraftChange: (value: string) => void
  onThreadChange: (messageId: string | null) => void
  privateContent?: PrivateContentResolver
  searchTargetMessageId: string | null
  tasks: readonly TaskSummary[]
  threadDraft: string
  threadRootMessageId: string | null
  transcription?: TranscriptionProvider
  workspaceId: string
}) {
  const audienceEpoch = useWorkspaceState(
    (state) => state.conversationAudienceEpochs[props.workspaceId] ?? 0
  )
  const [leadReceipt, setLeadReceipt] = createSignal<ApiLeadTurnStatus | null>(null)
  const [cursor, setCursor] = createSignal<number | undefined>()
  const [messages, setMessages] = createSignal<readonly MessageSummary[]>([])
  // Whether the loaded page belongs to this conversation. Solid Query keeps the
  // previous result while the next key is in flight, so a page that only holds
  // another channel's messages must not render as this conversation's history
  // (nor as an empty transcript). A genuinely empty page does belong here.
  const [pageBelongsToChannel, setPageBelongsToChannel] = createSignal(false)
  const [optimisticMessage, setOptimisticMessage] = createSignal<MessageSummary | null>(null)
  const [transcript, setTranscript] = createSignal<HTMLDivElement>()
  const prefetchThread = usePrefetchThreadMessages(
    props.client,
    () => props.workspaceId,
    () => props.channel?.id
  )
  let lastMarkedRead = ''
  const messageQuery = useMessageListQuery(
    props.client,
    () => props.workspaceId,
    () => props.channel?.id,
    {
      // An ACCESSOR, not a value: the query resolves it inside its reactive
      // scope so the cursor reaches the query key. Passing the value read here
      // captured it once at setup, so "Load newer messages" mutated a signal
      // nothing observed and no refetch ever happened.
      afterSequence: () => cursor(),
      limit: 100,
    }
  )
  const createMessage = useCreateMessageMutation(
    props.client,
    () => props.workspaceId,
    () => props.channel?.id ?? ''
  )

  // Channel bookkeeping and page application are deliberately one effect. Two
  // effects race: Solid applies a cached query's result to the store before the
  // sibling reset effect runs, so returning to an already-loaded channel could
  // apply the cached page and then have the reset clear it, leaving the
  // transcript on the loading surface with no further update to recover it.
  // One effect makes the order explicit: reset first when the channel changes,
  // then accept whatever the query currently holds.
  let loadedChannelId: string | undefined
  let loadedWorkspaceId = props.workspaceId
  let loadedAudienceEpoch = audienceEpoch()
  // Live scroll position of the loaded channel — captured into the cache
  // entry on switch instead of writing a map on every scroll event.
  let liveReadingPosition: ConversationReadingPosition = { top: 0, following: true }
  createEffect(() => {
    const epoch = audienceEpoch()
    const channel = props.channel
    for (const [key, cached] of transcriptCache)
      if (cached.workspaceId === props.workspaceId && cached.audienceEpoch !== epoch)
        transcriptCache.delete(key)
    if (
      channel?.id !== loadedChannelId ||
      epoch !== loadedAudienceEpoch ||
      props.workspaceId !== loadedWorkspaceId
    ) {
      setLeadReceipt(null)
      if (loadedChannelId)
        rememberTranscript(
          loadedWorkspaceId,
          loadedAudienceEpoch,
          loadedChannelId,
          messages(),
          liveReadingPosition
        )
      loadedChannelId = channel?.id
      loadedWorkspaceId = props.workspaceId
      loadedAudienceEpoch = epoch
      setCursor(undefined)
      // Restore the last-known transcript for the incoming channel. The merge
      // below reconciles it with the fresh page when the refetch lands, so the
      // stale copy is a render bridge, not a second source of truth.
      const cached = channel ? cachedTranscript(props.workspaceId, epoch, channel.id) : undefined
      setMessages(cached?.messages ?? [])
      liveReadingPosition = cached?.readingPosition ?? { top: 0, following: true }
      setOptimisticMessage(null)
      setPageBelongsToChannel(false)
    }
    // The resource can retain its previous success until Solid Query's queued
    // update runs. Only a page admitted under this audience may refill history.
    const data = settledConversationPage(messageQuery, epoch)
    if (!channel || !data) return
    const all = data.messages
    const page = all.filter((message) => message.channelId === channel.id)
    const belongs = page.length > 0 || all.length === 0
    setPageBelongsToChannel(belongs)
    if (!belongs) return
    setMessages((current) => {
      const merged = new Map(current.map((message) => [message.id, message]))
      for (const message of page) merged.set(message.id, message)
      return [...merged.values()].toSorted((left, right) => left.sequence - right.sequence)
    })
  })

  createEffect(() => {
    const target = props.searchTargetMessageId
    if (!target) return
    void messages()
    void props.threadRootMessageId
    requestAnimationFrame(() =>
      transcript()
        ?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(target)}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    )
  })

  const rootMessages = createMemo(() =>
    messages().filter(({ threadRootMessageId }) => !threadRootMessageId)
  )

  // One stable marker: the effect re-evaluates it when the transcript changes,
  // and the focus/visibility listeners call the same closure for the life of
  // the component instead of being detached and re-registered per message.
  const markVisible = () => {
    const channel = props.channel
    if (!channel || messageQuery.isPending) return
    const roots = rootMessages()
    if (!roots.length) return
    const lastReadSequence = Math.max(...roots.map(({ sequence }) => sequence))
    const key = `${channel.id}:${lastReadSequence}`
    if (document.visibilityState !== 'visible' || !document.hasFocus() || lastMarkedRead === key)
      return
    lastMarkedRead = key
    void props.onMarkRead(lastReadSequence).catch(() => {
      if (lastMarkedRead === key) lastMarkedRead = ''
    })
  }
  createEffect(markVisible)
  onMount(() => {
    window.addEventListener('focus', markVisible)
    document.addEventListener('visibilitychange', markVisible)
    onCleanup(() => {
      window.removeEventListener('focus', markVisible)
      document.removeEventListener('visibilitychange', markVisible)
    })
  })

  const root = createMemo(() =>
    props.threadRootMessageId
      ? rootMessages().find(({ id }) => id === props.threadRootMessageId)
      : undefined
  )
  const artifactById = createMemo(
    () => new Map(props.artifacts.map((artifact) => [artifact.id, artifact]))
  )
  const taskById = createMemo(() => new Map(props.tasks.map((task) => [task.id, task])))
  const agentById = createMemo(() => new Map(props.agents.map((agent) => [agent.id, agent])))
  const directAgent = createMemo(() =>
    props.channel?.agentId
      ? props.agents.find(({ id }) => id === props.channel?.agentId)
      : undefined
  )
  const conversationPeople = createMemo(() =>
    props.channel ? peopleForConversation(props.channel, props.agents, directAgent()) : []
  )
  // The thread column: the focused thread when its root is inside the loaded
  // page, the placeholder panel when a deep link names a root this window
  // cannot show, and nothing — no second column — when no thread is open.
  const threadPanel = createMemo(() => {
    if (!props.threadRootMessageId) return undefined
    const rootMessage = root()
    if (!rootMessage) {
      return (
        <SharedThreadPanel
          data-conventional-thread=""
          label="Thread"
          onClose={() => props.onThreadChange(null)}
        >
          <WorkspaceEmpty
            title="Thread outside history window"
            detail="This thread is outside the loaded history window."
          />
        </SharedThreadPanel>
      )
    }
    return (
      <ThreadPanel
        agents={props.agents}
        artifacts={props.artifacts}
        channelId={props.channel?.id ?? ''}
        client={props.client}
        draft={props.threadDraft}
        onClose={() => props.onThreadChange(null)}
        onDraftChange={props.onThreadDraftChange}
        onOpenTask={props.onOpenTask}
        onMarkRead={(sequence) => props.onMarkThreadRead(rootMessage.id, sequence)}
        onMarkUnread={() => props.onMarkThreadUnread(rootMessage.id)}
        privateContent={props.privateContent}
        root={rootMessage}
        searchTargetMessageId={props.searchTargetMessageId}
        tasks={props.tasks}
        transcription={props.transcription}
        workspaceId={props.workspaceId}
      />
    )
  })

  const submit = async (submission: ComposerSubmission): Promise<ComposerSubmissionOutcome> => {
    const submittedWorkspaceId = props.workspaceId
    const submittedChannelId = props.channel?.id
    const submittedAudienceEpoch = audienceEpoch()
    const stillCurrent = () =>
      props.workspaceId === submittedWorkspaceId &&
      props.channel?.id === submittedChannelId &&
      audienceEpoch() === submittedAudienceEpoch
    const createdAt = new Date().toISOString()
    setOptimisticMessage({
      artifactIds: submission.artifactIds,
      bodyText: submission.bodyText,
      channelId: props.channel?.id ?? '',
      createdAt,
      deleted: false,
      id: 'optimistic-message',
      mentions: submission.mentions,
      sender: { kind: 'user', userId: 'current-user' },
      sequence: Number.MAX_SAFE_INTEGER,
      updatedAt: createdAt,
      version: 0,
      workspaceId: props.workspaceId,
    })
    try {
      const useLead = isWorkspaceLeadConversation(props.channel, directAgent())
      const created = await createMessage.mutateAsync({
        ...submission,
        ...(useLead ? { leadTurn: true as const } : {}),
      })
      if (!stillCurrent()) return { clearDraft: false }
      if (created.leadTurn)
        setLeadReceipt({
          schemaVersion: 'adea-lead-turn/v1',
          intentId: created.leadTurn.intentId,
          messageId: created.leadTurn.messageId,
          state: 'blocked',
          availability: 'unavailable',
          reasonCode: 'ADMISSION_SERVICE_UNAVAILABLE',
        })
      // Merge the committed message immediately: the list invalidation that
      // follows refetches the page, but the transcript should not wait a round
      // trip (or drop the optimistic row first) to show what the server
      // already confirmed.
      setMessages((current) => {
        if (current.some(({ id }) => id === created.message.id)) return current
        return [...current, created.message].toSorted(
          (left, right) => left.sequence - right.sequence
        )
      })
      return messageSubmissionOutcome(created, stillCurrent())
    } finally {
      if (stillCurrent()) setOptimisticMessage(null)
    }
  }

  const messagesWithDividers = createMemo(() => {
    const list = rootMessages()
    // Format each message's day exactly once. The previous shape called
    // `formatMessageDay` twice per message to test a single adjacency
    // condition — 2n Intl.DateTimeFormat.format calls per memo run, and
    // re-running the whole memo for one appended message redid all of them.
    const days = list.map((message) => formatMessageDay(message.createdAt))
    return list.map((message, index) => ({
      message,
      showDayDivider: index > 0 && days[index - 1] !== days[index],
    }))
  })
  // Keyed by message id so a refetched page updates rows in place instead of
  // remounting the whole transcript on every new object identity.
  const transcriptRows = keyedRows(
    messagesWithDividers,
    (entry) => entry.message.id,
    (previous, next) =>
      previous.showDayDivider === next.showDayDivider &&
      previous.message.version === next.message.version &&
      previous.message.updatedAt === next.message.updatedAt
  )

  return (
    <Show
      when={props.channel}
      fallback={
        <WorkspaceEmpty
          title="Choose a Project or conversation"
          detail="Projects keep durable work, Agents, Tasks, and conversation history together."
        />
      }
    >
      {(channel) => (
        <ConversationPane
          gutter
          composer={
            <>
              <Show when={isWorkspaceLeadConversation(channel(), directAgent())}>
                <LeadTurnControls
                  client={props.client}
                  workspaceId={props.workspaceId}
                  channelId={channel().id}
                  audienceEpoch={audienceEpoch()}
                  receipt={leadReceipt()}
                  onTimelineChange={() => void messageQuery.refetch()}
                />
              </Show>
              <MessageComposer
                agents={props.agents}
                artifacts={props.artifacts}
                channelId={channel().id}
                draft={props.draft}
                onDraftChange={props.onDraftChange}
                onSubmit={submit}
                transcription={props.transcription}
              />
            </>
          }
          header={
            <header class="border-border bg-card border-b px-5 pt-2.5 pb-2">
              <div class="flex min-h-16 items-center gap-3">
                <div class="min-w-0 flex-1">
                  <p class="text-muted-foreground text-2xs font-bold tracking-wider uppercase">
                    {channel().kind === 'project'
                      ? 'Project conversation'
                      : channel().kind === 'direct_agent'
                        ? 'Direct Conversation'
                        : 'Group conversation'}
                  </p>
                  <h1 class="truncate text-lg font-bold tracking-tight">
                    {directAgent() ? directAgent()!.name : channel().title}
                  </h1>
                </div>
                <div class="flex items-center justify-end gap-1">
                  <Show when={directAgent()}>
                    {(agent) => <AgentStatusBadge agent={agent()} />}
                  </Show>
                  <ActionButton
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Search this conversation"
                    tooltip="Search this conversation (Mod+F)"
                    tooltipSide="top"
                    onClick={() => props.onOpenSearch()}
                  >
                    <Search aria-hidden="true" />
                  </ActionButton>
                  <ActionButton
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Mark conversation unread"
                    tooltip="Mark conversation unread (Mod+Shift+U)"
                    tooltipSide="top"
                    onClick={() => void props.onMarkUnread()}
                  >
                    <MailOpen aria-hidden="true" />
                  </ActionButton>
                  <ActionButton
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Open conversation details"
                    tooltip="Open conversation details"
                    tooltipSide="top"
                    onClick={() => props.onOpenDetails()}
                  >
                    <Info aria-hidden="true" />
                  </ActionButton>
                </div>
              </div>
              <nav class="min-w-0 overflow-hidden pt-0.5" aria-label="People in this conversation">
                <ul class="flex justify-center gap-2.5 pt-0.5 pb-1">
                  <For each={conversationPeople()}>
                    {(person) => (
                      <li
                        class="relative grid size-9 shrink-0 place-items-center"
                        aria-label={person.label}
                        title={person.label}
                      >
                        <span
                          class={cn('block rounded-full', {
                            'ring-primary ring-offset-card ring-2 ring-offset-2': person.active,
                          })}
                        >
                          <ConversationAvatar kind={person.kind} avatarRef={person.avatarRef} />
                        </span>
                        <Show when={person.active}>
                          <span class="border-card bg-primary absolute right-0.5 bottom-0 size-2.5 rounded-full border-2" />
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </nav>
            </header>
          }
          thread={threadPanel()}
        >
          <SharedConversationSurface
            data-conventional-transcript=""
            gutter
            ref={setTranscript}
            resetKey={channel().id}
            initialReadingPosition={
              cachedTranscript(props.workspaceId, audienceEpoch(), channel().id)?.readingPosition
            }
            onReadingPositionChange={(position) => {
              // The engine's identity reset re-pins the outgoing transcript to
              // the bottom and reports that synthesized position before this
              // component's channel-switch effect has saved the reader's place.
              // Reports that arrive while the channel prop has already moved on
              // are internal repositioning, not reader intent — drop them or
              // the switch-away save captures a bottom pin instead of where
              // the reader actually was.
              if (props.channel?.id !== loadedChannelId) return
              liveReadingPosition = position
            }}
            aria-label={`${channel().title} message history`}
            onScroll={(event) => {
              liveReadingPosition = {
                top: event.currentTarget.scrollTop,
                following: liveReadingPosition.following,
              }
            }}
          >
            <Show when={(messageQuery.isPending || !pageBelongsToChannel()) && !messages().length}>
              <WorkspaceSkeleton label="Loading messages" />
            </Show>
            <Show when={messageQuery.isError && !messages().length}>
              <WorkspaceError
                error={messageQuery.error}
                retry={() => void messageQuery.refetch()}
              />
            </Show>
            <Show
              when={
                !messageQuery.isPending &&
                !messageQuery.isError &&
                pageBelongsToChannel() &&
                !rootMessages().length
              }
              fallback={
                <>
                  <For each={transcriptRows()}>
                    {(entry) => (
                      <>
                        <Show when={entry.item().showDayDivider}>
                          <MessageDayDivider
                            label={formatMessageDay(entry.item().message.createdAt)}
                            role="separator"
                          />
                        </Show>
                        <MessageRow
                          agents={agentById()}
                          artifacts={artifactById()}
                          message={entry.item().message}
                          highlighted={entry.item().message.id === props.searchTargetMessageId}
                          onOpenTask={props.onOpenTask}
                          onOpenThread={props.onThreadChange}
                          onThreadIntent={prefetchThread}
                          privateContent={props.privateContent}
                          task={
                            entry.item().message.taskId
                              ? taskById().get(entry.item().message.taskId!)
                              : undefined
                          }
                        />
                      </>
                    )}
                  </For>
                  <Show when={optimisticMessage()}>
                    {(message) => (
                      <MessageRow
                        agents={agentById()}
                        artifacts={artifactById()}
                        message={message()}
                        onOpenTask={props.onOpenTask}
                        onOpenThread={props.onThreadChange}
                        onThreadIntent={prefetchThread}
                        pending
                        privateContent={props.privateContent}
                      />
                    )}
                  </Show>
                  <Show
                    when={settledConversationPage(messageQuery, audienceEpoch())?.nextAfterSequence}
                  >
                    {(nextSequence) => (
                      <Button
                        type="button"
                        variant="outline"
                        class="mx-auto my-3"
                        disabled={messageQuery.isFetching}
                        onClick={() => setCursor(nextSequence())}
                      >
                        {messageQuery.isFetching ? 'Loading…' : 'Load newer messages'}
                      </Button>
                    )}
                  </Show>
                </>
              }
            >
              <WorkspaceEmpty
                title={
                  directAgent()
                    ? `Start a direct conversation with ${directAgent()!.name}`
                    : `Start the ${channel().title} conversation`
                }
                detail="Messages here are canonical Adea history and remain stable across runtime sessions."
              />
            </Show>
          </SharedConversationSurface>
        </ConversationPane>
      )}
    </Show>
  )
}
