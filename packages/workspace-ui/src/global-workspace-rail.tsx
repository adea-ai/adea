import type { WorkspaceSummary } from '@adea-ai/types'
import { Separator } from '@adea-ai/ui/components/ui/separator'
import {
  SideRail,
  SideRailContent,
  SideRailFooter,
  SideRailHeader,
  SideRailItem,
  SideRailSection,
} from '@adea-ai/ui/components/layout/side-rail'
import { Kbd, KbdGroup } from '@adea-ai/ui/components/ui/kbd'
import { WorkspaceLogo } from '@adea-ai/app-ui/components/workspace-logo'
import {
  Code2,
  Home,
  LayoutGrid,
  GitBranch,
  Map,
  MessageSquareText,
  Plug,
  Search,
  SquareKanban,
} from 'lucide-solid'
import { createEffect, createSignal, For, onCleanup } from 'solid-js'

import { AccountMenu } from './account-menu'
import { platformModifierKey, searchShortcutLabel } from './keyboard-shortcuts'
import type { WorkspaceView } from './workspace-view-toggle'
import type { WorkspaceAppId } from './workspace-apps'

const VIEW_ICONS: Record<string, typeof Home> = {
  virtual: Map,
  chat: MessageSquareText,
  dev: Code2,
  kanban: SquareKanban,
  'source-control': GitBranch,
}

const VIEW_LABELS: Record<string, string> = {
  virtual: 'Virtual view',
  chat: 'Chat view',
  dev: 'Dev view',
  kanban: 'Kanban',
  'source-control': 'Source control',
}

/**
 * The rail reorder contract: pointer drag-and-drop plus Alt+Arrow keyboard
 * moves. Both handlers return the live-region announcement so the rail keeps
 * a single owner of rail preferences (the host) and only owns the a11y
 * surface. The host funnels both through the same preference record, so a
 * pointer reorder and a keyboard reorder produce byte-identical orders.
 */
export type RailReorderHandlers = {
  /** Pointer drop: place `id` directly before or after `targetId`. */
  onDrop(id: WorkspaceAppId, targetId: WorkspaceAppId, position: 'after' | 'before'): string
  /** Keyboard move (Alt+Arrow) of one view by one slot. */
  onMove(id: WorkspaceAppId, direction: 'down' | 'up'): string
}

/**
 * The keyboard reorder contract, documented to assistive technology through
 * the row's description.
 */
export const RAIL_REORDER_HINT = 'Press Alt with Arrow Up or Arrow Down to move this view.'

/** Alt+Arrow moves the focused rail view; every other chord keeps its default. */
function railReorderKeyDown(
  event: KeyboardEvent,
  rowId: string,
  move: (direction: 'down' | 'up') => void
): void {
  if (!event.altKey) return
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
  event.preventDefault()
  event.stopPropagation()
  move(event.key === 'ArrowUp' ? 'up' : 'down')
  // A reorder re-renders the section; put focus back on the moved row.
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(`[data-row-id="${rowId}"]`)?.focus()
  })
}

export function GlobalWorkspaceRail(props: {
  account: Readonly<{
    authenticated: boolean
    busy?: boolean
    label: string
    onOpenUpdates?: (opener: HTMLButtonElement | undefined) => void
    onOpenHelp?: (opener: HTMLButtonElement | undefined) => void
    onOpenFeedback: (opener: HTMLButtonElement | undefined) => void
    onSignIn: () => void
    onSignOut: () => void
    platform: 'desktop' | 'web'
  }>
  activeWorkspace?: WorkspaceSummary
  /** The visible view entries, already ordered and filtered by rail preferences. */
  views: readonly WorkspaceAppId[]
  onOpenAbout: (opener: HTMLButtonElement | undefined) => void
  onOpenPlugins: () => void
  onOpenAppLibrary: () => void
  libraryActive?: boolean
  onOpenSearch: () => void
  onOpenSettings: (opener: HTMLButtonElement | undefined) => void
  onViewChange: (view: WorkspaceAppId) => void
  /** Fires when the user hovers or focuses a view button — prefetch the target. */
  onViewIntent?: (view: WorkspaceView) => void
  /** Fires on hover/focus of a panel's entry point — prefetch its dialog chunk. */
  onPanelIntent?: (panel: 'about' | 'help' | 'plugins' | 'settings') => void
  /** Present when the host persists rail order changes: drag and Alt+Arrow reorder. */
  reorder?: RailReorderHandlers
  view: WorkspaceAppId
}) {
  // Drag state lives only for the drop indicator; the drop itself reports the
  // pointer side of the target row (upper half before, lower half after).
  const [draggingId, setDraggingId] = createSignal<WorkspaceAppId>()
  const [dropTargetId, setDropTargetId] = createSignal<WorkspaceAppId>()
  const [dropPosition, setDropPosition] = createSignal<'after' | 'before'>()
  const [announcement, setAnnouncement] = createSignal('')
  const reorderable = () => Boolean(props.reorder) && props.views.length > 1
  // The search chord's advertised modifier follows the running OS, the same
  // helper the account menu and the Help Center draw from; the binding itself
  // accepts Meta and Ctrl alike (`keyshortcuts` below declares both).
  const searchModifier = platformModifierKey()
  const searchShortcut = searchShortcutLabel()

  createEffect(() => {
    // Captures props.onOpenSearch from the component scope.
    // oxlint-disable-next-line unicorn/consistent-function-scoping
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
    // Captures props.onOpenSettings from the component scope.
    // oxlint-disable-next-line unicorn/consistent-function-scoping
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
      // The chord has no menu trigger to restore to; the dialog falls back to
      // capturing the then-focused element.
      props.onOpenSettings(undefined)
    }

    window.addEventListener('keydown', openSearchWithShortcut, { capture: true })
    window.addEventListener('keydown', openSettingsWithShortcut, { capture: true })
    onCleanup(() => {
      window.removeEventListener('keydown', openSearchWithShortcut, { capture: true })
      window.removeEventListener('keydown', openSettingsWithShortcut, { capture: true })
    })
  })

  return (
    <SideRail collapsed data-global-rail="" aria-label="Global navigation">
      <SideRailHeader data-global-rail-header="">
        {/* The product mark, not a control: workspaces are switched from
            the contextual sidebar's Workspaces accordion (ADR 0011). It
            keeps the old trigger's row height so the rail rhythm holds. */}
        <span class="global-rail__mark">
          <WorkspaceLogo aria-hidden="true" class="size-9" />
        </span>
      </SideRailHeader>

      <SideRailContent data-global-rail-content="">
        <SideRailSection label="Search">
          {/* The chord is drawn as outlined key caps under the icon — the one
              row that advertises a shortcut — while the accessible chord stays
              on the row itself through aria-keyshortcuts. */}
          <div class="global-rail__search-item">
            <SideRailItem
              as="button"
              type="button"
              label="Search workspace"
              aria-label="Search workspace"
              shortcut={searchShortcut}
              keyshortcuts="Meta+K Control+K"
              onClick={props.onOpenSearch}
            >
              <Search aria-hidden="true" />
            </SideRailItem>
            {/* KbdChord draws one cap per character, so a spelled-out Ctrl
                cannot ride it; the shared group draws one cap per entry, and
                `platformModifierKey` picks the glyph ("⌘" or "Ctrl"). */}
            <KbdGroup size="compact" data-global-rail-search-keys="">
              <Kbd size="compact">{searchModifier}</Kbd>
              <Kbd size="compact">K</Kbd>
            </KbdGroup>
          </div>
        </SideRailSection>

        <Separator class="my-1" />

        <SideRailSection
          label="Workspace views"
          role="group"
          aria-label="Workspace views"
          data-reordering={draggingId() !== undefined || undefined}
        >
          <For each={props.views}>
            {(view) => {
              const Icon = VIEW_ICONS[view] ?? Map
              const active = () => !props.libraryActive && props.view === view
              const onIntent = () => {
                if (view === 'virtual' || view === 'chat' || view === 'dev')
                  props.onViewIntent?.(view)
              }
              const rowId = `rail-view:${view}`
              return (
                <div
                  class="global-rail__intent global-rail__slot"
                  data-drop-position={dropTargetId() === view ? dropPosition() : undefined}
                  data-drop-target={dropTargetId() === view || undefined}
                  onPointerEnter={onIntent}
                  onFocusIn={onIntent}
                  onDragOver={(event) => {
                    if (draggingId() === undefined || draggingId() === view) return
                    event.preventDefault()
                    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
                    setDropTargetId(view)
                    const rect = event.currentTarget.getBoundingClientRect()
                    setDropPosition(event.clientY < rect.top + rect.height / 2 ? 'before' : 'after')
                  }}
                  onDrop={(event) => {
                    const dragged = draggingId()
                    if (dragged === undefined || dragged === view || !props.reorder) return
                    event.preventDefault()
                    const rect = event.currentTarget.getBoundingClientRect()
                    const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
                    setAnnouncement(props.reorder.onDrop(dragged, view, position))
                    setDraggingId(undefined)
                    setDropTargetId(undefined)
                    setDropPosition(undefined)
                  }}
                >
                  <SideRailItem
                    as="button"
                    type="button"
                    active={active()}
                    aria-pressed={active() || undefined}
                    label={VIEW_LABELS[view] ?? view}
                    aria-label={VIEW_LABELS[view] ?? view}
                    aria-description={reorderable() ? RAIL_REORDER_HINT : undefined}
                    data-row-id={rowId}
                    draggable={reorderable()}
                    onClick={() => props.onViewChange(view)}
                    onKeyDown={(event) =>
                      props.reorder &&
                      railReorderKeyDown(event, rowId, (direction) =>
                        setAnnouncement(props.reorder!.onMove(view, direction))
                      )
                    }
                    onDragStart={(event) => {
                      setDraggingId(view)
                      setDropTargetId(undefined)
                      setDropPosition(undefined)
                      event.dataTransfer?.setData('text/plain', VIEW_LABELS[view] ?? view)
                      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragEnd={() => {
                      setDraggingId(undefined)
                      setDropTargetId(undefined)
                      setDropPosition(undefined)
                    }}
                  >
                    <Icon aria-hidden="true" />
                  </SideRailItem>
                </div>
              )
            }}
          </For>
          {/* App Library is the gateway to installed apps, not a workspace view;
              the divider keeps the two groups apart like the search separator. */}
          <Separator class="my-1" />
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
            label={props.activeWorkspace ? 'Plugins' : 'Plugins (select a workspace first)'}
            aria-label="Plugins"
            aria-description={
              !props.activeWorkspace ? 'Select a workspace to browse plugins.' : undefined
            }
            onClick={props.onOpenPlugins}
          >
            <Plug aria-hidden="true" />
          </SideRailItem>
        </div>
        <AccountMenu
          authenticated={props.account.authenticated}
          busy={props.account.busy}
          onIntent={() => {
            // The menu is the path to settings, about, and help: warm every
            // dialog it can open when the user reaches for it.
            props.onPanelIntent?.('settings')
            props.onPanelIntent?.('about')
            props.onPanelIntent?.('help')
          }}
          onOpenUpdates={props.account.onOpenUpdates}
          onOpenHelp={props.account.onOpenHelp}
          onOpenFeedback={props.account.onOpenFeedback}
          onOpenAbout={props.onOpenAbout}
          onOpenSettings={props.onOpenSettings}
          onSignIn={props.account.onSignIn}
          onSignOut={props.account.onSignOut}
          platform={props.account.platform}
        />
      </SideRailFooter>
      <p class="sr-only" role="status" aria-live="polite">
        {announcement()}
      </p>
    </SideRail>
  )
}
