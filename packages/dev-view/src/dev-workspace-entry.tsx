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
  DevLayoutPreferencesV2,
  DevUtilityPane,
  DevUtilityPreference,
} from '@adea-ai/types/dev-runtime'
import '@adea-ai/ui/dev-view.css'
import { cn } from '@adea-ai/ui/lib/utils'
import {
  Columns2,
  Files,
  GitBranch,
  History,
  Laptop,
  Maximize2,
  MonitorSmartphone,
  Plus,
  TerminalSquare,
  Users,
  X,
} from 'lucide-solid'
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'

import { createDevKeyboardController } from './keyboard'
import { DevLayoutView } from './layout/layout-view'
import {
  closePane,
  countLeaves,
  createLayoutState,
  focusPane,
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
import { resolveDevSelection, type DevSelection } from './selection'
import { DevSidebarShell } from './sidebar/dev-sidebar-shell'
import type { DevSessionBadgeState } from './sidebar/badges'

export type DevProjectFixture = Readonly<{
  id: string
  name: string
  repository: string
  branch: string
  sessions: readonly Readonly<{
    id: string
    title: string
    state: 'active' | 'ready' | 'archived'
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
  groups?: readonly DevGroupFixture[]
  storage?: LayoutStorage
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
  createLayoutState({
    kind: 'split',
    id: 'dev-root',
    direction: 'row',
    ratio: 0.5,
    children: [
      { kind: 'leaf', id: 'dev-terminal', pane: 'terminal' },
      { kind: 'leaf', id: 'dev-editor', pane: 'editor' },
    ],
  })

const snapUtilitySize = (size: number) => {
  if (!Number.isFinite(size)) return defaultUtilitySize
  return utilitySizeSteps.reduce(
    (best, step) => (Math.abs(step - size) < Math.abs(best - size) ? step : best),
    utilitySizeSteps[0]
  )
}

function focusPaneElement(leafId: string) {
  requestAnimationFrame(() => {
    const target = [...document.querySelectorAll<HTMLElement>('[data-pane-id]')].find(
      (element) => element.dataset.paneId === leafId
    )
    target?.focus()
  })
}

export function DevWorkspaceEntry(props: DevWorkspaceEntryProps) {
  let nextPaneId = 0
  let storageController: ReturnType<typeof createLayoutStorageController> | undefined
  const [projectedGroups, setProjectedGroups] = createSignal<readonly DevGroupFixture[]>([])
  const groups = () => props.groups ?? projectedGroups()
  const selectedProjectState = useWorkspaceState((state) => state.selectedDevProjectId)
  const selectedSessionState = useWorkspaceState((state) => state.selectedRuntimeSessionId)
  const collapsedGroupIds = useWorkspaceState((state) => state.collapsedDevGroupIds)
  const collapsedProjectIds = useWorkspaceState((state) => state.collapsedDevProjectIds)
  const focusMode = useWorkspaceState((state) => state.devFocusMode)
  const [compactSidebarOpen, setCompactSidebarOpen] = createSignal(false)
  const [utilityPreferences, setUtilityPreferences] = createSignal<readonly DevUtilityPreference[]>(
    defaultUtilityPreferences()
  )
  const [layout, setLayout] = createSignal<DevLayoutState>(initialLayout())
  const [announcement, setAnnouncement] = createSignal('')
  const runtimeState = createMemo(() => props.runtime.state())

  onMount(() => {
    if (props.groups || !props.runtime.projection) return
    const scope = props.runtime.preferenceScope?.()
    if (!scope) return
    void props.runtime
      .projection(scope)
      .then((projection) => {
        setProjectedGroups(toDevGroups(projection))
      })
      .catch(() => setProjectedGroups([]))
  })

  // Selection always resolves inside the active projection; a stale,
  // archived, or cross-project ID recovers visibly and is corrected once.
  const selection = createMemo<DevSelection>(() =>
    resolveDevSelection({
      projects: groups().flatMap((group) =>
        group.projects.map((project) => ({
          id: project.id,
          sessions: project.sessions.map((session) => ({
            id: session.id,
            archived: session.state === 'archived',
          })),
        }))
      ),
      requestedProjectId: selectedProjectState(),
      requestedSessionId: selectedSessionState(),
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

  createEffect(() => {
    const result = selection()
    if (result.status !== 'recovered') return
    const store = workspaceStore.getState()
    if (store.selectedDevProjectId !== result.projectId)
      store.setSelectedDevProjectId(result.projectId)
    if (result.runtimeSessionId && store.selectedRuntimeSessionId !== result.runtimeSessionId)
      store.setSelectedRuntimeSessionId(result.runtimeSessionId)
    setAnnouncement('Saved selection is unavailable; the closest live session is selected.')
  })

  const visiblePaneOf = (side: 'left' | 'right') =>
    utilityPreferences().find((item) => item.side === side && item.visible)
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
    setUtilityPreferences((items) =>
      items.map((item) => (item.side === side ? { ...item, visible: item.pane === pane } : item))
    )
    schedulePreferences()
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
      const restored = normalizeLayout(createLayoutState(loaded.value.center))
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

  return (
    <main
      class={cn('dev-workspace', {
        'dev-workspace--focus': focusMode(),
        'dev-workspace--left-full': leftFullWidth(),
        'dev-workspace--right-full': rightFullWidth(),
      })}
    >
      <a class="dev-skip-link" href="#dev-center">
        Skip to workspace
      </a>
      <header class="dev-toolbar">
        <button
          class="dev-icon-button dev-sidebar-toggle"
          type="button"
          aria-label="Toggle projects sidebar"
          aria-expanded={compactSidebarOpen()}
          onClick={() => setCompactSidebarOpen((value) => !value)}
        >
          <Columns2 aria-hidden="true" />
        </button>
        <div class="dev-toolbar__identity">
          <strong>Dev</strong>
          <span>
            {groups().length > 0 ? 'Foundation preview · typed fixtures' : 'Runtime unavailable'}
          </span>
        </div>
        <div class="dev-toolbar__actions" role="toolbar" aria-label="Developer workspace actions">
          <button type="button" class="dev-button dev-button--secondary" disabled>
            <Plus aria-hidden="true" /> <span>New session</span>
          </button>
          <button
            type="button"
            class="dev-button dev-button--secondary"
            disabled={countLeaves(layout().center) >= 8}
            onClick={() => {
              const pane = countLeaves(layout().center) % 2 === 0 ? 'terminal' : 'editor'
              const suffix = ++nextPaneId
              updateLayout((state) =>
                splitPane(state, state.focusedLeafId, {
                  direction: 'row',
                  placement: 'after',
                  leaf: { kind: 'leaf', id: `dev-pane-${suffix}`, pane },
                  splitId: `dev-split-${suffix}`,
                })
              )
            }}
          >
            <TerminalSquare aria-hidden="true" /> <span>Split pane</span>
          </button>
          <button
            type="button"
            class="dev-button dev-button--secondary"
            disabled={layout().closed.length === 0}
            onClick={() => updateLayout(undoClosePane)}
          >
            <span>Undo close</span>
          </button>
          <Show when={!leftFullWidth()}>
            <UtilityToolbarToggle
              label="Files / SC"
              icon={Files}
              pressed={Boolean(visiblePaneOf('left'))}
              onClick={() => toggleUtilityGroup(['files', 'source_control'])}
            />
          </Show>
          <Show when={!rightFullWidth()}>
            <UtilityToolbarToggle
              label="Browser / Devices"
              icon={Laptop}
              pressed={
                visiblePaneOf('right')?.pane === 'browser' ||
                visiblePaneOf('right')?.pane === 'devices'
              }
              onClick={() => toggleUtilityGroup(['browser', 'devices'])}
            />
            <UtilityToolbarToggle
              label="Agents / History"
              icon={Users}
              pressed={
                visiblePaneOf('right')?.pane === 'agents' ||
                visiblePaneOf('right')?.pane === 'history'
              }
              onClick={() => toggleUtilityGroup(['agents', 'history'])}
            />
          </Show>
          <button
            type="button"
            class="dev-icon-button"
            aria-label={focusMode() ? 'Exit focus mode' : 'Enter focus mode'}
            aria-pressed={focusMode()}
            onClick={() => {
              const next = !focusMode()
              workspaceStore.getState().setDevFocusMode(next)
              schedulePreferences()
              setAnnouncement(next ? 'Focus mode enabled' : 'Focus mode disabled')
            }}
          >
            <Maximize2 aria-hidden="true" />
          </button>
        </div>
      </header>

      <div class="dev-workspace__body">
        <DevSidebarShell
          groups={groups()}
          selectedProject={selectedProject()}
          selectedSession={selectedSession()}
          collapsedGroups={new Set(collapsedGroupIds())}
          collapsedProjects={new Set(collapsedProjectIds())}
          compactOpen={compactSidebarOpen()}
          onProjectSelect={(id) => workspaceStore.getState().setSelectedDevProjectId(id)}
          onSessionSelect={(projectId, sessionId) => {
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
            panes={panesOfSide('left')}
            visiblePane={visiblePaneOf('left')}
            onShow={showPane}
            onCollapse={() => collapseSide('left')}
            onToggleFullWidth={setPaneFullWidth}
            onResize={setPaneSize}
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
          <DevLayoutView
            state={layout()}
            unavailable={runtimeState().status === 'unavailable'}
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
            panes={panesOfSide('right')}
            visiblePane={visiblePaneOf('right')}
            onShow={showPane}
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

function UtilityToolbarToggle(props: {
  label: string
  icon: typeof Files
  pressed: boolean
  onClick(): void
}) {
  return (
    <button
      type="button"
      class="dev-button dev-button--toggle"
      aria-pressed={props.pressed}
      onClick={props.onClick}
    >
      <props.icon aria-hidden="true" /> <span>{props.label}</span>
    </button>
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
    <button
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

function UtilitySlot(props: {
  side: 'left' | 'right'
  panes: readonly DevUtilityPreference[]
  visiblePane: DevUtilityPreference | undefined
  onShow(pane: DevUtilityPane): void
  onCollapse(): void
  onToggleFullWidth(pane: DevUtilityPane, fullWidth: boolean): void
  onResize(pane: DevUtilityPane, size: number): void
}) {
  const sideLabel = () => (props.side === 'left' ? 'Left' : 'Right')
  const visibleItem = () =>
    props.visiblePane ? utilityItemByPane.get(props.visiblePane.pane) : undefined
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
      <div class="dev-utility-tabs" role="tablist" aria-label={`${sideLabel()} utility panes`}>
        <For each={props.panes}>
          {(item) => {
            const meta = utilityItemByPane.get(item.pane)!
            const selected = () => props.visiblePane?.pane === item.pane
            return (
              <button
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
              </button>
            )
          }}
        </For>
      </div>
      <div
        id={`dev-utility-panel-${props.side}`}
        role="tabpanel"
        aria-labelledby={`dev-utility-tab-${props.side}-${props.visiblePane?.pane ?? ''}`}
        class="dev-utility-panel"
      >
        <div class="dev-utility-panel__heading">
          <h2>{visibleItem()?.title}</h2>
          <button
            type="button"
            class="dev-icon-button"
            aria-label={
              props.visiblePane?.fullWidth ? 'Restore utility pane' : 'Expand utility pane'
            }
            aria-pressed={props.visiblePane?.fullWidth ?? false}
            onClick={() =>
              props.onToggleFullWidth(props.visiblePane!.pane, !props.visiblePane!.fullWidth)
            }
          >
            <Maximize2 aria-hidden="true" />
          </button>
          <button
            type="button"
            class="dev-icon-button"
            aria-label={`Collapse ${sideLabel().toLowerCase()} utility slot`}
            onClick={props.onCollapse}
          >
            <X aria-hidden="true" />
          </button>
        </div>
        <p>This panel is ready for its dependency-owned service.</p>
      </div>
    </aside>
  )
}
