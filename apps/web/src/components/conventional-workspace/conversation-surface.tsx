import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentSummary,
  ArtifactSummary,
  ChannelSummary,
  MessageSummary,
  TaskSummary,
} from '@agent-hq/types'
import type { AgentHqApiClient } from '@agent-hq/api-client'
import { useCreateMessageMutation, useMessageListQuery } from '@agent-hq/data'
import { Info, MessagesSquare } from 'lucide-react'

import { MessageComposer, type ComposerSubmission } from './message-composer'
import { MessageRow } from './message-row'
import { ThreadPanel } from './thread-panel'
import { WorkspaceEmpty, WorkspaceError, WorkspaceSkeleton } from './workspace-states'

const scrollPositions = new Map<string, number>()

export function ConversationSurface({
  agents,
  artifacts,
  channel,
  client,
  draft,
  onDraftChange,
  onOpenDetails,
  onOpenTask,
  onThreadDraftChange,
  onThreadChange,
  tasks,
  threadDraft,
  threadRootMessageId,
  workspaceId,
}: Readonly<{
  agents: readonly AgentSummary[]
  artifacts: readonly ArtifactSummary[]
  channel?: ChannelSummary
  client: AgentHqApiClient
  draft: string
  onDraftChange: (value: string) => void
  onOpenDetails: () => void
  onOpenTask: (taskId: string) => void
  onThreadDraftChange: (value: string) => void
  onThreadChange: (messageId: string | null) => void
  tasks: readonly TaskSummary[]
  threadDraft: string
  threadRootMessageId: string | null
  workspaceId: string
}>) {
  const [cursor, setCursor] = useState<number | undefined>()
  const [messages, setMessages] = useState<readonly MessageSummary[]>([])
  const [optimisticBody, setOptimisticBody] = useState<string | null>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const messageQuery = useMessageListQuery(client, workspaceId, channel?.id, {
    ...(cursor !== undefined ? { afterSequence: cursor } : {}),
    limit: 100,
  })
  const createMessage = useCreateMessageMutation(client, workspaceId, channel?.id ?? '')

  useEffect(() => {
    setCursor(undefined)
    setMessages([])
    setOptimisticBody(null)
    requestAnimationFrame(() => {
      if (transcriptRef.current && channel)
        transcriptRef.current.scrollTop = scrollPositions.get(channel.id) ?? 0
    })
  }, [channel])

  useEffect(() => {
    if (!channel || !messageQuery.data) return
    const page = messageQuery.data.messages.filter((message) => message.channelId === channel.id)
    setMessages((current) => {
      const merged = new Map(current.map((message) => [message.id, message]))
      for (const message of page) merged.set(message.id, message)
      return [...merged.values()].sort((left, right) => left.sequence - right.sequence)
    })
  }, [channel, messageQuery.data])

  const rootMessages = useMemo(
    () => messages.filter(({ threadRootMessageId }) => !threadRootMessageId),
    [messages]
  )
  const root = threadRootMessageId
    ? rootMessages.find(({ id }) => id === threadRootMessageId)
    : undefined
  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]))
  const taskById = new Map(tasks.map((task) => [task.id, task]))

  const submit = async (submission: ComposerSubmission) => {
    setOptimisticBody(submission.bodyText)
    try {
      await createMessage.mutateAsync(submission)
    } finally {
      setOptimisticBody(null)
    }
  }

  if (!channel)
    return (
      <WorkspaceEmpty
        title="Choose a Room or conversation"
        detail="Rooms keep durable work, Agents, Tasks, and conversation history together."
      />
    )

  return (
    <section
      className={`conventional-conversation${root ? ' conventional-conversation--thread-open' : ''}`}
    >
      <header className="conventional-conversation__header">
        <div>
          <span>
            {channel.kind === 'room'
              ? 'Room conversation'
              : channel.kind === 'direct_agent'
                ? 'Direct Agent'
                : 'Group conversation'}
          </span>
          <h1>{channel.title}</h1>
        </div>
        <button type="button" aria-label="Open conversation details" onClick={onOpenDetails}>
          <Info aria-hidden="true" />
        </button>
      </header>
      <div
        ref={transcriptRef}
        className="conventional-transcript"
        aria-label={`${channel.title} message history`}
        onScroll={(event) => scrollPositions.set(channel.id, event.currentTarget.scrollTop)}
      >
        {messageQuery.isPending && !messages.length ? (
          <WorkspaceSkeleton label="Loading messages" />
        ) : null}
        {messageQuery.isError && !messages.length ? (
          <WorkspaceError error={messageQuery.error} retry={() => void messageQuery.refetch()} />
        ) : null}
        {!messageQuery.isPending && !messageQuery.isError && !rootMessages.length ? (
          <WorkspaceEmpty
            title={`Start the ${channel.title} conversation`}
            detail="Messages here are canonical Agent HQ history and remain stable across runtime sessions."
          />
        ) : null}
        {rootMessages.map((message) => (
          <MessageRow
            key={message.id}
            agents={agents}
            artifacts={artifactById}
            message={message}
            onOpenTask={onOpenTask}
            onOpenThread={onThreadChange}
            task={message.taskId ? taskById.get(message.taskId) : undefined}
          />
        ))}
        {optimisticBody ? (
          <div className="conventional-optimistic-message" role="status">
            <span>You</span>
            <p>{optimisticBody}</p>
            <small>Sending…</small>
          </div>
        ) : null}
        {messageQuery.data?.nextAfterSequence ? (
          <button
            type="button"
            className="conventional-load-more"
            disabled={messageQuery.isFetching}
            onClick={() => setCursor(messageQuery.data?.nextAfterSequence)}
          >
            {messageQuery.isFetching ? 'Loading…' : 'Load newer messages'}
          </button>
        ) : null}
      </div>
      <MessageComposer
        agents={agents}
        artifacts={artifacts}
        channelId={channel.id}
        draft={draft}
        onDraftChange={onDraftChange}
        onSubmit={submit}
      />
      {root ? (
        <ThreadPanel
          agents={agents}
          artifacts={artifacts}
          channelId={channel.id}
          client={client}
          draft={threadDraft}
          onClose={() => onThreadChange(null)}
          onDraftChange={onThreadDraftChange}
          onOpenTask={onOpenTask}
          root={root}
          tasks={tasks}
          workspaceId={workspaceId}
        />
      ) : threadRootMessageId ? (
        <aside className="conventional-thread conventional-thread--missing" role="status">
          <MessagesSquare aria-hidden="true" />
          <p>This thread is outside the loaded history window.</p>
          <button type="button" onClick={() => onThreadChange(null)}>
            Close thread
          </button>
        </aside>
      ) : null}
    </section>
  )
}
