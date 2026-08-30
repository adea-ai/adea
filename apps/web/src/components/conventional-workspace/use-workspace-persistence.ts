'use client'

import { useEffect, useState } from 'react'
import { useWorkspaceStore, type WorkspaceState } from '@agent-hq/state'

const STORAGE_KEY = 'agent-hq:conventional-workspace:v1'
type PersistedState = Pick<
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

function persistedState(state: WorkspaceState): PersistedState {
  return {
    activeSurface: state.activeSurface,
    collapsedRoomIds: state.collapsedRoomIds,
    drafts: state.drafts,
    selectedAgentId: state.selectedAgentId,
    selectedChannelId: state.selectedChannelId,
    selectedRoomId: state.selectedRoomId,
    selectedTaskId: state.selectedTaskId,
    selectedWorkspaceId: state.selectedWorkspaceId,
    threadRootMessageId: state.threadRootMessageId,
  }
}

export function useWorkspacePersistence() {
  const restore = useWorkspaceStore((state) => state.restoreConventionalState)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY)
      if (saved) restore(JSON.parse(saved) as Partial<PersistedState>)
    } catch {
      window.localStorage.removeItem(STORAGE_KEY)
    }
    setReady(true)
  }, [restore])

  useEffect(() => {
    if (!ready) return
    const save = (state: WorkspaceState) => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedState(state)))
      } catch {
        // Private browsing or storage pressure must not break the workspace.
      }
    }
    save(useWorkspaceStore.getState())
    return useWorkspaceStore.subscribe(save)
  }, [ready])

  return ready
}
