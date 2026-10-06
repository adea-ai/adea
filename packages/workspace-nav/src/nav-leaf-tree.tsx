import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { Tree, TreeRow, type TreeItemDescriptor } from '@adea-ai/ui/components/composites/tree'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Text } from '@adea-ai/ui/components/ui/typography'
import { CircleAlert, House, Plus } from 'lucide-solid'
import { For, Show, createMemo, createSignal, type JSX } from 'solid-js'

import type { NavMenuItemId, ViewAdapter } from './adapters'
import {
  groupTree,
  projectCollapsedSummary,
  type LeafStatus,
  type NavGroupMode,
  type NavLeaf,
  type NavProject,
} from './model'
import { LeafStatusIcon, ProjectIcon } from './nav-icons'
import { NavRowMenu } from './nav-row-menu'

export type NavLeafTreeProps = {
  /** The tree's accessible name, e.g. "Adea projects". */
  label: string
  projects: readonly NavProject[]
  adapter: ViewAdapter
  groupBy: NavGroupMode
  selectedLeafId?: string | null
  onSelectLeaf: (leaf: NavLeaf, project: NavProject) => void
  onCreateLeaf?: (project: NavProject) => void
  onProjectMenuAction?: (id: NavMenuItemId, project: NavProject) => void
  onLeafMenuAction?: (id: NavMenuItemId, leaf: NavLeaf, project: NavProject) => void
  /** Hover or focus on a leaf: the host may prefetch what selecting it shows. */
  onLeafIntent?: (leaf: NavLeaf) => void
  /** Controlled collapsed projects; omit to let the tree keep its own. */
  collapsedProjectIds?: ReadonlySet<string>
  onProjectExpandedChange?: (projectId: string, expanded: boolean) => void
  portalMount?: HTMLElement
  /** False inside a modal sheet; see `WorkspaceNavProps.tooltips`. */
  tooltips?: boolean
}

const projectKey = (id: string) => `project:${id}`
const leafKey = (id: string) => `leaf:${id}`
const groupKey = (status: LeafStatus) => `group:${status}`

/**
 * The active workspace's projects and leaves as one keyboard tree. Grouping by
 * project keeps the hierarchy (checkout, "Worktrees" divider, worktrees and
 * tasks); status and recent groupings flatten the leaves and label each with
 * its project. All data and actions arrive through props.
 */
export function NavLeafTree(props: NavLeafTreeProps) {
  const [ownCollapsed, setOwnCollapsed] = createSignal<ReadonlySet<string>>(new Set())
  const [activeId, setActiveId] = createSignal<string | null>(null)

  const isProjectExpanded = (id: string) =>
    props.collapsedProjectIds
      ? !props.collapsedProjectIds.has(id)
      : !ownCollapsed().has(projectKey(id))
  const isGroupExpanded = (status: LeafStatus) => !ownCollapsed().has(groupKey(status))

  const setOwn = (key: string, expanded: boolean) =>
    setOwnCollapsed((current) => {
      const next = new Set(current)
      if (expanded) next.delete(key)
      else next.add(key)
      return next
    })

  const setProjectExpanded = (id: string, expanded: boolean) => {
    if (props.collapsedProjectIds === undefined) setOwn(projectKey(id), expanded)
    props.onProjectExpandedChange?.(id, expanded)
  }

  const grouping = createMemo(() => groupTree(props.projects, props.groupBy))
  const projectsById = createMemo(
    () => new Map(props.projects.map((project) => [project.id, project]))
  )

  /** Every visible row in render order, plus how to activate or expand it. */
  const rows = createMemo(() => {
    const items: TreeItemDescriptor[] = []
    const leaves = new Map<string, { leaf: NavLeaf; project: NavProject }>()
    const current = grouping()
    if (current.mode === 'project') {
      for (const { project, leaves: projectLeaves } of current.projects) {
        const expanded = isProjectExpanded(project.id)
        const id = projectKey(project.id)
        items.push({
          id,
          parentId: null,
          level: 1,
          expandable: projectLeaves.length > 0,
          expanded,
        })
        if (!expanded) continue
        for (const leaf of projectLeaves) {
          leaves.set(leafKey(leaf.id), { leaf, project })
          items.push({
            id: leafKey(leaf.id),
            parentId: id,
            level: 2,
            expandable: false,
            expanded: false,
          })
        }
      }
    } else if (current.mode === 'status') {
      for (const group of current.groups) {
        const id = groupKey(group.status)
        const expanded = isGroupExpanded(group.status)
        items.push({ id, parentId: null, level: 1, expandable: true, expanded })
        if (!expanded) continue
        for (const entry of group.items) {
          const project = projectsById().get(entry.projectId)
          if (!project) continue
          leaves.set(leafKey(entry.leaf.id), { leaf: entry.leaf, project })
          items.push({
            id: leafKey(entry.leaf.id),
            parentId: id,
            level: 2,
            expandable: false,
            expanded: false,
          })
        }
      }
    } else {
      for (const entry of current.items) {
        const project = projectsById().get(entry.projectId)
        if (!project) continue
        leaves.set(leafKey(entry.leaf.id), { leaf: entry.leaf, project })
        items.push({
          id: leafKey(entry.leaf.id),
          parentId: null,
          level: 1,
          expandable: false,
          expanded: false,
        })
      }
    }
    return { items, leaves, byId: new Map(items.map((item) => [item.id, item])) }
  })

  const descriptor = (id: string): TreeItemDescriptor =>
    rows().byId.get(id) ?? { id, parentId: null, level: 1, expandable: false, expanded: false }

  const expand = (id: string, expanded: boolean) => {
    if (id.startsWith('project:')) setProjectExpanded(id.slice('project:'.length), expanded)
    else if (id.startsWith('group:')) setOwn(id, expanded)
  }

  const activate = (id: string) => {
    const leaf = rows().leaves.get(id)
    if (leaf) {
      props.onSelectLeaf(leaf.leaf, leaf.project)
      return
    }
    const item = rows().byId.get(id)
    if (item?.expandable) expand(id, !item.expanded)
  }

  const leafRow = (leaf: NavLeaf, project: NavProject, showProject: boolean): JSX.Element => {
    const label = () => props.adapter.leafLabel(leaf, project)
    // Flat groupings lead every row with its status; only the project
    // hierarchy gives the checkout its own house row.
    const isCheckoutRow = () =>
      !showProject && leaf.kind === 'checkout' && props.adapter.showCheckoutRow
    const menuLabel = () => `Options for ${label().text}`
    return (
      <TreeRow
        item={descriptor(leafKey(leaf.id))}
        selected={props.selectedLeafId === leaf.id}
        class="workspace-nav-row"
        data-leaf-id={leaf.id}
        data-leaf-kind={leaf.kind}
        title={props.adapter.leafSecondary(leaf)}
        onPointerEnter={() => props.onLeafIntent?.(leaf)}
        onFocusIn={() => props.onLeafIntent?.(leaf)}
        leading={
          isCheckoutRow() ? <House aria-hidden="true" /> : <LeafStatusIcon status={leaf.status} />
        }
        trailing={
          <>
            <Show
              when={isCheckoutRow()}
              fallback={
                <Show when={leaf.diff || leaf.pullRequest}>
                  <span class="workspace-nav-row-meta">
                    <LeafMeta leaf={leaf} />
                  </span>
                </Show>
              }
            >
              <Show when={leaf.status === 'running' || leaf.status === 'needs_you'}>
                <span class="flex items-center">
                  <LeafStatusIcon status={leaf.status} class="size-3.5" />
                </span>
              </Show>
            </Show>
            <LeafUnread leaf={leaf} />
            {/* A leaf with nothing to offer gets no empty menu trigger. */}
            <Show when={props.adapter.leafMenu(leaf).length > 0}>
              <span class="workspace-nav-row-actions">
                <NavRowMenu
                  label={menuLabel()}
                  items={props.adapter.leafMenu(leaf)}
                  portalMount={props.portalMount}
                  tooltips={props.tooltips}
                  onSelect={(id) => props.onLeafMenuAction?.(id, leaf, project)}
                />
              </span>
            </Show>
          </>
        }
      >
        <Text variant={label().mono ? 'code' : 'label'}>{label().text}</Text>
        <Show when={showProject}>
          <Text variant="caption" tone="muted" class="ms-1.5">
            {project.name}
          </Text>
        </Show>
      </TreeRow>
    )
  }

  return (
    <Tree
      aria-label={props.label}
      visibleItems={rows().items}
      activeId={activeId()}
      onActiveIdChange={setActiveId}
      onExpand={expand}
      onActivate={activate}
      onSelectItem={activate}
    >
      <Show when={grouping().mode === 'project'}>
        <For each={projectGroups()}>
          {(group) => {
            const expanded = () => isProjectExpanded(group.project.id)
            const checkout = () =>
              props.adapter.showCheckoutRow
                ? group.leaves.find((leaf) => leaf.kind === 'checkout')
                : undefined
            const others = () =>
              props.adapter.showCheckoutRow
                ? group.leaves.filter((leaf) => leaf.kind !== 'checkout')
                : group.leaves
            const createLabel = () => props.adapter.createLeafLabel(group.project)
            const summary = () => projectCollapsedSummary(group.project)
            return (
              <>
                <TreeRow
                  item={descriptor(projectKey(group.project.id))}
                  class="workspace-nav-row"
                  data-project-id={group.project.id}
                  leading={<ProjectIcon icon={props.adapter.projectIcon(group.project)} />}
                  trailing={
                    <>
                      <Show when={!expanded() && summary()}>
                        <span class="workspace-nav-row-meta flex items-center gap-1">
                          <Show when={summary()?.endsWith('needs you')}>
                            <CircleAlert aria-hidden="true" class="size-3.5 text-warning" />
                          </Show>
                          <Text variant="caption" tone="muted">
                            {summary()}
                          </Text>
                        </span>
                      </Show>
                      <span class="workspace-nav-row-actions">
                        <Show when={props.onCreateLeaf}>
                          <ActionButton
                            variant="ghost"
                            size="icon-xs"
                            tooltip={props.tooltips === false ? undefined : createLabel()}
                            aria-label={`${createLabel()} in ${group.project.name}`}
                            onClick={() => props.onCreateLeaf?.(group.project)}
                          >
                            <Plus aria-hidden="true" />
                          </ActionButton>
                        </Show>
                        <Show when={props.adapter.projectMenu(group.project).length > 0}>
                          <NavRowMenu
                            // Named for the noun: in Chat and Virtual the default
                            // leaf carries the project's name, so its own
                            // "Options for …" menu must not share this name.
                            label={`${props.adapter.nouns.project} options for ${group.project.name}`}
                            items={props.adapter.projectMenu(group.project)}
                            portalMount={props.portalMount}
                            tooltips={props.tooltips}
                            onSelect={(id) => props.onProjectMenuAction?.(id, group.project)}
                          />
                        </Show>
                      </span>
                    </>
                  }
                >
                  <Text variant="label">{group.project.name}</Text>
                </TreeRow>
                <Show when={expanded()}>
                  <Show when={checkout()}>{(leaf) => leafRow(leaf(), group.project, false)}</Show>
                  <Show when={checkout() && others().length > 0}>
                    <div aria-hidden="true" class="workspace-nav-divider">
                      <span class="text-2xs font-medium tracking-wide text-sidebar-muted-foreground/60 uppercase">
                        Worktrees
                      </span>
                      <span class="h-px flex-1 bg-sidebar-border" />
                    </div>
                  </Show>
                  <For each={others()}>{(leaf) => leafRow(leaf, group.project, false)}</For>
                </Show>
              </>
            )
          }}
        </For>
      </Show>
      <Show when={grouping().mode === 'status'}>
        <For each={statusGroups()}>
          {(group) => (
            <>
              <TreeRow
                item={descriptor(groupKey(group.status))}
                class="workspace-nav-row workspace-nav-group-header"
                data-status-group={group.status}
                trailing={
                  <Text variant="micro" numeric>
                    {group.items.length}
                  </Text>
                }
              >
                {group.label}
              </TreeRow>
              <Show when={isGroupExpanded(group.status)}>
                <For each={group.items}>
                  {(entry) => (
                    <Show when={projectsById().get(entry.projectId)}>
                      {(project) => leafRow(entry.leaf, project(), true)}
                    </Show>
                  )}
                </For>
              </Show>
            </>
          )}
        </For>
      </Show>
      <Show when={grouping().mode === 'recent'}>
        <For each={recentItems()}>
          {(entry) => (
            <Show when={projectsById().get(entry.projectId)}>
              {(project) => leafRow(entry.leaf, project(), true)}
            </Show>
          )}
        </For>
      </Show>
    </Tree>
  )

  function projectGroups() {
    const current = grouping()
    return current.mode === 'project' ? current.projects : []
  }

  function statusGroups() {
    const current = grouping()
    return current.mode === 'status' ? current.groups : []
  }

  function recentItems() {
    const current = grouping()
    return current.mode === 'recent' ? current.items : []
  }
}

/**
 * The leaf's unread count (or a dot for a manual mark). The row's name stays
 * the leaf label; the count is announced as words.
 */
function LeafUnread(props: { leaf: NavLeaf }) {
  const unread = () => props.leaf.unread
  const visible = () => (unread()?.count ?? 0) > 0 || Boolean(unread()?.marked)
  return (
    <Show when={visible()}>
      <Badge variant="secondary" size="sm" data-slot="workspace-nav-unread">
        <span aria-hidden="true">
          {(unread()?.count ?? 0) > 99 ? '99+' : unread()?.count || '•'}
        </span>
        <span class="visually-hidden">
          {(unread()?.count ?? 0) > 0 ? `${unread()!.count} unread` : 'Marked unread'}
        </span>
      </Badge>
    </Show>
  )
}

/** Diff counts or the pull request number; words for assistive technology. */
function LeafMeta(props: { leaf: NavLeaf }) {
  return (
    <Show
      when={props.leaf.diff}
      fallback={
        <Show when={props.leaf.pullRequest}>
          {(pullRequest) => (
            <Text variant="caption" tone="muted" numeric>
              <span aria-hidden="true">#{pullRequest().number}</span>
              <span class="visually-hidden">Pull request {pullRequest().number}</span>
            </Text>
          )}
        </Show>
      }
    >
      {(diff) => (
        <Text variant="caption" numeric>
          <span aria-hidden="true">
            <span class="text-success">+{diff().added}</span>{' '}
            <span class="text-destructive">−{diff().removed}</span>
          </span>
          <span class="visually-hidden">
            {diff().added} lines added, {diff().removed} removed
          </span>
        </Text>
      )}
    </Show>
  )
}
