import type {
  CapabilitySnapshot,
  DevErrorCode,
  DevLayoutPreferencesV2,
  DevUtilityPane,
  DevUtilityPreference,
  PaneNode,
  Scope,
} from '@adea-ai/types/dev-runtime'
import { batch, createComputed, createEffect, createSignal, onCleanup, untrack } from 'solid-js'

import type { DevRuntimeService } from './platform'

/**
 * A runtime service for shells that boot without a Dev Runtime channel: every
 * authority reports unavailable, and the owner fences every dispatch behind
 * runtime readiness, so the contextual surfaces degrade to their provider
 * states without pulling the Dev contract into the startup chunk.
 */
export function createUnavailableDevUtilityRuntime(
  reason: DevErrorCode = 'unavailable'
): DevRuntimeService {
  return {
    state: () => ({ status: 'unavailable', reason }),
    preferenceScope: () => undefined,
    capabilitySnapshot: async (scope): Promise<CapabilitySnapshot> => ({
      scope,
      granted: [],
      unavailable: [],
      channelGeneration: 0,
      observedAt: new Date().toISOString(),
    }),
    execute: async (command) => ({
      schemaVersion: 1,
      operation: command.operation,
      requestId: command.requestId,
      ok: false,
      error: {
        code: reason,
        retryable: false,
        message: 'Dev Runtime is unavailable until its authenticated command channel is ready.',
        observedAt: new Date().toISOString(),
      },
    }),
  }
}
import type { LayoutStorage, PendingLayoutPatchJournal } from './layout/storage'
import { createPendingLayoutJournalKey } from './layout/storage-keys'
import {
  loadLayoutStorageModule,
  type LayoutStorageModule,
  type LayoutStorageModuleLoader,
} from './utility-layout-storage'
import {
  createDevUtilityContext,
  createDevUtilityFenceSource,
  isDevUtilityContextChanged,
  sameDevUtilityScope,
  type CanonicalRuntimeBinding,
  type DevUtilityContext,
  type DevUtilityView,
} from './utility-context'
import {
  archiveShelfError,
  archiveShelfReady,
  archiveShelfUnavailable,
  beginArchiveShelfLoad,
  cancelPendingDelete,
  confirmPendingDelete,
  requestDelete,
  restoreCompleted,
  SESSION_DELETE_OPERATION,
  type ArchiveShelfState,
  type ArchivedSessionSummary,
} from './sidebar/archive-shelf-model'
import {
  defaultUtilityPreferences,
  layoutUtilityTuple,
  snapUtilitySize,
  utilityPaneById,
} from './utility-preferences'

export type { CanonicalRuntimeBinding } from './utility-context'

export type LayoutLoadState =
  | 'loading'
  | 'empty'
  | 'ready'
  | 'corrupt'
  | 'unsupported'
  | 'unavailable'

type UtilityPreferencePatch = Partial<
  Pick<
    DevUtilityPreference,
    'visible' | 'size' | 'lastNonzeroSize' | 'fullWidth' | 'order' | 'side'
  >
>
type UtilityPreferenceField = keyof UtilityPreferencePatch
type UtilityPatchIntent = Partial<Record<DevUtilityPane, UtilityPreferencePatch>>
type LayoutPatch = {
  utility?: UtilityPatchIntent
  layout?: Pick<DevLayoutPreferencesV2, 'center' | 'focusMode' | 'focusTargetId'>
}

/**
 * Patch keys index plain objects, and the pane strings arrive from decoded
 * persisted preferences, so only known panes may become keys — a crafted
 * `__proto__` entry must never reach `utilityPatch[pane]`.
 */
const KNOWN_UTILITY_PANES: ReadonlySet<string> = new Set<DevUtilityPane>([
  'files',
  'source_control',
  'browser',
  'devices',
  'agents',
  'history',
])

function mergeLayoutPatch(value: DevLayoutPreferencesV2, patch?: LayoutPatch) {
  return {
    ...value,
    ...(patch?.utility
      ? {
          utility: layoutUtilityTuple(
            value.utility.map((item) => ({ ...item, ...patch.utility?.[item.pane] }))
          ),
        }
      : {}),
    ...patch?.layout,
  }
}

function hasLayoutPatch(patch: LayoutPatch | undefined) {
  return Boolean(patch && (patch.utility !== undefined || patch.layout !== undefined))
}

type LayoutVisibilityTarget = Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>

export type SharedDevUtilityOwner = Readonly<{
  context(): DevUtilityContext
  setView(view: DevUtilityView): void
  /** Publish only the selection resolved by CurrentDevWorkspaceEntry. */
  selectDevSession(binding: CanonicalRuntimeBinding | undefined): boolean
  /** Publish only after DesktopFirstRunChat has attached and validated it. */
  handoffCanonicalChatConversation(binding: CanonicalRuntimeBinding | undefined): boolean
  preferences(): DevLayoutPreferencesV2 | undefined
  /** Increments only when a new session document has been loaded. */
  layoutLoadRevision(): number
  layoutLoadState(): LayoutLoadState | undefined
  /** Retry a failed lazy layout-storage module load for the active session. */
  retryLayoutStorage(): boolean
  utilityPreferences(): readonly DevUtilityPreference[]
  updateUtilityPreferences(
    update:
      | readonly DevUtilityPreference[]
      | ((current: readonly DevUtilityPreference[]) => readonly DevUtilityPreference[]),
    expected?: CanonicalRuntimeBinding | null
  ): void
  rightUtilityOpen(): boolean
  showUtilityPane(pane: DevUtilityPane, expected?: CanonicalRuntimeBinding | null): void
  toggleRightUtility(expected?: CanonicalRuntimeBinding | null): void
  collapseRightUtility(expected?: CanonicalRuntimeBinding | null): void
  setUtilityPaneFullWidth(
    pane: DevUtilityPane,
    fullWidth: boolean,
    expected?: CanonicalRuntimeBinding | null
  ): void
  setUtilityPaneSize(
    pane: DevUtilityPane,
    size: number,
    expected?: CanonicalRuntimeBinding | null
  ): void
  updateLayoutPreferences(
    update: {
      center: PaneNode
      focusMode: boolean
      focusTargetId?: string
    },
    expected?: CanonicalRuntimeBinding | null
  ): void
  /** One scope-owned archive shelf shared by the workspace sidebars. */
  archiveShelf(): ArchiveShelfState
  archiveHandoffMessage(): string | undefined
  refreshArchiveShelf(): Promise<boolean>
  restoreArchivedSession(runtimeSessionId: string): Promise<boolean>
  requestArchiveDelete(runtimeSessionId: string): void
  cancelArchiveDelete(): void
  confirmArchiveDelete(): void
  /** Dev fixture input is projected into this owner without adding a second shelf model. */
  setArchiveShelfFixture(items: readonly ArchivedSessionSummary[]): void
  archiveRestoreRevision(): number
  dispose(): void
}>

function archiveScopeIdentity(scope: Scope | undefined): string | undefined {
  return scope
    ? JSON.stringify([scope.accountId, scope.workspaceId, scope.runtimeNodeId])
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (isRecord(error) && isRecord(error.error) && typeof error.error.message === 'string')
    return error.error.message
  return 'provider error'
}

const preferenceIdentity = (
  candidate: CanonicalRuntimeBinding,
  scope: CanonicalRuntimeBinding['scope']
) =>
  JSON.stringify([
    scope.accountId,
    scope.workspaceId,
    scope.runtimeNodeId,
    candidate.projectId,
    candidate.runtimeSessionId,
  ])

const makeDefaultDocument = (
  scope: CanonicalRuntimeBinding['scope'],
  projectId: string,
  runtimeSessionId: string
): DevLayoutPreferencesV2 => {
  const center: PaneNode = { kind: 'leaf', id: 'dev-terminal', pane: 'terminal' }
  return {
    schemaVersion: 2,
    scope,
    projectId,
    runtimeSessionId,
    center,
    utility: layoutUtilityTuple(defaultUtilityPreferences()),
    focusMode: false,
    focusTargetId: 'dev-terminal',
  }
}

const buildUtilityIntent = (
  items: readonly DevUtilityPreference[],
  predicate: (item: DevUtilityPreference) => boolean,
  fields: readonly UtilityPreferenceField[]
): UtilityPatchIntent => {
  const patch: UtilityPatchIntent = {}
  for (const item of items) {
    if (!predicate(item)) continue
    const changed: UtilityPreferencePatch = {}
    for (const field of fields) Object.assign(changed, { [field]: item[field] })
    patch[item.pane] = changed
  }
  return patch
}

/**
 * One shell-owned session identity for utilities shared across workspace views.
 * It does not infer a runtime session from a room/channel or a presentation
 * hint; Dev and Chat must publish their own authoritative binding.
 */
export function createSharedDevUtilityOwner(
  runtime: DevRuntimeService,
  storage?: LayoutStorage,
  loadStorageModule: LayoutStorageModuleLoader = loadLayoutStorageModule,
  visibilityTarget: LayoutVisibilityTarget | undefined = typeof globalThis.document === 'undefined'
    ? undefined
    : globalThis.document
): SharedDevUtilityOwner {
  const [view, setViewState] = createSignal<DevUtilityView>('workspace')
  const [binding, setBinding] = createSignal<CanonicalRuntimeBinding>()
  const [contextEpoch, setContextEpoch] = createSignal(0)
  const publishBinding = (next: CanonicalRuntimeBinding | undefined) => {
    const current = untrack(binding)
    if (
      current === next ||
      (current &&
        next &&
        sameDevUtilityScope(current.scope, next.scope) &&
        current.projectId === next.projectId &&
        current.runtimeSessionId === next.runtimeSessionId &&
        current.sessionGeneration === next.sessionGeneration &&
        current.worktreeId === next.worktreeId)
    )
      return
    batch(() => {
      setContextEpoch((epoch) => epoch + 1)
      setBinding(next)
    })
  }
  const [preferences, setPreferences] = createSignal<DevLayoutPreferencesV2>()
  const [layoutLoadRevision, setLayoutLoadRevision] = createSignal(0)
  const [layoutLoadState, setLayoutLoadState] = createSignal<LayoutLoadState>()
  const [layoutLoadRetryRevision, setLayoutLoadRetryRevision] = createSignal(0)
  const [utilityState, setUtilityState] = createSignal<readonly DevUtilityPreference[]>(
    defaultUtilityPreferences()
  )
  const [lastRightPane, setLastRightPane] = createSignal<DevUtilityPane>('browser')
  const [archiveState, setArchiveState] = createSignal<ArchiveShelfState>(beginArchiveShelfLoad())
  const [archiveHandoff, setArchiveHandoff] = createSignal<string>()
  const [archiveRestoreRevision, setArchiveRestoreRevision] = createSignal(0)
  let disposed = false
  type LayoutController = ReturnType<LayoutStorageModule['createLayoutStorageController']>
  type LayoutLoadJob = {
    identity: string
    scope: Scope
    projectId: string
    runtimeSessionId: string
    active: boolean
    loadedState?: Exclude<LayoutLoadState, 'loading' | 'unavailable'>
    controller?: LayoutController
    removeVisibilityListener?: () => void
  }
  let controller: LayoutController | undefined
  let controllerIdentity: string | undefined
  let controllerAttemptRevision = -1
  let activeLayoutLoadJob: LayoutLoadJob | undefined
  const pendingLayoutPatches = new Map<string, LayoutPatch>()
  const pendingJournalKeys = new Map<string, string>()
  let utilityChangedWithoutSession = false
  let archiveScopeIdentityValue: string | undefined
  let archiveRequestRevision = 0
  let fixtureArchiveActive = false

  // Observe reactive authority transitions synchronously, even when no pane
  // reads its context between A -> B -> A. The context read also observes
  // nonreactive host adapters when they publish their next snapshot.
  let scopeTransitionRevision = 0
  let observedScopeIdentity = archiveScopeIdentity(runtime.preferenceScope?.())
  const observeRuntimeScope = () => {
    const scope = runtime.preferenceScope?.()
    const identity = archiveScopeIdentity(scope)
    if (identity !== observedScopeIdentity) {
      observedScopeIdentity = identity
      scopeTransitionRevision += 1
    }
    return scope
  }
  createComputed(observeRuntimeScope)

  const context = createDevUtilityContext(
    () => {
      const scope = observeRuntimeScope()
      const candidate = binding()
      const valid =
        !disposed &&
        (view() === 'dev' || view() === 'chat') &&
        candidate !== undefined &&
        sameDevUtilityScope(candidate.scope, scope) &&
        Boolean(candidate.projectId && candidate.runtimeSessionId) &&
        Number.isSafeInteger(candidate.sessionGeneration) &&
        candidate.sessionGeneration > 0

      return {
        view: disposed ? 'workspace' : view(),
        runtime,
        scope,
        ...(valid
          ? {
              projectId: candidate.projectId,
              runtimeSessionId: candidate.runtimeSessionId,
              sessionGeneration: candidate.sessionGeneration,
              ...(candidate.worktreeId ? { worktreeId: candidate.worktreeId } : {}),
            }
          : {}),
      }
    },
    () => contextEpoch() + scopeTransitionRevision
  )
  const archiveFences = createDevUtilityFenceSource(context)

  const visibleArchiveState = (): ArchiveShelfState => {
    const currentScopeIdentity = archiveScopeIdentity(runtime.preferenceScope?.())
    if (fixtureArchiveActive)
      return archiveScopeIdentityValue === currentScopeIdentity
        ? archiveState()
        : beginArchiveShelfLoad()
    if (!currentScopeIdentity) return archiveShelfUnavailable('channel_unauthenticated')
    return archiveScopeIdentityValue === currentScopeIdentity
      ? archiveState()
      : beginArchiveShelfLoad()
  }

  const refreshArchiveShelf = async (): Promise<boolean> => {
    const requestedView = view()
    const requestedContextEpoch = contextEpoch()
    if (disposed || !['dev', 'chat', 'virtual'].includes(requestedView)) return false
    if (fixtureArchiveActive && requestedView === 'dev') return true
    // Fence any authority that already exists before the runtime readiness
    // wait. A first scope may be published by `ready`, but an existing scope
    // must not silently change while this request is suspended.
    const initialFence = archiveFences.capture('scope')
    const initialScopeRevision = scopeTransitionRevision
    const initialRuntimeStatus = initialFence?.context.runtime.state().status
    try {
      await runtime.ready?.catch(() => undefined)
    } catch {
      // The unavailable state below is the user's recovery affordance.
    }
    if (disposed || view() !== requestedView || contextEpoch() !== requestedContextEpoch)
      return false
    let fence = initialFence
    const current = context()
    if (
      initialFence
        ? scopeTransitionRevision !== initialScopeRevision
        : scopeTransitionRevision > initialScopeRevision + 1
    )
      return false
    if (fence) {
      if (
        current.runtime !== fence.context.runtime ||
        current.view !== fence.context.view ||
        archiveScopeIdentity(current.scope) !== archiveScopeIdentity(fence.context.scope) ||
        current.projectId !== fence.context.projectId ||
        current.runtimeSessionId !== fence.context.runtimeSessionId ||
        current.sessionGeneration !== fence.context.sessionGeneration ||
        current.worktreeId !== fence.context.worktreeId
      )
        return false
      // Runtime readiness is part of a utility fence. Re-capture only after
      // the owner context above proves that no view, binding, or scope changed.
      if (!fence.isCurrent()) {
        const currentRuntimeStatus = current.runtime.state().status
        if (
          currentRuntimeStatus === initialRuntimeStatus ||
          current.revision !== fence.context.revision + 1
        )
          return false
        fence = archiveFences.capture('scope')
      }
    } else {
      // No scope existed at invocation time. Preserve initial channel binding
      // by allowing the first ready scope only while the durable owner epoch
      // and requested view remain unchanged (checked above).
      fence = archiveFences.capture('scope')
    }
    if (!fence || !fence.context.scope) {
      archiveScopeIdentityValue = undefined
      setArchiveState(archiveShelfUnavailable('channel_unauthenticated'))
      return false
    }
    const runtimeState = runtime.state()
    if (runtimeState.status !== 'ready') {
      archiveScopeIdentityValue = archiveScopeIdentity(fence.context.scope)
      setArchiveState(archiveShelfUnavailable(runtimeState.reason))
      return false
    }
    const scopeIdentity = archiveScopeIdentity(fence.context.scope)
    if (!scopeIdentity) {
      setArchiveState(archiveShelfUnavailable('channel_unauthenticated'))
      return false
    }
    const sameScope = archiveScopeIdentityValue === scopeIdentity
    archiveScopeIdentityValue = scopeIdentity
    fixtureArchiveActive = false
    const requestRevision = ++archiveRequestRevision
    const previous = archiveState()
    setArchiveState(
      sameScope && (previous.status === 'ready' || previous.status === 'error')
        ? { ...previous, status: 'loading', reason: undefined }
        : beginArchiveShelfLoad()
    )
    setArchiveHandoff(undefined)
    const isOwnerCurrent = () =>
      !disposed &&
      contextEpoch() === requestedContextEpoch &&
      requestRevision === archiveRequestRevision
    try {
      const { listArchivedSessions } = await import('./utility-archive-operations')
      if (!isOwnerCurrent() || !fence.isCurrent()) return false
      const items = await listArchivedSessions({ fence, isOwnerCurrent })
      if (!isOwnerCurrent() || !fence.isCurrent()) return false
      setArchiveState(archiveShelfReady(items))
      return true
    } catch (error) {
      if (isDevUtilityContextChanged(error) || !fence.isCurrent() || !isOwnerCurrent()) return false
      setArchiveState(archiveShelfError(errorMessage(error), archiveState()))
      return false
    }
  }

  const restoreArchivedSession = async (runtimeSessionId: string): Promise<boolean> => {
    const requestedView = view()
    const requestedContextEpoch = contextEpoch()
    if (disposed || !['dev', 'chat', 'virtual'].includes(requestedView)) return false
    setArchiveHandoff(undefined)
    if (fixtureArchiveActive) {
      if (!archiveState().items.some((item) => item.id === runtimeSessionId)) return false
      setArchiveState((current) => restoreCompleted(current, runtimeSessionId))
      return true
    }
    const fence = archiveFences.capture('scope')
    const currentState = visibleArchiveState()
    if (!fence || !fence.context.scope) {
      setArchiveHandoff('Restore failed: the runtime scope is unavailable.')
      return false
    }
    const currentScopeIdentity = archiveScopeIdentity(fence.context.scope)
    if (!currentScopeIdentity || archiveScopeIdentityValue !== currentScopeIdentity) {
      setArchiveHandoff('Restore failed: refresh Archived sessions before restoring this session.')
      return false
    }
    const archived = currentState.items.find((item) => item.id === runtimeSessionId)
    if (!archived || !Number.isSafeInteger(archived.generation) || archived.generation! < 1) {
      setArchiveHandoff(
        'Restore failed: the session generation is unavailable; refresh Archived sessions.'
      )
      return false
    }
    const isOwnerCurrent = () =>
      !disposed && view() === requestedView && contextEpoch() === requestedContextEpoch
    try {
      const { restoreArchivedSession: restoreArchiveOperation } =
        await import('./utility-archive-operations')
      if (!isOwnerCurrent() || !fence.isCurrent()) return false
      await restoreArchiveOperation({ fence, isOwnerCurrent }, archived)
      if (!isOwnerCurrent() || !fence.isCurrent()) return false
      setArchiveState((current) => restoreCompleted(current, runtimeSessionId))
      setArchiveHandoff(undefined)
      setArchiveRestoreRevision((revision) => revision + 1)
      void refreshArchiveShelf()
      return true
    } catch (error) {
      if (isDevUtilityContextChanged(error) || !isOwnerCurrent() || !fence.isCurrent()) return false
      setArchiveHandoff(`Restore failed: ${errorMessage(error)}`)
      return false
    }
  }

  const requestArchiveDelete = (runtimeSessionId: string) => {
    if (!visibleArchiveState().items.some((item) => item.id === runtimeSessionId)) return
    setArchiveState((current) => requestDelete(current, runtimeSessionId))
  }
  const cancelArchiveDelete = () => setArchiveState((current) => cancelPendingDelete(current))
  const confirmArchiveDelete = () => {
    const commit = confirmPendingDelete(visibleArchiveState())
    setArchiveState(commit.state)
    if (!commit.commitId) return
    setArchiveHandoff(
      `Deleting sessions needs the ${SESSION_DELETE_OPERATION} host contract, which this build does not provide. The session stays archived and recoverable.`
    )
  }

  const accepts = (
    candidate: CanonicalRuntimeBinding | undefined
  ): candidate is CanonicalRuntimeBinding =>
    Boolean(
      !disposed &&
      candidate &&
      sameDevUtilityScope(candidate.scope, runtime.preferenceScope?.()) &&
      candidate.projectId &&
      candidate.runtimeSessionId &&
      Number.isSafeInteger(candidate.sessionGeneration) &&
      candidate.sessionGeneration > 0
    )

  const boundPreferences = () => {
    const candidate = binding()
    const scope = runtime.preferenceScope?.()
    if (
      !candidate ||
      !scope ||
      !sameDevUtilityScope(candidate.scope, scope) ||
      !candidate.projectId ||
      !candidate.runtimeSessionId
    )
      return undefined
    return { candidate, scope }
  }

  const matchesExpected = (expected: CanonicalRuntimeBinding | null | undefined) => {
    if (expected === undefined) return true
    if (expected === null) {
      const current = context()
      return (
        (current.view === 'dev' || current.view === 'chat' || current.view === 'virtual') &&
        current.runtimeSessionId === undefined
      )
    }
    const current = context()
    return Boolean(
      sameDevUtilityScope(expected.scope, current.scope) &&
      expected.projectId === current.projectId &&
      expected.runtimeSessionId === current.runtimeSessionId &&
      expected.sessionGeneration === current.sessionGeneration &&
      expected.worktreeId === current.worktreeId
    )
  }

  const documentForCurrentBinding = () => {
    const current = boundPreferences()

    if (!current) return undefined
    const loaded = preferences()
    if (
      loaded &&
      sameDevUtilityScope(loaded.scope, current.scope) &&
      loaded.projectId === current.candidate.projectId &&
      loaded.runtimeSessionId === current.candidate.runtimeSessionId
    )
      return loaded
    return makeDefaultDocument(
      current.scope,
      current.candidate.projectId,
      current.candidate.runtimeSessionId
    )
  }

  const commit = (
    next: DevLayoutPreferencesV2,
    schedule: boolean,
    patchField?: 'utility' | 'layout',
    utilityIntent?: UtilityPatchIntent
  ) => {
    const previous = patchField === 'utility' ? documentForCurrentBinding() : undefined
    setPreferences(next)
    setUtilityState(next.utility)
    const visibleRightPane = next.utility.find((item) => item.side === 'right' && item.visible)
    if (visibleRightPane) setLastRightPane(visibleRightPane.pane)
    const current = boundPreferences()
    if (
      schedule &&
      controller &&
      current &&
      controllerIdentity === preferenceIdentity(current.candidate, current.scope)
    )
      controller.schedule(next)
    else if (schedule && patchField && storage && current)
      recordLayoutPatch(
        preferenceIdentity(current.candidate, current.scope),
        patchField,
        next,
        previous,
        utilityIntent
      )
  }

  const recordLayoutPatch = (
    identity: string,
    field: 'utility' | 'layout',
    value: DevLayoutPreferencesV2,
    previous?: DevLayoutPreferencesV2,
    utilityIntent?: UtilityPatchIntent
  ) => {
    let patch = pendingLayoutPatches.get(identity)
    if (!patch) {
      patch = {}
      pendingLayoutPatches.set(identity, patch)
    }
    if (field === 'utility') {
      const previousByPane = new Map(previous?.utility.map((item) => [item.pane, item]))
      const fields = ['visible', 'size', 'lastNonzeroSize', 'fullWidth', 'order', 'side'] as const
      const utilityPatch = patch.utility ?? {}
      for (const item of value.utility) {
        if (!KNOWN_UTILITY_PANES.has(item.pane)) continue
        const before = previousByPane.get(item.pane)
        if (!before) continue
        const changed = utilityPatch[item.pane] ?? {}
        for (const key of fields) {
          if (item[key] !== before[key]) Object.assign(changed, { [key]: item[key] })
        }
        if (Object.keys(changed).length > 0) utilityPatch[item.pane] = changed
      }
      for (const [pane, intent] of Object.entries(utilityIntent ?? {}) as [
        DevUtilityPane,
        UtilityPreferencePatch,
      ][]) {
        if (!KNOWN_UTILITY_PANES.has(pane)) continue
        utilityPatch[pane] = { ...utilityPatch[pane], ...intent }
      }
      if (Object.keys(utilityPatch).length > 0) patch.utility = utilityPatch
    } else
      patch.layout = {
        center: value.center,
        focusMode: value.focusMode,
        focusTargetId: value.focusTargetId,
      }
    writePendingLayoutPatchJournal(identity, value, patch)
  }

  const writePendingLayoutPatchJournal = (
    identity: string,
    value: DevLayoutPreferencesV2,
    patch: LayoutPatch
  ) => {
    if (!storage) return
    let key = pendingJournalKeys.get(identity)
    if (key) {
      try {
        if (storage.getItem(key) === null) {
          pendingJournalKeys.delete(identity)
          key = undefined
        }
      } catch {
        // Reuse the scoped key when storage cannot be read; the write is retried below.
      }
    }
    if (!key) {
      key = createPendingLayoutJournalKey(
        storage,
        value.scope,
        value.projectId,
        value.runtimeSessionId
      )
      pendingJournalKeys.set(identity, key)
    }
    const journal = {
      version: 1,
      scope: value.scope,
      projectId: value.projectId,
      runtimeSessionId: value.runtimeSessionId,
      utilityFields: Object.fromEntries(
        Object.entries(patch.utility ?? {}).map(([pane, fields]) => [pane, Object.keys(fields)])
      ),
      layoutFields: Object.keys(patch.layout ?? {}),
      document: value,
    }
    try {
      storage.setItem(key, JSON.stringify(journal))
    } catch {
      // Keep the in-memory patch and prior journal; a later edit retries the write.
      if (controllerIdentity === identity && !disposed) setLayoutLoadState('unavailable')
    }
  }

  const closeLayoutLoadJob = (job: LayoutLoadJob) => {
    job.active = false
    job.removeVisibilityListener?.()
    job.removeVisibilityListener = undefined
    if (job.controller) {
      if (controller === job.controller) controller = undefined
      job.controller.dispose()
      job.controller = undefined
    }
    if (activeLayoutLoadJob === job) activeLayoutLoadJob = undefined
  }

  const startLayoutStorageLoad = (job: LayoutLoadJob, attemptRevision: number) => {
    const initialize = async () => {
      let storageModule: Awaited<ReturnType<LayoutStorageModuleLoader>>
      try {
        storageModule = await loadStorageModule()
      } catch {
        if (
          job.active &&
          !disposed &&
          activeLayoutLoadJob === job &&
          controllerIdentity === job.identity &&
          controllerAttemptRevision === attemptRevision
        )
          setLayoutLoadState('unavailable')
        return
      }

      const pendingPatch = pendingLayoutPatches.get(job.identity)
      if (!job.active && !hasLayoutPatch(pendingPatch)) return

      let nextController: LayoutController
      let loaded: ReturnType<LayoutController['load']>
      let createdController: LayoutController | undefined
      let journalSnapshot: PendingLayoutPatchJournal[] = []
      try {
        createdController = storageModule.createLayoutStorageController({
          storage: storage!,
          scope: job.scope,
          projectId: job.projectId,
          runtimeSessionId: job.runtimeSessionId,
          onCommit: () => {
            let complete = true
            for (const entry of journalSnapshot) {
              try {
                if (storage!.getItem(entry.key) !== entry.raw) continue
                storage!.removeItem(entry.key)
                if (storage!.getItem(entry.key) !== null) {
                  complete = false
                  continue
                }
                if (pendingJournalKeys.get(job.identity) === entry.key)
                  pendingJournalKeys.delete(job.identity)
              } catch {
                // The V2 document is committed; keep the journal if cleanup fails.
                complete = false
              }
            }
            if (complete && job.active && activeLayoutLoadJob === job && job.loadedState)
              setLayoutLoadState(job.loadedState)
            return complete
          },
          onWriteFailure: () => {
            if (job.active && activeLayoutLoadJob === job) setLayoutLoadState('unavailable')
          },
        })
        loaded = createdController.load()
        nextController = createdController
      } catch {
        createdController?.dispose()
        if (
          job.active &&
          !disposed &&
          activeLayoutLoadJob === job &&
          controllerIdentity === job.identity &&
          controllerAttemptRevision === attemptRevision
        )
          setLayoutLoadState('unavailable')
        return
      }

      const loadedDocument =
        loaded.state === 'ready'
          ? loaded.value
          : makeDefaultDocument(job.scope, job.projectId, job.runtimeSessionId)
      journalSnapshot = storageModule.readPendingLayoutPatchJournals(
        storage!,
        job.scope,
        job.projectId,
        job.runtimeSessionId
      )

      if (!job.active || disposed || activeLayoutLoadJob !== job) {
        if (hasLayoutPatch(pendingPatch) || journalSnapshot.length > 0) {
          const merged = journalSnapshot.reduce(
            (document, entry) => mergeLayoutPatch(document, entry.patch),
            loadedDocument
          )
          nextController.schedule(mergeLayoutPatch(merged, pendingPatch))
          pendingLayoutPatches.delete(job.identity)
        }
        nextController.dispose()
        return
      }

      let document = loadedDocument
      let schedule = false
      const hadUnboundUtilityChange = utilityChangedWithoutSession
      for (const entry of journalSnapshot) {
        document = mergeLayoutPatch(document, entry.patch)
        schedule = true
      }
      if (hadUnboundUtilityChange) {
        const selectedRightPane = utilityState().find(
          (item) => item.side === 'right' && item.visible
        )
        const utility = layoutUtilityTuple(
          document.utility.map((item) =>
            item.side === 'right'
              ? { ...item, visible: item.pane === selectedRightPane?.pane }
              : item
          )
        )
        document = { ...document, utility }
        schedule = true
      }
      if (hasLayoutPatch(pendingPatch)) {
        document = mergeLayoutPatch(document, pendingPatch)
        schedule = true
      }

      // Establish every resource and stage the complete document before any
      // observable signal can synchronously switch views or dispose the owner.
      job.controller = nextController
      controller = nextController
      job.loadedState = loaded.state
      if (visibilityTarget) {
        const target = visibilityTarget
        const visibilityChanged = () => nextController.visibilityChanged(target.hidden)
        let attached = false
        job.removeVisibilityListener = () => {
          if (!attached) return
          attached = false
          target.removeEventListener('visibilitychange', visibilityChanged)
        }
        try {
          target.addEventListener('visibilitychange', visibilityChanged)
          attached = true
        } catch {
          const ownsLoadState = !disposed && activeLayoutLoadJob === job
          if (ownsLoadState) setLayoutLoadState('unavailable')
          closeLayoutLoadJob(job)
          return
        }
      }
      if (
        !job.active ||
        disposed ||
        activeLayoutLoadJob !== job ||
        controller !== nextController ||
        controllerIdentity !== job.identity
      ) {
        job.removeVisibilityListener?.()
        closeLayoutLoadJob(job)
        return
      }
      batch(() => {
        if (
          !job.active ||
          disposed ||
          activeLayoutLoadJob !== job ||
          controller !== nextController ||
          controllerIdentity !== job.identity
        )
          return
        if (hadUnboundUtilityChange) utilityChangedWithoutSession = false
        commit(document, schedule)
        setLayoutLoadState(loaded.state)
        setLayoutLoadRevision((revision) => revision + 1)
      })
      if (
        !job.active ||
        disposed ||
        activeLayoutLoadJob !== job ||
        controller !== nextController ||
        controllerIdentity !== job.identity
      )
        return
      if (hasLayoutPatch(pendingPatch)) pendingLayoutPatches.delete(job.identity)
    }
    void initialize()
  }

  const rememberUnboundUtilityChange = () => {
    if (!boundPreferences()) utilityChangedWithoutSession = true
  }

  createEffect(() => {
    const activeView = view()
    const candidate = binding()
    const scope = runtime.preferenceScope?.()
    const retryRevision = layoutLoadRetryRevision()
    const valid =
      !disposed &&
      (activeView === 'dev' || activeView === 'chat') &&
      accepts(candidate) &&
      Boolean(scope && sameDevUtilityScope(candidate.scope, scope))
    const nextIdentity = valid ? preferenceIdentity(candidate!, scope!) : undefined
    if (nextIdentity === controllerIdentity && retryRevision === controllerAttemptRevision) return
    if (activeLayoutLoadJob) closeLayoutLoadJob(activeLayoutLoadJob)
    controller?.dispose()
    controller = undefined
    controllerIdentity = nextIdentity
    controllerAttemptRevision = retryRevision
    setPreferences(undefined)
    setLayoutLoadState(undefined)
    if (!nextIdentity) return
    if (!utilityChangedWithoutSession) setUtilityState(defaultUtilityPreferences())
    if (!storage || !candidate || !scope) return
    setLayoutLoadState('loading')
    const job: LayoutLoadJob = {
      identity: nextIdentity,
      scope,
      projectId: candidate.projectId,
      runtimeSessionId: candidate.runtimeSessionId,
      active: true,
    }
    activeLayoutLoadJob = job
    onCleanup(() => closeLayoutLoadJob(job))
    startLayoutStorageLoad(job, retryRevision)
  })

  return {
    context,
    setView(nextView) {
      if (disposed || view() === nextView) return
      batch(() => {
        setContextEpoch((epoch) => epoch + 1)
        setViewState(nextView)
        publishBinding(undefined)
      })
      if (nextView !== 'dev' && fixtureArchiveActive) {
        fixtureArchiveActive = false
        archiveScopeIdentityValue = undefined
        archiveRequestRevision += 1
        setArchiveState(beginArchiveShelfLoad())
      }
      setArchiveHandoff(undefined)
    },
    selectDevSession(candidate) {
      if (view() !== 'dev' || !accepts(candidate)) {
        if (view() === 'dev') publishBinding(undefined)
        return false
      }
      publishBinding(candidate)
      return true
    },
    handoffCanonicalChatConversation(candidate) {
      if (view() !== 'chat' || !accepts(candidate)) {
        if (view() === 'chat') publishBinding(undefined)
        return false
      }
      publishBinding(candidate)
      return true
    },
    preferences,
    layoutLoadRevision,
    layoutLoadState,
    retryLayoutStorage() {
      if (disposed || layoutLoadState() !== 'unavailable') return false
      const job = activeLayoutLoadJob
      if (controller && job?.controller === controller) {
        const committed = controller.flush()
        if (committed && activeLayoutLoadJob === job && job.loadedState)
          setLayoutLoadState(job.loadedState)
        return committed
      }
      setLayoutLoadRetryRevision((revision) => revision + 1)
      return true
    },
    utilityPreferences: utilityState,
    updateUtilityPreferences(update, expected) {
      if (!matchesExpected(expected)) return
      const next = layoutUtilityTuple(
        typeof update === 'function' ? update(utilityState()) : update
      )
      rememberUnboundUtilityChange()
      setUtilityState(next)
      const current = documentForCurrentBinding()
      if (current)
        commit(
          { ...current, utility: layoutUtilityTuple(next) },
          true,
          'utility',
          buildUtilityIntent(next, () => true, [
            'visible',
            'size',
            'lastNonzeroSize',
            'fullWidth',
            'order',
            'side',
          ])
        )
    },
    rightUtilityOpen() {
      return utilityState().some((item) => item.side === 'right' && item.visible)
    },
    showUtilityPane(pane, expected) {
      if (!matchesExpected(expected)) return
      rememberUnboundUtilityChange()
      const side = utilityPaneById.get(pane)?.side
      if (!side) return
      const next = utilityState().map((item) => ({
        ...item,
        visible: item.side === side ? item.pane === pane : item.visible,
      }))
      if (side === 'right') setLastRightPane(pane)
      setUtilityState(next)
      const current = documentForCurrentBinding()
      if (current)
        commit(
          { ...current, utility: layoutUtilityTuple(next) },
          true,
          'utility',
          buildUtilityIntent(next, (item) => item.side === side, ['visible'])
        )
    },
    toggleRightUtility(expected) {
      if (!matchesExpected(expected)) return
      rememberUnboundUtilityChange()
      const current = utilityState().find((item) => item.side === 'right' && item.visible)
      if (current) {
        const next = utilityState().map((item) =>
          item.side === 'right' ? { ...item, visible: false } : item
        )
        setUtilityState(next)
        const document = documentForCurrentBinding()
        if (document)
          commit(
            { ...document, utility: layoutUtilityTuple(next) },
            true,
            'utility',
            buildUtilityIntent(next, (item) => item.side === 'right', ['visible'])
          )
        return
      }
      const selected = lastRightPane()
      const next = utilityState().map((item) => ({
        ...item,
        visible: item.side === 'right' ? item.pane === selected : item.visible,
      }))
      setUtilityState(next)
      const document = documentForCurrentBinding()
      if (document)
        commit(
          { ...document, utility: layoutUtilityTuple(next) },
          true,
          'utility',
          buildUtilityIntent(next, (item) => item.side === 'right', ['visible'])
        )
    },
    collapseRightUtility(expected) {
      if (!matchesExpected(expected)) return
      rememberUnboundUtilityChange()
      const next = utilityState().map((item) =>
        item.side === 'right' ? { ...item, visible: false } : item
      )
      setUtilityState(next)
      const current = documentForCurrentBinding()
      if (current)
        commit(
          { ...current, utility: layoutUtilityTuple(next) },
          true,
          'utility',
          buildUtilityIntent(next, (item) => item.side === 'right', ['visible'])
        )
    },
    setUtilityPaneFullWidth(pane, fullWidth, expected) {
      if (!matchesExpected(expected)) return
      rememberUnboundUtilityChange()
      const next = utilityState().map((item) => {
        if (item.pane === pane) return { ...item, fullWidth }
        return fullWidth && item.fullWidth ? { ...item, fullWidth: false } : item
      })
      setUtilityState(next)
      const current = documentForCurrentBinding()
      if (current)
        commit(
          { ...current, utility: layoutUtilityTuple(next) },
          true,
          'utility',
          buildUtilityIntent(next, (item) => fullWidth || item.pane === pane, ['fullWidth'])
        )
    },
    setUtilityPaneSize(pane, size, expected) {
      if (!matchesExpected(expected)) return
      rememberUnboundUtilityChange()
      const side = utilityPaneById.get(pane)?.side
      if (!side) return
      const snapped = snapUtilitySize(size, side)
      const next = utilityState().map((item) =>
        item.side === side ? { ...item, size: snapped, lastNonzeroSize: snapped } : item
      )
      setUtilityState(next)
      const current = documentForCurrentBinding()
      if (current)
        commit(
          { ...current, utility: layoutUtilityTuple(next) },
          true,
          'utility',
          buildUtilityIntent(next, (item) => item.side === side, ['size', 'lastNonzeroSize'])
        )
    },
    updateLayoutPreferences(update, expected) {
      if (!matchesExpected(expected)) return
      const current = documentForCurrentBinding()
      if (!current) return
      commit(
        {
          ...current,
          center: update.center,
          focusMode: update.focusMode,
          focusTargetId: update.focusTargetId,
        },
        true,
        'layout'
      )
    },
    archiveShelf: visibleArchiveState,
    archiveHandoffMessage() {
      const currentScopeIdentity = archiveScopeIdentity(runtime.preferenceScope?.())
      return archiveScopeIdentityValue === currentScopeIdentity ? archiveHandoff() : undefined
    },
    refreshArchiveShelf,
    restoreArchivedSession,
    requestArchiveDelete,
    cancelArchiveDelete,
    confirmArchiveDelete,
    setArchiveShelfFixture(items) {
      if (disposed || view() !== 'dev') return
      fixtureArchiveActive = true
      archiveScopeIdentityValue = archiveScopeIdentity(runtime.preferenceScope?.())
      archiveRequestRevision += 1
      setArchiveHandoff(undefined)
      setArchiveState(archiveShelfReady(items))
    },
    archiveRestoreRevision,
    dispose() {
      if (disposed) return
      disposed = true
      archiveRequestRevision += 1
      archiveFences.dispose()
      if (activeLayoutLoadJob) closeLayoutLoadJob(activeLayoutLoadJob)
      controller?.dispose()
      controller = undefined
      controllerIdentity = undefined
      batch(() => {
        setViewState('workspace')
        publishBinding(undefined)
        setPreferences(undefined)
        setLayoutLoadState(undefined)
      })
    },
  }
}
