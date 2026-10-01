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
  SidebarNavSection,
  SidebarNavTitle,
} from '@adea-ai/ui/components/layout/sidebar-nav'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { EmptyDescription } from '@adea-ai/ui/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@adea-ai/ui/components/ui/input-group'
import { StatusChip, type StatusTone } from '@adea-ai/ui/components/ui/status-chip'
import { Search } from 'lucide-solid'
import { For, Show, createMemo, createSignal, type JSX } from 'solid-js'

import type { DevGroupFixture, DevProjectFixture } from '../dev-workspace-entry'
import type { ArchiveShelfState } from './archive-shelf-model'
import { sessionBadges } from './badges'
import { ArchiveShelf } from './archive-shelf'
import { filterDevNavigationGroups } from './navigation-filter'

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
  const [query, setQuery] = createSignal('')
  const isFiltering = () => query().trim().length > 0
  const visibleGroups = createMemo(() => filterDevNavigationGroups(props.groups, query()))
  const groupCollapsed = (groupId: string) => !isFiltering() && props.collapsedGroups.has(groupId)
  const projectCollapsed = (projectId: string) =>
    !isFiltering() && props.collapsedProjects.has(projectId)
  let dragged: { kind: 'group' | 'project'; groupId: string; id: string } | undefined

  return (
    <div class={cn('dev-sidebar', { 'dev-sidebar--open': props.compactOpen })}>
      <SidebarNav as="aside" class="h-full w-full" aria-label="Projects and sessions">
        <SidebarNavHeader>
          <SidebarNavTitle as="h2">Projects and sessions</SidebarNavTitle>
        </SidebarNavHeader>
        <SidebarNavContent>
          <InputGroup>
            <InputGroupAddon>
              <Search aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              value={query()}
              aria-label="Filter projects and sessions"
              placeholder="Filter projects"
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </InputGroup>
          <Show when={props.addProject}>{props.addProject}</Show>
          <Show when={props.repoRegistry}>{props.repoRegistry}</Show>
          <nav class="flex flex-col gap-1" aria-label={props.navigationLabel ?? 'Dev projects'}>
            <Show
              when={visibleGroups().length > 0}
              fallback={
                <EmptyDescription>
                  {isFiltering()
                    ? 'No matching projects or sessions.'
                    : 'No runtime projects available.'}
                </EmptyDescription>
              }
            >
              <For each={visibleGroups()}>
                {(group) => {
                  const groupOpen = () => !groupCollapsed(group.id)
                  const groupRowId = `dev-sidebar-group-${group.id}`
                  const groupTriggerProps = props.reorder
                    ? {
                        id: groupRowId,
                        'data-row-id': `group:${group.id}`,
                        'aria-description': SIDEBAR_REORDER_HINT,
                        draggable: true,
                        onClick: (event: MouseEvent) => {
                          if (isFiltering()) event.preventDefault()
                        },
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
                        onClick: (event: MouseEvent) => {
                          if (isFiltering()) event.preventDefault()
                        },
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
                          const projectOpen = () => !projectCollapsed(project.id)
                          const projectRowId = `dev-sidebar-project-${group.id}-${project.id}`
                          const onProjectClick = (event: MouseEvent) => {
                            props.onProjectSelect(project.id)
                            if (isFiltering()) event.preventDefault()
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
        <Show when={props.children}>
          <SidebarNavFooter class="max-h-1/2 overflow-y-auto">{props.children}</SidebarNavFooter>
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
