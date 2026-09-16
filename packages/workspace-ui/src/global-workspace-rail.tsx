import type { WorkspaceSummary } from '@adea-ai/types'
import { Button } from '@adea-ai/ui/components/ui/button'
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
  Map,
  MessageSquareText,
  Plug,
  Search,
} from 'lucide-solid'
import { createEffect, createSignal, createUniqueId, For, onCleanup, Show } from 'solid-js'

import { AccountMenu } from './account-menu'
import type { WorkspaceView } from './workspace-view-toggle'

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
  onOpenNotifications: () => void
  onOpenAbout: () => void
  onOpenPlugins: () => void
  onOpenSearch: () => void
  onOpenSettings: () => void
  onWorkspaceChange: (workspace: WorkspaceSummary) => void
  onViewChange: (view: WorkspaceView) => void
  /** Fires when the user hovers or focuses a view button — prefetch the target. */
  onViewIntent?: (view: WorkspaceView) => void
  view: WorkspaceView
  workspaces: readonly WorkspaceSummary[]
}) {
  const activeWorkspaceLabel = () => props.activeWorkspace?.name ?? 'Loading'
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
              <For each={props.workspaces}>
                {(workspace) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={workspace.id === props.activeWorkspace?.id}
                    onClick={() => {
                      props.onWorkspaceChange(workspace)
                      setWorkspaceMenuOpen(false)
                    }}
                  >
                    <WorkspaceMark workspace={workspace} />
                    <span class="global-rail__workspace-name">{workspace.name}</span>
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
          <RailAction
            active={props.view === 'virtual'}
            icon={Map}
            label="Virtual view"
            onClick={() => props.onViewChange('virtual')}
            onIntent={() => props.onViewIntent?.('virtual')}
          />
          <RailAction
            active={props.view === 'chat'}
            icon={MessageSquareText}
            label="Chat view"
            onClick={() => props.onViewChange('chat')}
            onIntent={() => props.onViewIntent?.('chat')}
          />
          <RailAction
            active={props.view === 'dev'}
            icon={Code2}
            label="Dev view"
            onClick={() => props.onViewChange('dev')}
            onIntent={() => props.onViewIntent?.('dev')}
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
          />
          <AccountMenu
            authenticated={props.account.authenticated}
            busy={props.account.busy}
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
