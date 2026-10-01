import type {
  AgentSummary,
  ChannelSummary,
  ConversationParticipantRef,
  RoomSummary,
} from '@adea-ai/types'

export type RoomNavigationItem = Readonly<{
  primaryChannel?: ChannelSummary
  room: RoomSummary
  selectionChannelId?: string
  visibleChannels: readonly ChannelSummary[]
}>

export type WorkspaceNavigation = Readonly<{
  directAgentChannels: readonly ChannelSummary[]
  groupChannels: readonly ChannelSummary[]
  rooms: readonly RoomNavigationItem[]
}>

export type WorkspaceSelectionDecision =
  | Readonly<{ action: 'wait' }>
  | Readonly<{ action: 'preserve'; clearExplicitSelection: boolean }>
  | Readonly<{ action: 'select'; channelId: string; roomId: string | null }>

/**
 * Preserve a valid selection, including one just created while its list query
 * is refreshing. The caller must not call the store's channel setter for the
 * preserve result because changing channels closes an open thread.
 */
export function reconcileWorkspaceChannelSelection(
  input: Readonly<{
    channels: readonly ChannelSummary[] | undefined
    explicitSelection: string | null
    navigation: WorkspaceNavigation
    selectedChannelId: string | null
  }>
): WorkspaceSelectionDecision {
  if (!input.channels?.length) return { action: 'wait' }

  if (input.selectedChannelId && input.channels.some(({ id }) => id === input.selectedChannelId)) {
    return {
      action: 'preserve',
      clearExplicitSelection: input.explicitSelection === input.selectedChannelId,
    }
  }

  if (input.selectedChannelId && input.selectedChannelId === input.explicitSelection) {
    return { action: 'preserve', clearExplicitSelection: false }
  }

  const firstRoom = input.navigation.rooms.find(({ selectionChannelId }) => selectionChannelId)
  const channelId =
    firstRoom?.selectionChannelId ??
    input.navigation.directAgentChannels[0]?.id ??
    input.navigation.groupChannels[0]?.id
  return channelId
    ? { action: 'select', channelId, roomId: firstRoom?.room.id ?? null }
    : { action: 'wait' }
}

function compareChannels(left: ChannelSummary, right: ChannelSummary) {
  return (
    left.sortOrder - right.sortOrder ||
    left.title.localeCompare(right.title) ||
    left.id.localeCompare(right.id)
  )
}

export function projectWorkspaceNavigation(
  rooms: readonly RoomSummary[],
  channels: readonly ChannelSummary[]
): WorkspaceNavigation {
  const activeChannels = channels.filter(({ lifecycleState }) => lifecycleState === 'active')
  const roomItems = [...rooms]
    .filter(({ lifecycleState }) => lifecycleState === 'active')
    .toSorted(
      (left, right) =>
        left.sortOrder - right.sortOrder ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id)
    )
    .map((room) => {
      const roomChannels = activeChannels
        .filter((channel) => channel.kind === 'room' && channel.roomId === room.id)
        .toSorted(compareChannels)
      const primaryChannel = roomChannels.find(({ isPrimaryRoomChannel }) => isPrimaryRoomChannel)
      return Object.freeze({
        ...(primaryChannel ? { primaryChannel } : {}),
        room,
        ...(primaryChannel || roomChannels[0]
          ? { selectionChannelId: (primaryChannel ?? roomChannels[0])!.id }
          : {}),
        visibleChannels: Object.freeze(roomChannels.length > 1 ? roomChannels : []),
      })
    })
  return Object.freeze({
    directAgentChannels: Object.freeze(
      activeChannels.filter(({ kind }) => kind === 'direct_agent').toSorted(compareChannels)
    ),
    groupChannels: Object.freeze(
      activeChannels.filter(({ kind }) => kind === 'group').toSorted(compareChannels)
    ),
    rooms: Object.freeze(roomItems),
  })
}

export function fuzzySearchMatch(candidate: string, query: string) {
  const target = candidate.toLocaleLowerCase()
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return true
  let cursor = 0
  for (const character of target) if (character === needle[cursor]) cursor += 1
  return cursor === needle.length
}

export function parseAgentMentions(
  text: string,
  agents: readonly AgentSummary[]
): readonly ConversationParticipantRef[] {
  const normalized = text.toLocaleLowerCase()
  return agents
    .filter(({ name }) => normalized.includes(`@${name.toLocaleLowerCase()}`))
    .toSorted(
      (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
    )
    .map(({ id }) => Object.freeze({ agentId: id, kind: 'agent' as const }))
}
