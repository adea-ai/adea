import '@adea-ai/app-ui/workspace-nav.css'

import { useOptionalTheme } from '@adea-ai/app-ui/components/theme-provider'
import { paintWorkspaceAccent } from '@adea-ai/app-ui/components/workspace-accent'
import { WorkspaceIdentityMark } from '@adea-ai/app-ui/components/workspace-identity-mark'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { SidebarNavButton, SidebarNavLabel } from '@adea-ai/ui/components/layout/sidebar-nav'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@adea-ai/ui/components/ui/dropdown-menu'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Heading, Text } from '@adea-ai/ui/components/ui/typography'
import {
  AtSign,
  CircleAlert,
  ListFilter,
  LoaderCircle,
  MessageSquare,
  Plus,
  Settings,
} from 'lucide-solid'
import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  on,
  onMount,
  type JSX,
} from 'solid-js'

import { createViewAdapter, type NavMenuItemId, type NavView, type ViewAdapter } from './adapters'
import {
  navGroupModes,
  sortWorkspaces,
  workspaceChips,
  type NavGroupMode,
  type NavLeaf,
  type NavProject,
  type NavTree,
  type NavWorkspace,
  type WorkspaceChip,
} from './model'
import { NavLeafTree } from './nav-leaf-tree'

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
  onSelectWorkspace: (workspaceId: string) => void
  onCreateWorkspace: (name: string) => void
  /**
   * Controlled inline-create state; omit to let the "New workspace" button own
   * it. While controlled, Enter keeps the draft row until the host closes it,
   * so a failed create can show `workspaceDraftError` beside the typed name.
   */
  creatingWorkspace?: boolean
  onCreatingWorkspaceChange?: (creating: boolean) => void
  /** Inline failure for the controlled draft; the typed name is kept. */
  workspaceDraftError?: string
  /** The controlled draft's create request is in flight. */
  workspaceDraftPending?: boolean
  onCreateProject?: (workspaceId: string) => void
  onOpenWorkspaceSettings?: (workspaceId: string) => void
  onCreateLeaf?: (project: NavProject) => void
  onProjectMenuAction?: (id: NavMenuItemId, project: NavProject) => void
  onLeafMenuAction?: (id: NavMenuItemId, leaf: NavLeaf, project: NavProject) => void
  /** Hover or focus on a leaf, for prefetching what selecting it shows. */
  onLeafIntent?: (leaf: NavLeaf) => void
  /** Controlled collapsed projects of the active workspace. */
  collapsedProjectIds?: ReadonlySet<string>
  onProjectExpandedChange?: (projectId: string, expanded: boolean) => void
  /** "Needs you" strip activation; defaults to grouping by status. */
  onNeedsYou?: () => void
  /** Host quick actions (Agents, Mark all read) above the strip. */
  quickActions?: JSX.Element
  /** The host's global Conversations section. */
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
 * The shared contextual sidebar of ADR 0011: quick actions, the cross-workspace
 * "Needs you" strip, the workspace accordion (only the active workspace is
 * expanded; the others are one row each with status chips), the active
 * workspace's project tree in the chosen grouping, and the host's
 * Conversations and footer slots. Presentational only: every datum and action
 * arrives through props.
 */
export function WorkspaceNav(props: WorkspaceNavProps) {
  const adapter = createMemo(
    () =>
      props.adapter ??
      createViewAdapter(props.view ?? 'dev', { branchSwitching: props.branchSwitching })
  )
  const workspaces = createMemo(() => sortWorkspaces(props.tree.workspaces))
  const [ownCreating, setOwnCreating] = createSignal(false)
  const creating = () => props.creatingWorkspace ?? ownCreating()
  const setCreating = (next: boolean) => {
    if (props.creatingWorkspace === undefined) setOwnCreating(next)
    props.onCreatingWorkspaceChange?.(next)
  }
  const groupLabel = () =>
    navGroupModes.find((entry) => entry.mode === props.groupBy)?.label ?? 'Project'
  const headingId = `workspace-nav-heading-${createUniqueId()}`

  return (
    <nav
      aria-label={props.label ?? 'Workspaces'}
      data-slot="workspace-nav"
      class="flex min-w-0 flex-col gap-3"
    >
      <Show when={props.quickActions}>
        <div class="flex flex-col gap-0.5">{props.quickActions}</div>
      </Show>
      <Show when={props.tree.needsYou > 0}>
        <SidebarNavButton
          data-slot="workspace-nav-needs-you"
          aria-pressed={props.groupBy === 'status'}
          onClick={() => (props.onNeedsYou ?? (() => props.onGroupByChange('status')))()}
        >
          <CircleAlert aria-hidden="true" class="text-warning" />
          <SidebarNavLabel>Needs you</SidebarNavLabel>
          <Badge variant="warning" size="sm">
            {props.tree.needsYou}
          </Badge>
        </SidebarNavButton>
      </Show>
      <section
        aria-labelledby={headingId}
        data-slot="workspace-nav-workspaces"
        class="flex min-w-0 flex-col gap-0.5"
      >
        {/* The heading's actions stay visible: grouping and creating a
            workspace are primary affordances, not hover extras. */}
        <div class="flex min-w-0 items-center gap-1 py-1 ps-2 pe-1">
          <h2
            id={headingId}
            class="min-w-0 flex-1 truncate text-2xs font-medium tracking-wide text-sidebar-muted-foreground uppercase"
          >
            Workspaces
          </h2>
          <span class="flex shrink-0 items-center gap-0.5" data-slot="workspace-nav-actions">
            <DropdownMenu>
              <DropdownMenuTrigger
                as={ActionButton}
                variant="ghost"
                size="icon-xs"
                tooltip={props.tooltips === false ? undefined : `Group by: ${groupLabel()}`}
                aria-label={`Group by, currently ${groupLabel()}`}
              >
                <ListFilter aria-hidden="true" />
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
            <ActionButton
              variant="ghost"
              size="icon-xs"
              tooltip={props.tooltips === false ? undefined : 'New workspace'}
              aria-label="New workspace"
              onClick={() => setCreating(true)}
            >
              <Plus aria-hidden="true" />
            </ActionButton>
          </span>
        </div>
        <For each={workspaces()}>
          {(workspace) => (
            <Show
              when={workspace.id === props.tree.activeWorkspaceId}
              fallback={
                <CollapsedWorkspaceRow
                  workspace={workspace}
                  onSelect={() => props.onSelectWorkspace(workspace.id)}
                />
              }
            >
              <ActiveWorkspace {...props} workspace={workspace} adapter={adapter()} />
            </Show>
          )}
        </For>
        <Show when={creating()}>
          <WorkspaceDraftRow
            controlled={props.creatingWorkspace !== undefined}
            error={props.workspaceDraftError}
            pending={props.workspaceDraftPending}
            onCreate={(name) => {
              // A host-owned draft stays open until the host closes it, so a
              // failure can be shown beside the name the user typed.
              if (props.creatingWorkspace === undefined) setCreating(false)
              props.onCreateWorkspace(name)
            }}
            onCancel={() => setCreating(false)}
          />
        </Show>
      </section>
      <Show when={props.conversations}>{props.conversations}</Show>
      <Show when={props.footer}>{props.footer}</Show>
    </nav>
  )
}

function ChipIcon(props: { chip: WorkspaceChip }) {
  return (
    <Switch>
      <Match when={props.chip.kind === 'needs_you'}>
        <CircleAlert aria-hidden="true" />
      </Match>
      <Match when={props.chip.kind === 'running'}>
        <LoaderCircle aria-hidden="true" />
      </Match>
      <Match when={props.chip.kind === 'mention'}>
        <AtSign aria-hidden="true" />
      </Match>
      <Match when={props.chip.kind === 'unread'}>
        <MessageSquare aria-hidden="true" />
      </Match>
    </Switch>
  )
}

const chipVariant = {
  needs_you: 'warning',
  running: 'info',
  mention: 'subtle',
  unread: 'secondary',
} as const

/** A collapsed workspace: one row whose click switches to it. */
function CollapsedWorkspaceRow(props: { workspace: NavWorkspace; onSelect: () => void }) {
  return (
    <SidebarNavButton
      data-workspace-id={props.workspace.id}
      aria-description="Switch to this workspace"
      onClick={() => props.onSelect()}
    >
      <span aria-hidden="true" class="flex shrink-0">
        <WorkspaceIdentityMark
          accent={props.workspace.accent}
          logo={props.workspace.logo}
          name={props.workspace.name}
          size="xs"
        />
      </span>
      <SidebarNavLabel>{props.workspace.name}</SidebarNavLabel>
      {/* The row keeps the name readable: the most urgent chip is shown,
          and every chip is announced. */}
      <Show when={workspaceChips(props.workspace)[0]}>
        {(chip) => (
          // The chip gives way before the name does: in a narrow column (or
          // at a large root size) it truncates while the name keeps width.
          <Badge
            variant={chipVariant[chip().kind]}
            size="sm"
            data-chip={chip().kind}
            aria-hidden="true"
            class="max-w-1/2 min-w-0 shrink"
          >
            <ChipIcon chip={chip()} />
            <span class="min-w-0 truncate">{chip().label}</span>
          </Badge>
        )}
      </Show>
      <Show when={workspaceChips(props.workspace).length > 0}>
        <span class="visually-hidden">
          {workspaceChips(props.workspace)
            .map((chip) => chip.label)
            .join(', ')}
        </span>
      </Show>
    </SidebarNavButton>
  )
}

/** The expanded, active workspace: its header actions and project tree. */
function ActiveWorkspace(
  props: WorkspaceNavProps & { workspace: NavWorkspace; adapter: ViewAdapter }
) {
  // The active workspace themes its own subtree: the header, project rows,
  // selection and focus rings follow its accent; a null accent inherits.
  const theme = useOptionalTheme()
  const [host, setHost] = createSignal<HTMLDivElement>()
  createEffect(() => {
    const element = host()
    if (element) paintWorkspaceAccent(element, props.workspace.accent, theme?.variantId() ?? '')
  })
  return (
    <div
      ref={setHost}
      class="flex min-w-0 flex-col gap-0.5"
      data-workspace-id={props.workspace.id}
      data-active-workspace=""
    >
      <div class="flex min-w-0 items-center gap-2 ps-2">
        <span aria-hidden="true" class="flex shrink-0">
          <WorkspaceIdentityMark
            accent={props.workspace.accent}
            logo={props.workspace.logo}
            name={props.workspace.name}
            size="xs"
          />
        </span>
        <span class="min-w-0 flex-1 truncate">
          <Heading as="h3" size="subsection">
            {props.workspace.name}
          </Heading>
        </span>
        <span class="flex shrink-0 items-center gap-0.5">
          <Show when={props.onCreateProject}>
            <ActionButton
              variant="ghost"
              size="icon-xs"
              tooltip={props.tooltips === false ? undefined : props.adapter.createProjectLabel}
              aria-label={`${props.adapter.createProjectLabel} in ${props.workspace.name}`}
              onClick={() => props.onCreateProject?.(props.workspace.id)}
            >
              <Plus aria-hidden="true" />
            </ActionButton>
          </Show>
          <Show when={props.onOpenWorkspaceSettings}>
            <ActionButton
              variant="ghost"
              size="icon-xs"
              tooltip={props.tooltips === false ? undefined : 'Workspace settings'}
              aria-label={`Workspace settings for ${props.workspace.name}`}
              onClick={() => props.onOpenWorkspaceSettings?.(props.workspace.id)}
            >
              <Settings aria-hidden="true" />
            </ActionButton>
          </Show>
        </span>
      </div>
      <Show
        when={(props.workspace.projects ?? []).length > 0}
        fallback={
          <p class="ps-9 pe-2 py-1" data-slot="workspace-nav-empty">
            <Text variant="caption" tone="muted">
              No {props.adapter.nouns.project.toLowerCase()}s yet.
            </Text>
          </p>
        }
      >
        <NavLeafTree
          label={`${props.workspace.name} ${props.adapter.nouns.project.toLowerCase()}s`}
          projects={props.workspace.projects ?? []}
          adapter={props.adapter}
          groupBy={props.groupBy}
          selectedLeafId={props.selectedLeafId}
          onSelectLeaf={props.onSelectLeaf}
          onCreateLeaf={props.onCreateLeaf}
          onProjectMenuAction={props.onProjectMenuAction}
          onLeafMenuAction={props.onLeafMenuAction}
          onLeafIntent={props.onLeafIntent}
          collapsedProjectIds={props.collapsedProjectIds}
          onProjectExpandedChange={props.onProjectExpandedChange}
          portalMount={props.portalMount}
          tooltips={props.tooltips}
        />
      </Show>
    </div>
  )
}

/**
 * Inline workspace creation: Enter creates, Escape cancels, and leaving the
 * field creates when a name was typed and cancels when it is empty. The mark
 * previews the initials the new workspace will get. A host-controlled draft
 * stays mounted after Enter: a failure shows beside the kept name, Enter
 * retries, and leaving the field no longer resubmits until the name changes.
 */
function WorkspaceDraftRow(props: {
  controlled: boolean
  error?: string
  pending?: boolean
  onCreate: (name: string) => void
  onCancel: () => void
}) {
  const [name, setName] = createSignal('')
  const errorId = `workspace-nav-draft-error-${createUniqueId()}`
  let input: HTMLInputElement | undefined
  let settled = false
  let submittedName: string | undefined
  // A reported failure re-arms the row so the user can retry.
  createEffect(
    on(
      () => props.error,
      (error) => {
        if (error) settled = false
      },
      { defer: true }
    )
  )
  const finish = (create: boolean, fromBlur = false) => {
    if (settled || props.pending) return
    const value = name().trim()
    if (create && value === '') return
    // Leaving the field after a failure keeps the draft instead of retrying.
    if (create && fromBlur && submittedName === value) return
    settled = true
    if (create) {
      submittedName = value
      props.onCreate(value)
    } else props.onCancel()
  }

  onMount(() => input?.focus())

  return (
    <div class="flex min-w-0 flex-col gap-1 px-2 py-1" data-slot="workspace-nav-draft">
      <div class="flex min-w-0 items-center gap-2">
        <span aria-hidden="true" class="flex shrink-0">
          <WorkspaceIdentityMark
            accent={null}
            logo={{ kind: 'monogram' }}
            name={name().trim()}
            size="xs"
          />
        </span>
        <Input
          ref={(element) => {
            input = element
          }}
          aria-label="New workspace name"
          aria-invalid={props.error ? true : undefined}
          aria-describedby={props.error ? errorId : undefined}
          aria-busy={props.pending ? true : undefined}
          placeholder="New workspace name"
          value={name()}
          onInput={(event) => {
            setName(event.currentTarget.value)
            if (props.controlled) settled = false
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              finish(true)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              settled = false
              finish(false)
            }
          }}
          onBlur={() => finish(name().trim() !== '', true)}
        />
      </div>
      <Show when={props.error}>
        {(message) => (
          <Alert variant="destructive" id={errorId}>
            <AlertDescription>{message()}</AlertDescription>
          </Alert>
        )}
      </Show>
    </div>
  )
}
