import type {
  DevLayoutPreferencesV2,
  DevUtilityPane,
  DevUtilityPreference,
  PaneNode,
  Scope,
} from '@adea-ai/types/dev-runtime'
import { batch, createComputed, createEffect, createSignal, onCleanup, untrack } from 'solid-js'

import type { DevRuntimeService } from './platform'
import { createLayoutStorageController, type LayoutStorage } from './layout/storage'
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

export type LayoutLoadState = 'empty' | 'ready' | 'corrupt' | 'unsupported'

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

/**
 * One shell-owned session identity for utilities shared across workspace views.
 * It does not infer a runtime session from a room/channel or a presentation
 * hint; Dev and Chat must publish their own authoritative binding.
 */
export function createSharedDevUtilityOwner(
  runtime: DevRuntimeService,
  storage?: LayoutStorage
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
  const [utilityState, setUtilityState] = createSignal<readonly DevUtilityPreference[]>(
    defaultUtilityPreferences()
  )
  const [lastRightPane, setLastRightPane] = createSignal<DevUtilityPane>('browser')
  const [archiveState, setArchiveState] = createSignal<ArchiveShelfState>(beginArchiveShelfLoad())
  const [archiveHandoff, setArchiveHandoff] = createSignal<string>()
  const [archiveRestoreRevision, setArchiveRestoreRevision] = createSignal(0)
  let disposed = false
  let controller: ReturnType<typeof createLayoutStorageController> | undefined
  let controllerIdentity: string | undefined
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

  const context = createDevUtilityContext(() => {
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
  }, () => contextEpoch() + scopeTransitionRevision)
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
    if (
      disposed ||
      view() !== requestedView ||
      contextEpoch() !== requestedContextEpoch
    )
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
      if (
        isDevUtilityContextChanged(error) ||
        !fence.isCurrent() ||
        !isOwnerCurrent()
      )
        return false
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
      const { restoreArchivedSession: restoreArchiveOperation } = await import(
        './utility-archive-operations'
      )
      if (!isOwnerCurrent() || !fence.isCurrent()) return false
      await restoreArchiveOperation({ fence, isOwnerCurrent }, archived)
      if (!isOwnerCurrent() || !fence.isCurrent()) return false
      setArchiveState((current) => restoreCompleted(current, runtimeSessionId))
      setArchiveHandoff(undefined)
      setArchiveRestoreRevision((revision) => revision + 1)
      void refreshArchiveShelf()
      return true
    } catch (error) {
      if (isDevUtilityContextChanged(error) || !isOwnerCurrent() || !fence.isCurrent())
        return false
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

  const commit = (next: DevLayoutPreferencesV2, schedule: boolean) => {
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
  }

  const rememberUnboundUtilityChange = () => {
    if (!boundPreferences()) utilityChangedWithoutSession = true
  }

  createEffect(() => {
    const activeView = view()
    const candidate = binding()
    const scope = runtime.preferenceScope?.()
    const valid =
      !disposed &&
      (activeView === 'dev' || activeView === 'chat') &&
      accepts(candidate) &&
      Boolean(scope && sameDevUtilityScope(candidate.scope, scope))
    const nextIdentity = valid ? preferenceIdentity(candidate!, scope!) : undefined
    if (nextIdentity === controllerIdentity) return
    controller?.dispose()
    controller = undefined
    controllerIdentity = nextIdentity
    setPreferences(undefined)
    setLayoutLoadState(undefined)
    if (!nextIdentity) return
    if (!utilityChangedWithoutSession) setUtilityState(defaultUtilityPreferences())
    if (!storage || !candidate || !scope) return
    const nextController = createLayoutStorageController({
      storage,
      scope,
      projectId: candidate.projectId,
      runtimeSessionId: candidate.runtimeSessionId,
    })
    controller = nextController
    const loaded = nextController.load()
    setLayoutLoadState(loaded.state)
    const loadedDocument =
      loaded.state === 'ready'
        ? loaded.value
        : makeDefaultDocument(scope, candidate.projectId, candidate.runtimeSessionId)
    if (utilityChangedWithoutSession) {
      const selectedRightPane = utilityState().find((item) => item.side === 'right' && item.visible)
      const utility = layoutUtilityTuple(
        loadedDocument.utility.map((item) =>
          item.side === 'right' ? { ...item, visible: item.pane === selectedRightPane?.pane } : item
        )
      )
      commit({ ...loadedDocument, utility }, true)
      utilityChangedWithoutSession = false
    } else {
      commit(loadedDocument, false)
    }
    setLayoutLoadRevision((revision) => revision + 1)
    if (typeof globalThis.document !== 'undefined') {
      const visibilityChanged = () => nextController.visibilityChanged(globalThis.document.hidden)
      globalThis.document.addEventListener('visibilitychange', visibilityChanged)
      onCleanup(() =>
        globalThis.document.removeEventListener('visibilitychange', visibilityChanged)
      )
    }
    onCleanup(() => {
      nextController.dispose()
      if (controller === nextController) controller = undefined
    })
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
    utilityPreferences: utilityState,
    updateUtilityPreferences(update, expected) {
      if (!matchesExpected(expected)) return
      const next = layoutUtilityTuple(
        typeof update === 'function' ? update(utilityState()) : update
      )
      rememberUnboundUtilityChange()
      setUtilityState(next)
      const current = documentForCurrentBinding()
      if (current) commit({ ...current, utility: layoutUtilityTuple(next) }, true)
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
      if (current) commit({ ...current, utility: layoutUtilityTuple(next) }, true)
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
        if (document) commit({ ...document, utility: layoutUtilityTuple(next) }, true)
        return
      }
      const selected = lastRightPane()
      const next = utilityState().map((item) => ({
        ...item,
        visible: item.side === 'right' ? item.pane === selected : item.visible,
      }))
      setUtilityState(next)
      const document = documentForCurrentBinding()
      if (document) commit({ ...document, utility: layoutUtilityTuple(next) }, true)
    },
    collapseRightUtility(expected) {
      if (!matchesExpected(expected)) return
      rememberUnboundUtilityChange()
      const next = utilityState().map((item) =>
        item.side === 'right' ? { ...item, visible: false } : item
      )
      setUtilityState(next)
      const current = documentForCurrentBinding()
      if (current) commit({ ...current, utility: layoutUtilityTuple(next) }, true)
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
      if (current) commit({ ...current, utility: layoutUtilityTuple(next) }, true)
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
      if (current) commit({ ...current, utility: layoutUtilityTuple(next) }, true)
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
        true
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
      setViewState('workspace')
      publishBinding(undefined)
      controller?.dispose()
      controller = undefined
      controllerIdentity = undefined
    },
  }
}
