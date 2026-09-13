'use client'

import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js'
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

/**
 * Restores the persisted workspace state once, then keeps it written back.
 * Returns an accessor: callers must read it inside a reactive scope so the
 * workspace waits for the restore (and writes) to arm before rendering.
 */
export function useWorkspacePersistence(): Accessor<boolean> {
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
    const persister = createWorkspaceStatePersister<PersistedState>((state) => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
      } catch {
        // Private browsing or storage pressure must not break the workspace.
      }
    })
    // Reading the persisted fields inside the subscription is what makes the
    // subscription track them; passing the raw store only captures a live
    // proxy whose later reads would not retrigger the write.
    const writeNow = (state: WorkspaceState) => persister.save(persistedState(state))
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

  return ready
}
