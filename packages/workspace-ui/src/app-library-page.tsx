import { InputGroup, InputGroupAddon, InputGroupInput } from '@adea-ai/ui/components/ui/input-group'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Code2,
  GitBranch,
  GripVertical,
  Map,
  MessageSquareText,
  Plus,
  Search,
  SquareKanban,
} from 'lucide-solid'
import { createEffect, createSignal, For, Show } from 'solid-js'
import type { RailPreferencesV1 } from './rail-preferences'
import {
  enabledWorkspaceApps,
  orderedWorkspaceApps,
  type WorkspaceApp,
  type WorkspaceAppId,
} from './workspace-apps'

type RailDropPosition = 'after' | 'before'

const APP_ICONS = {
  virtual: Map,
  chat: MessageSquareText,
  dev: Code2,
  kanban: SquareKanban,
  'source-control': GitBranch,
}

/**
 * One launchpad tile (the KiroCrew library pattern): the app's mark, its
 * name, and a status caption, with the sidebar toggle riding the icon's
 * corner and Open as the tile's own action. The shared rail order also drives
 * these tiles, so enabled destinations keep the same placement in both views.
 */
function AppLibraryTile(props: {
  app: WorkspaceApp
  enabled: boolean
  canMoveLeft: boolean
  canMoveRight: boolean
  reorderable: boolean
  dropTargetId?: WorkspaceAppId
  dropPosition?: RailDropPosition
  onDragOver(event: DragEvent): void
  onDrop(event: DragEvent): void
  onDragStart(id: WorkspaceAppId): void
  onDragEnd(): void
  onMove(direction: 'left' | 'right', control: HTMLButtonElement): void
  onOpen(id: WorkspaceAppId): void
  onSetEnabled(id: WorkspaceAppId, enabled: boolean): void
}) {
  const Icon = APP_ICONS[props.app.id]
  return (
    <div
      class="workspace-app-library__tile"
      data-app-id={props.app.id}
      data-enabled={props.enabled ? 'true' : 'false'}
      data-drop-target={props.dropTargetId === props.app.id || undefined}
      data-drop-position={props.dropTargetId === props.app.id ? props.dropPosition : undefined}
      draggable={props.reorderable}
      onDragStart={(event) => {
        props.onDragStart(props.app.id)
        event.dataTransfer?.setData('text/plain', props.app.id)
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
      }}
      onDragEnd={props.onDragEnd}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
    >
      <div class="workspace-app-library__tile-media">
        <span class="workspace-app-library__tile-icon" aria-hidden="true">
          <Icon />
        </span>
        <ActionButton
          variant={props.enabled ? 'default' : 'outline'}
          size="icon-xs"
          class="workspace-app-library__tile-toggle"
          aria-label={`${props.enabled ? 'Disable' : 'Enable'} ${props.app.name}`}
          tooltip={
            props.enabled
              ? `Remove ${props.app.name} from your sidebar`
              : `Add ${props.app.name} to your sidebar`
          }
          onClick={() => props.onSetEnabled(props.app.id, !props.enabled)}
        >
          <Show when={props.enabled} fallback={<Plus aria-hidden="true" />}>
            <Check aria-hidden="true" />
          </Show>
        </ActionButton>
      </div>
      <Show
        when={props.enabled}
        fallback={<span class="workspace-app-library__tile-name">{props.app.name}</span>}
      >
        <ActionButton
          variant="ghost"
          size="sm"
          class="workspace-app-library__tile-open"
          aria-label={`Open ${props.app.name}`}
          tooltip={`Switch to ${props.app.name}`}
          onClick={() => props.onOpen(props.app.id)}
        >
          {props.app.name}
        </ActionButton>
      </Show>
      <span class="workspace-app-library__tile-caption">
        {props.enabled ? 'In sidebar' : 'Not in sidebar'}
      </span>
      <div class="workspace-app-library__reorder-actions flex items-center justify-center gap-1">
        <ActionButton
          variant="ghost"
          size="icon-xs"
          aria-label={`Move ${props.app.name} left`}
          tooltip={`Move ${props.app.name} left`}
          disabled={!props.canMoveLeft}
          onClick={(event) => props.onMove('left', event.currentTarget)}
        >
          <ArrowLeft aria-hidden="true" />
        </ActionButton>
        <ActionButton
          variant="ghost"
          size="icon-xs"
          class="workspace-app-library__tile-grip"
          aria-label={`Drag ${props.app.name} to reorder`}
          aria-description="Drag the app to reorder it. Use the Move left and Move right buttons to reorder without dragging."
          tooltip={`Drag ${props.app.name} to reorder`}
          disabled={!props.reorderable}
        >
          <GripVertical aria-hidden="true" />
        </ActionButton>
        <ActionButton
          variant="ghost"
          size="icon-xs"
          aria-label={`Move ${props.app.name} right`}
          tooltip={`Move ${props.app.name} right`}
          disabled={!props.canMoveRight}
          onClick={(event) => props.onMove('right', event.currentTarget)}
        >
          <ArrowRight aria-hidden="true" />
        </ActionButton>
      </div>
    </div>
  )
}

const positionFor = (event: DragEvent, tile: HTMLElement): RailDropPosition => {
  const bounds = tile.getBoundingClientRect()
  return event.clientX < bounds.left + bounds.width / 2 ? 'before' : 'after'
}

/** Build-owned apps, separate from the external extensions marketplace. */
export function AppLibraryPage(props: {
  focusSearchRequest: number
  focusSearchRequestHandled: number
  onFocusSearchRequestHandled(request: number): void
  preferences: RailPreferencesV1
  onReorder(id: WorkspaceAppId, targetId: WorkspaceAppId, position: RailDropPosition): string
  onSetEnabled(id: WorkspaceAppId, enabled: boolean): void
  onOpen(id: WorkspaceAppId): void
  onReset(): void
}) {
  let searchInput: HTMLInputElement | undefined
  createEffect(() => {
    const request = props.focusSearchRequest
    if (request > props.focusSearchRequestHandled && searchInput) {
      searchInput.focus()
      props.onFocusSearchRequestHandled(request)
    }
  })
  const [enabledOnly, setEnabledOnly] = createSignal(false)
  const [search, setSearch] = createSignal('')
  const [draggingId, setDraggingId] = createSignal<WorkspaceAppId>()
  const [dropTargetId, setDropTargetId] = createSignal<WorkspaceAppId>()
  const [dropPosition, setDropPosition] = createSignal<RailDropPosition>()
  const [announcement, setAnnouncement] = createSignal('')
  const enabledIds = () => new Set(enabledWorkspaceApps(props.preferences).map((app) => app.id))
  const matches = (app: WorkspaceApp) =>
    `${app.name} ${app.description}`.toLowerCase().includes(search().trim().toLowerCase())
  // The grid follows the complete stored order, including hidden entries.
  // Filtering changes only what is rendered; it never replaces the order with
  // a partial list that could discard apps the user cannot currently see.
  const tiles = () =>
    orderedWorkspaceApps(props.preferences).filter(
      (app) => (!enabledOnly() || enabledIds().has(app.id)) && matches(app)
    )
  const move = (id: WorkspaceAppId, direction: 'left' | 'right', control: HTMLButtonElement) => {
    const restoreFocus = document.activeElement === control
    const apps = tiles()
    const index = apps.findIndex((app) => app.id === id)
    const target = apps[index + (direction === 'left' ? -1 : 1)]
    if (!target) return
    setAnnouncement(props.onReorder(id, target.id, direction === 'left' ? 'before' : 'after'))
    if (restoreFocus) {
      queueMicrotask(() => {
        if (control.isConnected) control.focus()
      })
    }
  }
  const dragOver = (event: DragEvent, id: WorkspaceAppId) => {
    const dragged = draggingId()
    if (!dragged || dragged === id) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    setDropTargetId(id)
    setDropPosition(positionFor(event, event.currentTarget as HTMLElement))
  }
  const drop = (event: DragEvent, targetId: WorkspaceAppId) => {
    const dragged = draggingId()
    if (!dragged || dragged === targetId) return
    event.preventDefault()
    setAnnouncement(
      props.onReorder(dragged, targetId, positionFor(event, event.currentTarget as HTMLElement))
    )
    clearDrag()
  }
  const clearDrag = () => {
    setDraggingId(undefined)
    setDropTargetId(undefined)
    setDropPosition(undefined)
  }

  return (
    <main class="workspace-app-library" aria-labelledby="workspace-app-library-title">
      <header class="workspace-app-library__header">
        <div class="workspace-app-library__heading">
          <h1 id="workspace-app-library-title">App Library</h1>
          <p>Choose the views and tools in your workspace.</p>
        </div>
        <div class="workspace-app-library__controls">
          <InputGroup class="w-64 max-w-full flex-1 basis-48">
            <InputGroupAddon>
              <Search aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              ref={(element) => (searchInput = element)}
              aria-label="Search apps"
              type="search"
              placeholder="Search apps"
              value={search()}
              onInput={(event) => setSearch(event.currentTarget.value)}
            />
          </InputGroup>
          <ActionButton
            variant={enabledOnly() ? 'secondary' : 'outline'}
            size="sm"
            aria-pressed={enabledOnly()}
            tooltip={enabledOnly() ? 'Show every available app' : 'Show only apps in your sidebar'}
            onClick={() => setEnabledOnly(!enabledOnly())}
          >
            Show enabled only
          </ActionButton>
          <ActionButton
            variant="outline"
            size="sm"
            tooltip="Restore the default apps and sidebar order"
            onClick={props.onReset}
          >
            Reset Navigation
          </ActionButton>
        </div>
      </header>
      <div class="workspace-app-library__body">
        <Show
          when={tiles().length > 0}
          fallback={
            <p class="workspace-app-library__empty" role="status">
              No apps match these filters.
            </p>
          }
        >
          <div class="workspace-app-library__grid">
            <For each={tiles()}>
              {(app, index) => (
                <AppLibraryTile
                  app={app}
                  enabled={enabledIds().has(app.id)}
                  canMoveLeft={index() > 0}
                  canMoveRight={index() < tiles().length - 1}
                  reorderable={tiles().length > 1}
                  dropTargetId={dropTargetId()}
                  dropPosition={dropPosition()}
                  onDragOver={(event) => dragOver(event, app.id)}
                  onDrop={(event) => drop(event, app.id)}
                  onDragStart={setDraggingId}
                  onDragEnd={clearDrag}
                  onMove={(direction, control) => move(app.id, direction, control)}
                  onOpen={props.onOpen}
                  onSetEnabled={props.onSetEnabled}
                />
              )}
            </For>
          </div>
        </Show>
      </div>
      <footer class="workspace-app-library__footer">
        <p>Drag an app to reorder it, or use the Move left and Move right buttons.</p>
        <p class="visually-hidden" role="status" aria-live="polite">
          {announcement()}
        </p>
        <p>
          External plugins, skills and connectors are managed in Plugins. Larger installable apps
          will appear here when their installation is supported.
        </p>
      </footer>
    </main>
  )
}
