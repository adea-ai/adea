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
import { For, Show, createMemo, createSignal, onMount } from 'solid-js'

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
}>

const fixtureGroups: readonly DevGroupFixture[] = [
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

export function DevWorkspaceEntry(props: DevWorkspaceEntryProps) {
  let centerElement: HTMLElement | undefined
  const groups = () => props.groups ?? fixtureGroups
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
  const [narrow, setNarrow] = createSignal(false)
  const [activeUtility, setActiveUtility] =
    createSignal<(typeof utilityItems)[number]['id']>('files')
  const [splitRatio, setSplitRatio] = createSignal(50)
  const [utilityFullWidth, setUtilityFullWidth] = createSignal(false)
  const [announcement, setAnnouncement] = createSignal('')
  const runtimeState = createMemo(() => props.runtime.state())

  onMount(() => {
    const narrowQuery = window.matchMedia('(max-width: 48rem)')
    const updateNarrow = () => setNarrow(narrowQuery.matches)
    updateNarrow()
    narrowQuery.addEventListener('change', updateNarrow)
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
    return () => {
      narrowQuery.removeEventListener('change', updateNarrow)
      window.removeEventListener('keydown', handler)
    }
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
          <span>Foundation preview · typed fixtures</span>
        </div>
        <div class="dev-toolbar__actions" role="toolbar" aria-label="Developer workspace actions">
          <button type="button" class="dev-button" disabled>
            <Plus aria-hidden="true" /> New worktree
          </button>
          <button type="button" class="dev-button" disabled>
            <TerminalSquare aria-hidden="true" /> Terminal
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

        <section
          class="dev-center"
          id="dev-center"
          aria-label="Developer workspace panes"
          style={{ '--dev-split-ratio': `${splitRatio()}%` }}
          ref={(element) => {
            centerElement = element
          }}
        >
          <div class="dev-pane dev-pane--terminal">
            <header>
              <TerminalSquare aria-hidden="true" />
              <span>Terminal</span>
              <span class="dev-pane__badge">typed seam</span>
            </header>
            <div class="dev-terminal-placeholder">
              <p>$ dev runtime status</p>
              <p class="dev-terminal-muted">
                Authenticated terminal transport is not available in this slice.
              </p>
              <Show when={runtimeState().status === 'unavailable'}>
                <p>Capability state: unavailable</p>
              </Show>
            </div>
          </div>
          <button
            type="button"
            class="dev-splitter"
            role="separator"
            aria-label="Resize terminal and editor panes"
            aria-orientation={narrow() ? 'horizontal' : 'vertical'}
            aria-valuemin="10"
            aria-valuemax="90"
            aria-valuenow={splitRatio()}
            onPointerDown={(event) => {
              if (!centerElement) return
              event.currentTarget.setPointerCapture(event.pointerId)
              const vertical = window.matchMedia('(max-width: 48rem)').matches
              const resize = (move: PointerEvent) => {
                const bounds = centerElement!.getBoundingClientRect()
                const position = vertical ? move.clientY - bounds.top : move.clientX - bounds.left
                const extent = vertical ? bounds.height : bounds.width
                if (extent > 0)
                  setSplitRatio(Math.min(90, Math.max(10, Math.round((position / extent) * 100))))
              }
              const done = () => {
                window.removeEventListener('pointermove', resize)
                window.removeEventListener('pointerup', done)
                window.removeEventListener('pointercancel', done)
              }
              window.addEventListener('pointermove', resize)
              window.addEventListener('pointerup', done, { once: true })
              window.addEventListener('pointercancel', done, { once: true })
            }}
            onKeyDown={(event) => {
              const delta =
                event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                  ? -5
                  : event.key === 'ArrowRight' || event.key === 'ArrowDown'
                    ? 5
                    : 0
              if (!delta) return
              event.preventDefault()
              setSplitRatio((value) => Math.min(90, Math.max(10, value + delta)))
            }}
          />
          <div class="dev-pane dev-pane--editor">
            <header>
              <Files aria-hidden="true" />
              <span>Editor</span>
            </header>
            <div class="dev-empty-state">
              <PanelRightOpen aria-hidden="true" />
              <h1>Choose a file to edit</h1>
              <p>File authority will arrive through the authenticated Dev Runtime.</p>
            </div>
          </div>
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
                  role="tab"
                  aria-selected={activeUtility() === item.id}
                  aria-controls="dev-utility-panel"
                  class={cn('dev-utility-tab', {
                    'dev-utility-tab--selected': activeUtility() === item.id,
                  })}
                  onClick={() => setActiveUtility(item.id)}
                >
                  <item.icon aria-hidden="true" />
                  <span>{item.label}</span>
                </button>
              )}
            </For>
          </div>
          <div id="dev-utility-panel" role="tabpanel" class="dev-utility-panel">
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
