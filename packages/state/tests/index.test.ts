import { afterEach, expect, test } from 'bun:test'

import { workspaceStore } from '../src'

const initialState = workspaceStore.getState()

afterEach(() => {
  workspaceStore.setState(initialState, true)
})

test('switchWorkspace starts a fresh workspace context with its configured scene', () => {
  workspaceStore.setState({
    activeSurface: 'tasks',
    cameraViewMode: 'perspective',
    collapsedRoomIds: ['room-work'],
    drafts: { 'channel-work': 'unsent work' },
    globalPanel: 'plugins',
    mobileSidebarOpen: true,
    selectedAgentId: 'agent-work',
    selectedChannelId: 'channel-work',
    selectedRoomId: 'room-work',
    selectedTaskId: 'task-work',
    selectedWorkspaceId: 'workspace-work',
    selectedScene: 'work',
    threadRootMessageId: 'thread-work',
  })

  workspaceStore.getState().switchWorkspace('workspace-home', 'home')

  expect(workspaceStore.getState()).toMatchObject({
    activeSurface: 'conversation',
    cameraViewMode: 'orthographic',
    collapsedRoomIds: [],
    drafts: {},
    globalPanel: null,
    // The sidebar open/closed choice persists across workspace switches at
    // every viewport width.
    mobileSidebarOpen: true,
    selectedAgentId: null,
    selectedChannelId: null,
    selectedRoomId: null,
    selectedScene: 'home',
    selectedTaskId: null,
    selectedWorkspaceId: 'workspace-home',
    threadRootMessageId: null,
  })
})
