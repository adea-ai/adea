import type { AgentSummary, ArtifactSummary, MessageSummary, TaskSummary } from '@agent-hq/types'
import type { AgentHqApiClient } from '@agent-hq/api-client'
import { useCreateMessageMutation, useMessageListQuery } from '@agent-hq/data'
import { X } from 'lucide-react'

import { MessageComposer, type ComposerSubmission } from './message-composer'
import { MessageRow } from './message-row'
import { WorkspaceError, WorkspaceSkeleton } from './workspace-states'

export function ThreadPanel({
  agents,
  artifacts,
  channelId,
  client,
  draft,
  onClose,
  onDraftChange,
  onOpenTask,
  root,
  tasks,
  workspaceId,
}: Readonly<{
  agents: readonly AgentSummary[]
  artifacts: readonly ArtifactSummary[]
  channelId: string
  client: AgentHqApiClient
  draft: string
  onClose: () => void
  onDraftChange: (value: string) => void
  onOpenTask: (taskId: string) => void
  root: MessageSummary
  tasks: readonly TaskSummary[]
  workspaceId: string
}>) {
  const replies = useMessageListQuery(client, workspaceId, channelId, {
    limit: 100,
    threadRootMessageId: root.id,
  })
  const createMessage = useCreateMessageMutation(client, workspaceId, channelId)
  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]))
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const submit = async (submission: ComposerSubmission) => {
    await createMessage.mutateAsync({
      ...submission,
      replyToMessageId: root.id,
      threadRootMessageId: root.id,
    })
  }

  return (
    <aside className="conventional-thread" aria-labelledby="thread-title">
      <header className="conventional-thread__header">
        <div>
          <span>Focused discussion</span>
          <h2 id="thread-title">Thread</h2>
        </div>
        <button type="button" aria-label="Close thread" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="conventional-thread__transcript">
        <MessageRow
          agents={agents}
          artifacts={artifactById}
          message={root}
          onOpenTask={onOpenTask}
          task={root.taskId ? taskById.get(root.taskId) : undefined}
        />
        <div className="conventional-thread__divider" role="separator">
          {replies.data?.messages.length ?? 0} replies
        </div>
        {replies.isPending ? <WorkspaceSkeleton label="Loading thread replies" /> : null}
        {replies.isError ? (
          <WorkspaceError error={replies.error} retry={() => void replies.refetch()} />
        ) : null}
        {replies.data?.messages.map((message) => (
          <MessageRow
            key={message.id}
            agents={agents}
            artifacts={artifactById}
            message={message}
            onOpenTask={onOpenTask}
            task={message.taskId ? taskById.get(message.taskId) : undefined}
          />
        ))}
      </div>
      <MessageComposer
        agents={agents}
        artifacts={artifacts}
        channelId={`thread-${root.id}`}
        draft={draft}
        onDraftChange={onDraftChange}
        onSubmit={submit}
        replyLabel={root.bodyText?.slice(0, 56) || 'private message'}
      />
    </aside>
  )
}
