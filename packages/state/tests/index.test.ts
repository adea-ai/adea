import { afterEach, expect, test } from 'bun:test'

import { workspaceStore } from '../src'

const initialState = workspaceStore.getState()

afterEach(() => {
  workspaceStore.setState(initialState, true)
})

test('Dev selections reset at their authority boundaries without storing durable records', () => {
  workspaceStore.setState({
    selectedRuntimeNodeId: 'node-a',
    selectedDevProjectId: 'project-a',
    selectedRuntimeSessionId: 'session-a',
    selectedDevPaneId: 'pane-a',
    collapsedDevGroupIds: ['group-a'],
    collapsedDevProjectIds: ['project-a'],
    devFocusMode: true,
  })

  workspaceStore.getState().setSelectedRuntimeNodeId('node-b')
  expect(workspaceStore.getState()).toMatchObject({
    selectedRuntimeNodeId: 'node-b',
    selectedDevProjectId: null,
    selectedRuntimeSessionId: null,
    selectedDevPaneId: null,
    collapsedDevGroupIds: [],
    collapsedDevProjectIds: [],
    devFocusMode: false,
  })

  workspaceStore.getState().setSelectedDevProjectId('project-b')
  workspaceStore.getState().setSelectedRuntimeSessionId('session-b')
  workspaceStore.getState().setSelectedDevPaneId('pane-b')
  workspaceStore.getState().setSelectedDevProjectId('project-c')
  expect(workspaceStore.getState()).toMatchObject({
    selectedDevProjectId: 'project-c',
    selectedRuntimeSessionId: null,
    selectedDevPaneId: null,
  })
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
    selectedRuntimeNodeId: 'node-work',
    selectedDevProjectId: 'project-work',
    selectedRuntimeSessionId: 'session-work',
    selectedDevPaneId: 'pane-work',
    collapsedDevGroupIds: ['group-work'],
    collapsedDevProjectIds: ['project-work'],
    devFocusMode: true,
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
    selectedRuntimeNodeId: null,
    selectedDevProjectId: null,
    selectedRuntimeSessionId: null,
    selectedDevPaneId: null,
    collapsedDevGroupIds: [],
    collapsedDevProjectIds: [],
    devFocusMode: false,
    threadRootMessageId: null,
  })
})

test('switchWorkspace preserves the Dev selection family when asked', () => {
  workspaceStore.setState({
    selectedWorkspaceId: 'workspace-work',
    selectedScene: 'work',
    selectedRoomId: 'room-work',
    selectedChannelId: 'channel-work',
    drafts: { 'channel-work': 'unsent work' },
    selectedDevProjectId: 'project-recovered',
    selectedRuntimeSessionId: 'session-recovered',
    selectedDevPaneId: 'pane-work',
  })

  workspaceStore.getState().switchWorkspace('workspace-next', 'work', {
    preserveDevSelection: true,
  })

  expect(workspaceStore.getState()).toMatchObject({
    selectedWorkspaceId: 'workspace-next',
    // The freshly recovered Dev deep-link selection survives the reconcile.
    selectedDevProjectId: 'project-recovered',
    selectedRuntimeSessionId: 'session-recovered',
    // Only the Dev selection family survives; the context reset still runs.
    selectedRoomId: null,
    selectedChannelId: null,
    drafts: {},
  })
})
