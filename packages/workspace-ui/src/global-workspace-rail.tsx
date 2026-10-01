import type { WorkspaceSummary } from '@adea-ai/types'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@adea-ai/ui/components/ui/dropdown-menu'
import { Separator } from '@adea-ai/ui/components/ui/separator'
import {
  SideRail,
  SideRailButton,
  SideRailContent,
  SideRailFooter,
  SideRailHeader,
  SideRailItem,
  SideRailSection,
} from '@adea-ai/ui/components/layout/side-rail'
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

function WorkspaceMark(props: { workspace?: WorkspaceSummary }) {
  const Icon = props.workspace?.scene === 'home' ? Home : BriefcaseBusiness
  return <Icon aria-hidden="true" />
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
    <SideRail collapsed class="global-rail" aria-label="Global navigation">
      <SideRailHeader>
        <DropdownMenu modal={false} placement="right-start" gutter={4}>
          <DropdownMenuTrigger
            as={SideRailButton}
            label={`Switch workspace, current ${activeWorkspaceLabel()}`}
            class="global-rail__workspace-trigger"
          >
            <WorkspaceMark workspace={props.activeWorkspace} />
          </DropdownMenuTrigger>
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
      </SideRailHeader>

      <SideRailContent>
        <SideRailSection label="Search">
          <SideRailItem
            as="button"
            type="button"
            label="Search workspace"
            aria-label="Search workspace"
            shortcut="⌘K"
            keyshortcuts="Meta+K Control+K"
            onClick={props.onOpenSearch}
          >
            <Search aria-hidden="true" />
          </SideRailItem>
        </SideRailSection>

        <Separator class="global-rail__separator" />

        <SideRailSection label="Workspace views" role="group" aria-label="Workspace views">
          <For each={props.views}>
            {(view) => {
              const Icon = VIEW_ICONS[view] ?? Map
              const active = () => !props.libraryActive && props.view === view
              const onIntent = () => {
                if (view === 'virtual' || view === 'chat' || view === 'dev')
                  props.onViewIntent?.(view)
              }
              return (
                <div class="global-rail__intent" onPointerEnter={onIntent} onFocusIn={onIntent}>
                  <SideRailItem
                    as="button"
                    type="button"
                    active={active()}
                    aria-pressed={active() || undefined}
                    label={VIEW_LABELS[view] ?? view}
                    aria-label={VIEW_LABELS[view] ?? view}
                    onClick={() => props.onViewChange(view)}
                  >
                    <Icon aria-hidden="true" />
                  </SideRailItem>
                </div>
              )
            }}
          </For>
          <SideRailItem
            as="button"
            type="button"
            active={props.libraryActive}
            aria-pressed={props.libraryActive || undefined}
            label="App Library"
            aria-label="App Library"
            onClick={props.onOpenAppLibrary}
          >
            <LayoutGrid aria-hidden="true" />
          </SideRailItem>
          <SideRailItem
            as="button"
            type="button"
            disabled
            label="Notifications (coming soon)"
            aria-label="Notifications (coming soon)"
            onClick={props.onOpenNotifications}
          >
            <Bell aria-hidden="true" />
          </SideRailItem>
        </SideRailSection>
      </SideRailContent>

      <SideRailFooter>
        <div
          class="global-rail__intent"
          onPointerEnter={() => props.onPanelIntent?.('plugins')}
          onFocusIn={() => props.onPanelIntent?.('plugins')}
        >
          <SideRailItem
            as="button"
            type="button"
            disabled={!props.activeWorkspace}
            label="Plugins"
            aria-label="Plugins"
            onClick={props.onOpenPlugins}
          >
            <Plug aria-hidden="true" />
          </SideRailItem>
        </div>
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
      </SideRailFooter>
    </SideRail>
  )
}
