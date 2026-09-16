import type {
  AgentSummary,
  ArtifactSummary,
  ChannelSummary,
  MessageSummary,
  TaskSummary,
} from '@adea-ai/types'
import type { AgentHqApiClient } from '@adea-ai/api-client'
import { settledData, useCreateMessageMutation, useMessageListQuery } from '@adea-ai/data'
import { Info, MailOpen, MessagesSquare, Search } from 'lucide-solid'
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'

import { Tooltip, TooltipContent, TooltipTrigger } from '@adea-ai/ui/components/ui/tooltip'
import { keyedRows } from './keyed-rows'
import { MessageComposer, type ComposerSubmission } from './message-composer'
import { MessageRow } from './message-row'
import { ThreadPanel } from './thread-panel'
import { WorkspaceEmpty, WorkspaceError, WorkspaceSkeleton } from './workspace-states'
import type { PrivateContentResolver, TranscriptionProvider } from './platform'
import { AgentStatusBadge } from './agent-status'
import { ConversationAvatar } from './conversation-avatar'

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
  { messages: readonly MessageSummary[]; scrollTop: number }
>()
const TRANSCRIPT_CACHE_LIMIT = 12

function rememberTranscript(
  channelId: string,
  messages: readonly MessageSummary[],
  scrollTop: number
) {
  transcriptCache.delete(channelId)
  transcriptCache.set(channelId, { messages, scrollTop })
  while (transcriptCache.size > TRANSCRIPT_CACHE_LIMIT) {
    transcriptCache.delete(transcriptCache.keys().next().value!)
  }
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
  if (channel.kind === 'room' && participantIds.size === 0) {
    for (const agent of agents) if (agent.roomId === channel.roomId) participantIds.add(agent.id)
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
  const [cursor, setCursor] = createSignal<number | undefined>()
  const [messages, setMessages] = createSignal<readonly MessageSummary[]>([])
  // Whether the loaded page belongs to this conversation. Solid Query keeps the
  // previous result while the next key is in flight, so a page that only holds
  // another channel's messages must not render as this conversation's history
  // (nor as an empty transcript). A genuinely empty page does belong here.
  const [pageBelongsToChannel, setPageBelongsToChannel] = createSignal(false)
  const [optimisticMessage, setOptimisticMessage] = createSignal<MessageSummary | null>(null)
  const [transcript, setTranscript] = createSignal<HTMLDivElement>()
  let lastMarkedRead = ''
  const messageQuery = useMessageListQuery(
    props.client,
    () => props.workspaceId,
    () => props.channel?.id,
    {
      ...(cursor() !== undefined ? { afterSequence: cursor() } : {}),
      limit: 100,
    },
    {
      // Revisiting a channel renders its last-known transcript as the
      // placeholder page while the refetch merges fresher messages in — the
      // query itself carries the stale-while-revalidate contract.
      placeholderData: () => {
        const channel = props.channel
        const cached = channel ? transcriptCache.get(channel.id) : undefined
        return cached ? { messages: cached.messages } : undefined
      },
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
  // Live scroll position of the loaded channel — captured into the cache
  // entry on switch instead of written to a map on every scroll event.
  let liveScrollTop = 0
  createEffect(() => {
    const channel = props.channel
    if (channel?.id !== loadedChannelId) {
      if (loadedChannelId) rememberTranscript(loadedChannelId, messages(), liveScrollTop)
      loadedChannelId = channel?.id
      setCursor(undefined)
      // Restore the last-known transcript for the incoming channel. The merge
      // below reconciles it with the fresh page when the refetch lands, so the
      // stale copy is a render bridge, not a second source of truth.
      const cached = channel ? transcriptCache.get(channel.id) : undefined
      setMessages(cached?.messages ?? [])
      liveScrollTop = cached?.scrollTop ?? 0
      setOptimisticMessage(null)
      setPageBelongsToChannel(false)
      requestAnimationFrame(() => {
        if (transcript() && channel) transcript()!.scrollTop = cached?.scrollTop ?? 0
      })
    }
    const data = settledData(messageQuery)
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

  const submit = async (submission: ComposerSubmission) => {
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
      const created = await createMessage.mutateAsync(submission)
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
    } finally {
      setOptimisticMessage(null)
    }
  }

  const messagesWithDividers = createMemo(() => {
    const list = rootMessages()
    return list.map((message, index) => {
      const previousMessage = list[index - 1]
      return {
        message,
        showDayDivider: Boolean(
          previousMessage &&
          formatMessageDay(previousMessage.createdAt) !== formatMessageDay(message.createdAt)
        ),
      }
    })
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
          title="Choose a Room or conversation"
          detail="Rooms keep durable work, Agents, Tasks, and conversation history together."
        />
      }
    >
      {(channel) => (
        <section
          class={`conventional-conversation${root() ? ' conventional-conversation--thread-open' : ''}`}
        >
          <header class="conventional-conversation__header">
            <div class="conventional-conversation__header-top">
              <div class="conventional-conversation__identity">
                <span>
                  {channel().kind === 'room'
                    ? 'Room conversation'
                    : channel().kind === 'direct_agent'
                      ? 'Direct Conversation'
                      : 'Group conversation'}
                </span>
                <h1>{directAgent() ? directAgent()!.name : channel().title}</h1>
              </div>
              <div class="conventional-conversation__actions">
                <Show when={directAgent()}>{(agent) => <AgentStatusBadge agent={agent()} />}</Show>
                <Tooltip>
                  <TooltipTrigger
                    aria-label="Search this conversation"
                    onClick={() => props.onOpenSearch()}
                  >
                    <Search aria-hidden="true" />
                  </TooltipTrigger>
                  <TooltipContent>Search this conversation (Mod+F)</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    aria-label="Mark conversation unread"
                    onClick={() => void props.onMarkUnread()}
                  >
                    <MailOpen aria-hidden="true" />
                  </TooltipTrigger>
                  <TooltipContent>Mark conversation unread (Mod+Shift+U)</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    aria-label="Open conversation details"
                    onClick={() => props.onOpenDetails()}
                  >
                    <Info aria-hidden="true" />
                  </TooltipTrigger>
                  <TooltipContent>Open conversation details</TooltipContent>
                </Tooltip>
              </div>
            </div>
            <nav class="conventional-conversation__people" aria-label="People in this conversation">
              <ul>
                <For each={conversationPeople()}>
                  {(person) => (
                    <li
                      class={
                        person.active ? 'conventional-conversation__person--active' : undefined
                      }
                      aria-label={person.label}
                      title={person.label}
                    >
                      <span
                        class={`conventional-conversation__person-avatar conventional-conversation__person-avatar--${person.kind}`}
                      >
                        <ConversationAvatar kind={person.kind} avatarRef={person.avatarRef} />
                      </span>
                      <Show when={person.active}>
                        <span class="conventional-conversation__person-presence" />
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </nav>
          </header>
          <div
            ref={setTranscript}
            class="conventional-transcript"
            aria-label={`${channel().title} message history`}
            onScroll={(event) => {
              liveScrollTop = event.currentTarget.scrollTop
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
            <For each={transcriptRows()}>
              {(entry) => (
                <>
                  <Show when={entry.item().showDayDivider}>
                    <div class="conventional-date-divider" role="separator">
                      <span>{formatMessageDay(entry.item().message.createdAt)}</span>
                    </div>
                  </Show>
                  <MessageRow
                    agents={agentById()}
                    artifacts={artifactById()}
                    message={entry.item().message}
                    highlighted={entry.item().message.id === props.searchTargetMessageId}
                    onOpenTask={props.onOpenTask}
                    onOpenThread={props.onThreadChange}
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
                  pending
                  privateContent={props.privateContent}
                />
              )}
            </Show>
            <Show when={settledData(messageQuery)?.nextAfterSequence}>
              {(nextSequence) => (
                <button
                  type="button"
                  class="conventional-load-more"
                  disabled={messageQuery.isFetching}
                  onClick={() => setCursor(nextSequence())}
                >
                  {messageQuery.isFetching ? 'Loading…' : 'Load newer messages'}
                </button>
              )}
            </Show>
          </div>
          <MessageComposer
            agents={props.agents}
            artifacts={props.artifacts}
            channelId={channel().id}
            draft={props.draft}
            onDraftChange={props.onDraftChange}
            onSubmit={submit}
            transcription={props.transcription}
          />
          <Show
            when={root()}
            fallback={
              <Show when={props.threadRootMessageId}>
                <aside class="conventional-thread conventional-thread--missing" role="status">
                  <MessagesSquare aria-hidden="true" />
                  <p>This thread is outside the loaded history window.</p>
                  <button type="button" onClick={() => props.onThreadChange(null)}>
                    Close thread
                  </button>
                </aside>
              </Show>
            }
          >
            {(rootMessage) => (
              <ThreadPanel
                agents={props.agents}
                artifacts={props.artifacts}
                channelId={channel().id}
                client={props.client}
                draft={props.threadDraft}
                onClose={() => props.onThreadChange(null)}
                onDraftChange={props.onThreadDraftChange}
                onOpenTask={props.onOpenTask}
                onMarkRead={(sequence) => props.onMarkThreadRead(rootMessage().id, sequence)}
                onMarkUnread={() => props.onMarkThreadUnread(rootMessage().id)}
                privateContent={props.privateContent}
                root={rootMessage()}
                searchTargetMessageId={props.searchTargetMessageId}
                tasks={props.tasks}
                transcription={props.transcription}
                workspaceId={props.workspaceId}
              />
            )}
          </Show>
        </section>
      )}
    </Show>
  )
}
