/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0.
 *
 * Substantially translated from KiroCrew website/src/pages/ChatSidebar.tsx and
 * website/src/pages/chat/SidePanel.tsx at revision
 * 283e136c0f902e965a535a7c9548c57c7504fed0. Modified for Solid, semantic
 * tree controls, typed fixtures, and Adea authority boundaries. Projects
 * render as one flat list: the cloud owns project order and grouping.
 */
import { cn } from '@adea-ai/app-ui/lib/utils'
import { ContextualSidebar } from '@adea-ai/ui/components/layout/contextual-sidebar'
import { SidebarNavItem, SidebarNavSection } from '@adea-ai/ui/components/layout/sidebar-nav'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { EmptyDescription } from '@adea-ai/ui/components/ui/empty'
import { StatusChip, type StatusTone } from '@adea-ai/ui/components/ui/status-chip'
import { For, Show, children, createEffect, createMemo, createSignal, type JSX } from 'solid-js'

import type { DevProjectFixture } from '../dev-workspace-entry'
import {
  devProjectDisplayName,
  type DevProjectNames,
  type DevWorkspaceProjection,
} from '../platform'
import type { ArchiveShelfState } from './archive-shelf-model'
import { sessionBadges } from './badges'
import { ArchiveShelf } from './archive-shelf'

/*
 * The contextual sidebar shares one stored width with the chat/virtual
 * navigation (packages/workspace-ui/src/workspace-nav-sidebar.tsx owns the same
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

/**
 * The sidebar rows for a flat register projection, in projection order. The
 * label is the host-supplied cloud project name, or the short project id.
 */
export function devProjectsFromProjection(
  projection: DevWorkspaceProjection,
  names?: DevProjectNames
): readonly DevProjectFixture[] {
  return projection.projects.map((project) => ({
    id: project.id,
    name: devProjectDisplayName(project.id, names),
    repository: project.repoIds[0] ?? '',
    branch: project.branch,
    sessions: project.sessions,
  }))
}

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

type DevSidebarNavigationProps = {
  projects: readonly DevProjectFixture[]
  selectedProject: string
  selectedSession: string
  collapsedProjects: ReadonlySet<string>
  compactOpen: boolean
  onOpenChange(open: boolean): void
  wideViewportAtLoad: boolean
  restoreFocusRef?: () => HTMLElement | undefined
  navigationLabel?: string
  /** Registry add/scan surface slot (#398); absent in E2E fixture mode. */
  addProject?: JSX.Element
  /** Repository registry surface slot (#398 follow-up); absent in fixture mode. */
  repoRegistry?: JSX.Element
  onProjectSelect(id: string): void
  onSessionSelect(projectId: string, sessionId: string): void
  onToggleProject(id: string): void
  children?: JSX.Element
}

export function DevSidebarNavigation(props: DevSidebarNavigationProps) {
  // Children arrive as an unmemoized JSX getter; resolve them once so the
  // footer condition and body share a single constructed instance.
  const resolvedChildren = children(() => props.children)
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
      <ContextualSidebar
        label="Projects and sessions"
        title="Projects and sessions"
        open={props.compactOpen}
        onOpenChange={props.onOpenChange}
        wideViewportAtLoad={props.wideViewportAtLoad}
        restoreFocusRef={props.restoreFocusRef}
        width={sidebarWidth()}
        minimum={SIDEBAR_MIN_WIDTH}
        maximum={SIDEBAR_MAX_WIDTH}
        step={16}
        resizeLabel="Resize projects and sessions sidebar"
        sidebarClass="h-full w-full"
        sheetClass="dev-sidebar__sheet"
        footerClass="max-h-1/2 overflow-y-auto"
        onSidebarElement={(element, mobile) => {
          if (mobile) return
          setSidebar(element)
          // Solid refs run before insertion; the root memo needs one nudge
          // once the aside is attached to observe its frame ancestor.
          if (element) queueMicrotask(() => setRootTick((tick) => tick + 1))
        }}
        content={(context) => (
          <>
            <Show when={props.addProject}>{props.addProject}</Show>
            <Show when={props.repoRegistry}>{props.repoRegistry}</Show>
            <nav class="flex flex-col gap-1" aria-label={props.navigationLabel ?? 'Dev projects'}>
              <Show
                when={props.projects.length > 0}
                fallback={<EmptyDescription>No runtime projects available.</EmptyDescription>}
              >
                <For each={props.projects}>
                  {(project) => {
                    const projectOpen = () => !props.collapsedProjects.has(project.id)
                    const triggerProps = {
                      id: `dev-sidebar-project-${project.id}`,
                      'data-row-id': `project:${project.id}`,
                      onClick: () => {
                        props.onProjectSelect(project.id)
                        if (context.mobile && project.id !== props.selectedProject)
                          props.onOpenChange(false)
                      },
                    }
                    return (
                      <SidebarNavSection
                        label={project.name}
                        active={props.selectedProject === project.id}
                        headingAs="h2"
                        collapsible
                        count={project.sessions.length}
                        open={projectOpen()}
                        onOpenChange={() => props.onToggleProject(project.id)}
                        triggerProps={triggerProps}
                      >
                        <For each={project.sessions}>
                          {(session) => (
                            <SidebarNavItem
                              as="button"
                              type="button"
                              active={props.selectedSession === session.id}
                              nested
                              data-row-id={`session:${project.id}:${session.id}`}
                              onClick={() => {
                                props.onSessionSelect(project.id, session.id)
                                if (context.mobile) props.onOpenChange(false)
                              }}
                            >
                              {/* The name is computed from contents: explicit
                                  whitespace text nodes keep the status chip,
                                  the title, and the badges as separated
                                  tokens instead of one mushed string. */}
                              <StatusChip
                                tone={sessionStateTone[session.state]}
                                label={session.state}
                                compact
                              />{' '}
                              <span class="dev-tree-row__title">{session.title}</span>{' '}
                              <span class="flex shrink-0 items-center gap-1 ms-auto">
                                <For each={sessionBadges(session.badges)}>
                                  {(badge) => (
                                    <>
                                      {' '}
                                      <Badge
                                        size="sm"
                                        variant={badgeVariant[badge.tone]}
                                        title={badge.label}
                                      >
                                        {badge.short}
                                      </Badge>
                                    </>
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
              </Show>
            </nav>
          </>
        )}
        footer={resolvedChildren() ? () => resolvedChildren() : undefined}
        onWidthChange={updateSidebarWidth}
        onWidthCommit={(width) => {
          window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clampSidebarWidth(width)))
        }}
      />
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
