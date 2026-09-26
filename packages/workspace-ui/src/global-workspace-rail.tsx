import type { WorkspaceSummary } from '@adea-ai/types'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Separator } from '@adea-ai/app-ui/components/ui/separator'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@adea-ai/app-ui/components/ui/tooltip'
import {
  Bell,
  BriefcaseBusiness,
  Code2,
  Home,
  Map,
  MessageSquareText,
  Plug,
  Search,
} from 'lucide-solid'
import { createEffect, createSignal, createUniqueId, For, onCleanup, Show } from 'solid-js'

import { AccountMenu } from './account-menu'
import { keyedRows } from './keyed-rows'
import type { WorkspaceView } from './workspace-view-toggle'

const VIEW_ICONS: Record<string, typeof Home> = {
  virtual: Map,
  chat: MessageSquareText,
  dev: Code2,
}

const VIEW_LABELS: Record<string, string> = {
  virtual: 'Virtual view',
  chat: 'Chat view',
  dev: 'Dev view',
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
      <TooltipContent side="right">{props.label}</TooltipContent>
    </Tooltip>
  )
}

function WorkspaceMark(props: { workspace?: WorkspaceSummary }) {
  const Icon = props.workspace?.scene === 'home' ? Home : BriefcaseBusiness
  return <Icon aria-hidden="true" />
}

export function GlobalWorkspaceRail(props: {
  account: Readonly<{
    authenticated: boolean
    busy?: boolean
    label: string
    onOpenUpdates?: () => void
    onSignIn: () => void
    onSignOut: () => void
    platform: 'desktop' | 'web'
  }>
  activeWorkspace?: WorkspaceSummary
  /** The visible view entries, already ordered and filtered by rail preferences. */
  views: readonly WorkspaceView[]
  onOpenNotifications: () => void
  onOpenAbout: () => void
  onOpenPlugins: () => void
  onOpenSearch: () => void
  onOpenSettings: () => void
  onWorkspaceChange: (workspace: WorkspaceSummary) => void
  onViewChange: (view: WorkspaceView) => void
  /** Fires when the user hovers or focuses a view button — prefetch the target. */
  onViewIntent?: (view: WorkspaceView) => void
  /** Fires on hover/focus of a panel's entry point — prefetch its dialog chunk. */
  onPanelIntent?: (panel: 'about' | 'plugins' | 'settings') => void
  view: WorkspaceView
  workspaces: readonly WorkspaceSummary[]
}) {
  const activeWorkspaceLabel = () => props.activeWorkspace?.name ?? 'Loading'
  const workspaceRows = keyedRows(
    () => props.workspaces,
    (workspace) => workspace.id
  )
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = createSignal(false)
  const workspaceMenuId = createUniqueId()
  const [workspaceMenu, setWorkspaceMenu] = createSignal<HTMLDivElement>()

  createEffect(() => {
    if (!workspaceMenuOpen()) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!workspaceMenu()?.contains(event.target as Node)) setWorkspaceMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setWorkspaceMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    onCleanup(() => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    })
  })

  createEffect(() => {
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

    window.addEventListener('keydown', openSettingsWithShortcut, { capture: true })
    onCleanup(() =>
      window.removeEventListener('keydown', openSettingsWithShortcut, { capture: true })
    )
  })

  return (
    <TooltipProvider>
      <nav class="global-rail" aria-label="Global navigation">
        <div class="global-rail__workspace" ref={setWorkspaceMenu}>
          <Tooltip>
            <TooltipTrigger
              as={Button}
              variant="default"
              size="icon-lg"
              class="global-rail__workspace-trigger"
              aria-controls={workspaceMenuId}
              aria-expanded={workspaceMenuOpen()}
              aria-haspopup="menu"
              aria-label={`Switch workspace, current ${activeWorkspaceLabel()}`}
              onClick={() => setWorkspaceMenuOpen((open) => !open)}
            >
              <WorkspaceMark workspace={props.activeWorkspace} />
            </TooltipTrigger>
            <TooltipContent side="right">Switch workspace</TooltipContent>
          </Tooltip>
          <Show when={workspaceMenuOpen()}>
            <div class="global-rail__workspace-menu" id={workspaceMenuId} role="menu">
              <For each={workspaceRows()}>
                {(entry) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={entry.item().id === props.activeWorkspace?.id}
                    onClick={() => {
                      props.onWorkspaceChange(entry.item())
                      setWorkspaceMenuOpen(false)
                    }}
                  >
                    <WorkspaceMark workspace={entry.item()} />
                    <span class="global-rail__workspace-name">{entry.item().name}</span>
                  </button>
                )}
              </For>
            </div>
          </Show>
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
                  active={props.view === view}
                  icon={Icon}
                  label={VIEW_LABELS[view] ?? view}
                  onClick={() => props.onViewChange(view)}
                  onIntent={() => props.onViewIntent?.(view)}
                />
              )
            }}
          </For>
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
            label="App Library"
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
