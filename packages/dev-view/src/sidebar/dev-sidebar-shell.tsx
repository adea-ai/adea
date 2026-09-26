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
import { ChevronDown, ChevronRight, Search } from 'lucide-solid'
import { For, Show, type JSX } from 'solid-js'

import type { DevGroupFixture } from '../dev-workspace-entry'
import type { ArchiveShelfState } from './archive-shelf-model'
import { sessionBadges } from './badges'
import { ArchiveShelf } from './archive-shelf'

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

/** Alt+Arrow moves the focused row; every other chord keeps its default. */
function reorderKeyDown(
  event: KeyboardEvent,
  selector: () => string,
  move: (direction: 'up' | 'down') => void
): void {
  if (!event.altKey) return
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
  event.preventDefault()
  event.stopPropagation()
  move(event.key === 'ArrowUp' ? 'up' : 'down')
  // A reorder re-renders the tree; put focus back on the moved row.
  requestAnimationFrame(() => {
    const selectorValue = selector()
    const next = selectorValue ? document.querySelector<HTMLElement>(selectorValue) : undefined
    next?.focus()
  })
}

export function DevSidebarShell(props: {
  groups: readonly DevGroupFixture[]
  selectedProject: string
  selectedSession: string
  collapsedGroups: ReadonlySet<string>
  collapsedProjects: ReadonlySet<string>
  compactOpen: boolean
  reorder?: SidebarReorderHandlers
  /** Provider-backed archive shelf state (see archive-shelf-model). */
  archiveShelf: ArchiveShelfState
  archiveHandoffMessage?: string
  /** Registry add/scan surface slot (#398); absent in E2E fixture mode. */
  addProject?: JSX.Element
  /** Repository registry surface slot (#398 follow-up); absent in fixture mode. */
  repoRegistry?: JSX.Element
  onArchiveRestore(runtimeSessionId: string): void
  onArchiveRequestDelete(runtimeSessionId: string): void
  onArchiveCancelDelete(): void
  onArchiveConfirmDelete(): void
  onProjectSelect(id: string): void
  onSessionSelect(projectId: string, sessionId: string): void
  onToggleGroup(id: string): void
  onToggleProject(id: string): void
}) {
  let dragged: { kind: 'group' | 'project'; groupId: string; id: string } | undefined

  return (
    <aside
      class={cn('dev-sidebar', { 'dev-sidebar--open': props.compactOpen })}
      aria-label="Projects and sessions"
    >
      <label class="dev-search">
        <Search aria-hidden="true" />
        <span class="sr-only">Filter projects and sessions</span>
        <input type="search" placeholder="Filter projects" />
      </label>
      <Show when={props.addProject}>{props.addProject}</Show>
      <Show when={props.repoRegistry}>{props.repoRegistry}</Show>
      <nav aria-label="Dev projects">
        <Show
          when={props.groups.length > 0}
          fallback={<p class="dev-tree-empty">No runtime projects available.</p>}
        >
          <For each={props.groups}>
            {(group) => {
              const groupCollapsed = () => props.collapsedGroups.has(group.id)
              return (
                <section
                  class="dev-tree-group"
                  onDragOver={(event) => {
                    if (dragged?.kind !== 'group') return
                    event.preventDefault()
                    event.dataTransfer!.dropEffect = 'move'
                  }}
                  onDrop={(event) => {
                    if (dragged?.kind !== 'group') return
                    event.preventDefault()
                    event.stopPropagation()
                    if (dragged.id !== group.id) props.reorder?.onDropGroup(dragged.id, group.id)
                    dragged = undefined
                  }}
                >
                  <button
                    type="button"
                    class="dev-tree-row dev-tree-row--group"
                    data-row-id={`group:${group.id}`}
                    aria-expanded={!groupCollapsed()}
                    aria-description={props.reorder ? SIDEBAR_REORDER_HINT : undefined}
                    draggable={Boolean(props.reorder)}
                    onClick={() => props.onToggleGroup(group.id)}
                    onKeyDown={(event) =>
                      props.reorder &&
                      reorderKeyDown(
                        event,
                        () => `[data-row-id="group:${group.id}"]`,
                        (direction) => props.reorder!.onMoveGroup(group.id, direction)
                      )
                    }
                    onDragStart={(event) => {
                      dragged = { kind: 'group', groupId: group.id, id: group.id }
                      event.dataTransfer?.setData('text/plain', group.name)
                      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragEnd={() => {
                      dragged = undefined
                    }}
                  >
                    <Show when={groupCollapsed()} fallback={<ChevronDown aria-hidden="true" />}>
                      <ChevronRight aria-hidden="true" />
                    </Show>
                    <span>{group.name}</span>
                  </button>
                  <Show when={!groupCollapsed()}>
                    <For each={group.projects}>
                      {(project) => {
                        const projectCollapsed = () => props.collapsedProjects.has(project.id)
                        return (
                          <div
                            class="dev-tree-project"
                            onDragOver={(event) => {
                              if (dragged?.groupId !== group.id) return
                              event.preventDefault()
                              event.dataTransfer!.dropEffect = 'move'
                            }}
                            onDrop={(event) => {
                              if (dragged?.groupId !== group.id) return
                              event.preventDefault()
                              event.stopPropagation()
                              if (dragged.id !== project.id)
                                props.reorder?.onDropProject(group.id, dragged.id, project.id)
                              dragged = undefined
                            }}
                          >
                            <button
                              type="button"
                              class={cn('dev-tree-row', 'dev-tree-row--project', {
                                'dev-tree-row--selected': props.selectedProject === project.id,
                              })}
                              data-row-id={`project:${group.id}:${project.id}`}
                              aria-expanded={!projectCollapsed()}
                              aria-description={props.reorder ? SIDEBAR_REORDER_HINT : undefined}
                              draggable={Boolean(props.reorder)}
                              onClick={() => {
                                props.onProjectSelect(project.id)
                                props.onToggleProject(project.id)
                              }}
                              onKeyDown={(event) =>
                                props.reorder &&
                                reorderKeyDown(
                                  event,
                                  () => `[data-row-id="project:${group.id}:${project.id}"]`,
                                  (direction) =>
                                    props.reorder!.onMoveProject(group.id, project.id, direction)
                                )
                              }
                              onDragStart={(event) => {
                                dragged = {
                                  kind: 'project',
                                  groupId: group.id,
                                  id: project.id,
                                }
                                event.dataTransfer?.setData('text/plain', project.name)
                                if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
                              }}
                              onDragEnd={() => {
                                dragged = undefined
                              }}
                            >
                              <Show
                                when={projectCollapsed()}
                                fallback={<ChevronDown aria-hidden="true" />}
                              >
                                <ChevronRight aria-hidden="true" />
                              </Show>
                              <span>{project.name}</span>
                              <span class="dev-tree-row__count">{project.sessions.length}</span>
                            </button>
                            <Show when={!projectCollapsed()}>
                              <For each={project.sessions}>
                                {(session) => (
                                  <button
                                    type="button"
                                    class={cn('dev-tree-row', 'dev-tree-row--session', {
                                      'dev-tree-row--selected':
                                        props.selectedSession === session.id,
                                    })}
                                    aria-current={
                                      props.selectedSession === session.id ? 'page' : undefined
                                    }
                                    onClick={() => props.onSessionSelect(project.id, session.id)}
                                  >
                                    <span
                                      role="img"
                                      class={cn('dev-status-dot', {
                                        'dev-status-dot--active': session.state === 'active',
                                        'dev-status-dot--ready': session.state === 'ready',
                                        'dev-status-dot--archived': session.state === 'archived',
                                      })}
                                      aria-label={session.state}
                                    />
                                    <span class="dev-tree-row__title">{session.title}</span>
                                    <span class="dev-row-badges">
                                      <For each={sessionBadges(session.badges)}>
                                        {(badge) => (
                                          <span
                                            class={cn('dev-row-badge', {
                                              'dev-row-badge--success': badge.tone === 'success',
                                              'dev-row-badge--failure': badge.tone === 'failure',
                                              'dev-row-badge--progress': badge.tone === 'progress',
                                            })}
                                            title={badge.label}
                                          >
                                            {badge.short}
                                          </span>
                                        )}
                                      </For>
                                    </span>
                                  </button>
                                )}
                              </For>
                            </Show>
                          </div>
                        )
                      }}
                    </For>
                  </Show>
                </section>
              )
            }}
          </For>
        </Show>
      </nav>
      <ArchiveShelf
        state={props.archiveShelf}
        handoffMessage={props.archiveHandoffMessage}
        onRestore={props.onArchiveRestore}
        onRequestDelete={props.onArchiveRequestDelete}
        onCancelDelete={props.onArchiveCancelDelete}
        onConfirmDelete={props.onArchiveConfirmDelete}
      />
    </aside>
  )
}
