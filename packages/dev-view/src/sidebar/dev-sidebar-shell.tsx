/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0.
 *
 * Substantially translated from KiroCrew website/src/pages/ChatSidebar.tsx and
 * website/src/pages/chat/SidePanel.tsx at revision
 * 283e136c0f902e965a535a7c9548c57c7504fed0. Modified for Solid, semantic
 * tree controls, typed fixtures, Adea authority boundaries, and accessible
 * group/project reordering (pointer drag plus Alt+Arrow keyboard moves).
 */
import { cn } from '@adea-ai/app-ui/lib/utils'
import {
  SidebarNav,
  SidebarNavContent,
  SidebarNavFooter,
  SidebarNavHeader,
  SidebarNavItem,
  SidebarNavResizeHandle,
  SidebarNavSection,
  SidebarNavTitle,
} from '@adea-ai/ui/components/layout/sidebar-nav'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { EmptyDescription } from '@adea-ai/ui/components/ui/empty'
import { StatusChip, type StatusTone } from '@adea-ai/ui/components/ui/status-chip'
import { For, Show, children, createEffect, createMemo, createSignal, type JSX } from 'solid-js'

import type { DevGroupFixture, DevProjectFixture } from '../dev-workspace-entry'
import type { ArchiveShelfState } from './archive-shelf-model'
import { sessionBadges } from './badges'
import { ArchiveShelf } from './archive-shelf'

/*
 * The contextual sidebar shares one stored width with the chat/virtual
 * navigation (packages/workspace-ui/src/workspace-sidebar.tsx owns the same
 * key, bounds, and CSS variable). The constants are restated here because
 * dev-view does not depend on workspace-ui; change them together.
 */
const SIDEBAR_WIDTH_STORAGE_KEY = 'adea:workspace-sidebar-width'
const SIDEBAR_MIN_WIDTH = 208
const SIDEBAR_MAX_WIDTH = 448
const SIDEBAR_DEFAULT_WIDTH = 272

function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)))
}

function devSidebarRootFor(sidebar: HTMLElement | null | undefined): HTMLElement | null {
  // The width variable must reach the workspace frame: the Dev top-bar's
  // section alignment and the sidebar itself both read it there. Hosts without
  // a frame (direct integrations) fall back to the dev workspace root.
  return (
    sidebar?.closest<HTMLElement>('.workspace-frame, .workspace-shell--contextual') ??
    sidebar?.closest<HTMLElement>('.dev-workspace') ??
    null
  )
}

function applyDevSidebarWidth(root: HTMLElement, width: number) {
  root.style.setProperty('--conventional-sidebar-width', `${clampSidebarWidth(width)}px`)
}

export type SidebarReorderHandlers = {
  /** Keyboard move (Alt+Arrow) of a group. */
  onMoveGroup(id: string, direction: 'up' | 'down'): void
  /** Keyboard move of a project within its group. */
  onMoveProject(groupId: string, id: string, direction: 'up' | 'down'): void
  /** Pointer drop of a group before `targetId`. */
  onDropGroup(id: string, targetId: string): void
  /** Pointer drop of a project before `targetId` inside its group. */
  onDropProject(groupId: string, id: string, targetId: string): void
}

/**
 * The keyboard reorder contract: Alt+ArrowUp/Down on a focused row moves it.
 * Documented for screen readers through the row's description below.
 */
export const SIDEBAR_REORDER_HINT = 'Press Alt with Arrow Up or Arrow Down to move this item.'

const badgeVariant = {
  neutral: 'secondary',
  progress: 'info',
  success: 'success',
  failure: 'destructive',
} as const

const sessionStateTone: Record<DevProjectFixture['sessions'][number]['state'], StatusTone> = {
  preparing: 'info',
  ready: 'success',
  active: 'success',
  disconnected: 'warning',
  completed: 'neutral',
  failed: 'danger',
  cancelled: 'neutral',
  archived: 'unknown',
}

/** Alt+Arrow moves the focused row; every other chord keeps its default. */
function reorderAndRestoreFocus(triggerId: string, move: () => void): void {
  move()
  // A reorder re-renders the tree; stable trigger IDs restore focus on the moved row.
  requestAnimationFrame(() => document.getElementById(triggerId)?.focus())
}

type DevSidebarNavigationProps = {
  groups: readonly DevGroupFixture[]
  selectedProject: string
  selectedSession: string
  collapsedGroups: ReadonlySet<string>
  collapsedProjects: ReadonlySet<string>
  compactOpen: boolean
  navigationLabel?: string
  reorder?: SidebarReorderHandlers
  /** Registry add/scan surface slot (#398); absent in E2E fixture mode. */
  addProject?: JSX.Element
  /** Repository registry surface slot (#398 follow-up); absent in fixture mode. */
  repoRegistry?: JSX.Element
  onProjectSelect(id: string): void
  onSessionSelect(projectId: string, sessionId: string): void
  onToggleGroup(id: string): void
  onToggleProject(id: string): void
  children?: JSX.Element
}

export function DevSidebarNavigation(props: DevSidebarNavigationProps) {
  // Children arrive as an unmemoized JSX getter; resolve them once so the
  // footer condition and body share a single constructed instance.
  const resolvedChildren = children(() => props.children)
  let dragged: { kind: 'group' | 'project'; groupId: string; id: string } | undefined
  const [sidebar, setSidebar] = createSignal<HTMLElement>()
  const [sidebarWidth, setSidebarWidth] = createSignal(SIDEBAR_DEFAULT_WIDTH)
  const [rootTick, setRootTick] = createSignal(0)
  const layoutRoot = createMemo(() => {
    const element = sidebar()
    void rootTick()
    return element?.isConnected ? devSidebarRootFor(element) : null
  })

  const updateSidebarWidth = (nextWidth: number) => {
    const root = layoutRoot()
    if (!root) return
    const width = clampSidebarWidth(nextWidth)
    applyDevSidebarWidth(root, width)
    setSidebarWidth(width)
  }

  createEffect(() => {
    // Restore the shared stored width as soon as the layout root exists — the
    // same value the chat/virtual navigation applies, so one drag sets both.
    const root = layoutRoot()
    if (!root) return
    const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY))
    if (!Number.isFinite(stored) || stored <= 0) return
    applyDevSidebarWidth(root, stored)
    setSidebarWidth(clampSidebarWidth(stored))
  })

  return (
    <div class={cn('dev-sidebar', { 'dev-sidebar--open': props.compactOpen })}>
      <SidebarNav
        as="aside"
        class="h-full w-full"
        aria-label="Projects and sessions"
        ref={(element) => {
          setSidebar(element)
          // Solid refs run before insertion; the root memo needs one nudge
          // once the aside is attached to observe its frame ancestor.
          queueMicrotask(() => setRootTick((tick) => tick + 1))
        }}
      >
        <SidebarNavResizeHandle
          value={sidebarWidth()}
          minimum={SIDEBAR_MIN_WIDTH}
          maximum={SIDEBAR_MAX_WIDTH}
          step={16}
          label="Resize projects and sessions sidebar"
          class="dev-sidebar__resize"
          onChange={updateSidebarWidth}
          onCommit={(width) => {
            window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clampSidebarWidth(width)))
          }}
        />
        <SidebarNavHeader>
          <SidebarNavTitle as="h2">Projects and sessions</SidebarNavTitle>
        </SidebarNavHeader>
        <SidebarNavContent>
          <Show when={props.addProject}>{props.addProject}</Show>
          <Show when={props.repoRegistry}>{props.repoRegistry}</Show>
          <nav class="flex flex-col gap-1" aria-label={props.navigationLabel ?? 'Dev projects'}>
            <Show
              when={props.groups.length > 0}
              fallback={<EmptyDescription>No runtime projects available.</EmptyDescription>}
            >
              <For each={props.groups}>
                {(group) => {
                  const groupOpen = () => !props.collapsedGroups.has(group.id)
                  const groupRowId = `dev-sidebar-group-${group.id}`
                  const groupTriggerProps = props.reorder
                    ? {
                        id: groupRowId,
                        'data-row-id': `group:${group.id}`,
                        'aria-description': SIDEBAR_REORDER_HINT,
                        draggable: true,
                        onReorder: (direction: 'up' | 'down') =>
                          reorderAndRestoreFocus(groupRowId, () =>
                            props.reorder?.onMoveGroup(group.id, direction)
                          ),
                        onDragStart: (event: DragEvent) => {
                          dragged = { kind: 'group', groupId: group.id, id: group.id }
                          event.dataTransfer?.setData('text/plain', group.name)
                          if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
                        },
                        onDragEnd: () => {
                          dragged = undefined
                        },
                      }
                    : {
                        id: groupRowId,
                        'data-row-id': `group:${group.id}`,
                      }

                  return (
                    <SidebarNavSection
                      label={group.name}
                      headingAs="h2"
                      collapsible
                      open={groupOpen()}
                      onOpenChange={() => props.onToggleGroup(group.id)}
                      triggerProps={groupTriggerProps}
                      onDragOver={(event) => {
                        if (dragged?.kind !== 'group') return
                        event.preventDefault()
                        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
                      }}
                      onDrop={(event) => {
                        if (dragged?.kind !== 'group') return
                        event.preventDefault()
                        event.stopPropagation()
                        if (dragged.id !== group.id)
                          props.reorder?.onDropGroup(dragged.id, group.id)
                        dragged = undefined
                      }}
                    >
                      <For each={group.projects}>
                        {(project) => {
                          const projectOpen = () => !props.collapsedProjects.has(project.id)
                          const projectRowId = `dev-sidebar-project-${group.id}-${project.id}`
                          const onProjectClick = () => {
                            props.onProjectSelect(project.id)
                          }
                          const projectTriggerProps = props.reorder
                            ? {
                                id: projectRowId,
                                'data-row-id': `project:${group.id}:${project.id}`,
                                'aria-description': SIDEBAR_REORDER_HINT,
                                draggable: true,
                                onClick: onProjectClick,
                                onReorder: (direction: 'up' | 'down') =>
                                  reorderAndRestoreFocus(projectRowId, () =>
                                    props.reorder?.onMoveProject(group.id, project.id, direction)
                                  ),
                                onDragStart: (event: DragEvent) => {
                                  dragged = { kind: 'project', groupId: group.id, id: project.id }
                                  event.dataTransfer?.setData('text/plain', project.name)
                                  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
                                },
                                onDragEnd: () => {
                                  dragged = undefined
                                },
                              }
                            : {
                                id: projectRowId,
                                'data-row-id': `project:${group.id}:${project.id}`,
                                onClick: onProjectClick,
                              }

                          return (
                            <SidebarNavSection
                              class="ms-2"
                              label={project.name}
                              active={props.selectedProject === project.id}
                              headingAs="h3"
                              collapsible
                              count={project.sessions.length}
                              open={projectOpen()}
                              onOpenChange={() => props.onToggleProject(project.id)}
                              triggerProps={projectTriggerProps}
                              onDragOver={(event) => {
                                if (dragged?.kind !== 'project' || dragged.groupId !== group.id)
                                  return
                                event.preventDefault()
                                if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
                              }}
                              onDrop={(event) => {
                                if (dragged?.kind !== 'project' || dragged.groupId !== group.id)
                                  return
                                event.preventDefault()
                                event.stopPropagation()
                                if (dragged.id !== project.id)
                                  props.reorder?.onDropProject(group.id, dragged.id, project.id)
                                dragged = undefined
                              }}
                            >
                              <For each={project.sessions}>
                                {(session) => (
                                  <SidebarNavItem
                                    as="button"
                                    type="button"
                                    active={props.selectedSession === session.id}
                                    nested
                                    data-row-id={`session:${project.id}:${session.id}`}
                                    onClick={() => props.onSessionSelect(project.id, session.id)}
                                  >
                                    <StatusChip
                                      tone={sessionStateTone[session.state]}
                                      label={session.state}
                                      compact
                                    />
                                    <span class="dev-tree-row__title">{session.title}</span>
                                    <span class="flex shrink-0 items-center gap-1 ms-auto">
                                      <For each={sessionBadges(session.badges)}>
                                        {(badge) => (
                                          <Badge
                                            size="sm"
                                            variant={badgeVariant[badge.tone]}
                                            title={badge.label}
                                          >
                                            {badge.short}
                                          </Badge>
                                        )}
                                      </For>
                                    </span>
                                  </SidebarNavItem>
                                )}
                              </For>
                            </SidebarNavSection>
                          )
                        }}
                      </For>
                    </SidebarNavSection>
                  )
                }}
              </For>
            </Show>
          </nav>
        </SidebarNavContent>
        <Show when={resolvedChildren()}>
          <SidebarNavFooter class="max-h-1/2 overflow-y-auto">
            {resolvedChildren()}
          </SidebarNavFooter>
        </Show>
      </SidebarNav>
    </div>
  )
}

/** Dev adds its provider-backed archive actions to the common hierarchy. */
export function DevSidebarShell(
  props: DevSidebarNavigationProps & {
    archiveShelf: ArchiveShelfState
    archiveHandoffMessage?: string
    onArchiveRestore(runtimeSessionId: string): void
    onArchiveRequestDelete(runtimeSessionId: string): void
    onArchiveCancelDelete(): void
    onArchiveConfirmDelete(): void
  }
) {
  return (
    <DevSidebarNavigation {...props}>
      <ArchiveShelf
        state={props.archiveShelf}
        handoffMessage={props.archiveHandoffMessage}
        onRestore={props.onArchiveRestore}
        onRequestDelete={props.onArchiveRequestDelete}
        onCancelDelete={props.onArchiveCancelDelete}
        onConfirmDelete={props.onArchiveConfirmDelete}
      />
    </DevSidebarNavigation>
  )
}
