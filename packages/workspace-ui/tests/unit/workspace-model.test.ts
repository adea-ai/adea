import { describe, expect, test } from 'bun:test'

import type { AgentSummary, ChannelSummary, ProjectSummary } from '@adea-ai/types'

import {
  projectWorkspaceNavigation,
  reconcileWorkspaceChannelSelection,
} from '../../src/workspace-model'
import { fuzzySearchMatch, parseAgentMentions } from '../../src/workspace-text-match'

const project = (id: string, sortOrder: number): ProjectSummary => ({
  createdAt: '2026-01-01T00:00:00.000Z',
  iconKey: id,
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
  isPrimaryProjectChannel: false,
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
  test('makes Projects primary and hides a lone primary Channel label', () => {
    const navigation = projectWorkspaceNavigation(
      [project('marketing', 2), project('engineering', 1)],
      [
        channel('engineering-main', 'project', {
          isPrimaryProjectChannel: true,
          projectId: 'engineering',
        }),
        channel('marketing-main', 'project', {
          isPrimaryProjectChannel: true,
          projectId: 'marketing',
        }),
        channel('campaigns', 'project', { projectId: 'marketing', sortOrder: 1 }),
        channel('agent-dm', 'direct_agent', { agentId: 'agent-1' }),
        channel('group-1', 'group'),
      ]
    )

    expect(navigation.projects.map(({ project: summary }) => summary.id)).toEqual([
      'engineering',
      'marketing',
    ])
    expect(navigation.projects[0]?.visibleChannels).toEqual([])
    expect(navigation.projects[0]?.selectionChannelId).toBe('engineering-main')
    expect(navigation.projects[1]?.visibleChannels.map(({ id }) => id)).toEqual([
      'marketing-main',
      'campaigns',
    ])
    expect(navigation.directAgentChannels.map(({ id }) => id)).toEqual(['agent-dm'])
    expect(navigation.groupChannels.map(({ id }) => id)).toEqual(['group-1'])
  })

  test('preserves valid direct and group selections without issuing a channel change', () => {
    const channels = [
      channel('engineering-main', 'project', {
        isPrimaryProjectChannel: true,
        projectId: 'engineering',
      }),
      channel('agent-dm', 'direct_agent', { agentId: 'agent-1' }),
      channel('group-1', 'group'),
    ]
    const navigation = projectWorkspaceNavigation([project('engineering', 1)], channels)

    for (const selectedChannelId of ['agent-dm', 'group-1']) {
      expect(
        reconcileWorkspaceChannelSelection({
          channels,
          explicitSelection: null,
          navigation,
          selectedChannelId,
        })
      ).toEqual({ action: 'preserve', clearExplicitSelection: false })
    }
  })

  test('preserves a freshly created selection until it appears in the channel query', () => {
    const channels = [channel('agent-dm', 'direct_agent', { agentId: 'agent-1' })]
    const navigation = projectWorkspaceNavigation([], channels)

    expect(
      reconcileWorkspaceChannelSelection({
        channels,
        explicitSelection: 'new-group',
        navigation,
        selectedChannelId: 'new-group',
      })
    ).toEqual({ action: 'preserve', clearExplicitSelection: false })

    const refreshedChannels = [...channels, channel('new-group', 'group')]
    expect(
      reconcileWorkspaceChannelSelection({
        channels: refreshedChannels,
        explicitSelection: 'new-group',
        navigation: projectWorkspaceNavigation([], refreshedChannels),
        selectedChannelId: 'new-group',
      })
    ).toEqual({ action: 'preserve', clearExplicitSelection: true })
  })

  test('replaces a stale channel selection with the first available project selection', () => {
    const channels = [
      channel('engineering-main', 'project', {
        isPrimaryProjectChannel: true,
        projectId: 'engineering',
      }),
      channel('agent-dm', 'direct_agent', { agentId: 'agent-1' }),
    ]
    expect(
      reconcileWorkspaceChannelSelection({
        channels,
        explicitSelection: null,
        navigation: projectWorkspaceNavigation([project('engineering', 1)], channels),
        selectedChannelId: 'removed-channel',
      })
    ).toEqual({ action: 'select', channelId: 'engineering-main', projectId: 'engineering' })
  })

  test('fuzzy-matches command palette destinations without changing navigation ownership', () => {
    expect(fuzzySearchMatch('Mark all conversations read', 'macr')).toBe(true)
    expect(fuzzySearchMatch('Workspace settings', 'wset')).toBe(true)
    expect(fuzzySearchMatch('Engineering', 'zz')).toBe(false)
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
