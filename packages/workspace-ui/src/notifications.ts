export type WorkspaceNotificationDestination = Readonly<{
  channelId?: string;
  messageId?: string;
  taskId?: string;
  threadRootMessageId?: string;
  workspaceId: string;
}>;

export function canonicalNotificationHref(destination: WorkspaceNotificationDestination) {
  const query = new URLSearchParams({ workspace: destination.workspaceId });
  if (destination.channelId) query.set("channel", destination.channelId);
  if (destination.messageId) query.set("message", destination.messageId);
  if (destination.taskId) query.set("task", destination.taskId);
  if (destination.threadRootMessageId) query.set("thread", destination.threadRootMessageId);
  return `/?${query.toString()}`;
}

export function notificationPreview(
  input: Readonly<{
    destination: WorkspaceNotificationDestination;
    privateBody?: string;
    privateContent: boolean;
    privatePreviewAuthorized: boolean;
    publicBody?: string;
    sender: string;
  }>
) {
  const body = input.privateContent
    ? input.privatePreviewAuthorized && input.privateBody
      ? input.privateBody.slice(0, 180)
      : "New private message. Open Adea on the authorized device to read it."
    : (input.publicBody ?? "New workspace activity").slice(0, 180);
  return Object.freeze({
    body,
    href: canonicalNotificationHref(input.destination),
    title: input.sender,
  });
}
