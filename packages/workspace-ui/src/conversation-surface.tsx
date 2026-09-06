import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentSummary,
  ArtifactSummary,
  ChannelSummary,
  MessageSummary,
  TaskSummary,
} from "@adea-ai/types";
import type { AgentHqApiClient } from "@adea-ai/api-client";
import { useCreateMessageMutation, useMessageListQuery } from "@adea-ai/data";
import { Info, MailOpen, MessagesSquare, Search } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@adea-ai/ui/components/ui/tooltip";
import { MessageComposer, type ComposerSubmission } from "./message-composer";
import { MessageRow } from "./message-row";
import { ThreadPanel } from "./thread-panel";
import { WorkspaceEmpty, WorkspaceError, WorkspaceSkeleton } from "./workspace-states";
import type { PrivateContentResolver, TranscriptionProvider } from "./platform";
import { AgentStatusBadge } from "./agent-status";
import { ConversationAvatar } from "./conversation-avatar";

const scrollPositions = new Map<string, number>();

type ConversationPerson = Readonly<{
  active: boolean;
  id: string;
  label: string;
  kind: "agent" | "user";
  avatarRef?: string;
}>;

function peopleForConversation(
  channel: ChannelSummary,
  agents: readonly AgentSummary[],
  directAgent?: AgentSummary
): ConversationPerson[] {
  const participantIds = new Set(
    channel.participants
      .filter(
        (participant): participant is { kind: "agent"; agentId: string } =>
          participant.kind === "agent"
      )
      .map(({ agentId }) => agentId)
  );
  if (directAgent) participantIds.add(directAgent.id);
  if (channel.kind === "room" && participantIds.size === 0) {
    for (const agent of agents) if (agent.roomId === channel.roomId) participantIds.add(agent.id);
  }
  const activeAgentId = directAgent?.id ?? participantIds.values().next().value;
  const people: ConversationPerson[] = [
    { active: false, id: "current-user", kind: "user", label: "You" },
  ];
  for (const agent of agents) {
    if (!participantIds.has(agent.id)) continue;
    people.push({
      active: activeAgentId === agent.id,
      id: agent.id,
      kind: "agent",
      label: agent.name,
      ...(agent.avatarRef ? { avatarRef: agent.avatarRef } : {}),
    });
  }
  return people;
}

function formatMessageDay(value: string): string {
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long" }).format(
    new Date(value)
  );
}

export function ConversationSurface({
  agents,
  artifacts,
  channel,
  client,
  draft,
  onDraftChange,
  onOpenDetails,
  onOpenSearch,
  onOpenTask,
  onMarkRead,
  onMarkThreadRead,
  onMarkThreadUnread,
  onMarkUnread,
  onThreadDraftChange,
  onThreadChange,
  privateContent,
  searchTargetMessageId,
  tasks,
  threadDraft,
  threadRootMessageId,
  transcription,
  workspaceId,
}: Readonly<{
  agents: readonly AgentSummary[];
  artifacts: readonly ArtifactSummary[];
  channel?: ChannelSummary;
  client: AgentHqApiClient;
  draft: string;
  onDraftChange: (value: string) => void;
  onOpenDetails: () => void;
  onOpenSearch: () => void;
  onOpenTask: (taskId: string) => void;
  onMarkRead: (lastReadSequence: number) => Promise<void>;
  onMarkThreadRead: (rootId: string, lastReadSequence: number) => Promise<void>;
  onMarkThreadUnread: (rootId: string) => Promise<void>;
  onMarkUnread: () => Promise<void>;
  onThreadDraftChange: (value: string) => void;
  onThreadChange: (messageId: string | null) => void;
  privateContent?: PrivateContentResolver;
  searchTargetMessageId: string | null;
  tasks: readonly TaskSummary[];
  threadDraft: string;
  threadRootMessageId: string | null;
  transcription?: TranscriptionProvider;
  workspaceId: string;
}>) {
  const [cursor, setCursor] = useState<number | undefined>();
  const [messages, setMessages] = useState<readonly MessageSummary[]>([]);
  const [optimisticMessage, setOptimisticMessage] = useState<MessageSummary | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const lastMarkedReadRef = useRef("");
  const messageQuery = useMessageListQuery(client, workspaceId, channel?.id, {
    ...(cursor !== undefined ? { afterSequence: cursor } : {}),
    limit: 100,
  });
  const createMessage = useCreateMessageMutation(client, workspaceId, channel?.id ?? "");

  useEffect(() => {
    setCursor(undefined);
    setMessages([]);
    setOptimisticMessage(null);
    requestAnimationFrame(() => {
      if (transcriptRef.current && channel)
        transcriptRef.current.scrollTop = scrollPositions.get(channel.id) ?? 0;
    });
  }, [channel]);

  useEffect(() => {
    if (!channel || !messageQuery.data) return;
    const page = messageQuery.data.messages.filter((message) => message.channelId === channel.id);
    setMessages((current) => {
      const merged = new Map(current.map((message) => [message.id, message]));
      for (const message of page) merged.set(message.id, message);
      return [...merged.values()].sort((left, right) => left.sequence - right.sequence);
    });
  }, [channel, messageQuery.data]);

  useEffect(() => {
    if (!searchTargetMessageId) return;
    requestAnimationFrame(() =>
      transcriptRef.current
        ?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(searchTargetMessageId)}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" })
    );
  }, [messages, searchTargetMessageId, threadRootMessageId]);

  const rootMessages = useMemo(
    () => messages.filter(({ threadRootMessageId }) => !threadRootMessageId),
    [messages]
  );
  useEffect(() => {
    if (!channel || messageQuery.isPending || !rootMessages.length) return;
    const lastReadSequence = Math.max(...rootMessages.map(({ sequence }) => sequence));
    const markVisible = () => {
      const key = `${channel.id}:${lastReadSequence}`;
      if (
        document.visibilityState !== "visible" ||
        !document.hasFocus() ||
        lastMarkedReadRef.current === key
      )
        return;
      lastMarkedReadRef.current = key;
      void onMarkRead(lastReadSequence).catch(() => {
        if (lastMarkedReadRef.current === key) lastMarkedReadRef.current = "";
      });
    };
    markVisible();
    window.addEventListener("focus", markVisible);
    document.addEventListener("visibilitychange", markVisible);
    return () => {
      window.removeEventListener("focus", markVisible);
      document.removeEventListener("visibilitychange", markVisible);
    };
  }, [channel, messageQuery.isPending, onMarkRead, rootMessages]);
  const root = threadRootMessageId
    ? rootMessages.find(({ id }) => id === threadRootMessageId)
    : undefined;
  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const directAgent = channel?.agentId
    ? agents.find(({ id }) => id === channel.agentId)
    : undefined;
  const conversationPeople = channel ? peopleForConversation(channel, agents, directAgent) : [];

  const submit = async (submission: ComposerSubmission) => {
    const createdAt = new Date().toISOString();
    setOptimisticMessage({
      artifactIds: submission.artifactIds,
      bodyText: submission.bodyText,
      channelId: channel?.id ?? "",
      createdAt,
      deleted: false,
      id: "optimistic-message",
      mentions: submission.mentions,
      sender: { kind: "user", userId: "current-user" },
      sequence: Number.MAX_SAFE_INTEGER,
      updatedAt: createdAt,
      version: 0,
      workspaceId,
    });
    try {
      await createMessage.mutateAsync(submission);
    } finally {
      setOptimisticMessage(null);
    }
  };

  if (!channel)
    return (
      <WorkspaceEmpty
        title="Choose a Room or conversation"
        detail="Rooms keep durable work, Agents, Tasks, and conversation history together."
      />
    );

  return (
    <section
      className={`conventional-conversation${root ? " conventional-conversation--thread-open" : ""}`}
    >
      <header className="conventional-conversation__header">
        <div className="conventional-conversation__header-top">
          <div className="conventional-conversation__identity">
            <span>
              {channel.kind === "room"
                ? "Room conversation"
                : channel.kind === "direct_agent"
                  ? "Direct Conversation"
                  : "Group conversation"}
            </span>
            <h1>{directAgent ? directAgent.name : channel.title}</h1>
          </div>
          <div className="conventional-conversation__actions">
            {directAgent ? <AgentStatusBadge agent={directAgent} /> : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Search this conversation"
                    onClick={onOpenSearch}
                  />
                }
              >
                <Search aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent>Search this conversation (Mod+F)</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Mark conversation unread"
                    onClick={() => void onMarkUnread()}
                  />
                }
              >
                <MailOpen aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent>Mark conversation unread (Mod+Shift+U)</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Open conversation details"
                    onClick={onOpenDetails}
                  />
                }
              >
                <Info aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent>Open conversation details</TooltipContent>
            </Tooltip>
          </div>
        </div>
        <nav className="conventional-conversation__people" aria-label="People in this conversation">
          <ul>
            {conversationPeople.map((person) => (
              <li
                key={person.id}
                className={person.active ? "conventional-conversation__person--active" : undefined}
                aria-label={person.label}
                title={person.label}
              >
                <span
                  className={`conventional-conversation__person-avatar conventional-conversation__person-avatar--${person.kind}`}
                >
                  <ConversationAvatar kind={person.kind} avatarRef={person.avatarRef} />
                </span>
                {person.active ? (
                  <span className="conventional-conversation__person-presence" />
                ) : null}
              </li>
            ))}
          </ul>
        </nav>
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
            title={
              directAgent
                ? `Start a direct conversation with ${directAgent.name}`
                : `Start the ${channel.title} conversation`
            }
            detail="Messages here are canonical Adea history and remain stable across runtime sessions."
          />
        ) : null}
        {rootMessages.map((message, index) => {
          const previousMessage = rootMessages[index - 1];
          const showDayDivider =
            previousMessage &&
            formatMessageDay(previousMessage.createdAt) !== formatMessageDay(message.createdAt);
          return (
            <Fragment key={message.id}>
              {showDayDivider ? (
                <div className="conventional-date-divider" role="separator">
                  <span>{formatMessageDay(message.createdAt)}</span>
                </div>
              ) : null}
              <MessageRow
                agents={agents}
                artifacts={artifactById}
                message={message}
                highlighted={message.id === searchTargetMessageId}
                onOpenTask={onOpenTask}
                onOpenThread={onThreadChange}
                privateContent={privateContent}
                task={message.taskId ? taskById.get(message.taskId) : undefined}
              />
            </Fragment>
          );
        })}
        {optimisticMessage ? (
          <MessageRow
            agents={agents}
            artifacts={artifactById}
            message={optimisticMessage}
            onOpenTask={onOpenTask}
            onOpenThread={onThreadChange}
            pending
            privateContent={privateContent}
          />
        ) : null}
        {messageQuery.data?.nextAfterSequence ? (
          <button
            type="button"
            className="conventional-load-more"
            disabled={messageQuery.isFetching}
            onClick={() => setCursor(messageQuery.data?.nextAfterSequence)}
          >
            {messageQuery.isFetching ? "Loading…" : "Load newer messages"}
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
        transcription={transcription}
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
          onMarkRead={(sequence) => onMarkThreadRead(root.id, sequence)}
          onMarkUnread={() => onMarkThreadUnread(root.id)}
          privateContent={privateContent}
          root={root}
          searchTargetMessageId={searchTargetMessageId}
          tasks={tasks}
          transcription={transcription}
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
  );
}
