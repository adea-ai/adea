import { useEffect, useState } from "react";
import type { AgentSummary, ArtifactSummary, MessageSummary, TaskSummary } from "@adea-ai/types";
import {
  CheckCheck,
  File,
  LockKeyhole,
  MessageSquareReply,
  Pencil,
  RotateCcw,
  Trash2,
} from "lucide-react";

import type { PrivateContentResolver } from "./platform";
import { ConversationAvatar } from "./conversation-avatar";

function senderLabel(message: MessageSummary, agents: readonly AgentSummary[]) {
  if (message.sender.kind === "user") return "You";
  if (message.sender.kind === "system") return "Agent HQ";
  const agentId = message.sender.agentId;
  return agents.find(({ id }) => id === agentId)?.name ?? "Agent";
}

function MessageBody({
  message,
  privateContent,
}: {
  message: MessageSummary;
  privateContent?: PrivateContentResolver;
}) {
  const [resolvedBody, setResolvedBody] = useState<string | null>(null);
  const [resolutionState, setResolutionState] = useState<"idle" | "loading" | "unavailable">(
    "idle"
  );
  useEffect(() => {
    let active = true;
    setResolvedBody(null);
    if (!message.bodyContentRefId || message.bodyText || !privateContent) {
      setResolutionState("idle");
      return () => {
        active = false;
      };
    }
    setResolutionState("loading");
    void privateContent
      .read({ contentId: message.bodyContentRefId, workspaceId: message.workspaceId })
      .then(({ plaintext }) => {
        if (!active) return;
        setResolvedBody(plaintext);
        setResolutionState("idle");
      })
      .catch(() => {
        if (active) setResolutionState("unavailable");
      });
    return () => {
      active = false;
    };
  }, [message.bodyContentRefId, message.bodyText, message.workspaceId, privateContent]);
  if (message.deleted) return <p className="conventional-message__deleted">Message deleted</p>;
  if (message.bodyContentRefId && !message.bodyText && !resolvedBody)
    return (
      <div
        className="conventional-private-content"
        role={resolutionState === "unavailable" ? "alert" : "status"}
      >
        <LockKeyhole aria-hidden="true" />
        <div>
          <strong>
            {resolutionState === "loading"
              ? "Opening private content…"
              : "Private content unavailable"}
          </strong>
          <span>
            {privateContent
              ? "This device is not currently authorized for this content."
              : "Open this conversation on its authorized desktop device."}
          </span>
        </div>
      </div>
    );
  const blocks = (message.bodyText ?? resolvedBody ?? "")
    .split(/(```[\s\S]*?```)/g)
    .filter(Boolean);
  return (
    <div className="conventional-message__body">
      {blocks.map((block, index) =>
        block.startsWith("```") && block.endsWith("```") ? (
          <pre key={index} tabIndex={0} aria-label="Code block">
            <code>{block.slice(3, -3).replace(/^\w+\n/, "")}</code>
          </pre>
        ) : (
          <p key={index}>{block}</p>
        )
      )}
    </div>
  );
}

function ArtifactCard({
  artifactId,
  artifact,
}: {
  artifact?: ArtifactSummary;
  artifactId: string;
}) {
  const unavailable = !artifact || artifact.availability !== "available";
  return (
    <article
      className="conventional-artifact-card"
      aria-label={`Attachment ${artifact?.filename ?? artifactId}`}
    >
      <File aria-hidden="true" />
      <div>
        <strong>{artifact?.filename ?? "Unavailable Artifact"}</strong>
        <span>
          {artifact?.deletionState === "deleted"
            ? "Deleted"
            : unavailable
              ? "Unavailable"
              : `${artifact.mediaType} · ${artifact.sizeBytes.toLocaleString()} bytes`}
        </span>
      </div>
    </article>
  );
}

export function MessageRow({
  agents,
  artifacts,
  highlighted = false,
  message,
  onDelete,
  onEdit,
  onOpenTask,
  onOpenThread,
  privateContent,
  pending = false,
  retry,
  task,
}: Readonly<{
  agents: readonly AgentSummary[];
  artifacts: ReadonlyMap<string, ArtifactSummary>;
  highlighted?: boolean;
  message: MessageSummary;
  onDelete?: () => void;
  onEdit?: () => void;
  onOpenTask?: (taskId: string) => void;
  onOpenThread?: (messageId: string) => void;
  privateContent?: PrivateContentResolver;
  pending?: boolean;
  retry?: () => void;
  task?: TaskSummary;
}>) {
  const label = senderLabel(message, agents);
  const senderAgentId = message.sender.kind === "agent" ? message.sender.agentId : undefined;
  const senderAgent = senderAgentId ? agents.find(({ id }) => id === senderAgentId) : undefined;
  return (
    <article
      className={`conventional-message conventional-message--${message.sender.kind}${highlighted ? " conventional-message--highlighted" : ""}`}
      data-message-id={message.id}
      tabIndex={highlighted ? -1 : undefined}
      aria-busy={pending || undefined}
    >
      <div className="conventional-message__avatar" aria-hidden="true">
        <ConversationAvatar kind={message.sender.kind} avatarRef={senderAgent?.avatarRef} />
      </div>
      <div className="conventional-message__content">
        <div className="conventional-message__bubble">
          <span className="visually-hidden">{label}</span>
          <MessageBody message={message} privateContent={privateContent} />
          {message.artifactIds.length ? (
            <div className="conventional-message__artifacts">
              {message.artifactIds.map((artifactId) => (
                <ArtifactCard
                  key={artifactId}
                  artifactId={artifactId}
                  artifact={artifacts.get(artifactId)}
                />
              ))}
            </div>
          ) : null}
          {task ? (
            <button
              type="button"
              className="conventional-task-link"
              onClick={() => onOpenTask?.(task.id)}
            >
              Task · {task.title}
            </button>
          ) : null}
          <div className="conventional-message__meta">
            <time dateTime={message.createdAt}>
              {new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
                new Date(message.createdAt)
              )}
            </time>
            {message.editedAt ? <span>edited</span> : null}
            {pending ? <span role="status">sending…</span> : null}
            {message.sender.kind === "user" ? (
              <span className="conventional-message__receipt" aria-label="Delivered">
                <CheckCheck aria-hidden="true" />
              </span>
            ) : null}
          </div>
        </div>
        <footer className="conventional-message__actions">
          {!message.threadRootMessageId && !message.deleted ? (
            <button type="button" onClick={() => onOpenThread?.(message.id)}>
              <MessageSquareReply aria-hidden="true" />
              Thread
            </button>
          ) : null}
          {onEdit && !message.deleted ? (
            <button type="button" onClick={onEdit}>
              <Pencil aria-hidden="true" />
              Edit
            </button>
          ) : null}
          {onDelete && !message.deleted ? (
            <button type="button" onClick={onDelete}>
              <Trash2 aria-hidden="true" />
              Delete
            </button>
          ) : null}
          {retry ? (
            <button type="button" onClick={retry}>
              <RotateCcw aria-hidden="true" />
              Retry
            </button>
          ) : null}
        </footer>
      </div>
    </article>
  );
}
