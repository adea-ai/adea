import { createEffect, createRoot, createSignal, onCleanup, onMount, type Accessor } from 'solid-js'
import { browserStorage, readPersisted, workspaceStore, type WorkspaceState } from '@adea-ai/state'

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

const ACTIVE_SURFACES = new Set(['agents', 'conversation', 'tasks'])
const NULLABLE_ID_FIELDS = [
  'selectedAgentId',
  'selectedChannelId',
  'selectedRoomId',
  'selectedTaskId',
  'selectedWorkspaceId',
  'threadRootMessageId',
] as const

/**
 * Validates a persisted blob for `restoreConventionalState`, which merges what
 * it is handed straight into the store. A field that is PRESENT with the wrong
 * type rejects the whole blob (corruption); a MISSING field is accepted (an
 * older shape), so a legacy blob still restores what it has. Exported so the
 * rejection rules are pinned by tests rather than by reading the store.
 */
export function validatePersistedState(parsed: unknown): Partial<PersistedState> | undefined {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const candidate = parsed as Record<string, unknown>
  const restored: Partial<PersistedState> = {}

  if ('activeSurface' in candidate) {
    if (
      typeof candidate.activeSurface !== 'string' ||
      !ACTIVE_SURFACES.has(candidate.activeSurface)
    )
      return undefined
    restored.activeSurface = candidate.activeSurface as PersistedState['activeSurface']
  }
  if ('collapsedRoomIds' in candidate) {
    const ids = candidate.collapsedRoomIds
    if (!Array.isArray(ids) || !ids.every((entry) => typeof entry === 'string')) return undefined
    restored.collapsedRoomIds = ids as readonly string[]
  }
  if ('drafts' in candidate) {
    const drafts = candidate.drafts
    if (
      drafts === null ||
      typeof drafts !== 'object' ||
      Array.isArray(drafts) ||
      !Object.values(drafts as Record<string, unknown>).every((entry) => typeof entry === 'string')
    )
      return undefined
    restored.drafts = drafts as Readonly<Record<string, string>>
  }
  for (const field of NULLABLE_ID_FIELDS) {
    if (!(field in candidate)) continue
    const value = candidate[field]
    if (value !== null && typeof value !== 'string') return undefined
    restored[field] = value
  }
  return restored
}

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
 * Restores the persisted workspace state once per app lifetime, then keeps it
 * written back. This is a module singleton: both the chat controller and the
 * virtual room controls mount it, and each mount used to re-restore from
 * storage (racing any state written since) and register a second store
 * subscription plus pagehide listener. One shared root means one restore,
 * one writer, and persistence that survives view switches.
 *
 * Returns an accessor: callers must read it inside a reactive scope so the
 * workspace waits for the restore (and writes) to arm before rendering.
 */
export function useWorkspacePersistence(): Accessor<boolean> {
  persistenceReady ??= createRoot(createPersistence)
  return persistenceReady
}

let persistenceReady: Accessor<boolean> | undefined

function createPersistence(): Accessor<boolean> {
  const [ready, setReady] = createSignal(false)

  // One-time restore: it tracks nothing, so onMount says what the effect was
  // silently relying on.
  onMount(() => {
    // Through the persistence boundary (#302): malformed text is quarantined
    // rather than deleted, and a blob whose present fields are the wrong type
    // is dropped instead of being merged into the store — restoreConventionalState
    // writes what it is given straight into the store.
    const { value } = readPersisted(browserStorage(), STORAGE_KEY, validatePersistedState)
    if (value) workspaceStore.getState().restoreConventionalState(value)
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
    if (typeof window === 'undefined') {
      onCleanup(unsubscribe)
      return
    }
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
