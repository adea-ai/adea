import '@adea-ai/app-ui/workspace-nav.css'

import { useOptionalTheme } from '@adea-ai/ui/components/theme/lazy'
import { paintWorkspaceAccent } from '@adea-ai/app-ui/components/workspace-accent'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { Button } from '@adea-ai/ui/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@adea-ai/ui/components/ui/dropdown-menu'
import { Text } from '@adea-ai/ui/components/ui/typography'
import { ChevronDown, FolderPlus, ListFilter } from 'lucide-solid'
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  type JSX,
} from 'solid-js'

import { createViewAdapter, type NavMenuItemId, type NavView, type ViewAdapter } from './adapters'
import {
  activeWorkspace,
  emptyWorkspaceHint,
  navGroupModes,
  type NavGroupMode,
  type NavLeaf,
  type NavProject,
  type NavTree,
} from './model'
import { NavLeafTree } from './nav-leaf-tree'

export { describeWorkspaceCreationContext } from './workspace-creation-context'
export type { WorkspaceCreationContext } from './workspace-creation-context'

export type WorkspaceNavProps = {
  tree: NavTree
  /** The view whose words and menus the tree uses; ignored when `adapter` is set. */
  view?: NavView
  adapter?: ViewAdapter
  /** Show "Switch branch…" on checkout menus when the default adapter is used. */
  branchSwitching?: boolean
  groupBy: NavGroupMode
  onGroupByChange: (mode: NavGroupMode) => void
  selectedLeafId?: string | null
  onSelectLeaf: (leaf: NavLeaf, project: NavProject) => void
  /** Adds a project to the selected workspace; the heading's button hides without it. */
  onCreateProject?: () => void
  /**
   * The create affordance stays mounted while its action is unavailable (a
   * runtime scope still resolving, a workspace still preparing) — a disabled
   * control reads as "not yet", an absent one as "never".
   */
  createDisabled?: boolean
  /** Opens a project's settings; each project row shows the button only when present. */
  onOpenProjectSettings?: (project: NavProject) => void
  onCreateLeaf?: (project: NavProject) => void
  onProjectMenuAction?: (id: NavMenuItemId, project: NavProject) => void
  onLeafMenuAction?: (id: NavMenuItemId, leaf: NavLeaf, project: NavProject) => void
  /** Hover or focus on a leaf, for prefetching what selecting it shows. */
  onLeafIntent?: (leaf: NavLeaf) => void
  /** Controlled collapsed projects of the selected workspace. */
  collapsedProjectIds?: ReadonlySet<string>
  onProjectExpandedChange?: (projectId: string, expanded: boolean) => void
  /** Host quick actions (Agents, Mark all read) above the projects. */
  quickActions?: JSX.Element
  /** The selected workspace's Conversations section. */
  conversations?: JSX.Element
  /** The host's footer (archive shelf). */
  footer?: JSX.Element
  portalMount?: HTMLElement
  /**
   * False inside a modal sheet: a focus tooltip there registers a top-most
   * dismissable layer that swallows the Escape meant to close the sheet.
   * Accessible names still carry every action.
   */
  tooltips?: boolean
  /** The navigation landmark's name. */
  label?: string
}

/**
 * WorkspaceNav.
 *
 * The shared contextual sidebar: everything in it belongs to the selected
 * workspace. The workspace itself is chosen from the top bar's switcher, so the
 * sidebar lists no other workspaces, no cross-workspace counts and no "needs
 * you" strip. From the top it holds the host's quick actions, the Projects
 * section (each project an independent accordion group of sessions, in the
 * chosen grouping), the workspace's Conversations and the host's footer.
 * Presentational only: every datum and action arrives through props.
 */
export function WorkspaceNav(props: WorkspaceNavProps) {
  const adapter = createMemo(
    () =>
      props.adapter ??
      createViewAdapter(props.view ?? 'dev', { branchSwitching: props.branchSwitching })
  )
  const workspace = createMemo(() => activeWorkspace(props.tree))
  const projects = () => workspace()?.projects ?? []
  const groupLabel = () =>
    navGroupModes.find((entry) => entry.mode === props.groupBy)?.label ?? 'Project'
  const headingId = `workspace-nav-heading-${createUniqueId()}`

  // The selected workspace themes its own subtree: project rows, selection and
  // focus rings follow its accent; a null accent inherits the app's.
  const theme = useOptionalTheme()
  const [host, setHost] = createSignal<HTMLElement>()
  createEffect(() => {
    const element = host()
    if (element) paintWorkspaceAccent(element, workspace()?.accent ?? null, theme)
  })

  return (
    <nav
      ref={setHost}
      aria-label={props.label ?? 'Workspace'}
      data-slot="workspace-nav"
      data-workspace-id={workspace()?.id}
      class="flex min-w-0 flex-col gap-3"
    >
      <Show when={props.quickActions}>
        <div class="flex flex-col gap-0.5">{props.quickActions}</div>
      </Show>
      <section
        aria-labelledby={headingId}
        data-slot="workspace-nav-projects"
        class="flex min-w-0 flex-col gap-0.5"
      >
        {/* The heading's actions stay visible: grouping and adding a project
            are primary affordances, not hover extras. */}
        <div class="flex min-w-0 items-center gap-1 py-1 ps-2 pe-1">
          <Text as="h2" variant="overline" id={headingId} class="min-w-0 flex-1">
            Projects
          </Text>
          <span class="flex shrink-0 items-center gap-0.5" data-slot="workspace-nav-actions">
            <DropdownMenu>
              {/* The current grouping is visible text, not only a tooltip. */}
              <DropdownMenuTrigger
                as={Button}
                variant="ghost"
                size="xs"
                aria-label={`Group by, currently ${groupLabel()}`}
                data-slot="workspace-nav-group-by"
              >
                <ListFilter aria-hidden="true" />
                <span>{groupLabel()}</span>
                <ChevronDown aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                hideArrow
                placement="bottom-end"
                gutter={4}
                portalMount={props.portalMount}
              >
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Group by</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={props.groupBy}
                    onChange={(value) => props.onGroupByChange(value as NavGroupMode)}
                  >
                    <For each={navGroupModes}>
                      {(entry) => (
                        <DropdownMenuRadioItem value={entry.mode} closeOnSelect>
                          <span class="flex min-w-0 flex-col">
                            <span>{entry.label}</span>
                            <Text variant="caption" tone="muted">
                              {entry.description}
                            </Text>
                          </span>
                        </DropdownMenuRadioItem>
                      )}
                    </For>
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Show when={props.onCreateProject}>
              <ActionButton
                variant="ghost"
                size="icon-xs"
                disabled={props.createDisabled}
                tooltip={props.tooltips === false ? undefined : adapter().createProjectLabel}
                aria-label={adapter().createProjectLabel}
                data-slot="workspace-nav-add-project"
                onClick={() => props.onCreateProject?.()}
              >
                <FolderPlus aria-hidden="true" />
              </ActionButton>
            </Show>
          </span>
        </div>
        <Show
          when={projects().length > 0}
          fallback={
            <p class="px-2 py-1" data-slot="workspace-nav-empty">
              <Text variant="caption" tone="muted">
                {emptyWorkspaceHint(
                  adapter().nouns.project,
                  Boolean(props.onCreateProject) && props.createDisabled !== true
                )}
              </Text>
            </p>
          }
        >
          <NavLeafTree
            label={`${workspace()?.name ?? 'Workspace'} ${adapter().nouns.project.toLowerCase()}s`}
            projects={projects()}
            adapter={adapter()}
            groupBy={props.groupBy}
            selectedLeafId={props.selectedLeafId}
            onSelectLeaf={props.onSelectLeaf}
            onCreateLeaf={props.onCreateLeaf}
            onOpenProjectSettings={props.onOpenProjectSettings}
            onProjectMenuAction={props.onProjectMenuAction}
            onLeafMenuAction={props.onLeafMenuAction}
            onLeafIntent={props.onLeafIntent}
            collapsedProjectIds={props.collapsedProjectIds}
            onProjectExpandedChange={props.onProjectExpandedChange}
            portalMount={props.portalMount}
            tooltips={props.tooltips}
          />
        </Show>
      </section>
      <Show when={props.conversations}>{props.conversations}</Show>
      <Show when={props.footer}>{props.footer}</Show>
    </nav>
  )
}
