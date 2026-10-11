import { workspaceStore, useWorkspaceState } from '@adea-ai/state'
import type {
  CapabilitySnapshot,
  DevCapability,
  DevLayoutPreferencesV2,
  DevUtilityPane,
  DevUtilityPreference,
  PaneLeaf,
  Scope,
} from '@adea-ai/types/dev-runtime'
import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  lazy,
  onCleanup,
  onMount,
  Show,
  useContext,
  type Accessor,
  type JSX,
} from 'solid-js'
import { Portal } from 'solid-js/web'
import { PanelRightClose, PanelRightOpen } from 'lucide-solid'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'

import type { LayoutStorage } from '../layout/storage'
import { createLayoutStorageController } from '../layout/storage'
import {
  createLayoutState,
  normalizeLayout,
  type DevLayoutState,
} from '../layout/operations'
import type { DevSelection, DevSelectionReason } from '../selection'
import { resolveDevSelection } from '../selection'
import {
  createUnavailableDevRuntimeService,
  type DevRuntimeService,
  type DevWorkspaceProjection,
} from '../platform'
const DevRightUtilitySidebar = lazy(() =>
  import('./right-sidebar').then((module) => ({ default: module.DevRightUtilitySidebar }))
)
import type { DevGroupFixture } from './types'
import {
  defaultUtilityPreferences,
  initialDevLayout,
  paneCapability,
  snapUtilitySize,
  utilityItemByPane,
  utilityItems,
} from './definitions'
export type { DevGroupFixture, DevProjectFixture } from './types'

const PROJECTION_FRESHNESS_MS = 60_000

const recoveryCopy: Record<DevSelectionReason, string> = {
  project_missing: 'That project link is no longer available. The first live project is selected.',
  session_missing: 'That session link is no longer available. A live session is selected.',
  session_archived:
    'That session is archived. A live session is selected — restore it from Archived sessions.',
  session_revoked: 'That session is no longer active. A live session is selected.',
  stale_generation:
    'That link points to an older session generation. The current session is selected.',
  cross_scope:
    'That link belongs to a different account, workspace, or runtime node. The active scope is selected.',
  project_empty: 'This project has no live sessions. Restore one from Archived sessions.',
}

const sameScope = (left: Scope | undefined, right: Scope | undefined): boolean =>
  Boolean(
    left &&
    right &&
    left.accountId === right.accountId &&
    left.workspaceId === right.workspaceId &&
    left.runtimeNodeId === right.runtimeNodeId
  )

const scopeKey = (value: Scope | undefined) =>
  value ? JSON.stringify([value.accountId, value.workspaceId, value.runtimeNodeId]) : undefined

function toDevGroups(projection: DevWorkspaceProjection): readonly DevGroupFixture[] {
  return projection.groups.map((group) => ({
    id: group.id,
    name: group.name,
    projects: group.projects.map((project) => ({
      id: project.id,
      name: project.name,
      repository: project.repository,
      branch: project.branch,
      sessions: project.sessions,
    })),
  }))
}

export type DevUtilityOwnerModel = Readonly<{
  runtime: Accessor<DevRuntimeService>
  activeScope: Accessor<Scope | undefined>
  projection: Accessor<DevWorkspaceProjection | undefined>
  projectionStatus: Accessor<'loading' | 'ready' | 'unavailable'>
  groups: Accessor<readonly DevGroupFixture[]>
  fixtureMode: Accessor<boolean>
  selection: Accessor<DevSelection>
  selectedProject: Accessor<string>
  selectedSession: Accessor<string>
  selectedSessionRecord: Accessor<DevWorkspaceProjection['groups'][number]['projects'][number]['sessions'][number] | undefined>
  selectedSessionWorktreeId: Accessor<string | undefined>
  selectedProjectLabel: Accessor<string | undefined>
  capabilitySnapshotStatus: Accessor<'loading' | 'ready' | 'unavailable'>
  capabilities: Accessor<ReadonlyMap<DevCapability, { granted: boolean; reason?: string }>>
  capabilityOf(pane: DevUtilityPane): { granted: boolean; reason?: string } | undefined
  layout: Accessor<DevLayoutState>
  setLayout: (value: DevLayoutState | ((current: DevLayoutState) => DevLayoutState)) => void
  utilityPreferences: Accessor<readonly DevUtilityPreference[]>
  setUtilityPreferences: (
    value:
      | readonly DevUtilityPreference[]
      | ((current: readonly DevUtilityPreference[]) => readonly DevUtilityPreference[])
  ) => void
  visiblePaneOf(side: 'left' | 'right'): DevUtilityPreference | undefined
  panesOfSide(side: 'left' | 'right'): readonly DevUtilityPreference[]
  lastRightPane: Accessor<DevUtilityPane>
  isRightOpen: Accessor<boolean>
  rightToggleAvailable: Accessor<boolean>
  showPane(pane: DevUtilityPane): void
  collapseSide(side: 'left' | 'right'): void
  toggleUtilityGroup(panes: readonly DevUtilityPane[]): void
  openRightUtilitySlot(): void
  toggleRightUtilitySlot(): void
  setPaneFullWidth(pane: DevUtilityPane, fullWidth: boolean): void
  setPaneSize(pane: DevUtilityPane, size: number): void
  updateLayout(update: (state: DevLayoutState) => DevLayoutState): DevLayoutState
  schedulePreferences(state?: DevLayoutState): void
  preferencesReady: Accessor<boolean>
  focusMode: Accessor<boolean>
  setFocusMode(enabled: boolean): void
  announcement: Accessor<string>
  announce(message: string): void
  recoveryNotice: Accessor<string>
  setRecoveryNotice(message: string): void
  replaceGroups(
    groups:
      | readonly DevGroupFixture[]
      | ((current: readonly DevGroupFixture[]) => readonly DevGroupFixture[])
  ): void
  reloadProjection(): Promise<void>
}>

export function createDevUtilityOwnerModel(options: {
  runtime: Accessor<DevRuntimeService>
  groups?: Accessor<readonly DevGroupFixture[] | undefined>
  workspaceId?: Accessor<string | undefined>
  activeDevView?: Accessor<boolean>
  storage: Accessor<LayoutStorage | undefined>
  selectedProjectId: Accessor<string | undefined>
  setSelectedProjectId(id: string): void
  selectedRuntimeSessionId: Accessor<string | undefined>
  setSelectedRuntimeSessionId(id: string): void
  focusMode: Accessor<boolean>
  setFocusMode(enabled: boolean): void
  now?: () => string
}) {
  const [projection, setProjection] = createSignal<DevWorkspaceProjection | undefined>()
  const [projectedGroups, setProjectedGroups] = createSignal<readonly DevGroupFixture[]>([])
  const [groupOverride, setGroupOverride] = createSignal<readonly DevGroupFixture[] | undefined>()
  const [projectionStatus, setProjectionStatus] = createSignal<'loading' | 'ready' | 'unavailable'>(
    'loading'
  )
  const [utilityPreferences, setUtilityPreferences] = createSignal<readonly DevUtilityPreference[]>(
    defaultUtilityPreferences()
  )
  const [layout, setLayout] = createSignal<DevLayoutState>(initialDevLayout())
  const [capabilities, setCapabilities] = createSignal<
    ReadonlyMap<DevCapability, { granted: boolean; reason?: string }>
  >(new Map())
  const [capabilitySnapshotStatus, setCapabilitySnapshotStatus] = createSignal<
    'loading' | 'ready' | 'unavailable'
  >('loading')
  const [preferencesReady, setPreferencesReady] = createSignal(false)
  const [announcement, setAnnouncement] = createSignal('')
  const [recoveryNotice, setRecoveryNotice] = createSignal('')
  const [lastRightPane, setLastRightPane] = createSignal<DevUtilityPane>('browser')
  const runtime = () => options.runtime()
  const fixtureGroups = () => options.groups?.()
  const fixtureMode = () => fixtureGroups() !== undefined
  const hasWorkspaceGate = options.workspaceId !== undefined
  const activeScope = createMemo(() => {
    const scope = runtime().preferenceScope?.()
    const workspaceId = options.workspaceId?.()
    if (!scope || (hasWorkspaceGate && (!workspaceId || scope.workspaceId !== workspaceId)))
      return undefined
    return scope
  })
  const groups = () => groupOverride() ?? fixtureGroups() ?? projectedGroups()
  const currentTime = options.now ?? (() => new Date().toISOString())
  let storageController: ReturnType<typeof createLayoutStorageController> | undefined
  let storageControllerKey: string | undefined
  let loadedPreferenceKey: string | undefined
  let loadedStorage: LayoutStorage | undefined
  let preferencesLoaded = false
  let removeVisibilityListener: (() => void) | undefined
  let projectionGeneration = 0
  let projectionScopeKey: string | undefined
  let projectionInputInitialized = false
  let previousFixtureGroups: readonly DevGroupFixture[] | undefined

  const disposeStorageController = () => {
    removeVisibilityListener?.()
    removeVisibilityListener = undefined
    storageController?.dispose()
    storageController = undefined
    storageControllerKey = undefined
  }

  onCleanup(disposeStorageController)

  const reloadProjection = async () => {
    const service = runtime()
    const requestScope = activeScope()
    if (fixtureMode()) return
    if (!requestScope || !service.projection) {
      setProjection(undefined)
      setProjectedGroups([])
      setProjectionStatus('unavailable')
      return
    }
    const generation = ++projectionGeneration
    setProjectionStatus('loading')
    try {
      await service.ready
      if (generation !== projectionGeneration || service !== runtime()) return
      if (!sameScope(requestScope, activeScope())) return
      const next = await service.projection(requestScope)
      if (
        generation !== projectionGeneration ||
        service !== runtime() ||
        !sameScope(requestScope, activeScope())
      )
        return
      setProjection(next)
      setProjectedGroups(toDevGroups(next))
      setGroupOverride(undefined)
      setProjectionStatus('ready')
    } catch {
      if (generation !== projectionGeneration || service !== runtime()) return
      setProjection(undefined)
      setProjectedGroups([])
      setGroupOverride(undefined)
      setProjectionStatus('unavailable')
    }
  }

  createEffect(() => {
    const service = runtime()
    const suppliedGroups = fixtureGroups()
    const requestScope = activeScope()
    const nextScopeKey = scopeKey(requestScope)
    const scopeChanged = projectionInputInitialized && nextScopeKey !== projectionScopeKey
    const fixtureChanged = projectionInputInitialized && suppliedGroups !== previousFixtureGroups
    projectionInputInitialized = true
    projectionScopeKey = nextScopeKey
    previousFixtureGroups = suppliedGroups

    const generation = ++projectionGeneration
    let current = true
    onCleanup(() => {
      current = false
    })
    if (scopeChanged || fixtureChanged) {
      setProjection(undefined)
      setProjectedGroups([])
      setGroupOverride(undefined)
    }
    setProjectionStatus('loading')

    if (suppliedGroups !== undefined) {
      setProjectedGroups(suppliedGroups)
      setProjectionStatus('ready')
      return
    }

    const load = async () => {
      try {
        await service.ready
        if (!current || generation !== projectionGeneration || service !== runtime()) return
        if (!requestScope || !service.projection) {
          setProjectionStatus('unavailable')
          return
        }
        const next = await service.projection(requestScope)
        if (
          !current ||
          generation !== projectionGeneration ||
          service !== runtime() ||
          !sameScope(requestScope, activeScope())
        )
          return
        setProjection(next)
        setProjectedGroups(toDevGroups(next))
        setGroupOverride(undefined)
        setProjectionStatus('ready')
      } catch {
        if (!current || generation !== projectionGeneration || service !== runtime()) return
        setProjection(undefined)
        setProjectedGroups([])
        setGroupOverride(undefined)
        setProjectionStatus('unavailable')
      }
    }
    void load()
  })

  const selection = createMemo<DevSelection>(() =>
    resolveDevSelection({
      projects: (activeScope() ? groups() : []).flatMap((group) =>
        group.projects.map((project) => ({
          id: project.id,
          sessions: project.sessions.map((session) => ({
            id: session.id,
            archived: session.state === 'archived',
            generation: session.generation,
          })),
        }))
      ),
      requestedProjectId: options.selectedProjectId(),
      requestedSessionId: options.selectedRuntimeSessionId(),
      scope: activeScope(),
      observedAt: projection()?.observedAt,
      staleAfterMs: PROJECTION_FRESHNESS_MS,
      now: currentTime(),
    })
  )
  const selectedProject = () => {
    const result = selection()
    return result.status === 'empty' ? '' : result.projectId
  }
  const selectedSession = () => {
    const result = selection()
    return result.status === 'empty' ? '' : result.runtimeSessionId
  }
  const selectedSessionRecord = createMemo(() => {
    const sessionId = selectedSession()
    if (!sessionId) return undefined
    for (const group of projection()?.groups ?? [])
      for (const project of group.projects)
        for (const session of project.sessions) if (session.id === sessionId) return session
    return undefined
  })
  const selectedSessionWorktreeId = createMemo(
    () => selectedSessionRecord()?.worktreeId || undefined
  )
  const selectedProjectLabel = createMemo(() => {
    const projectId = selectedProject()
    if (!projectId) return undefined
    for (const group of groups())
      for (const project of group.projects) if (project.id === projectId) return project.name
    return undefined
  })

  createEffect(() => {
    const service = runtime()
    const requestScope = activeScope()
    const ready = projectionStatus()
    if (ready === 'loading' && service.ready) {
      setCapabilities(new Map())
      setCapabilitySnapshotStatus('loading')
      return
    }
    if (!requestScope || fixtureMode()) {
      setCapabilities(new Map())
      setCapabilitySnapshotStatus('unavailable')
      return
    }
    let current = true
    const generationScope = scopeKey(requestScope)
    setCapabilities(new Map())
    setCapabilitySnapshotStatus('loading')
    onCleanup(() => {
      current = false
    })
    void service.capabilitySnapshot(requestScope)
      .then((snapshot: CapabilitySnapshot) => {
        if (
          !current ||
          service !== runtime() ||
          generationScope !== scopeKey(activeScope())
        )
          return
        if (!sameScope(requestScope, snapshot.scope)) {
          setCapabilities(new Map())
          setCapabilitySnapshotStatus('unavailable')
          return
        }
        const next = new Map<DevCapability, { granted: boolean; reason?: string }>()
        for (const capability of snapshot.granted) next.set(capability, { granted: true })
        for (const entry of snapshot.unavailable)
          next.set(entry.capability, { granted: false, reason: entry.reason })
        setCapabilities(next)
        setCapabilitySnapshotStatus('ready')
      })
      .catch(() => {
        if (!current || service !== runtime() || generationScope !== scopeKey(activeScope())) return
        setCapabilities(new Map())
        setCapabilitySnapshotStatus('unavailable')
      })
  })

  createEffect(() => {
    const hadRequest = Boolean(options.selectedProjectId() || options.selectedRuntimeSessionId())
    const result = selection()
    if (result.status !== 'recovered') return
    if (hadRequest && !recoveryNotice()) setRecoveryNotice(recoveryCopy[result.reason])
    const store = workspaceStore.getState()
    if (store.selectedDevProjectId !== result.projectId)
      options.setSelectedProjectId(result.projectId)
    if (result.runtimeSessionId && store.selectedRuntimeSessionId !== result.runtimeSessionId)
      options.setSelectedRuntimeSessionId(result.runtimeSessionId)
    if (hadRequest) setAnnouncement(recoveryCopy[result.reason])
  })

  const visiblePaneOf = (side: 'left' | 'right') =>
    utilityPreferences().find((item) => item.side === side && item.visible)
  const panesOfSide = (side: 'left' | 'right') =>
    utilityPreferences()
      .filter((item) => item.side === side)
      .toSorted((first, second) => first.order - second.order)
  const isRightSuppressed = () => Boolean(options.activeDevView?.() && options.focusMode())
  const isRightOpen = () => !isRightSuppressed() && Boolean(visiblePaneOf('right'))
  // Full-width utility content still needs its collapse control in the top bar.
  const rightToggleAvailable = () => true

  const toUtilityTuple = (
    items: readonly DevUtilityPreference[]
  ): DevLayoutPreferencesV2['utility'] => {
    if (items.length !== utilityItems.length)
      throw new TypeError('corrupt_state: utility preferences require all six panes')
    return items as DevLayoutPreferencesV2['utility']
  }
  const persistedPreferences = (state: DevLayoutState): DevLayoutPreferencesV2 | undefined => {
    const scope = activeScope()
    const projectId = selectedProject()
    const runtimeSessionId = selectedSession()
    if (!scope || !projectId || !runtimeSessionId) return undefined
    return {
      schemaVersion: 2,
      scope,
      projectId,
      runtimeSessionId,
      center: state.center,
      utility: toUtilityTuple(utilityPreferences()),
      focusMode: options.focusMode(),
      focusTargetId: state.focusedLeafId,
    }
  }
  const schedulePreferences = (state = layout()) => {
    const value = persistedPreferences(state)
    const requestKey = value
      ? JSON.stringify([scopeKey(value.scope), value.projectId, value.runtimeSessionId])
      : undefined
    if (value && storageController && storageControllerKey === requestKey)
      storageController.schedule(value)
  }
  const updateLayout = (update: (state: DevLayoutState) => DevLayoutState) => {
    const next = update(layout())
    setLayout(next)
    schedulePreferences(next)
    return next
  }
  const showPane = (pane: DevUtilityPane) => {
    const side = utilityItemByPane.get(pane)!.side
    if (side === 'right') setLastRightPane(pane)
    setUtilityPreferences((items) =>
      items.map((item) => (item.side === side ? { ...item, visible: item.pane === pane } : item))
    )
    schedulePreferences()
  }
  const collapseSide = (side: 'left' | 'right') => {
    if (side === 'right') {
      const current = visiblePaneOf('right')
      if (current) setLastRightPane(current.pane)
    }
    setUtilityPreferences((items) =>
      items.map((item) => (item.side === side ? { ...item, visible: false } : item))
    )
    schedulePreferences()
    setAnnouncement(`${side === 'left' ? 'Left' : 'Right'} utility slot collapsed`)
    if (typeof requestAnimationFrame !== 'undefined')
      requestAnimationFrame(() => {
        const center = document.getElementById('dev-center')
        const shellToggle =
          side === 'right' ? document.getElementById('dev-utility-right-toggle') : undefined
        const focusTarget = center ?? shellToggle
        focusTarget?.focus()
      })
  }
  const toggleUtilityGroup = (panes: readonly DevUtilityPane[]) => {
    const side = utilityItemByPane.get(panes[0]!)!.side
    const current = visiblePaneOf(side)
    if (!current) {
      showPane(panes[0]!)
      setAnnouncement(`${side === 'left' ? 'Left' : 'Right'} utility slot opened`)
      return
    }
    if (panes.includes(current.pane)) {
      collapseSide(side)
      return
    }
    showPane(panes.find((pane) => pane !== current.pane) ?? panes[0]!)
  }
  const openRightUtilitySlot = () => {
    if (isRightSuppressed()) options.setFocusMode(false)
    if (!visiblePaneOf('right')) {
      showPane(lastRightPane())
      setAnnouncement('Right utility slot opened')
    } else if (isRightSuppressed()) {
      setAnnouncement('Focus mode disabled; right utility slot opened')
    }
  }
  const toggleRightUtilitySlot = () => {
    if (isRightSuppressed()) openRightUtilitySlot()
    else if (isRightOpen()) collapseSide('right')
    else openRightUtilitySlot()
  }
  const setPaneFullWidth = (pane: DevUtilityPane, fullWidth: boolean) => {
    setUtilityPreferences((items) =>
      items.map((item) => {
        if (item.pane === pane) return { ...item, fullWidth }
        if (fullWidth && item.fullWidth) return { ...item, fullWidth: false }
        return item
      })
    )
    schedulePreferences()
  }
  const setPaneSize = (pane: DevUtilityPane, size: number) => {
    const snapped = snapUtilitySize(size)
    setUtilityPreferences((items) =>
      items.map((item) =>
        item.pane === pane ? { ...item, size: snapped, lastNonzeroSize: snapped } : item
      )
    )
    schedulePreferences()
  }

  createEffect(() => {
    const requestScope = activeScope()
    const projectId = selectedProject()
    const runtimeSessionId = selectedSession()
    const storage = options.storage()
    const dataReady = projectionStatus() !== 'loading'
    const loadKey = requestScope
      ? JSON.stringify([scopeKey(requestScope), projectId || null, runtimeSessionId || null])
      : undefined
    const requestKey =
      requestScope && projectId && runtimeSessionId
        ? JSON.stringify([scopeKey(requestScope), projectId, runtimeSessionId])
        : undefined

    const sameLoadedPreferences =
      preferencesLoaded && loadKey === loadedPreferenceKey && storage === loadedStorage

    if (!dataReady) {
      if (!sameLoadedPreferences) {
        disposeStorageController()
        setLayout(initialDevLayout())
        setUtilityPreferences(defaultUtilityPreferences())
        setLastRightPane('browser')
        setPreferencesReady(false)
        preferencesLoaded = false
        loadedPreferenceKey = undefined
        loadedStorage = undefined
      }
      return
    }

    if (sameLoadedPreferences) return

    disposeStorageController()
    setLayout(initialDevLayout())
    setUtilityPreferences(defaultUtilityPreferences())
    setLastRightPane('browser')
    setPreferencesReady(false)

    if (!requestKey || !storage) {
      preferencesLoaded = true
      loadedPreferenceKey = loadKey
      loadedStorage = storage
      setPreferencesReady(true)
      return
    }
    const controller = createLayoutStorageController({
      storage,
      scope: requestScope!,
      projectId,
      runtimeSessionId,
    })
    storageController = controller
    storageControllerKey = requestKey
    preferencesLoaded = true
    loadedPreferenceKey = loadKey
    loadedStorage = storage
    const loaded = controller.load()
    if (loaded.state === 'ready') {
      const restored = normalizeLayout(createLayoutState<PaneLeaf>(loaded.value.center))
      setLayout({
        ...restored,
        focusedLeafId: loaded.value.focusTargetId ?? restored.focusedLeafId,
      })
      setUtilityPreferences(loaded.value.utility)
      const visibleRight = loaded.value.utility.find((item) => item.side === 'right' && item.visible)
      if (visibleRight) setLastRightPane(visibleRight.pane)
      options.setFocusMode(loaded.value.focusMode)
      setPreferencesReady(true)
    } else {
      if (loaded.state !== 'empty')
        setAnnouncement('Stored Dev layout was unreadable and is kept for recovery.')
      options.setFocusMode(false)
      setPreferencesReady(true)
    }
    const visibilityChanged = () => controller.visibilityChanged(document.hidden)
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', visibilityChanged)
      removeVisibilityListener = () =>
        document.removeEventListener('visibilitychange', visibilityChanged)
    }
  })

  return {
    runtime,
    activeScope,
    projection,
    projectionStatus,
    groups,
    fixtureMode,
    selection,
    selectedProject,
    selectedSession,
    selectedSessionRecord,
    selectedSessionWorktreeId,
    selectedProjectLabel,
    capabilitySnapshotStatus,
    capabilities,
    capabilityOf: (pane: DevUtilityPane) => capabilities().get(paneCapability[pane]),
    layout,
    setLayout,
    utilityPreferences,
    setUtilityPreferences,
    visiblePaneOf,
    panesOfSide,
    lastRightPane,
    isRightOpen,
    rightToggleAvailable,
    showPane,
    collapseSide,
    toggleUtilityGroup,
    openRightUtilitySlot,
    toggleRightUtilitySlot,
    setPaneFullWidth,
    setPaneSize,
    updateLayout,
    schedulePreferences,
    preferencesReady,
    focusMode: options.focusMode,
    setFocusMode: (enabled: boolean) => {
      options.setFocusMode(enabled)
      schedulePreferences()
    },
    announcement,
    announce: setAnnouncement,
    recoveryNotice,
    setRecoveryNotice,
    replaceGroups: (next) =>
      setGroupOverride((current) =>
        typeof next === 'function' ? next(current ?? groups()) : next
      ),
    reloadProjection,
  } satisfies DevUtilityOwnerModel
}

const DevUtilityOwnerContext = createContext<DevUtilityOwnerModel>()

export function useDevUtilityOwner(): DevUtilityOwnerModel {
  const owner = useContext(DevUtilityOwnerContext)
  if (!owner) throw new Error('DevWorkspaceEntry must be mounted inside DevUtilityHost')
  return owner
}

export function DevUtilityOwnerProvider(props: {
  owner: DevUtilityOwnerModel
  children: JSX.Element
}) {
  return (
    <DevUtilityOwnerContext.Provider value={props.owner}>
      {props.children}
    </DevUtilityOwnerContext.Provider>
  )
}

export function DevUtilityHost(props: {
  runtime?: DevRuntimeService
  fixture?: boolean
  workspaceId?: string
  activeDevView?: Accessor<boolean>
  storage?: LayoutStorage
  openOnReady?: boolean
  onInitialOpenApplied?(): void
  rightUtilityMount?: Accessor<HTMLElement | undefined>
  rightSidebarMount?: Accessor<HTMLElement | undefined>
  onToggleReady?(): void
  onOwnerChange?(owner: DevUtilityOwnerModel | undefined): void
  onRuntimeChange?(runtime: DevRuntimeService): void
}) {
  const selectedProjectId = useWorkspaceState((state) => state.selectedDevProjectId)
  const selectedRuntimeSessionId = useWorkspaceState((state) => state.selectedRuntimeSessionId)
  const focusMode = useWorkspaceState((state) => state.devFocusMode)
  const [groups, setGroups] = createSignal<readonly DevGroupFixture[] | undefined>()
  let fixtureLoadGeneration = 0
  const isFixture = () => import.meta.env.DEV && Boolean(props.fixture)
  createEffect(() => {
    const enabled = isFixture()
    const generation = ++fixtureLoadGeneration
    if (!enabled) {
      setGroups(undefined)
      return
    }
    let current = true
    onCleanup(() => {
      current = false
    })
    void import('./fixtures').then(({ devViewFixtureGroups }) => {
      if (current && generation === fixtureLoadGeneration) setGroups(devViewFixtureGroups)
    })
  })
  const fallbackRuntime = createUnavailableDevRuntimeService({ reason: 'channel_unauthenticated' })
  const runtime = createMemo(() => {
    const service = props.runtime ?? fallbackRuntime
    if (!isFixture()) return service
    return {
      ...service,
      preferenceScope: () => ({
        accountId: '00000000-0000-4000-8000-000000000001',
        workspaceId: '00000000-0000-4000-8000-000000000002',
        runtimeNodeId: '00000000-0000-4000-8000-000000000003',
      }),
    }
  })
  const owner = createDevUtilityOwnerModel({
    runtime,
    groups,
    workspaceId: () => props.workspaceId,
    activeDevView: props.activeDevView,
    storage: () => props.storage,
    selectedProjectId,
    setSelectedProjectId: (id) => workspaceStore.getState().setSelectedDevProjectId(id),
    selectedRuntimeSessionId,
    setSelectedRuntimeSessionId: (id) =>
      workspaceStore.getState().setSelectedRuntimeSessionId(id),
    focusMode,
    setFocusMode: (enabled) => workspaceStore.getState().setDevFocusMode(enabled),
  })
  const scopedRuntime = createMemo<DevRuntimeService>(() => ({
    ...runtime(),
    preferenceScope: owner.activeScope,
  }))

  let pendingToggle = 0
  let initialOpenApplied = false
  const toggle = () => {
    if (!owner.preferencesReady()) {
      pendingToggle += 1
      return
    }
    owner.toggleRightUtilitySlot()
  }

  createEffect(() => {
    if (!owner.preferencesReady() || pendingToggle === 0) return
    const shouldToggle = pendingToggle % 2 === 1
    pendingToggle = 0
    if (shouldToggle) owner.toggleRightUtilitySlot()
  })

  createEffect(() => {
    if (initialOpenApplied || !props.openOnReady || !owner.preferencesReady()) return
    initialOpenApplied = true
    owner.openRightUtilitySlot()
    props.onInitialOpenApplied?.()
  })

  createEffect(() => props.onRuntimeChange?.(scopedRuntime()))

  onMount(() => {
    props.onToggleReady?.()
    props.onOwnerChange?.(owner)
    onCleanup(() => props.onOwnerChange?.(undefined))
  })

  const rightSidebar = () => <DevRightUtilitySidebar owner={owner} runtime={scopedRuntime()} />

  return (
    <DevUtilityOwnerContext.Provider value={owner}>
      <Show when={props.rightUtilityMount?.()}>
        {(mount) => (
          <Portal mount={mount()}>
            <ActionButton
              id="dev-utility-right-toggle"
              type="button"
              variant="outline"
              size="icon-sm"
              class="workspace-topbar__control"
              tooltip={owner.isRightOpen() ? 'Collapse utility sidebar' : 'Expand utility sidebar'}
              aria-label={owner.isRightOpen() ? 'Collapse utility sidebar' : 'Expand utility sidebar'}
              aria-expanded={owner.isRightOpen()}
              onClick={toggle}
            >
              <Show when={owner.isRightOpen()} fallback={<PanelRightOpen aria-hidden="true" />}>
                <PanelRightClose aria-hidden="true" />
              </Show>
            </ActionButton>
          </Portal>
        )}
      </Show>
      <ShowRightSidebar owner={owner} mount={props.rightSidebarMount} sidebar={rightSidebar} />
      <p class="sr-only" aria-live="polite">
        {owner.announcement()}
      </p>
    </DevUtilityOwnerContext.Provider>
  )
}

function ShowRightSidebar(props: {
  owner: DevUtilityOwnerModel
  mount?: Accessor<HTMLElement | undefined>
  sidebar: () => JSX.Element
}) {
  return (
    <Show
      when={props.mount?.()}
      fallback={props.owner.visiblePaneOf('right') ? props.sidebar() : undefined}
    >
      {(mount) => (
        <Portal mount={mount()}>
          {props.owner.visiblePaneOf('right') ? props.sidebar() : undefined}
        </Portal>
      )}
    </Show>
  )
}
