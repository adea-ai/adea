import type { AgentSummary, ArtifactSummary, MessageSummary, TaskSummary } from '@adea-ai/types'
import {
  AttachmentCard,
  MessageBody as SharedMessageBody,
  MessageRow as SharedMessageRow,
} from '@adea-ai/ui/components/conversation'
import { File, LockKeyhole } from 'lucide-solid'
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js'

import type { PrivateContentResolver } from './platform'
import { AvatarContent } from './conversation-avatar'
import { Button } from '@adea-ai/ui/components/ui/button'

const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

function senderLabel(message: MessageSummary, agents: ReadonlyMap<string, AgentSummary>) {
  if (message.sender.kind === 'user') return 'You'
  if (message.sender.kind === 'system') return 'Adea'
  const agentId = message.sender.agentId
  return (agentId ? agents.get(agentId)?.name : undefined) ?? 'Agent'
}

type PrivateContentIdentity = Readonly<{
  contentRefId: string
  resolver: PrivateContentResolver
  workspaceId: string
}>

type PrivateContentResolution = PrivateContentIdentity &
  Readonly<{ status: 'loading' | 'unavailable' } | { plaintext: string; status: 'resolved' }>

function samePrivateContentIdentity(left: PrivateContentIdentity, right: PrivateContentIdentity) {
  return (
    left.resolver === right.resolver &&
    left.workspaceId === right.workspaceId &&
    left.contentRefId === right.contentRefId
  )
}

function PrivateMessageBody(props: {
  message: MessageSummary
  privateContent?: PrivateContentResolver
}) {
  const [resolution, setResolution] = createSignal<PrivateContentResolution>()
  const currentIdentity = (): PrivateContentIdentity | undefined => {
    const contentRefId = props.message.bodyContentRefId
    const resolver = props.privateContent
    if (!contentRefId || props.message.bodyText || !resolver) return
    return { contentRefId, resolver, workspaceId: props.message.workspaceId }
  }
  const currentResolution = () => {
    const identity = currentIdentity()
    const value = resolution()
    return identity && value && samePrivateContentIdentity(identity, value) ? value : undefined
  }
  const resolvedBody = () => {
    const value = currentResolution()
    return value?.status === 'resolved' ? value.plaintext : null
  }
  const resolutionState = () => {
    if (!props.privateContent) return 'unavailable'
    return currentResolution()?.status === 'unavailable' ? 'unavailable' : 'loading'
  }

  createEffect(() => {
    let active = true
    onCleanup(() => {
      active = false
    })
    const identity = currentIdentity()
    if (!identity) {
      setResolution(undefined)
      return
    }
    setResolution({ ...identity, status: 'loading' })
    void identity.resolver
      .read({ contentId: identity.contentRefId, workspaceId: identity.workspaceId })
      .then(({ plaintext }) => {
        if (!active) return
        setResolution({ ...identity, plaintext, status: 'resolved' })
      })
      .catch(() => {
        if (active) setResolution({ ...identity, status: 'unavailable' })
      })
  })

  return (
    <Show
      when={!(props.message.bodyContentRefId && !props.message.bodyText && !resolvedBody())}
      fallback={
        <div
          class="border-border bg-background mt-2 flex items-center gap-2.5 rounded-lg border p-2.5"
          role={resolutionState() === 'unavailable' ? 'alert' : 'status'}
        >
          <LockKeyhole aria-hidden="true" />
          <div class="grid min-w-0 gap-0.5">
            <strong>
              {resolutionState() === 'loading'
                ? 'Opening private content…'
                : 'Private content unavailable'}
            </strong>
            <span class="text-muted-foreground text-xs">
              {props.privateContent
                ? 'This device is not currently authorized for this content.'
                : 'Open this conversation on its authorized desktop device.'}
            </span>
          </div>
        </div>
      }
    >
      <SharedMessageBody text={props.message.bodyText ?? resolvedBody() ?? ''} />
    </Show>
  )
}

function ArtifactAttachments(props: {
  artifacts: ReadonlyMap<string, ArtifactSummary>
  artifactIds: readonly string[]
}) {
  return (
    <div class="flex flex-wrap gap-2">
      <For each={props.artifactIds}>
        {(artifactId) => {
          const artifact = () => props.artifacts.get(artifactId)
          const unavailable = () => !artifact() || artifact()!.availability !== 'available'
          const detail = () => {
            const value = artifact()
            if (value?.deletionState === 'deleted') return 'Deleted'
            if (unavailable()) return 'Unavailable'
            return `${value!.mediaType} · ${value!.sizeBytes.toLocaleString()} bytes`
          }

          return (
            <AttachmentCard
              aria-label={`Attachment ${artifact()?.filename ?? artifactId}`}
              disabled
              detail={detail()}
              icon={<File aria-hidden="true" />}
              name={artifact()?.filename ?? 'Unavailable Artifact'}
              unavailable={unavailable()}
            />
          )
        }}
      </For>
    </div>
  )
}

export function MessageRow(props: {
  /** Memoized id-keyed lookup — one map per surface, shared across all rows. */
  agents: ReadonlyMap<string, AgentSummary>
  artifacts: ReadonlyMap<string, ArtifactSummary>
  highlighted?: boolean
  message: MessageSummary
  onDelete?: () => void
  onEdit?: () => void
  onOpenTask?: (taskId: string) => void
  onOpenThread?: (messageId: string) => void
  /** Fires on hover/focus of the thread affordance — prefetch before click. */
  onThreadIntent?: (messageId: string) => void
  privateContent?: PrivateContentResolver
  pending?: boolean
  retry?: () => void
  task?: TaskSummary
}) {
  const label = () => senderLabel(props.message, props.agents)
  const senderAgent = () => {
    const agentId = props.message.sender.kind === 'agent' ? props.message.sender.agentId : undefined
    return agentId ? props.agents.get(agentId) : undefined
  }
  const taskLink = () =>
    props.task ? (
      <Button type="button" onClick={() => props.onOpenTask?.(props.task!.id)}>
        Task · {props.task.title}
      </Button>
    ) : undefined

  return (
    <SharedMessageRow
      data-message-id={props.message.id}
      dateTime={props.message.createdAt}
      edited={Boolean(props.message.editedAt)}
      highlighted={props.highlighted}
      link={taskLink()}
      onDelete={props.onDelete}
      onEdit={props.onEdit}
      onOpenThread={
        !props.message.threadRootMessageId && !props.message.deleted
          ? () => props.onOpenThread?.(props.message.id)
          : undefined
      }
      onRetry={props.retry}
      onThreadIntent={() => props.onThreadIntent?.(props.message.id)}
      pending={props.pending}
      senderKind={props.message.sender.kind}
      senderName={label()}
      time={timeFormatter.format(new Date(props.message.createdAt))}
      deleted={props.message.deleted}
      avatar={
        <AvatarContent kind={props.message.sender.kind} avatarRef={senderAgent()?.avatarRef} />
      }
      attachments={
        props.message.artifactIds.length ? (
          <ArtifactAttachments
            artifacts={props.artifacts}
            artifactIds={props.message.artifactIds}
          />
        ) : undefined
      }
    >
      <Show when={!props.message.deleted}>
        <PrivateMessageBody message={props.message} privateContent={props.privateContent} />
      </Show>
    </SharedMessageRow>
  )
}
