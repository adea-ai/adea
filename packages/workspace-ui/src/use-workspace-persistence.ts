'use client'

import { createEffect, createSignal, onCleanup } from 'solid-js'
import { workspaceStore, type WorkspaceState } from '@adea-ai/state'

import { createWorkspaceStatePersister } from './workspace-state-persister'

const STORAGE_KEY = 'adea:conventional-workspace:v2'
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
  const [ready, setReady] = createSignal(false)

  createEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY)
      if (saved) workspaceStore.getState().restoreConventionalState(JSON.parse(saved))
    } catch {
      window.localStorage.removeItem(STORAGE_KEY)
    }
    setReady(true)
  })

  createEffect(() => {
    if (!ready()) return
    const persister = createWorkspaceStatePersister((state) => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedState(state)))
      } catch {
        // Private browsing or storage pressure must not break the workspace.
      }
    })
    const writeNow = (state: WorkspaceState) => persister.save(state)
    writeNow(workspaceStore.getState())
    const unsubscribe = workspaceStore.subscribe(writeNow)
    // The debounced write must not lose the latest state when the app goes
    // away before the timer fires.
    const flushWhenHidden = () => {
      if (document.visibilityState === 'hidden') persister.flush()
    }
    window.addEventListener('pagehide', persister.flush)
    document.addEventListener('visibilitychange', flushWhenHidden)
    onCleanup(() => {
      unsubscribe()
      window.removeEventListener('pagehide', persister.flush)
      document.removeEventListener('visibilitychange', flushWhenHidden)
      persister.flush()
    })
  })

  return ready()
}
