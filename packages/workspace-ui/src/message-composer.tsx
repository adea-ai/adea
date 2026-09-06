import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentSummary, ArtifactSummary, ConversationParticipantRef } from "@adea-ai/types";
import { AtSign, LoaderCircle, Mic, MicOff, Paperclip, Send, X } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@adea-ai/ui/components/ui/tooltip";
import type { TranscriptionProvider, TranscriptionSession, TranscriptionState } from "./platform";
import { mergeTranscription } from "./transcription";
import { createClientRequestId } from "./request-id";
import { composerKeyboardAction, parseAgentMentions } from "./workspace-model";

export type ComposerSubmission = Readonly<{
  artifactIds: readonly string[];
  bodyText: string;
  idempotencyKey: string;
  mentions: readonly ConversationParticipantRef[];
}>;

export function MessageComposer({
  agents,
  artifacts,
  channelId,
  disabled = false,
  draft,
  onDraftChange,
  onSubmit,
  replyLabel,
  transcription,
}: Readonly<{
  agents: readonly AgentSummary[];
  artifacts: readonly ArtifactSummary[];
  channelId: string;
  disabled?: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: (submission: ComposerSubmission) => Promise<void>;
  replyLabel?: string;
  transcription?: TranscriptionProvider;
}>) {
  const [attachmentIds, setAttachmentIds] = useState<readonly string[]>([]);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null);
  const [transcriptionState, setTranscriptionState] = useState<TranscriptionState>(
    transcription ? "idle" : "unavailable"
  );
  const transcriptionSessionRef = useRef<TranscriptionSession | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(
    () => () => {
      transcriptionSessionRef.current?.cancel();
    },
    []
  );
  const mentionSuggestions = useMemo(() => {
    const match = draft.match(/(?:^|\s)@([^\n]*)$/);
    if (!match) return [];
    const query = match[1]?.toLocaleLowerCase() ?? "";
    return agents.filter(({ name }) => name.toLocaleLowerCase().includes(query)).slice(0, 5);
  }, [agents, draft]);

  const send = async () => {
    const bodyText = draft.trim();
    if (!bodyText || disabled || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSubmit({
        artifactIds: attachmentIds,
        bodyText,
        idempotencyKey: createClientRequestId(),
        mentions: parseAgentMentions(bodyText, agents),
      });
      onDraftChange("");
      setAttachmentIds([]);
    } catch {
      setError("Message not sent. Your draft is still here; retry when the connection recovers.");
    } finally {
      setSending(false);
    }
  };

  const insertMention = (agent: AgentSummary) => {
    onDraftChange(draft.replace(/@[^\n]*$/, `@${agent.name} `));
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const dictate = async () => {
    if (!transcription) return;
    if (transcriptionState === "listening" || transcriptionState === "processing") {
      transcriptionSessionRef.current?.cancel();
      transcriptionSessionRef.current = null;
      setTranscriptionState("cancelled");
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    setTranscriptionError(null);
    let activeSession: TranscriptionSession | null = null;
    try {
      const permission = await transcription.requestPermission();
      if (permission !== "granted") {
        setTranscriptionState(permission === "unavailable" ? "unavailable" : "error");
        setTranscriptionError(
          permission === "denied"
            ? "Microphone access is off. Enable it in system privacy settings, then retry."
            : "Dictation is unavailable on this device."
        );
        return;
      }
      const session = await transcription.start();
      activeSession = session;
      transcriptionSessionRef.current = session;
      setTranscriptionState("listening");
      const result = await session.completion;
      if (transcriptionSessionRef.current !== session) return;
      setTranscriptionState("processing");
      onDraftChange(mergeTranscription(draft, result.text));
      transcriptionSessionRef.current = null;
      setTranscriptionState("idle");
      requestAnimationFrame(() => textareaRef.current?.focus());
    } catch (error) {
      if (activeSession && transcriptionSessionRef.current !== activeSession) return;
      transcriptionSessionRef.current = null;
      setTranscriptionState("error");
      setTranscriptionError(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "Microphone access is off. Enable it in system privacy settings, then retry."
          : "Dictation stopped unexpectedly. Your existing draft is unchanged."
      );
    }
  };

  return (
    <section
      className="conventional-composer"
      aria-label={replyLabel ? `Reply to ${replyLabel}` : "Message composer"}
    >
      {replyLabel ? (
        <div className="conventional-composer__context">
          <span>Replying in thread · {replyLabel}</span>
        </div>
      ) : null}
      {attachmentIds.length ? (
        <div className="conventional-composer__attachments" aria-label="Selected attachments">
          {attachmentIds.map((artifactId) => {
            const artifact = artifacts.find(({ id }) => id === artifactId);
            return (
              <span key={artifactId}>
                {artifact?.filename ?? "Artifact"}
                <button
                  type="button"
                  aria-label={`Remove ${artifact?.filename ?? "Artifact"}`}
                  onClick={() => setAttachmentIds((ids) => ids.filter((id) => id !== artifactId))}
                >
                  <X aria-hidden="true" />
                </button>
              </span>
            );
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
          placeholder={disabled ? "Messaging is unavailable" : "Type something..."}
          aria-describedby={`composer-help-${channelId}`}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            const action = composerKeyboardAction({
              isComposing: event.nativeEvent.isComposing,
              key: event.key,
              shiftKey: event.shiftKey,
            });
            if (action === "send") {
              event.preventDefault();
              void send();
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
        <div className="conventional-composer__attachment-control">
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
                    disabled={artifact.availability !== "available"}
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
        <p id={`composer-help-${channelId}`} className="visually-hidden">
          Enter to send · Shift+Enter newline · Mod+Shift+M focus
        </p>
        <div className="conventional-composer__voice-control">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={
                    transcriptionState === "listening" || transcriptionState === "processing"
                      ? "Cancel dictation"
                      : "Start dictation"
                  }
                  aria-pressed={transcriptionState === "listening" || undefined}
                  disabled={disabled || sending || transcriptionState === "unavailable"}
                  onClick={() => void dictate()}
                />
              }
            >
              {transcriptionState === "processing" ? (
                <LoaderCircle aria-hidden="true" className="conventional-spin" />
              ) : transcriptionState === "listening" ? (
                <MicOff aria-hidden="true" />
              ) : (
                <Mic aria-hidden="true" />
              )}
            </TooltipTrigger>
            <TooltipContent>
              {transcription
                ? `Dictate with ${transcription.label}`
                : "Dictation is available in Adea Desktop"}
            </TooltipContent>
          </Tooltip>
        </div>
        <button
          type="button"
          className="conventional-send-button"
          aria-label={sending ? "Sending message" : "Send message"}
          disabled={disabled || sending || !draft.trim()}
          onClick={() => void send()}
        >
          <Send aria-hidden="true" />
          <span className="visually-hidden">{sending ? "Sending" : "Send"}</span>
        </button>
      </div>
      <div className="conventional-composer__status" aria-live="polite">
        {error ? (
          <p role="alert">{error}</p>
        ) : transcriptionError ? (
          <p role="alert">{transcriptionError}</p>
        ) : sending ? (
          <p className="conventional-composer__status--muted">Sending message…</p>
        ) : transcriptionState === "listening" ? (
          <p>Listening… Select the microphone again to cancel.</p>
        ) : transcriptionState === "processing" ? (
          <p>Preparing editable transcript…</p>
        ) : transcriptionState === "cancelled" ? (
          <p>Dictation cancelled. Your draft was preserved.</p>
        ) : null}
      </div>
    </section>
  );
}
