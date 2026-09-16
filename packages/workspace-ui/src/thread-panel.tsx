import type { AgentSummary, ArtifactSummary, MessageSummary, TaskSummary } from '@adea-ai/types'
import type { AgentHqApiClient } from '@adea-ai/api-client'
import { settledData, useCreateMessageMutation, useMessageListQuery } from '@adea-ai/data'
import { MailOpen, X } from 'lucide-solid'
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'

import { keyedRows } from './keyed-rows'
import { MessageComposer, type ComposerSubmission } from './message-composer'
import { MessageRow } from './message-row'
import type { PrivateContentResolver, TranscriptionProvider } from './platform'
import { WorkspaceError, WorkspaceSkeleton } from './workspace-states'

export function ThreadPanel(props: {
  agents: readonly AgentSummary[]
  artifacts: readonly ArtifactSummary[]
  channelId: string
  client: AgentHqApiClient
  draft: string
  onClose: () => void
  onDraftChange: (value: string) => void
  onOpenTask: (taskId: string) => void
  onMarkRead: (lastReadSequence: number) => Promise<void>
  onMarkUnread: () => Promise<void>
  privateContent?: PrivateContentResolver
  root: MessageSummary
  searchTargetMessageId: string | null
  tasks: readonly TaskSummary[]
  transcription?: TranscriptionProvider
  workspaceId: string
}) {
  const replies = useMessageListQuery(
    props.client,
    () => props.workspaceId,
    () => props.channelId,
    { limit: 100, threadRootMessageId: props.root.id }
  )
  let lastMarkedRead = 0
  const [panel, setPanel] = createSignal<HTMLElement>()

  createEffect(() => {
    void props.root.id
    lastMarkedRead = 0
  })

  const markVisible = () => {
    const messages = settledData(replies)?.messages ?? []
    if (!messages.length) return
    const lastReadSequence = Math.max(...messages.map(({ sequence }) => sequence))
    if (
      document.visibilityState !== 'visible' ||
      !document.hasFocus() ||
      lastMarkedRead >= lastReadSequence
    )
      return
    lastMarkedRead = lastReadSequence
    void props.onMarkRead(lastReadSequence).catch(() => {
      if (lastMarkedRead === lastReadSequence) lastMarkedRead = 0
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

  createEffect(() => {
    const target = props.searchTargetMessageId
    if (!target) return
    void settledData(replies)?.messages
    requestAnimationFrame(() =>
      panel()
        ?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(target)}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    )
  })

  const createMessage = useCreateMessageMutation(
    props.client,
    () => props.workspaceId,
    () => props.channelId
  )
  const artifactById = createMemo(
    () => new Map(props.artifacts.map((artifact) => [artifact.id, artifact]))
  )
  const taskById = createMemo(() => new Map(props.tasks.map((task) => [task.id, task])))
  // Keyed by message id: a refetched page updates rows in place instead of
  // remounting the reply list on every new object identity.
  const replyRows = keyedRows(
    () => settledData(replies)?.messages ?? [],
    (message) => message.id,
    (previous, next) => previous.version === next.version && previous.updatedAt === next.updatedAt
  )

  const submit = async (submission: ComposerSubmission) => {
    await createMessage.mutateAsync({
      ...submission,
      replyToMessageId: props.root.id,
      threadRootMessageId: props.root.id,
    })
  }

  return (
    <aside ref={setPanel} class="conventional-thread" aria-labelledby="thread-title">
      <header class="conventional-thread__header">
        <div>
          <span>Focused discussion</span>
          <h2 id="thread-title">Thread</h2>
        </div>
        <div>
          <button
            type="button"
            aria-label="Mark thread unread"
            onClick={() => void props.onMarkUnread()}
          >
            <MailOpen aria-hidden="true" />
          </button>
          <button type="button" aria-label="Close thread" onClick={() => props.onClose()}>
            <X aria-hidden="true" />
          </button>
        </div>
      </header>
      <div class="conventional-thread__transcript">
        <MessageRow
          agents={props.agents}
          artifacts={artifactById()}
          message={props.root}
          highlighted={props.root.id === props.searchTargetMessageId}
          onOpenTask={props.onOpenTask}
          privateContent={props.privateContent}
          task={props.root.taskId ? taskById().get(props.root.taskId) : undefined}
        />
        <div class="conventional-thread__divider" role="separator">
          {settledData(replies)?.messages.length ?? 0} replies
        </div>
        <Show when={replies.isPending}>
          <WorkspaceSkeleton label="Loading thread replies" />
        </Show>
        <Show when={replies.isError}>
          <WorkspaceError error={replies.error} retry={() => void replies.refetch()} />
        </Show>
        <For each={replyRows()}>
          {(entry) => (
            <MessageRow
              agents={props.agents}
              artifacts={artifactById()}
              message={entry.item()}
              highlighted={entry.item().id === props.searchTargetMessageId}
              onOpenTask={props.onOpenTask}
              privateContent={props.privateContent}
              task={entry.item().taskId ? taskById().get(entry.item().taskId!) : undefined}
            />
          )}
        </For>
      </div>
      <MessageComposer
        agents={props.agents}
        artifacts={props.artifacts}
        channelId={`thread-${props.root.id}`}
        draft={props.draft}
        onDraftChange={props.onDraftChange}
        onSubmit={submit}
        replyLabel={props.root.bodyText?.slice(0, 56) || 'private message'}
        transcription={props.transcription}
      />
    </aside>
  )
}
