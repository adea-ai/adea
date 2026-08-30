import type {
  AgentSummary,
  ChannelSummary,
  ConversationParticipantRef,
  RoomSummary,
} from '@agent-hq/types'

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
    .sort(
      (left, right) =>
        left.sortOrder - right.sortOrder ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id)
    )
    .map((room) => {
      const roomChannels = activeChannels
        .filter((channel) => channel.kind === 'room' && channel.roomId === room.id)
        .sort(compareChannels)
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
      activeChannels.filter(({ kind }) => kind === 'direct_agent').sort(compareChannels)
    ),
    groupChannels: Object.freeze(
      activeChannels.filter(({ kind }) => kind === 'group').sort(compareChannels)
    ),
    rooms: Object.freeze(roomItems),
  })
}

export function composerKeyboardAction(
  input: Readonly<{
    isComposing: boolean
    key: string
    shiftKey: boolean
  }>
): 'newline' | 'none' | 'send' {
  if (input.key !== 'Enter' || input.isComposing) return 'none'
  return input.shiftKey ? 'newline' : 'send'
}

export function parseAgentMentions(
  text: string,
  agents: readonly AgentSummary[]
): readonly ConversationParticipantRef[] {
  const normalized = text.toLocaleLowerCase()
  return agents
    .filter(({ name }) => normalized.includes(`@${name.toLocaleLowerCase()}`))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    .map(({ id }) => Object.freeze({ agentId: id, kind: 'agent' as const }))
}
