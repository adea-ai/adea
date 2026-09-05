import { useEffect, useRef } from "react";
import type { AgentSummary, ArtifactSummary, MessageSummary, TaskSummary } from "@agent-hq/types";
import type { AgentHqApiClient } from "@agent-hq/api-client";
import { useCreateMessageMutation, useMessageListQuery } from "@agent-hq/data";
import { MailOpen, X } from "lucide-react";

import { MessageComposer, type ComposerSubmission } from "./message-composer";
import { MessageRow } from "./message-row";
import type { PrivateContentResolver, TranscriptionProvider } from "./platform";
import { WorkspaceError, WorkspaceSkeleton } from "./workspace-states";

export function ThreadPanel({
  agents,
  artifacts,
  channelId,
  client,
  draft,
  onClose,
  onDraftChange,
  onOpenTask,
  onMarkRead,
  onMarkUnread,
  privateContent,
  root,
  searchTargetMessageId,
  tasks,
  transcription,
  workspaceId,
}: Readonly<{
  agents: readonly AgentSummary[];
  artifacts: readonly ArtifactSummary[];
  channelId: string;
  client: AgentHqApiClient;
  draft: string;
  onClose: () => void;
  onDraftChange: (value: string) => void;
  onOpenTask: (taskId: string) => void;
  onMarkRead: (lastReadSequence: number) => Promise<void>;
  onMarkUnread: () => Promise<void>;
  privateContent?: PrivateContentResolver;
  root: MessageSummary;
  searchTargetMessageId: string | null;
  tasks: readonly TaskSummary[];
  transcription?: TranscriptionProvider;
  workspaceId: string;
}>) {
  const replies = useMessageListQuery(client, workspaceId, channelId, {
    limit: 100,
    threadRootMessageId: root.id,
  });
  const lastMarkedReadRef = useRef(0);
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    lastMarkedReadRef.current = 0;
  }, [root.id]);
  useEffect(() => {
    const messages = replies.data?.messages ?? [];
    if (!messages.length) return;
    const lastReadSequence = Math.max(...messages.map(({ sequence }) => sequence));
    const markVisible = () => {
      if (
        document.visibilityState !== "visible" ||
        !document.hasFocus() ||
        lastMarkedReadRef.current >= lastReadSequence
      )
        return;
      lastMarkedReadRef.current = lastReadSequence;
      void onMarkRead(lastReadSequence).catch(() => {
        if (lastMarkedReadRef.current === lastReadSequence) lastMarkedReadRef.current = 0;
      });
    };
    markVisible();
    window.addEventListener("focus", markVisible);
    document.addEventListener("visibilitychange", markVisible);
    return () => {
      window.removeEventListener("focus", markVisible);
      document.removeEventListener("visibilitychange", markVisible);
    };
  }, [onMarkRead, replies.data?.messages]);
  useEffect(() => {
    if (!searchTargetMessageId) return;
    requestAnimationFrame(() =>
      panelRef.current
        ?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(searchTargetMessageId)}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" })
    );
  }, [replies.data?.messages, searchTargetMessageId]);
  const createMessage = useCreateMessageMutation(client, workspaceId, channelId);
  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const submit = async (submission: ComposerSubmission) => {
    await createMessage.mutateAsync({
      ...submission,
      replyToMessageId: root.id,
      threadRootMessageId: root.id,
    });
  };

  return (
    <aside ref={panelRef} className="conventional-thread" aria-labelledby="thread-title">
      <header className="conventional-thread__header">
        <div>
          <span>Focused discussion</span>
          <h2 id="thread-title">Thread</h2>
        </div>
        <div>
          <button type="button" aria-label="Mark thread unread" onClick={() => void onMarkUnread()}>
            <MailOpen aria-hidden="true" />
          </button>
          <button type="button" aria-label="Close thread" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="conventional-thread__transcript">
        <MessageRow
          agents={agents}
          artifacts={artifactById}
          message={root}
          highlighted={root.id === searchTargetMessageId}
          onOpenTask={onOpenTask}
          privateContent={privateContent}
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
            highlighted={message.id === searchTargetMessageId}
            onOpenTask={onOpenTask}
            privateContent={privateContent}
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
        replyLabel={root.bodyText?.slice(0, 56) || "private message"}
        transcription={transcription}
      />
    </aside>
  );
}
