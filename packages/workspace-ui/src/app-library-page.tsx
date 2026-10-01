import { InputGroup, InputGroupAddon, InputGroupInput } from '@adea-ai/ui/components/ui/input-group'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import {
  Check,
  Code2,
  GitBranch,
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
  workspaceApps,
  type WorkspaceApp,
  type WorkspaceAppId,
} from './workspace-apps'

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
 * corner and Open as the tile's own action. Reordering is not a tile
 * concern — the rail's drag-and-drop owns the order.
 */
function AppLibraryTile(props: {
  app: WorkspaceApp
  enabled: boolean
  onOpen(id: WorkspaceAppId): void
  onSetEnabled(id: WorkspaceAppId, enabled: boolean): void
}) {
  const Icon = APP_ICONS[props.app.id]
  return (
    <div class="workspace-app-library__tile" data-enabled={props.enabled ? 'true' : 'false'}>
      <div class="workspace-app-library__tile-media">
        <span class="workspace-app-library__tile-icon" aria-hidden="true">
          <Icon />
        </span>
        <ActionButton
          variant={props.enabled ? 'secondary' : 'outline'}
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
    </div>
  )
}

/** Build-owned apps, separate from the external extensions marketplace. */
export function AppLibraryPage(props: {
  focusSearchRequest: number
  focusSearchRequestHandled: number
  onFocusSearchRequestHandled(request: number): void
  preferences: RailPreferencesV1
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
  const enabledIds = () => new Set(enabledWorkspaceApps(props.preferences).map((app) => app.id))
  const matches = (app: WorkspaceApp) =>
    `${app.name} ${app.description}`.toLowerCase().includes(search().trim().toLowerCase())
  // Enabled apps lead in rail order; everything else follows in catalog
  // order, so the grid reads as "active first, then what you can add".
  const tiles = () => [
    ...enabledWorkspaceApps(props.preferences).filter((app) => matches(app)),
    ...(enabledOnly()
      ? []
      : workspaceApps.filter((app) => !enabledIds().has(app.id) && matches(app))),
  ]

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
              {(app) => (
                <AppLibraryTile
                  app={app}
                  enabled={enabledIds().has(app.id)}
                  onOpen={props.onOpen}
                  onSetEnabled={props.onSetEnabled}
                />
              )}
            </For>
          </div>
        </Show>
      </div>
      <footer class="workspace-app-library__footer">
        <ActionButton
          variant="ghost"
          size="sm"
          class="workspace-app-library__reset"
          tooltip="Restore the default apps and sidebar order"
          onClick={props.onReset}
        >
          Reset Navigation
        </ActionButton>
        <p>Drag the icons in the sidebar to reorder your apps.</p>
        <p>
          External plugins, skills and connectors are managed in Plugins. Larger installable apps
          will appear here when their installation is supported.
        </p>
      </footer>
    </main>
  )
}
