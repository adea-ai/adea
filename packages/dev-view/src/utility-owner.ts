import type {
  ArchiveRecord,
  DevLayoutPreferencesV2,
  DevUtilityPane,
  DevUtilityPreference,
  PaneNode,
  RuntimeSession,
  Scope,
} from '@adea-ai/types/dev-runtime'
import {
  devOperationMetadataFor_dev_session_get,
  devOperationMetadataFor_dev_session_list,
  devOperationMetadataFor_dev_session_unarchive,
} from '@adea-ai/types/dev-runtime-operation-metadata'
import { createEffect, createSignal, onCleanup } from 'solid-js'

import type { DevRuntimeService } from './platform'
import { createLayoutStorageController, type LayoutStorage } from './layout/storage'
import {
  createDevUtilityContext,
  createDevUtilityFenceSource,
  DevUtilityContextChangedError,
  isDevUtilityContextChanged,
  sameDevUtilityScope,
  type CanonicalRuntimeBinding,
  type DevUtilityContext,
  type DevUtilityFence,
  type DevUtilityView,
} from './utility-context'
import {
  buildDevCommandFromMetadata,
  type BoundDevOperationMetadata,
} from './browser/command-core'
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
import { defaultUtilityPreferences, snapUtilitySize, utilityItemByPane } from './utility-model'

export type { CanonicalRuntimeBinding } from './utility-context'

export type LayoutLoadState = 'empty' | 'ready' | 'corrupt' | 'unsupported'

const ARCHIVE_SHELF_PAGE_SIZE = 500
const ARCHIVE_SHELF_PAGE_LIMIT = 20

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
  updateLayoutPreferences(update: {
    center: PaneNode
    focusMode: boolean
    focusTargetId?: string
  }, expected?: CanonicalRuntimeBinding | null): void
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

function runtimeSessionFromArchiveRow(
  value: unknown,
  expectedScope: Scope
): ArchivedSessionSummary | undefined {
  if (!isRecord(value) || value.archived !== true) return undefined
  if (
    typeof value.id !== 'string' ||
    !value.id ||
    typeof value.projectId !== 'string' ||
    !value.projectId ||
    typeof value.generation !== 'number' ||
    !Number.isSafeInteger(value.generation) ||
    Number(value.generation) < 1 ||
    !isRecord(value.scope)
  )
    return undefined
  const rowScope = value.scope as unknown as Scope
  if (!sameDevUtilityScope(rowScope, expectedScope)) return undefined
  return {
    id: value.id,
    projectId: value.projectId,
    title: typeof value.displayName === 'string' && value.displayName ? value.displayName : value.id,
    archivedAt: typeof value.archivedAt === 'string' ? value.archivedAt : 'legacy',
    generation: Number(value.generation),
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (isRecord(error) && isRecord(error.error) && typeof error.error.message === 'string')
    return error.error.message
  return 'provider error'
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

  const context = createDevUtilityContext(() => {
    const scope = runtime.preferenceScope?.()
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
  })
  const archiveFences = createDevUtilityFenceSource(context)

  const visibleArchiveState = (): ArchiveShelfState => {
    const currentScopeIdentity = archiveScopeIdentity(runtime.preferenceScope?.())
    if (fixtureArchiveActive)
      return archiveScopeIdentityValue === currentScopeIdentity
        ? archiveState()
        : beginArchiveShelfLoad()
    if (!currentScopeIdentity)
      return archiveShelfUnavailable('channel_unauthenticated')
    return archiveScopeIdentityValue === currentScopeIdentity
      ? archiveState()
      : beginArchiveShelfLoad()
  }

  const executeArchiveOperation = async <T>(
    fence: DevUtilityFence,
    metadata: BoundDevOperationMetadata,
    body: Record<string, unknown>,
    resource?: { kind: string; id: string; generation: number }
  ): Promise<T> => {
    if (!fence.context.scope || !fence.isCurrent()) throw new DevUtilityContextChangedError()
    const reply = await fence.context.runtime.execute(
      buildDevCommandFromMetadata(metadata, {
        scope: fence.context.scope,
        body,
        ...(resource ? { resource } : {}),
      })
    )
    if (!fence.isCurrent()) throw new DevUtilityContextChangedError()
    if (!reply.ok) throw reply
    return reply.value as T
  }

  const refreshArchiveShelf = async (): Promise<boolean> => {
    const requestedView = view()
    if (disposed || !['dev', 'chat', 'virtual'].includes(requestedView)) return false
    if (fixtureArchiveActive && requestedView === 'dev') return true
    try {
      await runtime.ready?.catch(() => undefined)
    } catch {
      // The unavailable state below is the user's recovery affordance.
    }
    if (disposed || view() !== requestedView) return false
    const fence = archiveFences.capture('scope')
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
    try {
      const items: ArchivedSessionSummary[] = []
      const seenCursors = new Set<string>()
      let cursor: string | undefined
      let pageCount = 0
      while (true) {
        const page = await executeArchiveOperation<unknown>(
          fence,
          devOperationMetadataFor_dev_session_list,
          {
            archived: true,
            limit: ARCHIVE_SHELF_PAGE_SIZE,
            ...(cursor === undefined ? {} : { cursor }),
          }
        )
        if (!fence.isCurrent() || requestRevision !== archiveRequestRevision) return false
        pageCount += 1
        if (!isRecord(page) || !Array.isArray(page.items))
          throw new Error('The runtime returned an invalid archived-session page.')
        for (const item of page.items) {
          const parsed = runtimeSessionFromArchiveRow(item, fence.context.scope!)
          if (!parsed)
            throw new Error(
              'The runtime returned an archived session with invalid or mismatched scope.'
            )
          items.push(parsed)
        }
        const nextCursor = page.nextCursor
        if (nextCursor === undefined) break
        if (typeof nextCursor !== 'string' || nextCursor.length === 0)
          throw new Error('The runtime returned an invalid archived-session cursor.')
        if (seenCursors.has(nextCursor))
          throw new Error('The runtime returned a repeated archived-session cursor.')
        seenCursors.add(nextCursor)
        if (pageCount >= ARCHIVE_SHELF_PAGE_LIMIT)
          throw new Error(
            `The archived-session list reached the ${ARCHIVE_SHELF_PAGE_LIMIT}-page limit and may be incomplete.`
          )
        cursor = nextCursor
      }
      setArchiveState(archiveShelfReady(items))
      return true
    } catch (error) {
      if (
        isDevUtilityContextChanged(error) ||
        !fence.isCurrent() ||
        requestRevision !== archiveRequestRevision
      )
        return false
      setArchiveState(archiveShelfError(errorMessage(error), archiveState()))
      return false
    }
  }

  const restoreArchivedSession = async (runtimeSessionId: string): Promise<boolean> => {
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
    const generation = archived.generation!
    try {
      const session = await executeArchiveOperation<RuntimeSession>(
        fence,
        devOperationMetadataFor_dev_session_get,
        { runtimeSessionId },
        { kind: 'runtime_session', id: runtimeSessionId, generation }
      )
      if (
        !isRecord(session) ||
        session.id !== runtimeSessionId ||
        session.projectId !== archived.projectId ||
        session.archived !== true ||
        session.generation !== generation ||
        !isRecord(session.scope) ||
        !sameDevUtilityScope(session.scope as unknown as Scope, fence.context.scope)
      )
        throw new Error('The archived session changed. Refresh Archived sessions and try again.')
      const restored = await executeArchiveOperation<ArchiveRecord>(
        fence,
        devOperationMetadataFor_dev_session_unarchive,
        { runtimeSessionId, expectedGeneration: generation },
        { kind: 'runtime_session', id: runtimeSessionId, generation }
      )
      if (
        !isRecord(restored) ||
        restored.runtimeSessionId !== runtimeSessionId ||
        restored.worktreeId !== session.worktreeId ||
        restored.generation !== generation ||
        restored.state !== 'restored' ||
        !isRecord(restored.scope) ||
        !sameDevUtilityScope(restored.scope as unknown as Scope, fence.context.scope)
      )
        throw new Error('The runtime did not confirm that the archived session was restored.')
      if (!fence.isCurrent()) return false
      setArchiveState((current) => restoreCompleted(current, runtimeSessionId))
      setArchiveHandoff(undefined)
      setArchiveRestoreRevision((revision) => revision + 1)
      void refreshArchiveShelf()
      return true
    } catch (error) {
      if (isDevUtilityContextChanged(error) || !fence.isCurrent()) return false
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

  const accepts = (candidate: CanonicalRuntimeBinding | undefined): candidate is CanonicalRuntimeBinding =>
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
      utility: defaultUtilityPreferences() as unknown as DevLayoutPreferencesV2['utility'],
      focusMode: false,
      focusTargetId: 'dev-terminal',
    }
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
      const utility = loadedDocument.utility.map((item) =>
        item.side === 'right'
          ? { ...item, visible: item.pane === selectedRightPane?.pane }
          : item
      ) as DevLayoutPreferencesV2['utility']
      commit({ ...loadedDocument, utility }, true)
      utilityChangedWithoutSession = false
    } else {
      commit(loadedDocument, false)
    }
    setLayoutLoadRevision((revision) => revision + 1)
    if (typeof globalThis.document !== 'undefined') {
      const visibilityChanged = () => nextController.visibilityChanged(globalThis.document.hidden)
      globalThis.document.addEventListener('visibilitychange', visibilityChanged)
      onCleanup(() => globalThis.document.removeEventListener('visibilitychange', visibilityChanged))
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
      setViewState(nextView)
      setBinding(undefined)
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
        if (view() === 'dev') setBinding(undefined)
        return false
      }
      setBinding(candidate)
      return true
    },
    handoffCanonicalChatConversation(candidate) {
      if (view() !== 'chat' || !accepts(candidate)) {
        if (view() === 'chat') setBinding(undefined)
        return false
      }
      setBinding(candidate)
      return true
    },
    preferences,
    layoutLoadRevision,
    layoutLoadState,
    utilityPreferences: utilityState,
    updateUtilityPreferences(update, expected) {
      if (!matchesExpected(expected)) return
      rememberUnboundUtilityChange()
      const next = typeof update === 'function' ? update(utilityState()) : update
      if (next.length !== 6) throw new TypeError('corrupt_state: utility preferences require six panes')
      setUtilityState(next)
      const current = documentForCurrentBinding()
      if (current) commit({ ...current, utility: next as DevLayoutPreferencesV2['utility'] }, true)
    },
    rightUtilityOpen() {
      return utilityState().some((item) => item.side === 'right' && item.visible)
    },
    showUtilityPane(pane, expected) {
      if (!matchesExpected(expected)) return
      rememberUnboundUtilityChange()
      const side = utilityItemByPane.get(pane)?.side
      if (!side) return
      const next = utilityState().map((item) => ({
        ...item,
        visible: item.side === side ? item.pane === pane : item.visible,
      }))
      if (side === 'right') setLastRightPane(pane)
      setUtilityState(next)
      const current = documentForCurrentBinding()
      if (current) commit({ ...current, utility: next as DevLayoutPreferencesV2['utility'] }, true)
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
        if (document) commit({ ...document, utility: next as DevLayoutPreferencesV2['utility'] }, true)
        return
      }
      const selected = lastRightPane()
      const next = utilityState().map((item) => ({
        ...item,
        visible: item.side === 'right' ? item.pane === selected : item.visible,
      }))
      setUtilityState(next)
      const document = documentForCurrentBinding()
      if (document) commit({ ...document, utility: next as DevLayoutPreferencesV2['utility'] }, true)
    },
    collapseRightUtility(expected) {
      if (!matchesExpected(expected)) return
      rememberUnboundUtilityChange()
      const next = utilityState().map((item) =>
        item.side === 'right' ? { ...item, visible: false } : item
      )
      setUtilityState(next)
      const current = documentForCurrentBinding()
      if (current) commit({ ...current, utility: next as DevLayoutPreferencesV2['utility'] }, true)
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
      if (current) commit({ ...current, utility: next as DevLayoutPreferencesV2['utility'] }, true)
    },
    setUtilityPaneSize(pane, size, expected) {
      if (!matchesExpected(expected)) return
      rememberUnboundUtilityChange()
      const side = utilityItemByPane.get(pane)?.side
      if (!side) return
      const snapped = snapUtilitySize(size, side)
      const next = utilityState().map((item) =>
        item.side === side ? { ...item, size: snapped, lastNonzeroSize: snapped } : item
      )
      setUtilityState(next)
      const current = documentForCurrentBinding()
      if (current) commit({ ...current, utility: next as DevLayoutPreferencesV2['utility'] }, true)
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
      setBinding(undefined)
      controller?.dispose()
      controller = undefined
      controllerIdentity = undefined
    },
  }
}
