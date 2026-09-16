import type { AgentSummary, ArtifactSummary, MessageSummary, TaskSummary } from '@adea-ai/types'
import {
  CheckCheck,
  File,
  LockKeyhole,
  MessageSquareReply,
  Pencil,
  RotateCcw,
  Trash2,
} from 'lucide-solid'
import { createEffect, createSignal, For, Show } from 'solid-js'

import type { PrivateContentResolver } from './platform'
import { ConversationAvatar } from './conversation-avatar'

// Intl.DateTimeFormat construction is surprisingly expensive; share one
// formatter across every row instead of building it per binding evaluation.
const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

function senderLabel(message: MessageSummary, agents: ReadonlyMap<string, AgentSummary>) {
  if (message.sender.kind === 'user') return 'You'
  if (message.sender.kind === 'system') return 'Adea'
  const agentId = message.sender.agentId
  return (agentId ? agents.get(agentId)?.name : undefined) ?? 'Agent'
}

function MessageBody(props: { message: MessageSummary; privateContent?: PrivateContentResolver }) {
  const [resolvedBody, setResolvedBody] = createSignal<string | null>(null)
  const [resolutionState, setResolutionState] = createSignal<'idle' | 'loading' | 'unavailable'>(
    'idle'
  )

  createEffect(() => {
    let active = true
    setResolvedBody(null)
    const contentRefId = props.message.bodyContentRefId
    if (!contentRefId || props.message.bodyText || !props.privateContent) {
      setResolutionState('idle')
      return
    }
    setResolutionState('loading')
    void props.privateContent
      .read({ contentId: contentRefId, workspaceId: props.message.workspaceId })
      .then(({ plaintext }) => {
        if (!active) return
        setResolvedBody(plaintext)
        setResolutionState('idle')
      })
      .catch(() => {
        if (active) setResolutionState('unavailable')
      })
    return () => {
      active = false
    }
  })

  return (
    <Show
      when={!props.message.deleted}
      fallback={<p class="conventional-message__deleted">Message deleted</p>}
    >
      <Show
        when={!(props.message.bodyContentRefId && !props.message.bodyText && !resolvedBody())}
        fallback={
          <div
            class="conventional-private-content"
            role={resolutionState() === 'unavailable' ? 'alert' : 'status'}
          >
            <LockKeyhole aria-hidden="true" />
            <div>
              <strong>
                {resolutionState() === 'loading'
                  ? 'Opening private content…'
                  : 'Private content unavailable'}
              </strong>
              <span>
                {props.privateContent
                  ? 'This device is not currently authorized for this content.'
                  : 'Open this conversation on its authorized desktop device.'}
              </span>
            </div>
          </div>
        }
      >
        <div class="conventional-message__body">
          <For
            each={(props.message.bodyText ?? resolvedBody() ?? '')
              .split(/(```[\s\S]*?```)/g)
              .filter(Boolean)}
          >
            {(block) => (
              <Show
                when={block.startsWith('```') && block.endsWith('```')}
                fallback={<p>{block}</p>}
              >
                <pre tabIndex={0} aria-label="Code block">
                  <code>{block.slice(3, -3).replace(/^\w+\n/, '')}</code>
                </pre>
              </Show>
            )}
          </For>
        </div>
      </Show>
    </Show>
  )
}

function ArtifactCard(props: { artifact?: ArtifactSummary; artifactId: string }) {
  const unavailable = () => !props.artifact || props.artifact.availability !== 'available'
  return (
    <article
      class="conventional-artifact-card"
      aria-label={`Attachment ${props.artifact?.filename ?? props.artifactId}`}
    >
      <File aria-hidden="true" />
      <div>
        <strong>{props.artifact?.filename ?? 'Unavailable Artifact'}</strong>
        <span>
          {props.artifact?.deletionState === 'deleted'
            ? 'Deleted'
            : unavailable()
              ? 'Unavailable'
              : `${props.artifact!.mediaType} · ${props.artifact!.sizeBytes.toLocaleString()} bytes`}
        </span>
      </div>
    </article>
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
  const senderAgentId = () =>
    props.message.sender.kind === 'agent' ? props.message.sender.agentId : undefined
  const senderAgent = () => {
    const agentId = senderAgentId()
    return agentId ? props.agents.get(agentId) : undefined
  }

  return (
    <article
      class={`conventional-message conventional-message--${props.message.sender.kind}${props.highlighted ? ' conventional-message--highlighted' : ''}`}
      data-message-id={props.message.id}
      tabIndex={props.highlighted ? -1 : undefined}
      aria-busy={props.pending || undefined}
    >
      <div class="conventional-message__avatar" aria-hidden="true">
        <ConversationAvatar kind={props.message.sender.kind} avatarRef={senderAgent()?.avatarRef} />
      </div>
      <div class="conventional-message__content">
        <div class="conventional-message__bubble">
          <span class="visually-hidden">{label()}</span>
          <MessageBody message={props.message} privateContent={props.privateContent} />
          <Show when={props.message.artifactIds.length}>
            <div class="conventional-message__artifacts">
              <For each={props.message.artifactIds}>
                {(artifactId) => (
                  <ArtifactCard
                    artifactId={artifactId}
                    artifact={props.artifacts.get(artifactId)}
                  />
                )}
              </For>
            </div>
          </Show>
          <Show when={props.task}>
            {(task) => (
              <button
                type="button"
                class="conventional-task-link"
                onClick={() => props.onOpenTask?.(task().id)}
              >
                Task · {task().title}
              </button>
            )}
          </Show>
          <div class="conventional-message__meta">
            <time dateTime={props.message.createdAt}>
              {timeFormatter.format(new Date(props.message.createdAt))}
            </time>
            <Show when={props.message.editedAt}>
              <span>edited</span>
            </Show>
            <Show when={props.pending}>
              <span role="status">sending…</span>
            </Show>
            <Show when={props.message.sender.kind === 'user'}>
              <span class="conventional-message__receipt" aria-label="Delivered">
                <CheckCheck aria-hidden="true" />
              </span>
            </Show>
          </div>
        </div>
        <footer class="conventional-message__actions">
          <Show when={!props.message.threadRootMessageId && !props.message.deleted}>
            <button
              type="button"
              onClick={() => props.onOpenThread?.(props.message.id)}
              onPointerEnter={() => props.onThreadIntent?.(props.message.id)}
              onFocus={() => props.onThreadIntent?.(props.message.id)}
            >
              <MessageSquareReply aria-hidden="true" />
              Thread
            </button>
          </Show>
          <Show when={props.onEdit && !props.message.deleted}>
            <button type="button" onClick={() => props.onEdit?.()}>
              <Pencil aria-hidden="true" />
              Edit
            </button>
          </Show>
          <Show when={props.onDelete && !props.message.deleted}>
            <button type="button" onClick={() => props.onDelete?.()}>
              <Trash2 aria-hidden="true" />
              Delete
            </button>
          </Show>
          <Show when={props.retry}>
            <button type="button" onClick={() => props.retry?.()}>
              <RotateCcw aria-hidden="true" />
              Retry
            </button>
          </Show>
        </footer>
      </div>
    </article>
  )
}
