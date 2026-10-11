import type {
  DevLayoutPreferencesV2,
  DevUtilityPane,
  DevUtilityPreference,
  PaneNode,
} from '@adea-ai/types/dev-runtime'
import { createEffect, createSignal, onCleanup } from 'solid-js'

import type { DevRuntimeService } from './platform'
import { createLayoutStorageController, type LayoutStorage } from './layout/storage'
import {
  createDevUtilityContext,
  sameDevUtilityScope,
  type CanonicalRuntimeBinding,
  type DevUtilityContext,
  type DevUtilityView,
} from './utility-context'
import { defaultUtilityPreferences, snapUtilitySize, utilityItemByPane } from './utility-model'

export type { CanonicalRuntimeBinding } from './utility-context'

export type SharedDevUtilityOwner = Readonly<{
  context(): DevUtilityContext
  setView(view: DevUtilityView): void
  /** Publish only the selection resolved by CurrentDevWorkspaceEntry. */
  selectDevSession(binding: CanonicalRuntimeBinding | undefined): boolean
  /** Publish only after DesktopFirstRunChat has attached and validated it. */
  handoffCanonicalChatConversation(binding: CanonicalRuntimeBinding | undefined): boolean
  preferences(): DevLayoutPreferencesV2 | undefined
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
  dispose(): void
}>

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
  const [utilityState, setUtilityState] = createSignal<readonly DevUtilityPreference[]>(
    defaultUtilityPreferences()
  )
  const [lastRightPane, setLastRightPane] = createSignal<DevUtilityPane>('browser')
  let disposed = false
  let controller: ReturnType<typeof createLayoutStorageController> | undefined
  let controllerIdentity: string | undefined
  let utilityChangedWithoutSession = false

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
    const document =
      loaded.state === 'ready'
        ? loaded.value
        : makeDefaultDocument(scope, candidate.projectId, candidate.runtimeSessionId)
    if (utilityChangedWithoutSession) {
      const selectedRightPane = utilityState().find((item) => item.side === 'right' && item.visible)
      const utility = document.utility.map((item) =>
        item.side === 'right'
          ? { ...item, visible: item.pane === selectedRightPane?.pane }
          : item
      ) as DevLayoutPreferencesV2['utility']
      commit({ ...document, utility }, true)
      utilityChangedWithoutSession = false
    } else {
      commit(document, false)
    }
    if (typeof document !== 'undefined') {
      const visibilityChanged = () => nextController.visibilityChanged(document.hidden)
      document.addEventListener('visibilitychange', visibilityChanged)
      onCleanup(() => document.removeEventListener('visibilitychange', visibilityChanged))
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
        visible: item.side === side && item.pane === pane,
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
        visible: item.side === 'right' && item.pane === selected,
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
      const snapped = snapUtilitySize(size)
      const side = utilityItemByPane.get(pane)?.side
      if (!side) return
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
    dispose() {
      if (disposed) return
      disposed = true
      setViewState('workspace')
      setBinding(undefined)
      controller?.dispose()
      controller = undefined
      controllerIdentity = undefined
    },
  }
}
