import { create } from 'zustand'
import type { WorkspaceSceneId, WorkspaceViewMode } from '@agent-hq/types'

export type WorkspaceState = {
  selectedScene: WorkspaceSceneId
  cameraViewMode: WorkspaceViewMode
  selectedWorkspaceId: string | null
  selectedRoomId: string | null
  selectedChannelId: string | null
  selectedTaskId: string | null
  selectedAgentId: string | null
  threadRootMessageId: string | null
  activeSurface: 'agents' | 'conversation' | 'tasks'
  collapsedRoomIds: readonly string[]
  drafts: Readonly<Record<string, string>>
  mobileSidebarOpen: boolean
  globalPanel: 'about' | 'plugins' | 'search' | 'settings' | null
  setSelectedScene: (scene: WorkspaceSceneId) => void
  setCameraViewMode: (mode: WorkspaceViewMode) => void
  setSelectedWorkspaceId: (workspaceId: string | null) => void
  switchWorkspace: (workspaceId: string, scene: WorkspaceSceneId) => void
  setSelectedRoomId: (roomId: string | null) => void
  setSelectedChannelId: (channelId: string | null) => void
  setSelectedTaskId: (taskId: string | null) => void
  setSelectedAgentId: (agentId: string | null) => void
  setThreadRootMessageId: (messageId: string | null) => void
  setActiveSurface: (surface: WorkspaceState['activeSurface']) => void
  setDraft: (channelId: string, value: string) => void
  setMobileSidebarOpen: (open: boolean) => void
  setGlobalPanel: (panel: WorkspaceState['globalPanel']) => void
  toggleRoomCollapsed: (roomId: string) => void
  restoreConventionalState: (
    state: Partial<
      Pick<
        WorkspaceState,
        | 'activeSurface'
        | 'collapsedRoomIds'
        | 'drafts'
        | 'selectedAgentId'
        | 'selectedChannelId'
        | 'selectedRoomId'
        | 'selectedTaskId'
        | 'selectedWorkspaceId'
        | 'threadRootMessageId'
      >
    >
  ) => void
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  selectedScene: 'home',
  cameraViewMode: 'orthographic',
  selectedWorkspaceId: null,
  selectedRoomId: null,
  selectedChannelId: null,
  selectedTaskId: null,
  selectedAgentId: null,
  threadRootMessageId: null,
  activeSurface: 'conversation',
  collapsedRoomIds: [],
  drafts: {},
  mobileSidebarOpen: false,
  globalPanel: null,
  setSelectedScene: (selectedScene) => set({ selectedScene }),
  setCameraViewMode: (cameraViewMode) => set({ cameraViewMode }),
  setSelectedWorkspaceId: (selectedWorkspaceId) => set({ selectedWorkspaceId }),
  switchWorkspace: (selectedWorkspaceId, selectedScene) =>
    set({
      activeSurface: 'conversation',
      cameraViewMode: 'orthographic',
      collapsedRoomIds: [],
      drafts: {},
      globalPanel: null,
      mobileSidebarOpen: false,
      selectedAgentId: null,
      selectedChannelId: null,
      selectedRoomId: null,
      selectedScene,
      selectedTaskId: null,
      selectedWorkspaceId,
      threadRootMessageId: null,
    }),
  setSelectedRoomId: (selectedRoomId) => set({ selectedRoomId }),
  setSelectedChannelId: (selectedChannelId) =>
    set({ selectedChannelId, threadRootMessageId: null }),
  setSelectedTaskId: (selectedTaskId) => set({ selectedTaskId }),
  setSelectedAgentId: (selectedAgentId) => set({ selectedAgentId }),
  setThreadRootMessageId: (threadRootMessageId) => set({ threadRootMessageId }),
  setActiveSurface: (activeSurface) => set({ activeSurface }),
  setDraft: (channelId, value) =>
    set((state) => ({ drafts: { ...state.drafts, [channelId]: value } })),
  setMobileSidebarOpen: (mobileSidebarOpen) => set({ mobileSidebarOpen }),
  setGlobalPanel: (globalPanel) => set({ globalPanel }),
  toggleRoomCollapsed: (roomId) =>
    set((state) => ({
      collapsedRoomIds: state.collapsedRoomIds.includes(roomId)
        ? state.collapsedRoomIds.filter((id) => id !== roomId)
        : [...state.collapsedRoomIds, roomId],
    })),
  restoreConventionalState: (state) => set(state),
}))
