/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0.
 *
 * Shell decomposition and hierarchy semantics are substantially translated
 * from KiroCrew website/src/pages/ChatSidebar.tsx,
 * website/src/pages/chat/SidePanel.tsx, and website/src/hooks/panelTabRegistry.ts
 * (Apache-2.0), revision
 * 283e136c0f902e965a535a7c9548c57c7504fed0. Modified for Solid, Adea's
 * runtime authority boundaries, accessibility, and unavailable typed seams.
 * See NOTICE and docs/research/dev-view-donor-audit.md.
 */
import { useWorkspaceState, workspaceStore } from '@adea-ai/state'
import type {
  DevCapability,
  DevLayoutPreferencesV2,
  DevUtilityPane,
  DevUtilityPreference,
  DevReply,
  DevStreamFrame,
  PaneLeaf,
  Scope,
} from '@adea-ai/types/dev-runtime'
import {
  devOperationMetadataFor_dev_group_reorder,
  devOperationMetadataFor_dev_project_reorder,
  devOperationMetadataFor_dev_session_get,
  devOperationMetadataFor_dev_session_list,
  devOperationMetadataFor_dev_session_unarchive,
} from '@adea-ai/types/dev-runtime-operation-metadata'
import '@adea-ai/app-ui/dev-view.css'
import { cn } from '@adea-ai/app-ui/lib/utils'
import {
  Columns2,
  Files,
  FolderTree,
  GitBranch,
  History,
  Laptop,
  Maximize2,
  MonitorSmartphone,
  PanelRightClose,
  PanelRightOpen,
  Undo2,
  Users,
  X,
} from 'lucide-solid'
import {
  For,
  Show,
  Suspense,
  createEffect,
  createMemo,
  createSignal,
  lazy,
  onCleanup,
  onMount,
} from 'solid-js'
import { Portal } from 'solid-js/web'

import { createDevKeyboardController } from './keyboard'
import { buildDevCommandFromMetadata } from './browser/command-core'
import {
  closePane,
  countLeaves,
  createLayoutState,
  focusPane,
  listLeaves,
  neighborLeaf,
  normalizeLayout,
  resizeSplit,
  splitPane,
  undoClosePane,
  movePane,
  type DevLayoutState,
} from './layout/operations'
import { createLayoutStorageController, type LayoutStorage } from './layout/storage'
import type { DevRuntimeService, DevWorkspaceProjection } from './platform'
import type { TerminalStreamSocket } from './terminal/transport'
import type { ShellObservation } from './terminal/blocks'
import { resolveDevSelection, type DevSelection, type DevSelectionReason } from './selection'
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
} from './sidebar/archive-shelf-model'
import { AddProjectPanel } from './sidebar/add-project-panel'
import { DevSidebarShell } from './sidebar/dev-sidebar-shell'
import type { DevSessionBadgeState } from './sidebar/badges'
import {
  announcementForMove,
  moveIdInOrder,
  reorderGroups,
  reorderGroupsRelativeTo,
  reorderProjects,
  reorderProjectsRelativeTo,
} from './sidebar/reorder'
import { Button } from '@adea-ai/ui/components/ui/button'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'

// Keep the sidebar and runtime controls independent of the central split
// renderer. Its resize dependency is loaded when the panes actually mount.
const DevLayoutView = lazy(() =>
  import('./layout/layout-view').then((module) => ({ default: module.DevLayoutView }))
)

// Test transport and fake output are development-only, never production code.
const FixtureTerminalPane = import.meta.env.DEV
  ? lazy(() =>
      import('./terminal/fixture-terminal-pane').then((module) => ({
        default: module.FixtureTerminalPane,
      }))
    )
  : undefined

const devWorkspaceReorderMetadata = {
  'dev.group.reorder': devOperationMetadataFor_dev_group_reorder,
  'dev.project.reorder': devOperationMetadataFor_dev_project_reorder,
} as const

export type DevProjectFixture = Readonly<{
  id: string
  name: string
  repository: string
  branch: string
  sessions: readonly Readonly<{
    id: string
    title: string
    /** Canonical RuntimeSession lifecycle states (register-backed). */
    state:
      | 'preparing'
      | 'ready'
      | 'active'
      | 'disconnected'
      | 'completed'
      | 'failed'
      | 'cancelled'
      | 'archived'
    generation?: number
    badges?: DevSessionBadgeState
  }>[]
}>

export type DevGroupFixture = Readonly<{
  id: string
  name: string
  projects: readonly DevProjectFixture[]
}>

export type DevWorkspaceEntryProps = Readonly<{
  runtime: DevRuntimeService
  /** E2E/development fixtures only; production consumes the runtime projection. */
  groups?: readonly DevGroupFixture[]
  storage?: LayoutStorage
  toolbarMount?: HTMLElement
  /**
   * Mount for the bundled utility sidebar's top-bar toggle, placed after the
   * host's own actions so the control is the top bar's trailing icon. Absent
   * hosts render it inside the Dev toolbar instead.
   */
  sidebarActionMount?: HTMLElement
  appMode?: 'source-control'
}>

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

export const devViewFixtureGroups: readonly DevGroupFixture[] = [
  {
    id: 'fixture-product',
    name: 'Product',
    projects: [
      {
        id: 'fixture-adea',
        name: 'Example project',
        repository: 'example/repository',
        branch: 'feature/example',
        sessions: [
          {
            id: 'fixture-shell',
            title: 'Dev View foundation',
            state: 'active',
            badges: {
              harness: 'working',
              dirty: true,
              checks: 'running',
              ports: [3000],
            },
          },
          { id: 'fixture-runtime', title: 'Runtime contracts', state: 'ready' },
        ],
      },
      {
        id: 'fixture-tools',
        name: 'Runtime tools',
        repository: 'example/tools',
        branch: 'feature/runtime',
        sessions: [
          {
            id: 'fixture-tools-session',
            title: 'Other project session',
            state: 'ready',
            badges: { checks: 'failed', harness: 'awaiting_input' },
          },
          {
            id: 'fixture-archived',
            title: 'Archived discovery',
            state: 'archived',
          },
        ],
      },
    ],
  },
]

const utilityItems = [
  { pane: 'files', side: 'left', label: 'Files', title: 'Files', icon: Files },
  {
    pane: 'source_control',
    side: 'left',
    label: 'Source control',
    title: 'Source Control',
    icon: GitBranch,
  },
  { pane: 'browser', side: 'right', label: 'Browser', title: 'Browser', icon: Laptop },
  {
    pane: 'devices',
    side: 'right',
    label: 'Devices',
    title: 'Devices',
    icon: MonitorSmartphone,
  },
  { pane: 'agents', side: 'right', label: 'Agents', title: 'Agents', icon: Users },
  { pane: 'history', side: 'right', label: 'History', title: 'History', icon: History },
] as const satisfies readonly Readonly<{
  pane: DevUtilityPane
  side: 'left' | 'right'
  label: string
  title: string
  icon: typeof Files
}>[]

/** The read capability each utility pane depends on for its provider state. */
const PANE_CAPABILITY: Record<DevUtilityPane, DevCapability> = {
  files: 'dev.files.read',
  source_control: 'dev.git.read',
  browser: 'dev.browser.read',
  devices: 'dev.device.read',
  agents: 'dev.session.read',
  history: 'dev.session.read',
}

const utilityItemByPane = new Map(utilityItems.map((item) => [item.pane, item]))
const utilitySizeSteps = [240, 288, 336, 384] as const
const defaultUtilitySize = 288

const defaultUtilityPreferences = (): DevUtilityPreference[] =>
  utilityItems.map((item, order) => ({
    pane: item.pane,
    side: item.side,
    order,
    visible: item.pane === 'files',
    size: defaultUtilitySize,
    lastNonzeroSize: defaultUtilitySize,
    fullWidth: false,
  }))

const initialLayout = () =>
  createLayoutState<PaneLeaf>({
    kind: 'leaf',
    id: 'dev-terminal',
    pane: 'terminal',
  })

const snapUtilitySize = (size: number) => {
  if (!Number.isFinite(size)) return defaultUtilitySize
  return utilitySizeSteps.reduce(
    (best, step) => (Math.abs(step - size) < Math.abs(best - size) ? step : best),
    utilitySizeSteps[0]
  )
}

/** How long a projection observation stays fresh for selection rendering. */
const PROJECTION_FRESHNESS_MS = 60_000

const RECOVERY_COPY: Record<DevSelectionReason, string> = {
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

/*
 * The browser and device panes ride their own lazy chunks inside the lazy
 * Dev boundary: mounting code this heavy on the dev shell chunk would blow
 * the client budget the bundle check enforces. Both render only while their
 * utility pane is visible.
 */
const BrowserPane = lazy(() =>
  import('./browser/browser-pane').then((module) => ({ default: module.BrowserPane }))
)
const DevicesPane = lazy(() =>
  import('./devices/devices-pane').then((module) => ({ default: module.DevicesPane }))
)
// #424: the Agents pane's Activity section rides its own lazy chunk inside
// the Dev boundary, exactly like the browser and device panes.
const ActivityPane = lazy(() =>
  import('./resources/activity-pane').then((module) => ({ default: module.ActivityPane }))
)
/*
 * #400: the Agents pane's harness status and the History pane's run history
 * ride their own lazy chunks inside the Dev boundary, exactly like the browser
 * and device panes; each renders only while its utility pane is visible.
 */
const HarnessStatusSection = lazy(() =>
  import('./agents/harness-status-section').then((module) => ({
    default: module.HarnessStatusSection,
  }))
)
const RunHistorySection = lazy(() =>
  import('./history/run-history-section').then((module) => ({
    default: module.RunHistorySection,
  }))
)
/*
 * #399: Files/Source Control utility panes and the central editor leaf ride
 * their own lazy chunks inside the Dev boundary, exactly like the browser and
 * device panes; the editor's CodeMirror family loads one dynamic import
 * deeper still (inside the editor slice).
 */
const FilesPane = lazy(() =>
  import('./files/files-pane').then((module) => ({ default: module.FilesPane }))
)
const SourceControlPane = lazy(() =>
  import('./source-control/source-control-pane').then((module) => ({
    default: module.SourceControlPane,
  }))
)
const CodeEditor = lazy(() =>
  import('./editor/code-editor').then((module) => ({ default: module.CodeEditor }))
)
const RuntimeTerminalPane = lazy(() =>
  import('./terminal/runtime-terminal-pane').then((module) => ({
    default: module.RuntimeTerminalPane,
  }))
)
/*
 * #398 follow-up: the sidebar repository registry panel rides its own lazy
 * chunk exactly like the utility panes — the client budget the bundle check
 * enforces leaves no room for it in the Dev shell chunk.
 */
const RepoRegistryPanel = lazy(() =>
  import('./sidebar/repo-registry-panel').then((module) => ({
    default: module.RepoRegistryPanel,
  }))
)

function focusPaneElement(leafId: string) {
  requestAnimationFrame(() => {
    const target = [...document.querySelectorAll<HTMLElement>('[data-pane-id]')].find(
      (element) => element.dataset.paneId === leafId
    )
    target?.focus()
  })
}

function sameRuntimeScope(left: Scope, right: Scope | undefined): boolean {
  return Boolean(
    right &&
    left.accountId === right.accountId &&
    left.workspaceId === right.workspaceId &&
    left.runtimeNodeId === right.runtimeNodeId
  )
}

/** Fixture-only stream used by headless owner-journey coverage. It models the
 * authenticated terminal contract, including one bounded reconnect, without
 * creating a PTY or claiming production runtime authority. */
function createFixtureTerminalConnect() {
  let attempts = 0
  return (handlers: {
    onFrame: (frame: DevStreamFrame) => void
    onClose: () => void
  }): TerminalStreamSocket => {
    const attempt = ++attempts
    let open = true
    const reconnectTimer = setTimeout(() => {
      if (attempt !== 1 || !open) return
      open = false
      handlers.onClose()
    }, 250)
    queueMicrotask(() => {
      if (!open) return
      handlers.onFrame({
        type: 'opened',
        protocol: 'terminal-bytes-v1',
        generation: 1,
        nextSequence: attempt === 1 ? '0' : '1',
      })
      handlers.onFrame({
        type: 'data',
        sequence: attempt === 1 ? '0' : '1',
        bytes: new TextEncoder().encode(
          attempt === 1
            ? 'fixture terminal connected\\r\\n$ '
            : 'fixture terminal reconnected\\r\\n$ '
        ),
      })
    })
    return {
      get open() {
        return open
      },
      bufferedAmount: 0,
      send: (_frame) => undefined,
      close: () => {
        if (!open) return
        open = false
        clearTimeout(reconnectTimer)
      },
    }
  }
}

function createFixtureTerminalObservations() {
  return (handler: (observation: ShellObservation) => void) => {
    queueMicrotask(() => {
      const at = new Date().toISOString()
      handler({ kind: 'preexec', command: 'printf fixture', at, sequence: '0' })
      handler({ kind: 'cwd', cwd: '/fixture/runtime', at })
      handler({ kind: 'precmd', exitCode: 0, at: new Date().toISOString(), sequence: '0' })
    })
    return () => undefined
  }
}

export function DevWorkspaceEntry(props: DevWorkspaceEntryProps) {
  let nextPaneId = 0
  const fixtureTerminalObservations = import.meta.env.DEV
    ? createFixtureTerminalObservations()
    : undefined
  let storageController: ReturnType<typeof createLayoutStorageController> | undefined
  // #399: the file the central editor leaf shows. Open files are session-local
  // leaves in the split model — selecting a file focuses (or creates) the
  // editor leaf beside the active terminal; it never builds a tab forest.
  const [activeEditorFile, setActiveEditorFile] = createSignal<
    | {
        worktreeId: string
        generation: number
        rootIdentity: { device?: string; inode?: string; mtimeNs: string; size: string }
        relativePath: string
        identity: {
          device?: string
          inode?: string
          birthtimeNs?: string
          mtimeNs: string
          size: string
          contentSha256?: string
        }
      }
    | undefined
  >(undefined)
  const [projectedGroups, setProjectedGroups] = createSignal<readonly DevGroupFixture[]>([])
  // Fixture mode keeps a local, reorderable copy: `props.groups` itself is
  // readonly E2E input and never mutates.
  const [fixtureGroups, setFixtureGroups] = createSignal<readonly DevGroupFixture[] | undefined>()
  const [projection, setProjection] = createSignal<DevWorkspaceProjection | undefined>()
  const groups = () => fixtureGroups() ?? props.groups ?? projectedGroups()
  const selectedProjectState = useWorkspaceState((state) => state.selectedDevProjectId)
  const selectedSessionState = useWorkspaceState((state) => state.selectedRuntimeSessionId)
  const collapsedGroupIds = useWorkspaceState((state) => state.collapsedDevGroupIds)
  const collapsedProjectIds = useWorkspaceState((state) => state.collapsedDevProjectIds)
  const focusMode = useWorkspaceState((state) => state.devFocusMode)
  const compactSidebarOpen = useWorkspaceState((state) => state.mobileSidebarOpen)
  const [utilityPreferences, setUtilityPreferences] = createSignal<readonly DevUtilityPreference[]>(
    defaultUtilityPreferences()
  )
  const [layout, setLayout] = createSignal<DevLayoutState>(initialLayout())
  const firstUnboundTerminalLeafId = createMemo(
    () =>
      listLeaves(layout().center).find(
        (leaf) => leaf.pane === 'terminal' && leaf.resourceId === undefined
      )?.id
  )
  const [announcement, setAnnouncement] = createSignal('')
  const [capabilities, setCapabilities] = createSignal<
    ReadonlyMap<DevCapability, { granted: boolean; reason?: string }>
  >(new Map())
  const [capabilitySnapshotStatus, setCapabilitySnapshotStatus] = createSignal<
    'loading' | 'ready' | 'unavailable'
  >('loading')
  const [archiveShelf, setArchiveShelf] = createSignal<ArchiveShelfState>(beginArchiveShelfLoad())
  /**
   * A latched recovery notice: set the first time a requested selection needs
   * recovery, kept visible across the URL/store convergence, and cleared only
   * when the user makes an explicit selection.
   */
  const [recoveryNotice, setRecoveryNotice] = createSignal('')
  const [archiveHandoff, setArchiveHandoff] = createSignal<string | undefined>()
  // The right utility slot's panes share one bundled sidebar, so its single
  // top-bar toggle reopens the pane that was visible before the collapse.
  const [lastRightPane, setLastRightPane] = createSignal<DevUtilityPane>('browser')
  const [runtimeBindingReady, setRuntimeBindingReady] = createSignal(false)
  const runtimeState = createMemo(() => props.runtime.state())
  const fixtureMode = () => props.groups !== undefined

  const activeScope = () => props.runtime.preferenceScope?.()

  /** Production path: the authoritative projection, reloaded on demand. */
  const loadProjection = async () => {
    if (props.groups !== undefined) return
    const scope = activeScope()
    if (!scope || !props.runtime.projection) {
      setArchiveShelf(archiveShelfUnavailable('channel_unauthenticated'))
      return
    }
    try {
      const next = await props.runtime.projection(scope)
      setProjection(next)
      setProjectedGroups(toDevGroups(next))
      void loadArchivedSessions()
    } catch {
      setProjectedGroups([])
      setArchiveShelf(archiveShelfUnavailable('unavailable'))
    }
  }

  onMount(() => {
    if (props.groups !== undefined) {
      setFixtureGroups(props.groups)
      setArchiveShelf(
        archiveShelfReady(
          props.groups.flatMap((group) =>
            group.projects.flatMap((project) =>
              project.sessions
                .filter((session) => session.state === 'archived')
                .map((session) => ({
                  id: session.id,
                  projectId: project.id,
                  title: session.title,
                  archivedAt: 'fixture',
                }))
            )
          )
        )
      )
      return
    }
    const ready = props.runtime.ready
    if (ready) {
      void ready.then(() => {
        setRuntimeBindingReady(true)
        return loadProjection()
      })
    } else {
      setRuntimeBindingReady(true)
      void loadProjection()
    }
  })

  const capabilityOf = (pane: DevUtilityPane) => capabilities().get(PANE_CAPABILITY[pane])

  createEffect(() => {
    if (props.runtime.ready && !runtimeBindingReady()) return
    const scope = activeScope()
    if (!scope || fixtureMode()) {
      setCapabilities(new Map())
      setCapabilitySnapshotStatus('unavailable')
      return
    }
    let current = true
    setCapabilities(new Map())
    setCapabilitySnapshotStatus('loading')
    onCleanup(() => {
      current = false
    })
    void props.runtime
      .capabilitySnapshot(scope)
      .then((snapshot) => {
        if (!current || !sameRuntimeScope(scope, activeScope())) return
        if (!sameRuntimeScope(scope, snapshot.scope)) {
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
        if (!current || !sameRuntimeScope(scope, activeScope())) return
        setCapabilities(new Map())
        setCapabilitySnapshotStatus('unavailable')
      })
  })

  // Selection always resolves inside the active scope's projection; a stale,
  // archived, revoked, or cross-project ID recovers visibly and is corrected
  // once. Fixture selections resolve against the fixture projection.
  const selection = createMemo<DevSelection>(() =>
    resolveDevSelection({
      projects: groups().flatMap((group) =>
        group.projects.map((project) => ({
          id: project.id,
          sessions: project.sessions.map((session) => ({
            id: session.id,
            archived: session.state === 'archived',
            generation: session.generation,
          })),
        }))
      ),
      requestedProjectId: selectedProjectState(),
      requestedSessionId: selectedSessionState(),
      scope: activeScope(),
      observedAt: projection()?.observedAt,
      staleAfterMs: PROJECTION_FRESHNESS_MS,
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

  // The selected session's own worktree. Files and Source Control resolve
  // their worktree from this rather than taking the first ready one on the
  // node, which staged and committed against a different worktree than the one
  // being displayed whenever a node had more than one.
  const selectedSessionWorktreeId = createMemo(() => {
    const sessionId = selectedSession()
    if (!sessionId) return undefined
    for (const group of projection()?.groups ?? [])
      for (const project of group.projects)
        for (const session of project.sessions)
          if (session.id === sessionId) return session.worktreeId || undefined
    return undefined
  })
  const selectedSessionRecord = createMemo(() => {
    const sessionId = selectedSession()
    if (!sessionId) return undefined
    for (const group of projection()?.groups ?? [])
      for (const project of group.projects)
        for (const session of project.sessions) if (session.id === sessionId) return session
    return undefined
  })
  const selectedProjectLabel = createMemo(() => {
    const projectId = selectedProject()
    if (!projectId) return undefined
    for (const group of groups())
      for (const project of group.projects) if (project.id === projectId) return project.name
    return undefined
  })
  const recoveryMessage = () => recoveryNotice()

  createEffect(() => {
    // A defaulting mount (no requested IDs) is silent; recovery notices apply
    // only when a stored or deep-linked selection actually failed to resolve.
    const hadRequest = Boolean(selectedProjectState() || selectedSessionState())
    const result = selection()
    if (result.status !== 'recovered') return
    // Latch the visible notice before correcting the store: the correction
    // flips the selection to resolved, which would otherwise unmount the
    // banner in the same tick it appeared.
    if (hadRequest && !recoveryNotice()) setRecoveryNotice(RECOVERY_COPY[result.reason])
    const store = workspaceStore.getState()
    if (store.selectedDevProjectId !== result.projectId)
      store.setSelectedDevProjectId(result.projectId)
    if (result.runtimeSessionId && store.selectedRuntimeSessionId !== result.runtimeSessionId)
      store.setSelectedRuntimeSessionId(result.runtimeSessionId)
    if (hadRequest) setAnnouncement(RECOVERY_COPY[result.reason])
  })

  const visiblePaneOf = (side: 'left' | 'right') => {
    if (props.appMode === 'source-control') {
      const item = utilityPreferences().find((entry) => entry.pane === 'source_control')
      return side === item?.side ? { ...item, visible: true, fullWidth: true } : undefined
    }
    return utilityPreferences().find((item) => item.side === side && item.visible)
  }
  const panesOfSide = (side: 'left' | 'right') =>
    utilityPreferences()
      .filter((item) => item.side === side)
      .toSorted((first, second) => first.order - second.order)

  const toUtilityTuple = (
    items: readonly DevUtilityPreference[]
  ): DevLayoutPreferencesV2['utility'] => {
    if (items.length !== utilityItems.length)
      throw new TypeError('corrupt_state: utility preferences require all six panes')
    return items as DevLayoutPreferencesV2['utility']
  }

  const persistedPreferences = (state: DevLayoutState): DevLayoutPreferencesV2 | undefined => {
    const scope = props.runtime.preferenceScope?.()
    if (!scope || !selectedProject() || !selectedSession()) return undefined
    return {
      schemaVersion: 2,
      scope,
      projectId: selectedProject(),
      runtimeSessionId: selectedSession(),
      center: state.center,
      utility: toUtilityTuple(utilityPreferences()),
      focusMode: focusMode(),
      focusTargetId: state.focusedLeafId,
    }
  }
  const schedulePreferences = (state = layout()) => {
    const preferences = persistedPreferences(state)
    if (preferences) storageController?.schedule(preferences)
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
  /** #399: selecting a file opens an editor beside the focused pane. Keep
   *  one editor leaf; later file selections replace its content. */
  const openFileInEditorLeaf = (file: {
    worktreeId: string
    generation: number
    rootIdentity: { device?: string; inode?: string; mtimeNs: string; size: string }
    relativePath: string
    identity: {
      device?: string
      inode?: string
      birthtimeNs?: string
      mtimeNs: string
      size: string
      contentSha256?: string
    }
  }) => {
    setActiveEditorFile(file)
    const existing = listLeaves(layout().center).find((leaf) => leaf.pane === 'editor')
    if (existing) {
      updateLayout((state) => focusPane(state, existing.id))
      focusPaneElement(existing.id)
      return
    }
    const suffix = ++nextPaneId
    updateLayout((state) =>
      splitPane(state, state.focusedLeafId, {
        direction: 'row',
        placement: 'after',
        leaf: { kind: 'leaf', id: `dev-editor-${suffix}`, pane: 'editor' },
        splitId: `dev-split-${suffix}`,
      })
    )
    focusPaneElement(`dev-editor-${suffix}`)
  }
  const collapseSide = (side: 'left' | 'right') => {
    setUtilityPreferences((items) =>
      items.map((item) => (item.side === side ? { ...item, visible: false } : item))
    )
    schedulePreferences()
    setAnnouncement(`${side === 'left' ? 'Left' : 'Right'} utility slot collapsed`)
    requestAnimationFrame(() => document.getElementById('dev-center')?.focus())
  }
  /** One-click toolbar toggle: opens the group, switches to it, or collapses. */
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
  /**
   * The bundled utility sidebar's single toggle: browser, devices, agents,
   * and history share the right slot, so the control opens the last pane
   * shown or collapses the slot — no per-group toolbar buttons.
   */
  const toggleRightUtilitySlot = () => {
    const current = visiblePaneOf('right')
    if (current) {
      setLastRightPane(current.pane)
      collapseSide('right')
      return
    }
    showPane(lastRightPane())
    setAnnouncement('Right utility slot opened')
  }
  const setPaneFullWidth = (pane: DevUtilityPane, fullWidth: boolean) => {
    setUtilityPreferences((items) =>
      items.map((item) => {
        if (item.pane === pane) return { ...item, fullWidth }
        // Full width is exclusive: expanding one side clears the other.
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

  /*
   * Accessible reordering. Keyboard moves and pointer drops funnel through
   * one pure model; in production the resulting order is sent to the runtime
   * (`dev.group.reorder` / `dev.project.reorder`) and the authoritative
   * projection is reloaded — a refused reorder is reverted, never kept.
   */
  const reorderVersionOf = (groupId: string) =>
    projection()?.groups.find((g) => g.id === groupId)?.version

  const executeReorder = async (
    operation: 'dev.group.reorder' | 'dev.project.reorder',
    body: Record<string, unknown>
  ): Promise<boolean> => {
    const scope = activeScope()
    if (!scope) return false
    const reply: DevReply = await props.runtime.execute(
      buildDevCommandFromMetadata(devWorkspaceReorderMetadata[operation], { scope, body })
    )
    if (!reply.ok) {
      setAnnouncement(`Reorder was refused: ${reply.error.message}`)
      await loadProjection()
      return false
    }
    await loadProjection()
    return true
  }

  const applyGroups = (next: readonly DevGroupFixture[]) => {
    if (fixtureMode()) {
      setFixtureGroups(next)
      return
    }
    // Optimistic local reorder; the authoritative projection reloads after
    // the runtime command resolves (or refuses).
    setProjectedGroups(next)
  }

  const moveGroupHandler = (id: string, direction: 'up' | 'down') => {
    const current = groups()
    const moved = Boolean(
      moveIdInOrder(
        current.map((group) => group.id),
        id,
        direction
      )
    )
    const next = reorderGroups(current, id, direction)
    applyGroups(next)
    const position = next.findIndex((group) => group.id === id) + 1
    const label = current.find((group) => group.id === id)?.name ?? id
    setAnnouncement(announcementForMove(label, position, next.length, moved))
    if (!moved || fixtureMode()) return
    void executeReorder('dev.group.reorder', { orderedGroupIds: next.map((group) => group.id) })
  }

  const dropGroupHandler = (id: string, targetId: string) => {
    const current = groups()
    const next = reorderGroupsRelativeTo(current, id, targetId)
    if (next === current) return
    applyGroups(next)
    const label = current.find((group) => group.id === id)?.name ?? id
    const position = next.findIndex((group) => group.id === id) + 1
    setAnnouncement(announcementForMove(label, position, next.length, true))
    if (fixtureMode()) return
    void executeReorder('dev.group.reorder', { orderedGroupIds: next.map((group) => group.id) })
  }

  const moveProjectHandler = (groupId: string, id: string, direction: 'up' | 'down') => {
    const current = groups()
    const group = current.find((candidate) => candidate.id === groupId)
    const next = reorderProjects(current, groupId, id, direction)
    applyGroups(next)
    const position =
      next.find((candidate) => candidate.id === groupId)?.projects.findIndex((p) => p.id === id) ??
      -1
    const label = group?.projects.find((project) => project.id === id)?.name ?? id
    const total = group?.projects.length ?? 0
    const moved = Boolean(
      group &&
      moveIdInOrder(
        group.projects.map((project) => project.id),
        id,
        direction
      )
    )
    if (position >= 0) setAnnouncement(announcementForMove(label, position + 1, total, moved))
    if (!moved || fixtureMode()) return
    const expectedGroupVersion = reorderVersionOf(groupId)
    if (expectedGroupVersion === undefined) {
      setAnnouncement(
        'Reorder needs the connected provider to expose group versions; nothing was changed on the runtime.'
      )
      return
    }
    void executeReorder('dev.project.reorder', {
      groupId,
      orderedProjectIds:
        next.find((candidate) => candidate.id === groupId)?.projects.map((project) => project.id) ??
        [],
      expectedGroupVersion,
    })
  }

  const dropProjectHandler = (groupId: string, id: string, targetId: string) => {
    const current = groups()
    const group = current.find((candidate) => candidate.id === groupId)
    const next = reorderProjectsRelativeTo(current, groupId, id, targetId)
    if (next === current) return
    applyGroups(next)
    const position =
      next.find((candidate) => candidate.id === groupId)?.projects.findIndex((p) => p.id === id) ??
      -1
    const label = group?.projects.find((project) => project.id === id)?.name ?? id
    if (position >= 0)
      setAnnouncement(announcementForMove(label, position + 1, group?.projects.length ?? 0, true))
    if (fixtureMode()) return
    const expectedGroupVersion = reorderVersionOf(groupId)
    if (expectedGroupVersion === undefined) {
      setAnnouncement(
        'Reorder needs the connected provider to expose group versions; nothing was changed on the runtime.'
      )
      return
    }
    void executeReorder('dev.project.reorder', {
      groupId,
      orderedProjectIds:
        next.find((candidate) => candidate.id === groupId)?.projects.map((project) => project.id) ??
        [],
      expectedGroupVersion,
    })
  }

  /*
   * Provider-backed archive shelf. Restore rides `dev.session.unarchive`;
   * the destructive delete commit reports the missing `dev.session.delete`
   * host contract instead of pretending to succeed.
   */
  const loadArchivedSessions = async () => {
    const scope = activeScope()
    if (!scope) {
      setArchiveShelf(archiveShelfUnavailable('channel_unauthenticated'))
      return
    }
    setArchiveShelf((current) => (current.status === 'ready' ? current : beginArchiveShelfLoad()))
    const reply = await props.runtime.execute(
      buildDevCommandFromMetadata(devOperationMetadataFor_dev_session_list, {
        scope,
        body: { archived: true },
      })
    )
    if (!reply.ok) {
      setArchiveShelf((current) =>
        archiveShelfError(
          reply.error.code,
          current.status === 'ready' ? current : beginArchiveShelfLoad()
        )
      )
      return
    }
    const sessions = (reply.value as { items: readonly Record<string, unknown>[] }).items
    setArchiveShelf(
      archiveShelfReady(
        sessions.map((raw) => ({
          id: String(raw.id),
          projectId: String(raw.projectId ?? ''),
          title: typeof raw.displayName === 'string' ? raw.displayName : String(raw.id),
          archivedAt: 'recently',
          ...(typeof raw.generation === 'number' ? { generation: raw.generation } : {}),
        }))
      )
    )
  }

  const restoreFromArchive = async (runtimeSessionId: string) => {
    setArchiveHandoff(undefined)
    if (props.groups !== undefined) {
      setArchiveShelf((current) => restoreCompleted(current, runtimeSessionId))
      setAnnouncement('Archived session restored (fixtures)')
      return
    }
    const scope = activeScope()
    if (!scope) return
    // The authoritative generation is carried by the archive list record; the
    // register binds archive transitions to it. Never send a wildcard/zero
    // generation because the host rejects stale resource bindings.
    const archived = archiveShelf().items.find((item) => item.id === runtimeSessionId)
    if (archived?.generation === undefined) {
      setArchiveHandoff(
        'Restore failed: the session generation is unavailable; refresh Archived sessions.'
      )
      return
    }
    const reply = await props.runtime.execute(
      buildDevCommandFromMetadata(devOperationMetadataFor_dev_session_get, {
        scope,
        body: { runtimeSessionId },
        resource: {
          kind: 'runtime_session',
          id: runtimeSessionId,
          generation: archived.generation,
        },
      })
    )
    if (!reply.ok) {
      setArchiveHandoff(`Restore failed: ${reply.error.message}`)
      return
    }
    const record = reply.value as { generation?: number }
    const unarchive = await props.runtime.execute(
      buildDevCommandFromMetadata(devOperationMetadataFor_dev_session_unarchive, {
        scope,
        body: { runtimeSessionId, expectedGeneration: record.generation ?? 1 },
        resource: {
          kind: 'runtime_session',
          id: runtimeSessionId,
          generation: record.generation ?? 1,
        },
      })
    )
    if (!unarchive.ok) {
      setArchiveHandoff(`Restore failed: ${unarchive.error.message}`)
      return
    }
    setArchiveShelf((current) => restoreCompleted(current, runtimeSessionId))
    setAnnouncement('Archived session restored')
    await loadProjection()
  }

  const requestArchiveDelete = (runtimeSessionId: string) => {
    setArchiveShelf((current) => requestDelete(current, runtimeSessionId))
  }
  const cancelArchiveDelete = () => {
    setArchiveShelf((current) => cancelPendingDelete(current))
  }
  const confirmArchiveDelete = () => {
    const commit = confirmPendingDelete(archiveShelf())
    setArchiveShelf(commit.state)
    if (!commit.commitId) return
    // The destructive delete commit is an explicit handoff: the M12 registry
    // has no dev.session.delete operation, so nothing is invented here.
    setArchiveHandoff(
      `Deleting sessions needs the ${SESSION_DELETE_OPERATION} host contract, which this build does not provide. The session stays archived and recoverable.`
    )
  }

  createEffect(() => {
    const scope = props.runtime.preferenceScope?.()
    const projectId = selectedProject()
    const runtimeSessionId = selectedSession()
    storageController?.dispose()
    storageController = undefined
    if (!scope || !props.storage || !projectId || !runtimeSessionId) return
    const controller = createLayoutStorageController({
      storage: props.storage,
      scope,
      projectId,
      runtimeSessionId,
    })
    storageController = controller
    const loaded = controller.load()
    if (loaded.state === 'ready') {
      const restored = normalizeLayout(createLayoutState<PaneLeaf>(loaded.value.center))
      setLayout({
        ...restored,
        focusedLeafId: loaded.value.focusTargetId ?? restored.focusedLeafId,
      })
      setUtilityPreferences(loaded.value.utility)
      workspaceStore.getState().setDevFocusMode(loaded.value.focusMode)
    } else {
      if (loaded.state !== 'empty')
        setAnnouncement('Stored Dev layout was unreadable and is kept for recovery.')
      setLayout(initialLayout())
      setUtilityPreferences(defaultUtilityPreferences())
      workspaceStore.getState().setDevFocusMode(false)
    }
    const visibilityChanged = () => controller.visibilityChanged(document.hidden)
    document.addEventListener('visibilitychange', visibilityChanged)
    onCleanup(() => {
      document.removeEventListener('visibilitychange', visibilityChanged)
      controller.dispose()
      if (storageController === controller) storageController = undefined
    })
  })

  onMount(() => {
    const controller = createDevKeyboardController({
      target: window,
      actions: {
        toggleFocusMode: () => {
          const next = !focusMode()
          workspaceStore.getState().setDevFocusMode(next)
          schedulePreferences()
          setAnnouncement(next ? 'Focus mode enabled' : 'Focus mode disabled')
        },
        moveFocusedPane: ({ step, direction }) => {
          const state = layout()
          const neighbor = neighborLeaf(state, state.focusedLeafId, step)
          if (!neighbor) {
            setAnnouncement('No adjacent pane to move into')
            return
          }
          const suffix = ++nextPaneId
          updateLayout((current) =>
            movePane(
              current,
              current.focusedLeafId,
              neighbor.id,
              step === 1 ? 'after' : 'before',
              direction,
              `dev-move-${suffix}`
            )
          )
          focusPaneElement(state.focusedLeafId)
          setAnnouncement('Pane moved')
        },
      },
    })
    onCleanup(() => controller.dispose())
  })

  const leftFullWidth = () => visiblePaneOf('left')?.fullWidth ?? false
  const rightFullWidth = () => visiblePaneOf('right')?.fullWidth ?? false
  // The right collapse control remains available when its pane is full width;
  // the pane's own heading owns the separate restore-width action.
  const sidebarToggleAvailable = () => props.appMode !== 'source-control'
  const sidebarToggleControl = () => {
    const open = Boolean(visiblePaneOf('right'))
    return (
      <ActionButton
        type="button"
        variant="outline"
        size="icon-sm"
        class="workspace-topbar__control"
        tooltip={open ? 'Collapse utility sidebar' : 'Expand utility sidebar'}
        aria-label={open ? 'Collapse utility sidebar' : 'Expand utility sidebar'}
        aria-expanded={open}
        onClick={toggleRightUtilitySlot}
      >
        <Show when={open} fallback={<PanelRightOpen aria-hidden="true" />}>
          <PanelRightClose aria-hidden="true" />
        </Show>
      </ActionButton>
    )
  }

  const leftUtilityToggleControl = () => {
    const open = Boolean(visiblePaneOf('left'))
    return (
      <ActionButton
        type="button"
        variant="outline"
        size="icon-sm"
        class="workspace-topbar__control"
        tooltip={open ? 'Collapse left utility sidebar' : 'Expand left utility sidebar'}
        aria-label={open ? 'Collapse left utility sidebar' : 'Expand left utility sidebar'}
        aria-expanded={open}
        onClick={() => toggleUtilityGroup(['files', 'source_control'])}
      >
        <FolderTree aria-hidden="true" />
      </ActionButton>
    )
  }

  const devPaneActions = () => (
    <Show when={props.appMode !== 'source-control'}>
      {leftUtilityToggleControl()}
      <ActionButton
        type="button"
        variant="ghost"
        size="icon-sm"
        class="workspace-topbar__control"
        tooltip="Split pane"
        aria-label="Split pane"
        disabled={countLeaves(layout().center) >= 8}
        onClick={() => {
          const suffix = ++nextPaneId
          updateLayout((state) => {
            const focused = listLeaves(state.center).find((leaf) => leaf.id === state.focusedLeafId)
            if (!focused) return state
            return splitPane(state, state.focusedLeafId, {
              direction: 'row',
              placement: 'after',
              leaf: {
                kind: 'leaf',
                id: `dev-pane-${suffix}`,
                pane: focused.pane,
                ...(focused.pane === 'editor' && focused.resourceId !== undefined
                  ? { resourceId: focused.resourceId }
                  : {}),
              },
              splitId: `dev-split-${suffix}`,
            })
          })
        }}
      >
        <Columns2 aria-hidden="true" />
      </ActionButton>
      <ActionButton
        type="button"
        variant="ghost"
        size="icon-sm"
        class="workspace-topbar__control"
        tooltip="Reopen the last closed pane in this window"
        aria-label="Reopen closed pane"
        disabled={layout().closed.length === 0}
        onClick={() => updateLayout(undoClosePane)}
      >
        <Undo2 aria-hidden="true" />
      </ActionButton>
    </Show>
  )

  return (
    <main
      class={cn('dev-workspace', {
        'dev-workspace--source-control-app': props.appMode === 'source-control',
        'dev-workspace--focus': focusMode() && props.appMode !== 'source-control',
        'dev-workspace--left-full': leftFullWidth(),
        'dev-workspace--right-full': rightFullWidth(),
      })}
    >
      <a class="dev-skip-link" href="#dev-center">
        Skip to workspace
      </a>
      <Show
        when={props.toolbarMount}
        fallback={
          <header class="dev-toolbar">
            <div
              class="dev-toolbar__actions"
              role="toolbar"
              aria-label="Developer workspace actions"
            >
              {devPaneActions()}
              <Show when={sidebarToggleAvailable() && !props.sidebarActionMount}>
                {sidebarToggleControl()}
              </Show>
            </div>
          </header>
        }
      >
        {(mount) => <Portal mount={mount()}>{devPaneActions()}</Portal>}
      </Show>
      {/* The right utility collapse action stays in the trailing global slot;
          direct hosts keep a local fallback for the runtime integration harness. */}
      <Show when={sidebarToggleAvailable() && props.sidebarActionMount}>
        {(mount) => <Portal mount={mount()}>{sidebarToggleControl()}</Portal>}
      </Show>

      <Show when={recoveryMessage()}>
        <p class="dev-recovery-banner" role="status">
          {recoveryMessage()}
        </p>
      </Show>

      <div class="dev-workspace__body">
        <DevSidebarShell
          groups={groups()}
          selectedProject={selectedProject()}
          selectedSession={selectedSession()}
          collapsedGroups={new Set(collapsedGroupIds())}
          collapsedProjects={new Set(collapsedProjectIds())}
          compactOpen={compactSidebarOpen()}
          reorder={{
            onMoveGroup: moveGroupHandler,
            onMoveProject: moveProjectHandler,
            onDropGroup: dropGroupHandler,
            onDropProject: dropProjectHandler,
          }}
          archiveShelf={archiveShelf()}
          archiveHandoffMessage={archiveHandoff()}
          addProject={
            !fixtureMode() && activeScope() ? (
              <AddProjectPanel
                scope={activeScope()!}
                execute={(command) => props.runtime.execute(command)}
                knownProjectNames={groups().flatMap((group) =>
                  group.projects.map((project) => project.name)
                )}
                onImported={() => void loadProjection()}
                announce={setAnnouncement}
              />
            ) : undefined
          }
          repoRegistry={
            !fixtureMode() && activeScope() ? (
              <Suspense fallback={<p class="dev-tree-empty">Loading repositories…</p>}>
                <RepoRegistryPanel
                  scope={activeScope()!}
                  execute={(command) => props.runtime.execute(command)}
                  announce={setAnnouncement}
                />
              </Suspense>
            ) : undefined
          }
          onArchiveRestore={(id) => void restoreFromArchive(id)}
          onArchiveRequestDelete={requestArchiveDelete}
          onArchiveCancelDelete={cancelArchiveDelete}
          onArchiveConfirmDelete={confirmArchiveDelete}
          onProjectSelect={(id) => {
            setRecoveryNotice('')
            workspaceStore.getState().setSelectedDevProjectId(id)
          }}
          onSessionSelect={(projectId, sessionId) => {
            setRecoveryNotice('')
            const store = workspaceStore.getState()
            if (store.selectedDevProjectId !== projectId) store.setSelectedDevProjectId(projectId)
            workspaceStore.getState().setSelectedRuntimeSessionId(sessionId)
          }}
          onToggleGroup={(id) => workspaceStore.getState().toggleDevGroupCollapsed(id)}
          onToggleProject={(id) => workspaceStore.getState().toggleDevProjectCollapsed(id)}
        />

        <Show when={visiblePaneOf('left')}>
          <UtilitySlot
            side="left"
            fixedPane={props.appMode === 'source-control'}
            panes={
              props.appMode === 'source-control'
                ? panesOfSide('left').filter((item) => item.pane === 'source_control')
                : panesOfSide('left')
            }
            visiblePane={visiblePaneOf('left')}
            runtime={props.runtime}
            runtimeSessionId={selectedSession() || undefined}
            sessionWorktreeId={selectedSessionWorktreeId()}
            capabilityOf={capabilityOf}
            onShow={showPane}
            onCollapse={() => collapseSide('left')}
            onToggleFullWidth={setPaneFullWidth}
            onResize={setPaneSize}
            onOpenFile={openFileInEditorLeaf}
          />
        </Show>
        <Show when={visiblePaneOf('left') && !leftFullWidth()}>
          <UtilitySplitter
            side="left"
            size={visiblePaneOf('left')!.size}
            onResize={(size) => setPaneSize(visiblePaneOf('left')!.pane, size)}
          />
        </Show>

        <section
          class="dev-center"
          id="dev-center"
          aria-label="Developer workspace panes"
          tabIndex={-1}
        >
          <Suspense fallback={<p class="dev-pane-state__line">Loading workspace panes…</p>}>
            <DevLayoutView
              state={layout()}
              unavailable={runtimeState().status === 'unavailable'}
              renderTerminalLeaf={(leaf) => {
                if (import.meta.env.DEV && FixtureTerminalPane && fixtureMode())
                  return (
                    <Suspense fallback={<p class="dev-pane-state__line">Loading test terminal…</p>}>
                      <FixtureTerminalPane
                        connect={createFixtureTerminalConnect()}
                        fromSequence="0"
                        subscribeToObservations={fixtureTerminalObservations}
                        write={() => true}
                        worktreeLabel="Example project"
                      />
                    </Suspense>
                  )

                const scope = activeScope()
                const runtimeSessionId = selectedSession()
                const worktreeId = selectedSessionWorktreeId()
                if (!scope)
                  return (
                    <p class="dev-pane-state__line" role="status" data-state="unavailable">
                      Terminal access requires an authenticated runtime scope.
                    </p>
                  )
                if (!runtimeSessionId)
                  return (
                    <p class="dev-pane-state__line" role="status" data-state="unavailable">
                      No live runtime session is selected.
                    </p>
                  )
                if (!worktreeId)
                  return (
                    <p class="dev-pane-state__line" role="status" data-state="unavailable">
                      The selected session has no worktree binding.
                    </p>
                  )

                const terminalId =
                  leaf.resourceId !== undefined
                    ? leaf.resourceId
                    : firstUnboundTerminalLeafId() === leaf.id
                      ? selectedSessionRecord()?.terminalId
                      : undefined

                return (
                  <Suspense fallback={<p class="dev-pane-state__line">Loading terminal…</p>}>
                    <RuntimeTerminalPane
                      runtime={props.runtime}
                      scope={scope}
                      runtimeSessionId={runtimeSessionId}
                      worktreeId={worktreeId}
                      terminalId={terminalId}
                      worktreeLabel={selectedProjectLabel()}
                      capabilityStatus={capabilitySnapshotStatus()}
                      canAttach={capabilities().get('dev.terminal.attach')?.granted}
                      canInput={capabilities().get('dev.terminal.input')?.granted}
                      canManage={capabilities().get('dev.terminal.manage')?.granted}
                    />
                  </Suspense>
                )
              }}
              renderEditorLeaf={() => {
                const file = activeEditorFile()
                if (!file) return undefined
                const scope = props.runtime.preferenceScope?.()
                if (!scope) return undefined
                return (
                  <Suspense fallback={<p class="dev-pane-state__line">Loading editor…</p>}>
                    <CodeEditor
                      runtime={props.runtime}
                      worktree={{
                        worktreeId: file.worktreeId,
                        generation: file.generation,
                        rootIdentity: file.rootIdentity,
                      }}
                      relativePath={file.relativePath}
                      identity={file.identity}
                      onClose={() => setActiveEditorFile(undefined)}
                    />
                  </Suspense>
                )
              }}
              onClose={(leafId) => {
                let nextFocusId = layout().focusedLeafId
                updateLayout((state) => {
                  const next = closePane(state, leafId, () => `dev-placeholder-${++nextPaneId}`)
                  nextFocusId = next.focusedLeafId
                  return next
                })
                focusPaneElement(nextFocusId)
                return nextFocusId
              }}
              onFocus={(leafId) => updateLayout((state) => focusPane(state, leafId))}
              onResize={(splitId, ratio) =>
                updateLayout((state) => resizeSplit(state, splitId, Math.round(ratio * 20) / 20))
              }
              onMoveTo={(leafId, targetLeafId, placement, direction) => {
                const suffix = ++nextPaneId
                updateLayout((state) =>
                  movePane(state, leafId, targetLeafId, placement, direction, `dev-move-${suffix}`)
                )
                focusPaneElement(leafId)
                setAnnouncement('Pane moved')
              }}
            />
          </Suspense>
        </section>

        <Show when={visiblePaneOf('right') && !rightFullWidth()}>
          <UtilitySplitter
            side="right"
            size={visiblePaneOf('right')!.size}
            onResize={(size) => setPaneSize(visiblePaneOf('right')!.pane, size)}
          />
        </Show>
        <Show when={visiblePaneOf('right')}>
          <UtilitySlot
            side="right"
            fixedPane={props.appMode === 'source-control'}
            panes={
              props.appMode === 'source-control'
                ? panesOfSide('right').filter((item) => item.pane === 'source_control')
                : panesOfSide('right')
            }
            visiblePane={visiblePaneOf('right')}
            runtime={props.runtime}
            runtimeSessionId={selectedSession() || undefined}
            sessionWorktreeId={selectedSessionWorktreeId()}
            capabilityOf={capabilityOf}
            onShow={showPane}
            onOpenFile={openFileInEditorLeaf}
            onCollapse={() => collapseSide('right')}
            onToggleFullWidth={setPaneFullWidth}
            onResize={setPaneSize}
          />
        </Show>
      </div>
      <p class="sr-only" aria-live="polite">
        {announcement()}
      </p>
    </main>
  )
}

function UtilitySplitter(props: {
  side: 'left' | 'right'
  size: number
  onResize(size: number): void
}) {
  const resizeFromPointer = (startX: number, startSize: number) => (event: PointerEvent) => {
    const delta = props.side === 'right' ? startX - event.clientX : event.clientX - startX
    props.onResize(startSize + delta)
  }
  return (
    <Button
      type="button"
      class={cn('dev-utility-splitter', {
        'dev-utility-splitter--left': props.side === 'left',
        'dev-utility-splitter--right': props.side === 'right',
      })}
      role="separator"
      aria-label={`Resize ${props.side} utility pane`}
      aria-orientation="vertical"
      aria-valuemin={utilitySizeSteps[0]}
      aria-valuemax={utilitySizeSteps[utilitySizeSteps.length - 1]}
      aria-valuenow={props.size}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId)
        const startX = event.clientX
        const startSize = props.size
        const move = resizeFromPointer(startX, startSize)
        const done = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', done)
          window.removeEventListener('pointercancel', done)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', done, { once: true })
        window.addEventListener('pointercancel', done, { once: true })
      }}
      onKeyDown={(event) => {
        const grows = props.side === 'left' ? event.key === 'ArrowRight' : event.key === 'ArrowLeft'
        const shrinks =
          props.side === 'left' ? event.key === 'ArrowLeft' : event.key === 'ArrowRight'
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') return
        if (!grows && !shrinks) return
        event.preventDefault()
        props.onResize(props.size + (grows ? 48 : -48))
      }}
    />
  )
}

/**
 * Truthful per-pane provider state: real panes mount where a provider
 * contract exists (browser/devices); panes whose UI surface is owned by
 * another slice name their capability and its exact state — never a generic
 * placeholder.
 */
function PaneProviderState(props: {
  title: string
  capability: DevCapability
  state?: { granted: boolean; reason?: string }
}) {
  return (
    <div class="dev-pane-state">
      <p class="dev-pane-state__line">
        <Show
          when={props.state}
          fallback={`Requires ${props.capability}, which has not been reported by this provider yet.`}
        >
          <Show
            when={props.state!.granted}
            fallback={`${props.title} requires ${props.capability}, which is unavailable${
              props.state!.reason ? ` (${props.state!.reason})` : ''
            }.`}
          >
            {`${props.title} is connected through ${props.capability}. This pane's interactive surface is delivered by its owning provider slice.`}
          </Show>
        </Show>
      </p>
    </div>
  )
}

function UtilitySlot(props: {
  fixedPane?: boolean
  side: 'left' | 'right'
  panes: readonly DevUtilityPreference[]
  visiblePane: DevUtilityPreference | undefined
  runtime: DevRuntimeService
  runtimeSessionId: string | undefined
  /**
   * The selected session's own worktree, so the Files and Source Control
   * panes act on the worktree the session belongs to rather than the first
   * ready one on the node.
   */
  sessionWorktreeId: string | undefined
  capabilityOf(pane: DevUtilityPane): { granted: boolean; reason?: string } | undefined
  onShow(pane: DevUtilityPane): void
  onOpenFile(file: {
    worktreeId: string
    generation: number
    rootIdentity: { device?: string; inode?: string; mtimeNs: string; size: string }
    relativePath: string
    identity: {
      device?: string
      inode?: string
      birthtimeNs?: string
      mtimeNs: string
      size: string
      contentSha256?: string
    }
  }): void
  onCollapse(): void
  onToggleFullWidth(pane: DevUtilityPane, fullWidth: boolean): void
  onResize(pane: DevUtilityPane, size: number): void
}) {
  const sideLabel = () => (props.side === 'left' ? 'Left' : 'Right')
  const visibleItem = () =>
    props.visiblePane ? utilityItemByPane.get(props.visiblePane.pane) : undefined
  const runtimeReady = () => props.runtime.state().status === 'ready'
  const tabKeyDown = (event: KeyboardEvent, currentPane: DevUtilityPane) => {
    const panes = props.panes.map((entry) => entry.pane)
    const current = panes.indexOf(currentPane)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? panes.length - 1
          : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
            ? (current - 1 + panes.length) % panes.length
            : event.key === 'ArrowDown' || event.key === 'ArrowRight'
              ? (current + 1) % panes.length
              : -1
    if (next < 0) return
    event.preventDefault()
    const nextPane = panes[next]!
    props.onShow(nextPane)
    document.getElementById(`dev-utility-tab-${props.side}-${nextPane}`)?.focus()
  }
  const paneBody = (pane: DevUtilityPane) => {
    if (pane === 'browser') {
      return runtimeReady() ? (
        <BrowserPane runtime={props.runtime} runtimeSessionId={props.runtimeSessionId} />
      ) : (
        <PaneProviderState
          title="Browser"
          capability={PANE_CAPABILITY[pane]}
          state={props.capabilityOf(pane)}
        />
      )
    }
    if (pane === 'devices') {
      return runtimeReady() ? (
        <DevicesPane runtime={props.runtime} runtimeSessionId={props.runtimeSessionId} />
      ) : (
        <PaneProviderState
          title="Devices"
          capability={PANE_CAPABILITY[pane]}
          state={props.capabilityOf(pane)}
        />
      )
    }
    // #424 + #400: the Agents pane carries the harness status surface (the
    // session's run state, default harness, and preference rows) above the
    // Activity section (running harness runs, attention states, elapsed time,
    // and stop controls). History mounts its bounded run-history rows; both
    // keep their provider-state fallback when the runtime is unavailable.
    if (pane === 'agents') {
      return runtimeReady() ? (
        <Suspense
          fallback={
            <PaneProviderState
              title="Agents"
              capability={PANE_CAPABILITY[pane]}
              state={props.capabilityOf(pane)}
            />
          }
        >
          <HarnessStatusSection runtime={props.runtime} runtimeSessionId={props.runtimeSessionId} />
          <ActivityPane runtime={props.runtime} runtimeSessionId={props.runtimeSessionId} />
        </Suspense>
      ) : (
        <PaneProviderState
          title="Agents"
          capability={PANE_CAPABILITY[pane]}
          state={props.capabilityOf(pane)}
        />
      )
    }
    if (pane === 'history') {
      return runtimeReady() ? (
        <Suspense
          fallback={
            <PaneProviderState
              title="History"
              capability={PANE_CAPABILITY[pane]}
              state={props.capabilityOf(pane)}
            />
          }
        >
          <RunHistorySection runtime={props.runtime} runtimeSessionId={props.runtimeSessionId} />
        </Suspense>
      ) : (
        <PaneProviderState
          title="History"
          capability={PANE_CAPABILITY[pane]}
          state={props.capabilityOf(pane)}
        />
      )
    }
    if (pane === 'files') {
      return runtimeReady() ? (
        <FilesPane
          runtime={props.runtime}
          worktreeId={props.sessionWorktreeId}
          onOpenFile={props.onOpenFile}
        />
      ) : (
        <PaneProviderState
          title="Files"
          capability={PANE_CAPABILITY[pane]}
          state={props.capabilityOf(pane)}
        />
      )
    }
    if (pane === 'source_control') {
      return runtimeReady() ? (
        <SourceControlPane
          runtime={props.runtime}
          runtimeSessionId={props.runtimeSessionId}
          worktreeId={props.sessionWorktreeId}
        />
      ) : (
        <PaneProviderState
          title="Source Control"
          capability={PANE_CAPABILITY[pane]}
          state={props.capabilityOf(pane)}
        />
      )
    }
    return (
      <PaneProviderState
        title={utilityItemByPane.get(pane)!.title}
        capability={PANE_CAPABILITY[pane]}
        state={props.capabilityOf(pane)}
      />
    )
  }
  return (
    <aside
      class={cn('dev-utility', {
        'dev-utility--left': props.side === 'left',
        'dev-utility--right': props.side === 'right',
        'dev-utility--open': Boolean(props.visiblePane),
        'dev-utility--size-240': props.visiblePane?.size === 240,
        'dev-utility--size-336': props.visiblePane?.size === 336,
        'dev-utility--size-384': props.visiblePane?.size === 384,
      })}
      aria-label={`Developer utilities (${sideLabel().toLowerCase()})`}
    >
      {/* oxlint-disable-next-line adea/no-interactive-wrappers -- pane-closed state awaits the shared Tabs adoption */}
      <div class="dev-utility-tabs" role="tablist" aria-label={`${sideLabel()} utility panes`}>
        <For each={props.panes}>
          {(item) => {
            const meta = utilityItemByPane.get(item.pane)!
            const selected = () => props.visiblePane?.pane === item.pane
            return (
              <Button
                type="button"
                id={`dev-utility-tab-${props.side}-${item.pane}`}
                role="tab"
                aria-selected={selected()}
                aria-controls={`dev-utility-panel-${props.side}`}
                tabIndex={selected() ? 0 : -1}
                title={meta.title}
                class={cn('dev-utility-tab', {
                  'dev-utility-tab--selected': selected(),
                })}
                onClick={() => props.onShow(item.pane)}
                onKeyDown={(event) => tabKeyDown(event, item.pane)}
              >
                <meta.icon aria-hidden="true" />
                <span>{meta.label}</span>
              </Button>
            )
          }}
        </For>
      </div>
      {/* oxlint-disable-next-line adea/no-interactive-wrappers -- pane-closed state awaits the shared Tabs adoption */}
      <div
        id={`dev-utility-panel-${props.side}`}
        role="tabpanel"
        aria-labelledby={`dev-utility-tab-${props.side}-${props.visiblePane?.pane ?? ''}`}
        class="dev-utility-panel"
      >
        <div class="dev-utility-panel__heading">
          <h2>{visibleItem()?.title}</h2>
          <Show when={!props.fixedPane}>
            <ActionButton
              type="button"
              variant="outline"
              size="icon-sm"
              tooltip={
                props.visiblePane?.fullWidth ? 'Restore utility pane' : 'Expand utility pane'
              }
              aria-label={
                props.visiblePane?.fullWidth ? 'Restore utility pane' : 'Expand utility pane'
              }
              aria-pressed={props.visiblePane?.fullWidth ?? false}
              onClick={() =>
                props.onToggleFullWidth(props.visiblePane!.pane, !props.visiblePane!.fullWidth)
              }
            >
              <Maximize2 aria-hidden="true" />
            </ActionButton>
            <ActionButton
              type="button"
              variant="outline"
              size="icon-sm"
              tooltip={`Collapse ${sideLabel().toLowerCase()} utility slot`}
              aria-label={`Collapse ${sideLabel().toLowerCase()} utility slot`}
              onClick={props.onCollapse}
            >
              <X aria-hidden="true" />
            </ActionButton>
          </Show>
        </div>
        <Suspense fallback={<p class="dev-pane-state__line">Loading pane…</p>}>
          {paneBody(props.visiblePane!.pane)}
        </Suspense>
      </div>
    </aside>
  )
}
