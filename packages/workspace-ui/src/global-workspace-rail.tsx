import type { WorkspaceSummary } from '@adea-ai/types'
import { Button, type ButtonProps } from '@adea-ai/ui/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@adea-ai/ui/components/ui/dropdown-menu'
import { Separator } from '@adea-ai/ui/components/ui/separator'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@adea-ai/ui/components/ui/tooltip'
import {
  Bell,
  BriefcaseBusiness,
  Code2,
  Home,
  LayoutGrid,
  GitBranch,
  Map,
  MessageSquareText,
  Plug,
  Search,
} from 'lucide-solid'
import { createEffect, For, onCleanup } from 'solid-js'

import { AccountMenu } from './account-menu'
import { keyedRows } from './keyed-rows'
import type { WorkspaceView } from './workspace-view-toggle'
import type { WorkspaceAppId } from './workspace-apps'

const VIEW_ICONS: Record<string, typeof Home> = {
  virtual: Map,
  chat: MessageSquareText,
  dev: Code2,
  kanban: LayoutGrid,
  'source-control': GitBranch,
}

const VIEW_LABELS: Record<string, string> = {
  virtual: 'Virtual view',
  chat: 'Chat view',
  dev: 'Dev view',
  kanban: 'Kanban',
  'source-control': 'Source control',
}

type RailActionProps = {
  active?: boolean
  disabled?: boolean
  icon: typeof Home
  label: string
  onClick?: () => void
  /** Fires on hover or keyboard focus — a chance to prefetch before the click. */
  onIntent?: () => void
}

function RailAction(props: RailActionProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        as={Button}
        variant={props.active ? 'secondary' : 'ghost'}
        size="icon-lg"
        class="global-rail__button"
        aria-label={props.label}
        aria-pressed={props.active || undefined}
        disabled={props.disabled}
        onClick={() => props.onClick?.()}
        onFocus={() => props.onIntent?.()}
        onPointerEnter={() => props.onIntent?.()}
      >
        <props.icon aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent hideArrow placement="right" gutter={4} data-slot="tooltip-content">
        {props.label}
      </TooltipContent>
    </Tooltip>
  )
}

function WorkspaceMark(props: { workspace?: WorkspaceSummary }) {
  const Icon = props.workspace?.scene === 'home' ? Home : BriefcaseBusiness
  return <Icon aria-hidden="true" />
}

// Both published primitives need to decorate the same button. This tiny
// polymorphic bridge composes their trigger props; menu state and keyboard
// behavior remain owned by the published DropdownMenu.
type WorkspaceTooltipButtonProps = Omit<ButtonProps, 'type'> & {
  type?: 'button' | 'reset' | 'submit'
}

function WorkspaceTooltipButton(props: WorkspaceTooltipButtonProps) {
  return <TooltipTrigger as={Button} {...props} />
}

export function GlobalWorkspaceRail(props: {
  account: Readonly<{
    authenticated: boolean
    busy?: boolean
    label: string
    onOpenUpdates?: (opener: HTMLButtonElement | undefined) => void
    onSignIn: () => void
    onSignOut: () => void
    platform: 'desktop' | 'web'
  }>
  activeWorkspace?: WorkspaceSummary
  /** The visible view entries, already ordered and filtered by rail preferences. */
  views: readonly WorkspaceAppId[]
  onOpenNotifications: () => void
  onOpenAbout: () => void
  onOpenPlugins: () => void
  onOpenAppLibrary: () => void
  libraryActive?: boolean
  onOpenSearch: () => void
  onOpenSettings: () => void
  onWorkspaceChange: (workspace: WorkspaceSummary) => void
  onViewChange: (view: WorkspaceAppId) => void
  /** Fires when the user hovers or focuses a view button — prefetch the target. */
  onViewIntent?: (view: WorkspaceView) => void
  /** Fires on hover/focus of a panel's entry point — prefetch its dialog chunk. */
  onPanelIntent?: (panel: 'about' | 'plugins' | 'settings') => void
  view: WorkspaceAppId
  workspaces: readonly WorkspaceSummary[]
}) {
  const activeWorkspaceLabel = () => props.activeWorkspace?.name ?? 'Loading'
  const workspaceRows = keyedRows(
    () => props.workspaces,
    (workspace) => workspace.id
  )

  createEffect(() => {
    const openSearchWithShortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !(event.metaKey || event.ctrlKey) ||
        event.shiftKey ||
        event.key.toLowerCase() !== 'k'
      ) {
        return
      }
      event.preventDefault()
      props.onOpenSearch()
    }
    const openSettingsWithShortcut = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.shiftKey ||
        event.altKey ||
        event.key !== ','
      ) {
        return
      }
      const target = event.target
      const isEditable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      if (isEditable) return
      event.preventDefault()
      props.onOpenSettings()
    }

    window.addEventListener('keydown', openSearchWithShortcut, { capture: true })
    window.addEventListener('keydown', openSettingsWithShortcut, { capture: true })
    onCleanup(() => {
      window.removeEventListener('keydown', openSearchWithShortcut, { capture: true })
      window.removeEventListener('keydown', openSettingsWithShortcut, { capture: true })
    })
  })

  return (
    <TooltipProvider openDelay={200} closeDelay={300} skipDelayDuration={300}>
      <nav class="global-rail" aria-label="Global navigation">
        <div class="global-rail__workspace">
          <DropdownMenu modal={false} placement="right-start" gutter={4}>
            <Tooltip>
              <DropdownMenuTrigger
                as={WorkspaceTooltipButton}
                variant="default"
                size="icon-lg"
                class="global-rail__workspace-trigger"
                aria-label={`Switch workspace, current ${activeWorkspaceLabel()}`}
              >
                <WorkspaceMark workspace={props.activeWorkspace} />
              </DropdownMenuTrigger>
              <TooltipContent hideArrow placement="right" gutter={4} data-slot="tooltip-content">
                Switch workspace
              </TooltipContent>
            </Tooltip>
            <DropdownMenuContent
              hideArrow
              class="global-rail__workspace-menu max-h-(--kb-popper-available-height) overflow-x-hidden overflow-y-auto"
            >
              <DropdownMenuRadioGroup
                value={props.activeWorkspace?.id ?? ''}
                onChange={(id) => {
                  const workspace = props.workspaces.find((entry) => entry.id === id)
                  if (workspace) props.onWorkspaceChange(workspace)
                }}
              >
                <For each={workspaceRows()}>
                  {(entry) => (
                    <DropdownMenuRadioItem value={entry.item().id} closeOnSelect>
                      <WorkspaceMark workspace={entry.item()} />
                      <span class="global-rail__workspace-name">{entry.item().name}</span>
                    </DropdownMenuRadioItem>
                  )}
                </For>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div class="global-rail__search">
          <RailAction icon={Search} label="Search workspace" onClick={props.onOpenSearch} />
          <kbd aria-hidden="true">⌘ K</kbd>
        </div>

        <Separator class="global-rail__separator" />

        <div class="global-rail__views" role="group" aria-label="Workspace views">
          <For each={props.views}>
            {(view) => {
              const Icon = VIEW_ICONS[view] ?? Map
              return (
                <RailAction
                  active={!props.libraryActive && props.view === view}
                  icon={Icon}
                  label={VIEW_LABELS[view] ?? view}
                  onClick={() => props.onViewChange(view)}
                  onIntent={() => {
                    if (view === 'virtual' || view === 'chat' || view === 'dev')
                      props.onViewIntent?.(view)
                  }}
                />
              )
            }}
          </For>
          <RailAction
            icon={LayoutGrid}
            label="App Library"
            active={props.libraryActive}
            onClick={props.onOpenAppLibrary}
          />
          <RailAction
            disabled
            icon={Bell}
            label="Notifications (coming soon)"
            onClick={props.onOpenNotifications}
          />
        </div>

        <div class="global-rail__footer">
          <RailAction
            disabled={!props.activeWorkspace}
            icon={Plug}
            label="Plugins"
            onClick={props.onOpenPlugins}
            onIntent={() => props.onPanelIntent?.('plugins')}
          />
          <AccountMenu
            authenticated={props.account.authenticated}
            busy={props.account.busy}
            onIntent={() => {
              // The menu is the path to settings and about: warm both dialogs
              // when the user reaches for it.
              props.onPanelIntent?.('settings')
              props.onPanelIntent?.('about')
            }}
            onOpenUpdates={props.account.onOpenUpdates}
            onOpenAbout={props.onOpenAbout}
            onOpenSettings={props.onOpenSettings}
            onSignIn={props.account.onSignIn}
            onSignOut={props.account.onSignOut}
            platform={props.account.platform}
          />
        </div>
      </nav>
    </TooltipProvider>
  )
}
