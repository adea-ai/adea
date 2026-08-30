import { describe, expect, test } from 'bun:test'

import type { AgentSummary, ChannelSummary, RoomSummary } from '@agent-hq/types'

import {
  composerKeyboardAction,
  parseAgentMentions,
  projectWorkspaceNavigation,
} from '../src/components/conventional-workspace/workspace-model'

const room = (id: string, sortOrder: number): RoomSummary => ({
  createdAt: '2026-01-01T00:00:00.000Z',
  functionKey: id,
  id,
  lifecycleState: 'active',
  name: id === 'engineering' ? 'Engineering' : 'Marketing',
  sortOrder,
  updatedAt: '2026-01-01T00:00:00.000Z',
  workspaceId: 'workspace-1',
})
const channel = (
  id: string,
  kind: ChannelSummary['kind'],
  options: Partial<ChannelSummary> = {}
): ChannelSummary => ({
  createdAt: '2026-01-01T00:00:00.000Z',
  id,
  isPrimaryRoomChannel: false,
  kind,
  lifecycleState: 'active',
  participants: [],
  sortOrder: 0,
  title: id,
  updatedAt: '2026-01-01T00:00:00.000Z',
  version: 1,
  visibility: 'workspace',
  workspaceId: 'workspace-1',
  ...options,
})

describe('conventional workspace projection', () => {
  test('makes Rooms primary and hides a lone primary Channel label', () => {
    const navigation = projectWorkspaceNavigation(
      [room('marketing', 2), room('engineering', 1)],
      [
        channel('engineering-main', 'room', {
          isPrimaryRoomChannel: true,
          roomId: 'engineering',
        }),
        channel('marketing-main', 'room', {
          isPrimaryRoomChannel: true,
          roomId: 'marketing',
        }),
        channel('campaigns', 'room', { roomId: 'marketing', sortOrder: 1 }),
        channel('agent-dm', 'direct_agent', { agentId: 'agent-1' }),
        channel('group-1', 'group'),
      ]
    )

    expect(navigation.rooms.map(({ room }) => room.id)).toEqual(['engineering', 'marketing'])
    expect(navigation.rooms[0]?.visibleChannels).toEqual([])
    expect(navigation.rooms[0]?.selectionChannelId).toBe('engineering-main')
    expect(navigation.rooms[1]?.visibleChannels.map(({ id }) => id)).toEqual([
      'marketing-main',
      'campaigns',
    ])
    expect(navigation.directAgentChannels.map(({ id }) => id)).toEqual(['agent-dm'])
    expect(navigation.groupChannels.map(({ id }) => id)).toEqual(['group-1'])
  })

  test('uses Enter to send and Shift+Enter for a newline', () => {
    expect(composerKeyboardAction({ isComposing: false, key: 'Enter', shiftKey: false })).toBe(
      'send'
    )
    expect(composerKeyboardAction({ isComposing: false, key: 'Enter', shiftKey: true })).toBe(
      'newline'
    )
    expect(composerKeyboardAction({ isComposing: true, key: 'Enter', shiftKey: false })).toBe(
      'none'
    )
  })

  test('maps typed Agent mentions onto canonical Agent principals', () => {
    const agent: AgentSummary = {
      createdAt: '2026-01-01T00:00:00.000Z',
      id: 'agent-1',
      lifecycleState: 'active',
      name: 'Ada Lovelace',
      presentationMetadata: {},
      profile: { id: 'engineer', state: 'available', version: '1' },
      updatedAt: '2026-01-01T00:00:00.000Z',
      workspaceId: 'workspace-1',
    }
    expect(parseAgentMentions('Please ask @Ada Lovelace and @unknown', [agent])).toEqual([
      { agentId: 'agent-1', kind: 'agent' },
    ])
  })
})
