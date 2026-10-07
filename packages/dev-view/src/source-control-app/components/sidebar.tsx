/*
 * Left sidebar: the two cross-project shortcuts, then GitHub owners with the
 * Adea projects whose repository lives there, each with its default-branch
 * CI state and open pull request count. Registered repositories the viewer
 * does not want listed sit collapsed below the show-more bar (a persistent
 * display preference — hiding is never an unlink, and auto-adopted
 * repositories land above the bar); the bar itself is the pointer fast path —
 * dragging a row across it moves the row between the list and the group,
 * while the per-row hide/show controls remain the keyboard path. Archived
 * projects collapse at the bottom; Connect account stays in the footer. It
 * shares the Dev view's contextual sidebar frame, so the top bar's toggle
 * and the drawer behave the same.
 */
import { cn } from '@adea-ai/app-ui/lib/utils'
import {
  SidebarNav,
  SidebarNavContent,
  SidebarNavFooter,
  SidebarNavHeader,
  SidebarNavItem,
  SidebarNavRow,
  SidebarNavSection,
  SidebarNavTitle,
} from '@adea-ai/ui/components/layout/sidebar-nav'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Button } from '@adea-ai/ui/components/ui/button'
import { EmptyDescription } from '@adea-ai/ui/components/ui/empty'
import { Separator } from '@adea-ai/ui/components/ui/separator'
import { StatusChip } from '@adea-ai/ui/components/ui/status-chip'
import { ChevronsUpDown, Eye, EyeOff, GitMerge, Inbox, Plus } from 'lucide-solid'
import { For, Show, createEffect, createSignal, onCleanup, type JSX } from 'solid-js'

import {
  reduceDragBar,
  type DragBarEvent,
  type DragBarGesture,
  type DragBarZone,
} from '../model/drag-bar'
import { monogram, unregisteredNotice, type TreeProject } from '../model/tree'
import type { Tone } from '../model/types'
import type { SourceControlState } from '../state'

const ciTone: Record<string, Tone> = {
  success: 'success',
  failure: 'danger',
  pending: 'info',
  none: 'unknown',
}
const ciWord: Record<string, string> = {
  success: 'is passing',
  failure: 'is failing',
  pending: 'is running',
  none: 'has no checks',
}

/** Pointer wiring the sidebar gives each row that sits on one side of the bar. */
type DragRowControls = {
  /** True when the row's just-finished drag consumed its click. */
  takeConsumedClick(): boolean
  /** True while this row is the one being dragged. */
  dragged(): boolean
  onPointerDown(event: PointerEvent): void
  onPointerMove(event: PointerEvent): void
  onPointerUp(event: PointerEvent): void
  onPointerCancel(event: PointerEvent): void
  onLostPointerCapture(event: PointerEvent): void
}

function ProjectRow(props: {
  row: TreeProject
  state: SourceControlState
  /**
   * The row's place relative to the show-more bar: `false` above (the
   * control hides it), `true` below in the collapsed group (the control
   * restores it), `undefined` where hiding does not apply (the archived
   * section is already collapsed, and its rows never drag).
   */
  hidden?: boolean
  /** Pointer drag wiring; absent for rows the bar does not move. */
  drag?: DragRowControls
}): JSX.Element {
  const selected = () => {
    const current = props.state.selection()
    return current?.kind === 'project' && current.repoId === props.row.repoId
  }
  const count = () =>
    props.row.openCount === undefined
      ? undefined
      : `${props.row.openCount}${props.row.openCountMore ? '+' : ''}`
  const hiddenControl = () =>
    props.hidden === undefined
      ? undefined
      : props.hidden
        ? {
            label: `Show ${props.row.name} in the sidebar`,
            icon: <Eye aria-hidden="true" />,
          }
        : {
            label: `Hide ${props.row.name} below the show-more line`,
            icon: <EyeOff aria-hidden="true" />,
          }
  return (
    <SidebarNavRow
      actions={
        props.hidden === undefined ? undefined : (
          <Show when={hiddenControl()}>
            {(control) => (
              <ActionButton
                variant="ghost"
                size="icon-2xs"
                tooltip={control().label}
                aria-label={control().label}
                onClick={() => props.state.setRepoHidden(props.row.repoId, props.hidden !== true)}
              >
                {control().icon}
              </ActionButton>
            )}
          </Show>
        )
      }
    >
      <SidebarNavItem
        as="button"
        type="button"
        nested
        active={selected()}
        aria-current={selected() ? 'page' : undefined}
        title={
          props.row.projectName === props.row.name ? undefined : `Project ${props.row.projectName}`
        }
        class={cn('dev-scm-drag-row', {
          'dev-scm-drag-row--dragging': props.drag?.dragged() === true,
        })}
        {...(props.drag
          ? {
              onPointerDown: props.drag.onPointerDown,
              onPointerMove: props.drag.onPointerMove,
              onPointerUp: props.drag.onPointerUp,
              onPointerCancel: props.drag.onPointerCancel,
              onLostPointerCapture: props.drag.onLostPointerCapture,
            }
          : {})}
        onClick={() => {
          // A drag (or an aborted press) consumed the pointer: the row's
          // click must not also move the selection.
          if (props.drag?.takeConsumedClick() === true) return
          props.state.select({
            kind: 'project',
            repoId: props.row.repoId,
            projectId: props.row.projectId,
          })
        }}
        data-repo-id={props.row.repoId}
      >
        <StatusChip
          compact
          tone={props.row.ci ? (ciTone[props.row.ci] ?? 'unknown') : 'unknown'}
          label={
            props.row.ci
              ? `Default branch ${ciWord[props.row.ci]}`
              : 'Default branch status unknown'
          }
        />
        <span class="dev-scm-truncate">{props.row.name}</span>
        <Show when={count()}>
          {(value) => (
            <span class="dev-scm-count" aria-label={`${value()} open pull requests`}>
              {value()}
            </span>
          )}
        </Show>
      </SidebarNavItem>
    </SidebarNavRow>
  )
}

export function SourceControlSidebar(props: {
  state: SourceControlState
  open: boolean
  onConnect(): void
}): JSX.Element {
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set())
  const [archivedOpen, setArchivedOpen] = createSignal(false)
  const [hiddenOpen, setHiddenOpen] = createSignal(false)
  const toggle = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  /** Active rows below the show-more bar, across every owner. */
  const hiddenRows = () =>
    props.state
      .tree()
      .owners.flatMap((owner) => owner.projects)
      .filter((row) => props.state.isRepoHidden(row.repoId))
  const shortcutActive = (id: 'needs_you' | 'ready') => {
    const current = props.state.selection()
    return current?.kind === 'shortcut' && current.id === id
  }

  // ── The show-more bar's pointer drag ──────────────────────────────────
  // Mechanics mirror the published resize handle: capture on press, decide
  // on move, commit or abort on release — Escape, pointer cancellation and
  // lost capture abort without a drop, and a drag never ends in a click.
  const [gesture, setGesture] = createSignal<DragBarGesture>()
  const [consumedClick, setConsumedClick] = createSignal(false)
  let barElement: HTMLDivElement | undefined
  const dragging = () => gesture()?.phase === 'drag'
  const dropArmed = () => {
    const current = gesture()
    return current !== undefined && current.phase === 'drag' && current.zone !== current.origin
  }
  const handleDragEvent = (event: DragBarEvent) => {
    const outcome = reduceDragBar(gesture(), event)
    setGesture(outcome.gesture)
    if (outcome.consumed) setConsumedClick(true)
    if (outcome.drop) props.state.setRepoHidden(outcome.drop.repoId, outcome.drop.hidden)
  }
  /** One row's drag wiring; only rows on one side of the bar get one. */
  const dragControls = (repoId: string, origin: DragBarZone): DragRowControls => ({
    takeConsumedClick: () => {
      if (!consumedClick()) return false
      setConsumedClick(false)
      return true
    },
    dragged: () => gesture()?.repoId === repoId && dragging(),
    onPointerDown: (event) => {
      if (event.button !== 0 || !event.isPrimary) return
      const bar = barElement
      if (!bar) return
      // A fresh press always starts a new gesture: a leftover consumed flag
      // from an earlier drag must not eat this row's click.
      setConsumedClick(false)
      const barRect = bar.getBoundingClientRect()
      handleDragEvent({
        type: 'press',
        repoId,
        pointerId: event.pointerId,
        origin,
        y: event.clientY,
        barY: barRect.top + barRect.height / 2,
      })
      const row = event.currentTarget
      if (row instanceof HTMLElement) row.setPointerCapture(event.pointerId)
    },
    onPointerMove: (event) => {
      handleDragEvent({ type: 'move', pointerId: event.pointerId, y: event.clientY })
    },
    onPointerUp: (event) => {
      handleDragEvent({ type: 'release', pointerId: event.pointerId })
    },
    onPointerCancel: () => {
      handleDragEvent({ type: 'cancel' })
    },
    onLostPointerCapture: () => {
      handleDragEvent({ type: 'cancel' })
    },
  })
  // Escape aborts an active drag from wherever focus sits; capture phase so
  // nothing else consumes it first.
  const onDragKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') handleDragEvent({ type: 'escape' })
  }
  createEffect(() => {
    if (!gesture()) return
    window.addEventListener('keydown', onDragKey, true)
    onCleanup(() => window.removeEventListener('keydown', onDragKey, true))
  })

  return (
    <div class={cn('dev-sidebar', { 'dev-sidebar--open': props.open })}>
      <SidebarNav as="aside" class="h-full w-full" aria-label="Accounts and projects">
        <SidebarNavHeader>
          <SidebarNavTitle as="h2">Source control</SidebarNavTitle>
        </SidebarNavHeader>
        <SidebarNavContent>
          <nav class="flex flex-col gap-1" aria-label="Pull request shortcuts">
            <SidebarNavItem
              as="button"
              type="button"
              active={shortcutActive('needs_you')}
              aria-current={shortcutActive('needs_you') ? 'page' : undefined}
              onClick={() => props.state.select({ kind: 'shortcut', id: 'needs_you' })}
              trailing={
                <Badge
                  size="sm"
                  variant={props.state.shortcutCounts().needsYou > 0 ? 'default' : 'secondary'}
                >
                  {props.state.shortcutCounts().needsYou}
                </Badge>
              }
            >
              <Inbox aria-hidden="true" />
              <span>Needs you</span>
            </SidebarNavItem>
            <SidebarNavItem
              as="button"
              type="button"
              active={shortcutActive('ready')}
              aria-current={shortcutActive('ready') ? 'page' : undefined}
              onClick={() => props.state.select({ kind: 'shortcut', id: 'ready' })}
              trailing={
                <Badge size="sm" variant="secondary">
                  {props.state.shortcutCounts().ready}
                </Badge>
              }
            >
              <GitMerge aria-hidden="true" />
              <span>Ready to merge</span>
            </SidebarNavItem>
          </nav>
          <nav class="mt-3 flex flex-col gap-3" aria-label="Accounts and projects">
            <Show
              when={props.state.tree().owners.some((owner) => owner.projects.length > 0)}
              fallback={
                <Show when={props.state.catalogLoaded()}>
                  <Show
                    when={
                      props.state.tree().unregistered > 0 ||
                      props.state.tree().unregisteredArchived > 0
                    }
                    fallback={
                      <EmptyDescription>
                        No projects with a GitHub or GitLab repository yet. Add one in the Dev view.
                      </EmptyDescription>
                    }
                  >
                    <EmptyDescription>
                      {unregisteredNotice(
                        props.state.tree().unregistered,
                        props.state.tree().unregisteredArchived
                      )}
                    </EmptyDescription>
                  </Show>
                </Show>
              }
            >
              <>
                <For each={props.state.tree().owners}>
                  {(owner) => (
                    <Show
                      when={owner.projects.some((row) => !props.state.isRepoHidden(row.repoId))}
                    >
                      <SidebarNavSection
                        label={owner.owner}
                        headingAs="h3"
                        collapsible
                        open={!collapsed().has(owner.key)}
                        onOpenChange={() => toggle(owner.key)}
                        action={
                          <span class="dev-scm-tree__owner" aria-hidden="true">
                            <span class="dev-scm-mark">{monogram(owner.owner)}</span>
                            <span class="dev-scm-provider">{owner.providerName}</span>
                          </span>
                        }
                      >
                        <For each={owner.projects}>
                          {(row) => (
                            <Show when={!props.state.isRepoHidden(row.repoId)}>
                              <ProjectRow
                                row={row}
                                state={props.state}
                                hidden={false}
                                drag={dragControls(row.repoId, 'above')}
                              />
                            </Show>
                          )}
                        </For>
                      </SidebarNavSection>
                    </Show>
                  )}
                </For>
                <div
                  ref={(element) => (barElement = element)}
                  class="dev-scm-dragbar"
                  data-dragging={dragging() ? '' : undefined}
                  data-armed={dropArmed() ? '' : undefined}
                >
                  <Separator orientation="horizontal" class="dev-scm-dragbar__line" />
                  <Show when={hiddenRows().length > 0}>
                    <ActionButton
                      variant="ghost"
                      size="icon-2xs"
                      class="dev-scm-dragbar__grip"
                      tooltip={
                        hiddenOpen() ? 'Collapse the show-more group' : 'Expand the show-more group'
                      }
                      aria-label={
                        hiddenOpen() ? 'Collapse the show-more group' : 'Expand the show-more group'
                      }
                      onClick={() => setHiddenOpen((open) => !open)}
                    >
                      <ChevronsUpDown aria-hidden="true" />
                    </ActionButton>
                  </Show>
                </div>
                <Show when={hiddenRows().length > 0}>
                  <SidebarNavSection
                    label="Hidden repositories"
                    headingAs="h3"
                    collapsible
                    open={hiddenOpen()}
                    onOpenChange={setHiddenOpen}
                    count={hiddenRows().length}
                  >
                    <For each={hiddenRows()}>
                      {(row) => (
                        <ProjectRow
                          row={row}
                          state={props.state}
                          hidden
                          drag={dragControls(row.repoId, 'below')}
                        />
                      )}
                    </For>
                  </SidebarNavSection>
                </Show>
              </>
            </Show>
            <Show when={props.state.tree().archived.length > 0}>
              <SidebarNavSection
                label="Archived projects"
                headingAs="h3"
                collapsible
                open={archivedOpen()}
                onOpenChange={setArchivedOpen}
                count={props.state.tree().archived.length}
              >
                <For each={props.state.tree().archived}>
                  {(row) => <ProjectRow row={row} state={props.state} />}
                </For>
              </SidebarNavSection>
            </Show>
            <Show when={props.state.tree().skipped > 0}>
              <EmptyDescription>
                {props.state.tree().skipped === 1
                  ? '1 project has no GitHub or GitLab repository.'
                  : `${props.state.tree().skipped} projects have no GitHub or GitLab repository.`}
              </EmptyDescription>
            </Show>
          </nav>
        </SidebarNavContent>
        <SidebarNavFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            class="w-full justify-start"
            onClick={() => props.onConnect()}
          >
            <Plus aria-hidden="true" />
            Connect account
          </Button>
        </SidebarNavFooter>
      </SidebarNav>
    </div>
  )
}
