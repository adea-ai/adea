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
import { useWorkspaceState, workspaceStore, wideViewportAtLoad } from '@adea-ai/state'
import type {
  DevCapability,
  DevUtilityPane,
  DevUtilityPreference,
  DevStreamFrame,
  PaneLeaf,
  Scope,
} from '@adea-ai/types/dev-runtime'
import '@adea-ai/app-ui/dev-view.css'
import { cn } from '@adea-ai/app-ui/lib/utils'
import {
  Columns2,
  FolderTree,
  GitBranch,
  Maximize2,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
  SquareX,
  Undo2,
  X,
} from 'lucide-solid'
import {
  Show,
  Suspense,
  createEffect,
  createMemo,
  createSignal,
  lazy,
  onCleanup,
  onMount,
  untrack,
} from 'solid-js'
import { Portal } from 'solid-js/web'

import { createDevKeyboardController } from './keyboard'
import { SelectProjectEmptyState } from './select-project-empty'
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
  splitPaneBalanced,
  splitPaneDisabled,
  undoClosePane,
  movePane,
  type DevLayoutState,
} from './layout/operations'
import type { LayoutStorage } from './layout/storage'
import type { DevProjectNames, DevRuntimeService, DevWorkspaceProjection } from './platform'
import type { CanonicalRuntimeBinding } from './utility-context'
import { createSharedDevUtilityOwner, type SharedDevUtilityOwner } from './utility-owner'
import { defaultLeftUtilitySize, utilityPaneById } from './utility-preferences'
import { UtilityResizeHandle } from './utility-resize-handle'
import type { TerminalStreamSocket } from './terminal/transport'
import type { ShellObservation } from './terminal/blocks'
import { resolveDevSelection, type DevSelection, type DevSelectionReason } from './selection'
import { ArchiveShelf } from './sidebar/archive-shelf'
import { devBindingsFromProjection, type DevNavBinding } from './sidebar/dev-nav-model'
import { DevWorkspaceSidebar, type DevWorkspaceNavHost } from './sidebar/dev-workspace-sidebar'
import { Button } from '@adea-ai/ui/components/ui/button'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { ButtonGroup } from '@adea-ai/ui/components/ui/button-group'

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

/** The sidebar's display model for one bound project. `name` is the display
 *  label: the host-supplied cloud project name, or the short project id.
 *  Fixtures also carry their worktree records (checkout first). */
export type DevProjectFixture = DevNavBinding

/** A URL-owning host's current deep-link request (`?devProject=`/`?devSession=`). */
export type DevWorkspaceDeepLinkSelection = Readonly<{
  projectId?: string
  sessionId?: string
}>

export type DevWorkspaceEntryProps = Readonly<{
  runtime: DevRuntimeService
  /** Optional shell-owned utility identity shared with Chat/Virtual surfaces. */
  utilityOwner?: SharedDevUtilityOwner
  /** The global shell owns the right host and its toolbar control. */
  utilityHostOwnedByShell?: boolean
  /** E2E/development fixtures only; production consumes the runtime projection. */
  projects?: readonly DevProjectFixture[]
  /**
   * Display names keyed by cloud project id. The register stores only local
   * bindings; names come from the cloud project list the host already holds.
   * Absent entries render the short project id.
   */
  projectNames?: DevProjectNames
  storage?: LayoutStorage
  toolbarMount?: HTMLElement
  /**
   * Mount for the bundled utility sidebar's top-bar toggle, placed after the
   * host's own actions so the control is the top bar's trailing icon. Absent
   * hosts render it inside the Dev toolbar instead.
   */
  sidebarActionMount?: HTMLElement
  /** Global contextual-sidebar toggle to restore focus after mobile dismissal. */
  sidebarOpener?: () => HTMLElement | undefined
  /**
   * The router's deep-link request, handed over by the URL-owning host. A
   * present param wins over the store's corresponding field, so a link (or a
   * back/forward step) re-requests its selection while a param the host has
   * not written leaves the store in charge. Absent hosts run on the store.
   */
  deepLinkSelection?: () => DevWorkspaceDeepLinkSelection | undefined
  /**
   * Reports the resolved selection whenever it changes, so the URL-owning
   * host can converge the address bar with one guarded navigation (write
   * only when it actually differs) and presentation hints can follow the
   * resolution. Pairs with `deepLinkSelection`; neither side mirrors the
   * other through effects.
   */
  onSelectionChange?: (
    selection: Readonly<{
      projectId: string
      sessionId: string | null
    }>
  ) => void
  /**
   * Reports the selected project's name and checked-out branch for the host's
   * top-bar breadcrumbs, and `undefined` while nothing is selected or once Dev
   * unmounts. Presentation only: branch names stay on the client.
   */
  onBreadcrumbChange?: (
    crumb: Readonly<{ projectId: string; projectName: string; branch?: string }> | undefined
  ) => void
  /**
   * The cloud workspace the sidebar renders (ADR 0011): workspaces, the
   * project list the local bindings join by id, cross-workspace counts and
   * the cloud project mutations. Absent hosts render the bindings alone.
   */
  workspaceNav?: DevWorkspaceNavHost
}>

export { devViewFixtureProjects } from './sidebar/fixture-scale'

/** The read capability each utility pane depends on for its provider state. */
const PANE_CAPABILITY: Record<DevUtilityPane, DevCapability> = {
  files: 'dev.files.read',
  source_control: 'dev.git.read',
  browser: 'dev.browser.read',
  devices: 'dev.device.read',
  agents: 'dev.session.read',
  history: 'dev.session.read',
}

/** Every pane opens at one shared width — no custom width per tab type. */

const initialLayout = () =>
  createLayoutState<PaneLeaf>({
    kind: 'leaf',
    id: 'dev-terminal',
    pane: 'terminal',
  })

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

// The standalone fallback uses the same lazy host as the global shell without
// downloading its right-side chrome when Dev is mounted inside that shell.
const SharedDevUtilityHost = lazy(() =>
  import('./utility-host').then((module) => ({ default: module.SharedDevUtilityHost }))
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
  const utilityOwner =
    props.utilityOwner ?? createSharedDevUtilityOwner(props.runtime, props.storage)
  if (!props.utilityHostOwnedByShell) utilityOwner.setView('dev')
  if (!props.utilityOwner) onCleanup(() => utilityOwner.dispose())
  let nextPaneId = 0
  const fixtureTerminalObservations = import.meta.env.DEV
    ? createFixtureTerminalObservations()
    : undefined
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
  const [projection, setProjection] = createSignal<DevWorkspaceProjection | undefined>()
  // Production renders the authoritative flat projection with host-supplied
  // names; fixture mode renders the readonly E2E input as given.
  // Names come from the host's cloud project list; an explicit map wins.
  const projectNames = createMemo(
    () =>
      props.projectNames ??
      (props.workspaceNav?.projects
        ? new Map(props.workspaceNav.projects.map((project) => [project.id, project.name]))
        : undefined)
  )
  const projectedProjects = createMemo(() => {
    const current = projection()
    return current ? devBindingsFromProjection(current, projectNames()) : []
  })
  const projects = () => props.projects ?? projectedProjects()
  const selectedProjectState = useWorkspaceState((state) => state.selectedDevProjectId)
  const selectedSessionState = useWorkspaceState((state) => state.selectedRuntimeSessionId)
  // The effective selection request: a present deep-link param wins over the
  // store's field, per field. An empty param value counts as absent, matching
  // the URLSearchParams semantics the host hands over.
  const deepLinkRequest = () => {
    const request = props.deepLinkSelection?.()
    if (!request) return undefined
    const projectId = request.projectId || undefined
    const sessionId = request.sessionId || undefined
    if (!projectId && !sessionId) return undefined
    return { projectId, sessionId }
  }
  const requestedProjectId = () => deepLinkRequest()?.projectId ?? selectedProjectState()
  const requestedSessionId = () => {
    const request = deepLinkRequest()
    // A deep-linked project request switches projects, so it resets the
    // session request exactly like a sidebar project switch does; a
    // session-only link refines the active project.
    if (request?.projectId) return request.sessionId ?? null
    return request?.sessionId ?? selectedSessionState()
  }
  const focusMode = useWorkspaceState((state) => state.devFocusMode)
  const compactSidebarOpen = useWorkspaceState((state) => state.mobileSidebarOpen)
  const utilityPreferences = utilityOwner.utilityPreferences
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
  /**
   * A latched recovery notice: set the first time a requested selection needs
   * recovery, kept visible across the URL/store convergence, and cleared only
   * when the user makes an explicit selection.
   */
  const [recoveryNotice, setRecoveryNotice] = createSignal('')
  // The right utility slot's panes share one bundled sidebar, so its single
  // top-bar toggle reopens the pane that was visible before the collapse.
  const [runtimeBindingReady, setRuntimeBindingReady] = createSignal(false)
  const runtimeState = createMemo(() => props.runtime.state())
  const fixtureMode = () => props.projects !== undefined

  const activeScope = () => props.runtime.preferenceScope?.()

  /** Production path: the authoritative projection, reloaded on demand. */
  const loadProjection = async () => {
    if (props.projects !== undefined) return
    const scope = activeScope()
    if (!scope || !props.runtime.projection) return
    try {
      setProjection(await props.runtime.projection(scope))
    } catch {
      setProjection(undefined)
    }
  }

  onMount(() => {
    if (props.projects !== undefined) {
      utilityOwner.setArchiveShelfFixture(
        props.projects.flatMap((project) =>
          project.sessions
            .filter((session) => session.state === 'archived')
            .map((session) => ({
              id: session.id,
              projectId: project.id,
              title: session.title,
              archivedAt: 'fixture',
              ...(typeof session.generation === 'number' ? { generation: session.generation } : {}),
            }))
        )
      )
      return
    }
    const ready = props.runtime.ready
    if (ready) {
      void ready.then(() => {
        setRuntimeBindingReady(true)
        void utilityOwner.refreshArchiveShelf()
        return loadProjection()
      })
    } else {
      setRuntimeBindingReady(true)
      void utilityOwner.refreshArchiveShelf()
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
      projects: projects().map((project) => ({
        id: project.id,
        sessions: project.sessions.map((session) => ({
          id: session.id,
          archived: session.state === 'archived',
          generation: session.generation,
        })),
      })),
      requestedProjectId: requestedProjectId(),
      requestedSessionId: requestedSessionId(),
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
  const selectedSessionRecord = createMemo(() => {
    const sessionId = selectedSession()
    if (!sessionId) return undefined
    // The record comes from the same list the selection resolved against, so
    // fixture mounts (no runtime projection) still publish a canonical
    // binding with the session's generation.
    for (const project of projects())
      for (const session of project.sessions) if (session.id === sessionId) return session
    return undefined
  })
  const selectedSessionWorktreeId = createMemo(
    () => selectedSessionRecord()?.worktreeId || undefined
  )
  const selectedProjectLabel = createMemo(() => {
    const projectId = selectedProject()
    if (!projectId) return undefined
    return projects().find((project) => project.id === projectId)?.name
  })
  // The top bar's Workspace › Project › branch path follows the sidebar's
  // selected leaf: its project and the branch that leaf has checked out.
  const [selectedBreadcrumb, setSelectedBreadcrumb] = createSignal<
    Readonly<{ projectId: string; projectName: string; branch?: string }> | undefined
  >(undefined, {
    equals: (previous, next) =>
      previous?.projectId === next?.projectId &&
      previous?.projectName === next?.projectName &&
      previous?.branch === next?.branch,
  })
  createEffect(() => props.onBreadcrumbChange?.(selectedBreadcrumb()))
  onCleanup(() => props.onBreadcrumbChange?.(undefined))
  const selectedCanonicalBinding = (): CanonicalRuntimeBinding | undefined => {
    const current = selection()
    const scope = activeScope()
    const session = selectedSessionRecord()
    const projectId = current.status === 'empty' ? undefined : current.projectId
    const generation = session?.generation
    if (!scope || !projectId || !session || !Number.isSafeInteger(generation) || generation! < 1)
      return undefined
    return {
      scope,
      projectId,
      runtimeSessionId: session.id,
      sessionGeneration: generation!,
      worktreeId: session.worktreeId,
    }
  }
  createEffect(() => {
    utilityOwner.selectDevSession(selectedCanonicalBinding())
  })
  const recoveryMessage = () => recoveryNotice()

  createEffect(() => {
    // A defaulting mount (no requested IDs) is silent; recovery notices apply
    // only when a stored or deep-linked selection actually failed to resolve.
    const hadRequest = Boolean(requestedProjectId() || requestedSessionId())
    const result = selection()
    if (result.status !== 'recovered') return
    if (hadRequest) {
      // Latch the visible notice before the reporting effect below records
      // the corrected selection, so the banner cannot unmount in the same
      // tick it appeared.
      if (!recoveryNotice()) setRecoveryNotice(RECOVERY_COPY[result.reason])
      setAnnouncement(RECOVERY_COPY[result.reason])
    }
  })

  // The Dev selection family in the shared store is this surface's own record
  // of what it resolved; Dev View is its single writer (sidebar picks,
  // recovery, and this reporting pass for deep-linked requests). The host
  // receives the same report so a URL-owning shell converges the address bar
  // with one guarded navigation, and presentation consumers (resources
  // control, desktop chat hints) keep reading the store.
  createEffect(() => {
    const result = selection()
    if (result.status === 'empty') return
    // A project_empty recovery keeps the requested session record — the
    // selection did not move to a live session.
    const sessionId = result.runtimeSessionId || requestedSessionId() || null
    untrack(() => {
      const store = workspaceStore.getState()
      if (store.selectedDevProjectId !== result.projectId)
        store.setSelectedDevProjectId(result.projectId)
      if (sessionId && store.selectedRuntimeSessionId !== sessionId)
        store.setSelectedRuntimeSessionId(sessionId)
      props.onSelectionChange?.({ projectId: result.projectId, sessionId })
    })
  })

  const visiblePaneOf = (side: 'left' | 'right') =>
    utilityPreferences().find((item) => item.side === side && item.visible)
  const panesOfSide = (side: 'left' | 'right') =>
    utilityPreferences()
      .filter((item) => item.side === side)
      .toSorted((first, second) => first.order - second.order)

  const schedulePreferences = (state = layout()) => {
    const expected = selectedCanonicalBinding()
    utilityOwner.updateLayoutPreferences(
      {
        center: state.center,
        focusMode: focusMode(),
        focusTargetId: state.focusedLeafId,
      },
      expected ?? null
    )
  }
  const updateLayout = (update: (state: DevLayoutState) => DevLayoutState) => {
    const next = update(layout())
    setLayout(next)
    schedulePreferences(next)
    return next
  }
  const showPane = (pane: DevUtilityPane) => {
    utilityOwner.showUtilityPane(pane, selectedCanonicalBinding() ?? null)
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
  /** The open editor file's path, when it belongs to the given worktree —
   *  the Files tree marks that row with the shared selected affordance. */
  const openEditorPathFor = (worktreeId: string | undefined): string | undefined => {
    const file = activeEditorFile()
    return file !== undefined && file.worktreeId === worktreeId ? file.relativePath : undefined
  }
  const collapseSide = (side: 'left' | 'right', options: { focusCenter?: boolean } = {}) => {
    const expected = selectedCanonicalBinding() ?? null
    if (side === 'right') utilityOwner.collapseRightUtility(expected)
    else
      utilityOwner.updateUtilityPreferences(
        (items) => items.map((item) => (item.side === side ? { ...item, visible: false } : item)),
        expected
      )
    setAnnouncement(`${side === 'left' ? 'Left' : 'Right'} utility slot collapsed`)
    if (options.focusCenter !== false) {
      requestAnimationFrame(() => document.getElementById('dev-center')?.focus())
    }
  }
  /** One-click toolbar toggle: opens the group, switches to it, or collapses. */
  const toggleUtilityGroup = (panes: readonly DevUtilityPane[]) => {
    const side = utilityPaneById.get(panes[0]!)!.side
    const current = visiblePaneOf(side)
    if (!current) {
      showPane(panes[0]!)
      setAnnouncement(`${side === 'left' ? 'Left' : 'Right'} utility slot opened`)
      return
    }
    if (panes.includes(current.pane)) {
      collapseSide(side, { focusCenter: false })
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
    utilityOwner.toggleRightUtility(selectedCanonicalBinding() ?? null)
    setAnnouncement('Right utility slot opened')
  }
  const setPaneFullWidth = (pane: DevUtilityPane, fullWidth: boolean) => {
    utilityOwner.setUtilityPaneFullWidth(pane, fullWidth, selectedCanonicalBinding() ?? null)
  }
  const setPaneSize = (pane: DevUtilityPane, size: number) => {
    utilityOwner.setUtilityPaneSize(pane, size, selectedCanonicalBinding() ?? null)
  }

  const restoreFromArchive = async (runtimeSessionId: string) => {
    if (!(await utilityOwner.restoreArchivedSession(runtimeSessionId))) return
    setAnnouncement(
      fixtureMode() ? 'Archived session restored (fixtures)' : 'Archived session restored'
    )
    await loadProjection()
  }

  let restoredPreferenceRevision = 0
  createEffect(() => {
    const revision = utilityOwner.layoutLoadRevision()
    if (revision === 0 || revision === restoredPreferenceRevision) return
    const saved = utilityOwner.preferences()
    if (!saved) return
    const scope = activeScope()
    if (
      !scope ||
      !sameRuntimeScope(saved.scope, scope) ||
      saved.projectId !== selectedProject() ||
      saved.runtimeSessionId !== selectedSession()
    )
      return
    restoredPreferenceRevision = revision
    const loadState = utilityOwner.layoutLoadState()
    if (loadState === 'corrupt' || loadState === 'unsupported')
      setAnnouncement('Stored Dev layout was unreadable and is kept for recovery.')
    const restored = normalizeLayout(createLayoutState<PaneLeaf>(saved.center))
    setLayout({
      ...restored,
      focusedLeafId: saved.focusTargetId ?? restored.focusedLeafId,
    })
    workspaceStore.getState().setDevFocusMode(saved.focusMode)
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
  let rightUtilityOpener: HTMLButtonElement | undefined
  /** Registered by the sidebar's "New project" flow; center-pane empty states
   *  use it to start adding a project (no-op without a runtime scope). */
  let openAddProjectPanel: (() => void) | undefined
  const addProjectFromEmptyState = () => openAddProjectPanel?.()
  const sidebarToggleControl = () => {
    // Captures visiblePaneOf from the component scope.
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const open = () => Boolean(visiblePaneOf('right'))
    return (
      <ActionButton
        ref={(element) => {
          rightUtilityOpener = element
        }}
        type="button"
        variant="toolbar"
        size="icon-sm"
        data-expanded={open() ? '' : undefined}
        tooltip={open() ? 'Collapse utility sidebar' : 'Expand utility sidebar'}
        aria-label={open() ? 'Collapse utility sidebar' : 'Expand utility sidebar'}
        aria-expanded={open()}
        onClick={toggleRightUtilitySlot}
      >
        <Show when={open()} fallback={<PanelRightOpen aria-hidden="true" />}>
          <PanelRightClose aria-hidden="true" />
        </Show>
      </ActionButton>
    )
  }

  const leftUtilityToggleControl = () => {
    // Captures visiblePaneOf from the component scope.
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const open = () => Boolean(visiblePaneOf('left'))
    return (
      <ActionButton
        type="button"
        variant="toolbar"
        size="icon-sm"
        data-expanded={open() ? '' : undefined}
        tooltip={open() ? 'Collapse left utility sidebar' : 'Expand left utility sidebar'}
        aria-label={open() ? 'Collapse left utility sidebar' : 'Expand left utility sidebar'}
        aria-expanded={open()}
        onClick={() => toggleUtilityGroup(['files', 'source_control'])}
      >
        <FolderTree aria-hidden="true" />
      </ActionButton>
    )
  }

  const devPaneActions = () => (
    <>
      {leftUtilityToggleControl()}
      <ActionButton
        type="button"
        variant="ghost"
        size="icon-sm"
        tooltip="Split pane"
        aria-label="Split pane"
        disabled={splitPaneDisabled(countLeaves(layout().center), selectedProject())}
        onClick={() => {
          const suffix = ++nextPaneId
          updateLayout((state) => {
            const focused = listLeaves(state.center).find((leaf) => leaf.id === state.focusedLeafId)
            if (!focused) return state
            return splitPaneBalanced(state, state.focusedLeafId, {
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
        data-close-all=""
        tooltip="Close all panes"
        aria-label="Close all panes"
        disabled={countLeaves(layout().center) <= 1}
        onClick={() => {
          let nextFocusId = layout().focusedLeafId
          updateLayout((state) => {
            let next = state
            for (const leaf of listLeaves(next.center)) {
              next = closePane(next, leaf.id, () => `dev-placeholder-${++nextPaneId}`)
            }
            nextFocusId = next.focusedLeafId
            return next
          })
          setActiveEditorFile(undefined)
          focusPaneElement(nextFocusId)
          setAnnouncement('All panes closed')
        }}
      >
        <SquareX aria-hidden="true" />
      </ActionButton>
      <ActionButton
        type="button"
        variant="ghost"
        size="icon-sm"
        tooltip="Reopen the last closed pane in this window"
        aria-label="Reopen closed pane"
        disabled={layout().closed.length === 0}
        onClick={() => updateLayout(undoClosePane)}
      >
        <Undo2 aria-hidden="true" />
      </ActionButton>
    </>
  )

  return (
    <main
      class={cn('dev-workspace', {
        'dev-workspace--focus': focusMode(),
        'dev-workspace--left-full': leftFullWidth(),
        'dev-workspace--right-full': !props.utilityHostOwnedByShell && rightFullWidth(),
      })}
    >
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
              <Show when={!props.utilityHostOwnedByShell && !props.sidebarActionMount}>
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
      <Show when={!props.utilityHostOwnedByShell && props.sidebarActionMount}>
        {(mount) => <Portal mount={mount()}>{sidebarToggleControl()}</Portal>}
      </Show>

      <Show when={recoveryMessage()}>
        <p class="dev-recovery-banner" role="status">
          {recoveryMessage()}
        </p>
      </Show>

      <div class="dev-workspace__body">
        <DevWorkspaceSidebar
          runtime={props.runtime}
          scope={fixtureMode() ? undefined : activeScope()}
          fixture={fixtureMode()}
          bindings={projects()}
          host={props.workspaceNav}
          projectNames={projectNames()}
          selectedProjectId={selectedProject()}
          selectedSessionId={selectedSession()}
          compactOpen={
            compactSidebarOpen() &&
            !focusMode() &&
            !leftFullWidth() &&
            (props.utilityHostOwnedByShell || !rightFullWidth())
          }
          onOpenChange={(open) => workspaceStore.getState().setMobileSidebarOpen(open)}
          wideViewportAtLoad={wideViewportAtLoad}
          restoreFocusRef={props.sidebarOpener}
          status={
            !fixtureMode() && !activeScope() ? (
              <p class="dev-tree-empty" role="status">
                No runtime projects available.
              </p>
            ) : undefined
          }
          footer={
            <ArchiveShelf
              state={utilityOwner.archiveShelf()}
              handoffMessage={utilityOwner.archiveHandoffMessage()}
              onRestore={(id) => void restoreFromArchive(id)}
              onRequestDelete={utilityOwner.requestArchiveDelete}
              onCancelDelete={utilityOwner.cancelArchiveDelete}
              onConfirmDelete={utilityOwner.confirmArchiveDelete}
            />
          }
          onSelectSession={(projectId, sessionId) => {
            setRecoveryNotice('')
            const store = workspaceStore.getState()
            if (store.selectedDevProjectId !== projectId) store.setSelectedDevProjectId(projectId)
            if (sessionId) store.setSelectedRuntimeSessionId(sessionId)
            props.onSelectionChange?.({ projectId, sessionId })
          }}
          onBindingsChanged={() => loadProjection()}
          onSelectedLeafChange={setSelectedBreadcrumb}
          announce={setAnnouncement}
          registerAddProject={(open) => {
            openAddProjectPanel = open
          }}
        />

        <Show when={visiblePaneOf('left')}>
          <FileSourceControlSlot
            side="left"
            panes={panesOfSide('left')}
            visiblePane={visiblePaneOf('left')}
            runtime={props.runtime}
            runtimeSessionId={selectedSession() || undefined}
            sessionWorktreeId={selectedSessionWorktreeId()}
            openPath={openEditorPathFor(selectedSessionWorktreeId())}
            capabilityOf={capabilityOf}
            onShow={showPane}
            onCollapse={() => collapseSide('left')}
            onToggleFullWidth={setPaneFullWidth}
            onResize={setPaneSize}
            onOpenFile={openFileInEditorLeaf}
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
                    <SelectProjectEmptyState
                      class="dev-empty-state--center-pane"
                      message="Select a project from the sidebar to begin."
                      hint="The terminal runs inside a project's session worktree."
                      onAddProject={activeScope() ? addProjectFromEmptyState : undefined}
                    />
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

        <Show when={!props.utilityHostOwnedByShell && visiblePaneOf('right')}>
          <Suspense fallback={<p class="dev-pane-state__line">Loading workspace utilities…</p>}>
            <SharedDevUtilityHost owner={utilityOwner} restoreFocusRef={() => rightUtilityOpener} />
          </Suspense>
        </Show>
      </div>
      <p class="sr-only" aria-live="polite">
        {announcement()}
      </p>
    </main>
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

function FileSourceControlSlot(props: {
  side: 'left'
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
  /**
   * The open editor file's relative path, when it belongs to the session's
   * worktree — the Files tree marks that row as selected.
   */
  openPath: string | undefined
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
  const visibleItem = () =>
    props.visiblePane ? utilityPaneById.get(props.visiblePane.pane) : undefined
  const resizablePane = () => {
    const pane = props.visiblePane
    return pane && !pane.fullWidth ? pane : undefined
  }
  const runtimeReady = () => props.runtime.state().status === 'ready'
  const isFileSourceControlSlot = () =>
    props.side === 'left' &&
    props.panes.some((item) => item.pane === 'files') &&
    props.panes.some((item) => item.pane === 'source_control')
  const paneBody = (pane: DevUtilityPane) => {
    if (pane === 'files') {
      return runtimeReady() ? (
        <FilesPane
          runtime={props.runtime}
          worktreeId={props.sessionWorktreeId}
          openPath={props.openPath}
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
          title="Source control"
          capability={PANE_CAPABILITY[pane]}
          state={props.capabilityOf(pane)}
        />
      )
    }
    return (
      <PaneProviderState
        title={utilityPaneById.get(pane)!.title}
        capability={PANE_CAPABILITY[pane]}
        state={props.capabilityOf(pane)}
      />
    )
  }
  return (
    <aside
      class={cn('dev-utility', {
        'dev-utility--left': props.side === 'left',
        'dev-utility--open': Boolean(props.visiblePane),
        'dev-utility--size-240': props.visiblePane?.size === 240,
        'dev-utility--size-336': props.visiblePane?.size === 336,
        'dev-utility--size-384': props.visiblePane?.size === 384,
      })}
      id={`dev-utility-${props.side}`}
      aria-label="Developer utilities (left)"
    >
      <section
        id={`dev-utility-panel-${props.side}`}
        aria-labelledby={`dev-utility-heading-${props.side}`}
        class="dev-utility-panel"
      >
        <div class="dev-utility-panel__heading">
          <h2 id={`dev-utility-heading-${props.side}`}>{visibleItem()?.title}</h2>
          <ActionButton
            type="button"
            variant="ghost"
            size="icon-sm"
            tooltip={props.visiblePane?.fullWidth ? 'Restore utility pane' : 'Expand utility pane'}
            aria-label={
              props.visiblePane?.fullWidth ? 'Restore utility pane' : 'Expand utility pane'
            }
            aria-pressed={props.visiblePane?.fullWidth ?? false}
            onClick={() =>
              props.onToggleFullWidth(props.visiblePane!.pane, !props.visiblePane!.fullWidth)
            }
          >
            <Show when={props.visiblePane?.fullWidth} fallback={<Maximize2 aria-hidden="true" />}>
              <Minimize2 aria-hidden="true" />
            </Show>
          </ActionButton>
          <ActionButton
            type="button"
            variant="ghost"
            size="icon-sm"
            tooltip="Collapse left utility slot"
            aria-label="Collapse left utility slot"
            onClick={props.onCollapse}
          >
            <X aria-hidden="true" />
          </ActionButton>
        </div>
        <div class="dev-utility-panel__content">
          <Suspense fallback={<p class="dev-pane-state__line">Loading pane…</p>}>
            {paneBody(props.visiblePane!.pane)}
          </Suspense>
        </div>
        <Show when={isFileSourceControlSlot()}>
          <div class="dev-utility__file-source-selector">
            <ButtonGroup class="w-full" label="Files and Source Control">
              <Button
                type="button"
                variant={props.visiblePane?.pane === 'files' ? 'default' : 'outline'}
                size="sm"
                touchTarget="comfortable"
                class="min-w-0 flex-1"
                aria-label="Files"
                aria-pressed={props.visiblePane?.pane === 'files'}
                onClick={() => props.onShow('files')}
              >
                <FolderTree aria-hidden="true" />
                <span class="dev-utility__selector-label">Files</span>
              </Button>
              <Button
                type="button"
                variant={props.visiblePane?.pane === 'source_control' ? 'default' : 'outline'}
                size="sm"
                touchTarget="comfortable"
                class="min-w-0 flex-1"
                aria-label="Source control"
                aria-pressed={props.visiblePane?.pane === 'source_control'}
                onClick={() => props.onShow('source_control')}
              >
                <GitBranch aria-hidden="true" />
                <span class="dev-utility__selector-label">Source control</span>
              </Button>
            </ButtonGroup>
          </div>
        </Show>
      </section>
      <Show when={Boolean(resizablePane())}>
        <UtilityResizeHandle
          side={props.side}
          size={resizablePane()?.size ?? defaultLeftUtilitySize}
          onResize={(size) => {
            const pane = resizablePane()
            if (pane) props.onResize(pane.pane, size)
          }}
        />
      </Show>
    </aside>
  )
}
