import { createEffect, createMemo, createRoot, type Accessor } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import type { WorkspaceSceneId, WorkspaceViewMode } from '@adea-ai/types'

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

function initialState(): WorkspaceState {
  // `set` writes a shallow merge into the Solid store, matching the previous
  // store's set semantics for every action below.
  const set = (partial: Partial<WorkspaceState>) => setStore(partial)

  return {
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
    mobileSidebarOpen:
      typeof window === 'undefined' ? true : window.matchMedia('(min-width: 48rem)').matches,
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
      setStore('drafts', (drafts) => ({ ...drafts, [channelId]: value })),
    setMobileSidebarOpen: (mobileSidebarOpen) => set({ mobileSidebarOpen }),
    setGlobalPanel: (globalPanel) => set({ globalPanel }),
    toggleRoomCollapsed: (roomId) =>
      setStore('collapsedRoomIds', (collapsedRoomIds) =>
        collapsedRoomIds.includes(roomId)
          ? collapsedRoomIds.filter((id) => id !== roomId)
          : [...collapsedRoomIds, roomId]
      ),
    restoreConventionalState: (state) => set(state),
  }
}

const [state, setStore] = createStore<WorkspaceState>(initialState())

/**
 * The one workspace state container. It is a Solid store, so consumers select
 * the fields they need through `useWorkspaceState` and only those fields
 * re-render.
 */
export const workspaceStore = {
  getState: (): WorkspaceState => state,
  setState(next: Partial<WorkspaceState>, replace = false): void {
    if (replace) setStore(reconcile(next as WorkspaceState))
    else setStore(next)
  },
  /**
   * Subscribes to every field the listener reads. Runs the listener once for
   * the current state, then again whenever a read field changes.
   */
  subscribe(listener: (state: WorkspaceState) => void): () => void {
    return createRoot((rootDispose) => {
      createEffect(() => listener(state))
      return rootDispose
    })
  },
}

/** Selects one field (or derived value) from the workspace store. */
export function useWorkspaceState<T>(selector: (state: WorkspaceState) => T): Accessor<T> {
  return createMemo(() => selector(state))
}
