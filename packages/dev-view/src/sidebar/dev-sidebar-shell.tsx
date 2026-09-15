'use client'

/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0.
 *
 * Substantially translated from KiroCrew website/src/pages/ChatSidebar.tsx and
 * website/src/pages/chat/SidePanel.tsx at revision
 * 283e136c0f902e965a535a7c9548c57c7504fed0. Modified for Solid, semantic
 * tree controls, typed fixtures, and Adea authority boundaries.
 */
import { cn } from '@adea-ai/ui/lib/utils'
import { ChevronDown, ChevronRight, Search } from 'lucide-solid'
import { For, Show } from 'solid-js'

import type { DevGroupFixture } from '../dev-workspace-entry'
import { ArchiveShelf } from './archive-shelf'

export function DevSidebarShell(props: {
  groups: readonly DevGroupFixture[]
  selectedProject: string
  selectedSession: string
  collapsedGroups: ReadonlySet<string>
  collapsedProjects: ReadonlySet<string>
  compactOpen: boolean
  onProjectSelect(id: string): void
  onSessionSelect(projectId: string, sessionId: string): void
  onToggleGroup(id: string): void
  onToggleProject(id: string): void
}) {
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
      <nav aria-label="Dev projects">
        <Show
          when={props.groups.length > 0}
          fallback={<p class="dev-tree-empty">No runtime projects available.</p>}
        >
          <For each={props.groups}>
            {(group) => {
              const groupCollapsed = () => props.collapsedGroups.has(group.id)
              return (
                <section class="dev-tree-group">
                  <button
                    type="button"
                    class="dev-tree-row dev-tree-row--group"
                    aria-expanded={!groupCollapsed()}
                    onClick={() => props.onToggleGroup(group.id)}
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
                          <div class="dev-tree-project">
                            <button
                              type="button"
                              class={cn('dev-tree-row', 'dev-tree-row--project', {
                                'dev-tree-row--selected': props.selectedProject === project.id,
                              })}
                              aria-expanded={!projectCollapsed()}
                              onClick={() => {
                                props.onProjectSelect(project.id)
                                props.onToggleProject(project.id)
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
                                    <span>{session.title}</span>
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
      <ArchiveShelf />
    </aside>
  )
}
