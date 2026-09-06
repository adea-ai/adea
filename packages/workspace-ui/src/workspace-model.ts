import type {
  AgentSummary,
  ChannelSummary,
  ConversationParticipantRef,
  RoomSummary,
} from "@adea-ai/types";

export type RoomNavigationItem = Readonly<{
  primaryChannel?: ChannelSummary;
  room: RoomSummary;
  selectionChannelId?: string;
  visibleChannels: readonly ChannelSummary[];
}>;

export type WorkspaceNavigation = Readonly<{
  directAgentChannels: readonly ChannelSummary[];
  groupChannels: readonly ChannelSummary[];
  rooms: readonly RoomNavigationItem[];
}>;

function compareChannels(left: ChannelSummary, right: ChannelSummary) {
  return (
    left.sortOrder - right.sortOrder ||
    left.title.localeCompare(right.title) ||
    left.id.localeCompare(right.id)
  );
}

export function projectWorkspaceNavigation(
  rooms: readonly RoomSummary[],
  channels: readonly ChannelSummary[]
): WorkspaceNavigation {
  const activeChannels = channels.filter(({ lifecycleState }) => lifecycleState === "active");
  const roomItems = [...rooms]
    .filter(({ lifecycleState }) => lifecycleState === "active")
    .sort(
      (left, right) =>
        left.sortOrder - right.sortOrder ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id)
    )
    .map((room) => {
      const roomChannels = activeChannels
        .filter((channel) => channel.kind === "room" && channel.roomId === room.id)
        .sort(compareChannels);
      const primaryChannel = roomChannels.find(({ isPrimaryRoomChannel }) => isPrimaryRoomChannel);
      return Object.freeze({
        ...(primaryChannel ? { primaryChannel } : {}),
        room,
        ...(primaryChannel || roomChannels[0]
          ? { selectionChannelId: (primaryChannel ?? roomChannels[0])!.id }
          : {}),
        visibleChannels: Object.freeze(roomChannels.length > 1 ? roomChannels : []),
      });
    });
  return Object.freeze({
    directAgentChannels: Object.freeze(
      activeChannels.filter(({ kind }) => kind === "direct_agent").sort(compareChannels)
    ),
    groupChannels: Object.freeze(
      activeChannels.filter(({ kind }) => kind === "group").sort(compareChannels)
    ),
    rooms: Object.freeze(roomItems),
  });
}

export function composerKeyboardAction(
  input: Readonly<{
    isComposing: boolean;
    key: string;
    shiftKey: boolean;
  }>
): "newline" | "none" | "send" {
  if (input.key !== "Enter" || input.isComposing) return "none";
  return input.shiftKey ? "newline" : "send";
}

export function searchKeyboardSelection(
  key: string,
  selectedIndex: number,
  resultCount: number
): Readonly<{ action: "move" | "open" | "none"; index: number }> {
  if (key === "ArrowDown")
    return { action: "move", index: Math.min(selectedIndex + 1, Math.max(resultCount - 1, 0)) };
  if (key === "ArrowUp") return { action: "move", index: Math.max(selectedIndex - 1, 0) };
  if (key === "Enter" && resultCount > 0) return { action: "open", index: selectedIndex };
  return { action: "none", index: selectedIndex };
}

export function fuzzySearchMatch(candidate: string, query: string) {
  const target = candidate.toLocaleLowerCase();
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  let cursor = 0;
  for (const character of target) if (character === needle[cursor]) cursor += 1;
  return cursor === needle.length;
}

export function parseAgentMentions(
  text: string,
  agents: readonly AgentSummary[]
): readonly ConversationParticipantRef[] {
  const normalized = text.toLocaleLowerCase();
  return agents
    .filter(({ name }) => normalized.includes(`@${name.toLocaleLowerCase()}`))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    .map(({ id }) => Object.freeze({ agentId: id, kind: "agent" as const }));
}
