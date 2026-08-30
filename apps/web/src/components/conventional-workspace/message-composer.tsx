import { useMemo, useRef, useState } from 'react'
import type { AgentSummary, ArtifactSummary, ConversationParticipantRef } from '@agent-hq/types'
import { AtSign, Paperclip, Send, X } from 'lucide-react'

import { composerKeyboardAction, parseAgentMentions } from './workspace-model'

export type ComposerSubmission = Readonly<{
  artifactIds: readonly string[]
  bodyText: string
  idempotencyKey: string
  mentions: readonly ConversationParticipantRef[]
}>

export function MessageComposer({
  agents,
  artifacts,
  channelId,
  disabled = false,
  draft,
  onDraftChange,
  onSubmit,
  replyLabel,
}: Readonly<{
  agents: readonly AgentSummary[]
  artifacts: readonly ArtifactSummary[]
  channelId: string
  disabled?: boolean
  draft: string
  onDraftChange: (value: string) => void
  onSubmit: (submission: ComposerSubmission) => Promise<void>
  replyLabel?: string
}>) {
  const [attachmentIds, setAttachmentIds] = useState<readonly string[]>([])
  const [attachmentsOpen, setAttachmentsOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mentionSuggestions = useMemo(() => {
    const match = draft.match(/(?:^|\s)@([^\n]*)$/)
    if (!match) return []
    const query = match[1]?.toLocaleLowerCase() ?? ''
    return agents.filter(({ name }) => name.toLocaleLowerCase().includes(query)).slice(0, 5)
  }, [agents, draft])

  const send = async () => {
    const bodyText = draft.trim()
    if (!bodyText || disabled || sending) return
    setSending(true)
    setError(null)
    try {
      await onSubmit({
        artifactIds: attachmentIds,
        bodyText,
        idempotencyKey: crypto.randomUUID(),
        mentions: parseAgentMentions(bodyText, agents),
      })
      onDraftChange('')
      setAttachmentIds([])
    } catch {
      setError('Message not sent. Your draft is still here; retry when the connection recovers.')
    } finally {
      setSending(false)
    }
  }

  const insertMention = (agent: AgentSummary) => {
    onDraftChange(draft.replace(/@[^\n]*$/, `@${agent.name} `))
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  return (
    <section
      className="conventional-composer"
      aria-label={replyLabel ? `Reply to ${replyLabel}` : 'Message composer'}
    >
      {replyLabel ? (
        <div className="conventional-composer__context">
          <span>Replying in thread · {replyLabel}</span>
        </div>
      ) : null}
      {attachmentIds.length ? (
        <div className="conventional-composer__attachments" aria-label="Selected attachments">
          {attachmentIds.map((artifactId) => {
            const artifact = artifacts.find(({ id }) => id === artifactId)
            return (
              <span key={artifactId}>
                {artifact?.filename ?? 'Artifact'}
                <button
                  type="button"
                  aria-label={`Remove ${artifact?.filename ?? 'Artifact'}`}
                  onClick={() => setAttachmentIds((ids) => ids.filter((id) => id !== artifactId))}
                >
                  <X aria-hidden="true" />
                </button>
              </span>
            )
          })}
        </div>
      ) : null}
      <div className="conventional-composer__editor">
        <label htmlFor={`composer-${channelId}`} className="visually-hidden">
          Message
        </label>
        <textarea
          ref={textareaRef}
          id={`composer-${channelId}`}
          value={draft}
          rows={3}
          disabled={disabled || sending}
          placeholder={disabled ? 'Messaging is unavailable' : 'Message this conversation'}
          aria-describedby={`composer-help-${channelId}`}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            const action = composerKeyboardAction({
              isComposing: event.nativeEvent.isComposing,
              key: event.key,
              shiftKey: event.shiftKey,
            })
            if (action === 'send') {
              event.preventDefault()
              void send()
            }
          }}
        />
        {mentionSuggestions.length ? (
          <div className="conventional-mention-menu" aria-label="Mention an Agent">
            {mentionSuggestions.map((agent) => (
              <button key={agent.id} type="button" onClick={() => insertMention(agent)}>
                <AtSign aria-hidden="true" />
                {agent.name}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="conventional-composer__toolbar">
        <div>
          <button
            type="button"
            aria-label="Attach an Artifact"
            aria-expanded={attachmentsOpen}
            disabled={disabled || !artifacts.length}
            onClick={() => setAttachmentsOpen((open) => !open)}
          >
            <Paperclip aria-hidden="true" />
          </button>
          {attachmentsOpen ? (
            <div className="conventional-attachment-menu">
              <strong>Attach Artifact</strong>
              {artifacts.map((artifact) => (
                <label key={artifact.id}>
                  <input
                    type="checkbox"
                    checked={attachmentIds.includes(artifact.id)}
                    disabled={artifact.availability !== 'available'}
                    onChange={(event) =>
                      setAttachmentIds((ids) =>
                        event.target.checked
                          ? [...ids, artifact.id]
                          : ids.filter((id) => id !== artifact.id)
                      )
                    }
                  />
                  <span>{artifact.filename}</span>
                  <small>{artifact.availability}</small>
                </label>
              ))}
            </div>
          ) : null}
        </div>
        <p id={`composer-help-${channelId}`}>Enter to send · Shift+Enter for newline</p>
        <button
          type="button"
          className="conventional-send-button"
          disabled={disabled || sending || !draft.trim()}
          onClick={() => void send()}
        >
          <Send aria-hidden="true" />
          {sending ? 'Sending' : 'Send'}
        </button>
      </div>
      <div className="conventional-composer__status" aria-live="polite">
        {error ? <p role="alert">{error}</p> : sending ? <p>Sending message…</p> : null}
      </div>
    </section>
  )
}
