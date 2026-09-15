'use client'

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
  PanelRightOpen,
  Plus,
  TerminalSquare,
  Users,
} from 'lucide-solid'
import { For, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'

import { DevLayoutView } from './layout/layout-view'
import {
  closePane,
  countLeaves,
  createLayoutState,
  focusPane,
  resizeSplit,
  splitPane,
  undoClosePane,
  type DevLayoutState,
} from './layout/operations'
import { createLayoutStorageController, type LayoutStorage } from './layout/storage'
import type { DevRuntimeService } from './platform'
import { DevSidebarShell } from './sidebar/dev-sidebar-shell'

export type DevProjectFixture = Readonly<{
  id: string
  name: string
  repository: string
  branch: string
  sessions: readonly Readonly<{
    id: string
    title: string
    state: 'active' | 'ready' | 'archived'
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
          { id: 'fixture-shell', title: 'Dev View foundation', state: 'active' },
          { id: 'fixture-runtime', title: 'Runtime contracts', state: 'ready' },
        ],
      },
    ],
  },
]

const utilityItems = [
  { id: 'files', label: 'Files', icon: Files },
  { id: 'source', label: 'Source control', icon: GitBranch },
  { id: 'browser', label: 'Browser', icon: Laptop },
  { id: 'devices', label: 'Devices', icon: MonitorSmartphone },
  { id: 'agents', label: 'Agents', icon: Users },
  { id: 'history', label: 'History', icon: History },
] as const

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

export function DevWorkspaceEntry(props: DevWorkspaceEntryProps) {
  let nextPaneId = 0
  let storageController: ReturnType<typeof createLayoutStorageController> | undefined
  const groups = () => props.groups ?? []
  const selectedProjectState = useWorkspaceState((state) => state.selectedDevProjectId)
  const selectedSessionState = useWorkspaceState((state) => state.selectedRuntimeSessionId)
  const collapsedGroupIds = useWorkspaceState((state) => state.collapsedDevGroupIds)
  const collapsedProjectIds = useWorkspaceState((state) => state.collapsedDevProjectIds)
  const focusMode = useWorkspaceState((state) => state.devFocusMode)
  const selectedProject = () => selectedProjectState() ?? groups()[0]?.projects[0]?.id ?? ''
  const selectedSession = () =>
    selectedSessionState() ?? groups()[0]?.projects[0]?.sessions[0]?.id ?? ''
  const collapsedGroups = () => new Set(collapsedGroupIds())
  const collapsedProjects = () => new Set(collapsedProjectIds())
  const [compactSidebarOpen, setCompactSidebarOpen] = createSignal(false)
  const [compactUtilityOpen, setCompactUtilityOpen] = createSignal(false)
  const [activeUtility, setActiveUtility] =
    createSignal<(typeof utilityItems)[number]['id']>('files')
  const [layout, setLayout] = createSignal<DevLayoutState>(initialLayout())
  const [utilityFullWidth, setUtilityFullWidth] = createSignal(false)
  const [announcement, setAnnouncement] = createSignal('')
  const runtimeState = createMemo(() => props.runtime.state())

  const persistedPreferences = (state: DevLayoutState) => {
    const scope = props.runtime.preferenceScope?.()
    if (!scope) return undefined
    return {
      schemaVersion: 1 as const,
      scope,
      projectId: selectedProject(),
      runtimeSessionId: selectedSession(),
      center: state.center,
      utility: [],
      focusMode: focusMode(),
      focusTargetId: state.focusedLeafId,
    }
  }
  const updateLayout = (update: (state: DevLayoutState) => DevLayoutState) => {
    const next = update(layout())
    setLayout(next)
    const preferences = persistedPreferences(next)
    if (preferences) storageController?.schedule(preferences)
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
    if (loaded?.state === 'ready') {
      const restored = createLayoutState(loaded.value.center)
      setLayout({
        ...restored,
        focusedLeafId: loaded.value.focusTargetId ?? restored.focusedLeafId,
      })
    } else setLayout(initialLayout())
    const visibilityChanged = () => controller.visibilityChanged(document.hidden)
    document.addEventListener('visibilitychange', visibilityChanged)
    onCleanup(() => {
      document.removeEventListener('visibilitychange', visibilityChanged)
      controller.dispose()
      if (storageController === controller) storageController = undefined
    })
  })

  onMount(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target
      const editable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      if (
        !editable &&
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === 'f'
      ) {
        event.preventDefault()
        workspaceStore.getState().setDevFocusMode(!focusMode())
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  })

  return (
    <main
      class={cn('dev-workspace', {
        'dev-workspace--focus': focusMode(),
        'dev-workspace--utility-full': utilityFullWidth(),
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
        <button
          class="dev-icon-button dev-utility-toggle"
          type="button"
          aria-label="Toggle developer utilities"
          aria-expanded={compactUtilityOpen()}
          onClick={() => setCompactUtilityOpen((value) => !value)}
        >
          <PanelRightOpen aria-hidden="true" />
        </button>
        <div class="dev-toolbar__identity">
          <strong>Dev</strong>
          <span>
            {groups().length > 0 ? 'Foundation preview · typed fixtures' : 'Runtime unavailable'}
          </span>
        </div>
        <div class="dev-toolbar__actions" role="toolbar" aria-label="Developer workspace actions">
          <button type="button" class="dev-button" disabled>
            <Plus aria-hidden="true" /> New worktree
          </button>
          <button
            type="button"
            class="dev-button"
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
            <TerminalSquare aria-hidden="true" /> Split pane
          </button>
          <button
            type="button"
            class="dev-button"
            disabled={layout().closed.length === 0}
            onClick={() => updateLayout(undoClosePane)}
          >
            Undo close
          </button>
          <button type="button" class="dev-button" onClick={() => setActiveUtility('files')}>
            <Files aria-hidden="true" /> Files / SC
          </button>
          <button type="button" class="dev-button" onClick={() => setActiveUtility('browser')}>
            <Laptop aria-hidden="true" /> Browser / Devices
          </button>
          <button type="button" class="dev-button" onClick={() => setActiveUtility('agents')}>
            <Users aria-hidden="true" /> Agents / History
          </button>
          <button
            type="button"
            class="dev-icon-button"
            aria-label={focusMode() ? 'Exit focus mode' : 'Enter focus mode'}
            aria-pressed={focusMode()}
            onClick={() => {
              const next = !focusMode()
              workspaceStore.getState().setDevFocusMode(next)
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
          collapsedGroups={collapsedGroups()}
          collapsedProjects={collapsedProjects()}
          compactOpen={compactSidebarOpen()}
          onProjectSelect={(id) => workspaceStore.getState().setSelectedDevProjectId(id)}
          onSessionSelect={(id) => workspaceStore.getState().setSelectedRuntimeSessionId(id)}
          onToggleGroup={(id) => workspaceStore.getState().toggleDevGroupCollapsed(id)}
          onToggleProject={(id) => workspaceStore.getState().toggleDevProjectCollapsed(id)}
        />

        <section class="dev-center" id="dev-center" aria-label="Developer workspace panes">
          <DevLayoutView
            state={layout()}
            unavailable={runtimeState().status === 'unavailable'}
            onClose={(leafId) =>
              updateLayout((state) =>
                closePane(state, leafId, () => `dev-placeholder-${++nextPaneId}`)
              )
            }
            onFocus={(leafId) => updateLayout((state) => focusPane(state, leafId))}
            onResize={(splitId, ratio) =>
              updateLayout((state) => resizeSplit(state, splitId, Math.round(ratio * 20) / 20))
            }
          />
        </section>

        <aside
          class={cn('dev-utility', { 'dev-utility--open': compactUtilityOpen() })}
          aria-label="Developer utilities"
        >
          <div class="dev-utility-tabs" role="tablist" aria-label="Developer utilities">
            <For each={utilityItems}>
              {(item) => (
                <button
                  type="button"
                  id={`dev-utility-tab-${item.id}`}
                  role="tab"
                  aria-selected={activeUtility() === item.id}
                  aria-controls="dev-utility-panel"
                  tabIndex={activeUtility() === item.id ? 0 : -1}
                  class={cn('dev-utility-tab', {
                    'dev-utility-tab--selected': activeUtility() === item.id,
                  })}
                  onClick={() => setActiveUtility(item.id)}
                  onKeyDown={(event) => {
                    const current = utilityItems.findIndex(
                      (candidate) => candidate.id === activeUtility()
                    )
                    const next =
                      event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? utilityItems.length - 1
                          : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
                            ? (current - 1 + utilityItems.length) % utilityItems.length
                            : event.key === 'ArrowDown' || event.key === 'ArrowRight'
                              ? (current + 1) % utilityItems.length
                              : -1
                    if (next < 0) return
                    event.preventDefault()
                    const nextItem = utilityItems[next]!
                    setActiveUtility(nextItem.id)
                    document.getElementById(`dev-utility-tab-${nextItem.id}`)?.focus()
                  }}
                >
                  <item.icon aria-hidden="true" />
                  <span>{item.label}</span>
                </button>
              )}
            </For>
          </div>
          <div
            id="dev-utility-panel"
            role="tabpanel"
            aria-labelledby={`dev-utility-tab-${activeUtility()}`}
            class="dev-utility-panel"
          >
            <div class="dev-utility-panel__heading">
              <h2>{utilityItems.find((item) => item.id === activeUtility())?.label}</h2>
              <button
                type="button"
                class="dev-icon-button"
                aria-label={utilityFullWidth() ? 'Restore utility pane' : 'Expand utility pane'}
                aria-pressed={utilityFullWidth()}
                onClick={() => setUtilityFullWidth((value) => !value)}
              >
                <Maximize2 aria-hidden="true" />
              </button>
            </div>
            <p>This panel is ready for its dependency-owned service.</p>
          </div>
        </aside>
      </div>
      <p class="sr-only" aria-live="polite">
        {announcement()}
      </p>
    </main>
  )
}
