import { InputGroup, InputGroupAddon, InputGroupInput } from '@adea-ai/ui/components/ui/input-group'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { ListGroup, ListRow } from '@adea-ai/ui/components/composites/list-row'
import {
  ChevronDown,
  ChevronUp,
  Code2,
  GitBranch,
  LayoutGrid,
  Map,
  MessageSquareText,
  Search,
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
  kanban: LayoutGrid,
  'source-control': GitBranch,
}

function AppLibraryRow(props: {
  app: WorkspaceApp
  enabled: boolean
  enabledOrder: readonly string[]
  onOpen(id: WorkspaceAppId): void
  onReorder(id: WorkspaceAppId, direction: 'down' | 'up'): void
  onSetEnabled(id: WorkspaceAppId, enabled: boolean): void
}) {
  const Icon = APP_ICONS[props.app.id]
  const position = () => props.enabledOrder.indexOf(props.app.id)

  return (
    <ListRow
      leading={<Icon aria-hidden="true" />}
      description={props.app.description}
      trailing={
        <Show
          when={props.enabled}
          fallback={
            <ActionButton
              variant="outline"
              size="sm"
              tooltip={`Add ${props.app.name} to your sidebar`}
              aria-label={`Enable ${props.app.name}`}
              onClick={() => props.onSetEnabled(props.app.id, true)}
            >
              Enable
            </ActionButton>
          }
        >
          <>
            <Badge variant="secondary">In sidebar</Badge>
            <ActionButton
              variant="ghost"
              size="sm"
              tooltip={`Switch to ${props.app.name}`}
              onClick={() => props.onOpen(props.app.id)}
            >
              Open {props.app.name}
            </ActionButton>
            <ActionButton
              variant="ghost"
              size="icon-sm"
              tooltip={
                position() === 0
                  ? `${props.app.name} is already first in your sidebar`
                  : `Move ${props.app.name} earlier in your sidebar`
              }
              aria-label={`Move ${props.app.name} up`}
              disabled={position() === 0}
              onClick={() => props.onReorder(props.app.id, 'up')}
            >
              <ChevronUp aria-hidden="true" />
            </ActionButton>
            <ActionButton
              variant="ghost"
              size="icon-sm"
              tooltip={
                position() === props.enabledOrder.length - 1
                  ? `${props.app.name} is already last in your sidebar`
                  : `Move ${props.app.name} later in your sidebar`
              }
              aria-label={`Move ${props.app.name} down`}
              disabled={position() === props.enabledOrder.length - 1}
              onClick={() => props.onReorder(props.app.id, 'down')}
            >
              <ChevronDown aria-hidden="true" />
            </ActionButton>
            <ActionButton
              variant="ghost"
              size="sm"
              aria-label={`Disable ${props.app.name}`}
              tooltip={`Remove ${props.app.name} from your sidebar`}
              onClick={() => props.onSetEnabled(props.app.id, false)}
            >
              Disable
            </ActionButton>
          </>
        </Show>
      }
    >
      {props.app.name}
    </ListRow>
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
  onReorder(id: WorkspaceAppId, direction: 'down' | 'up'): void
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
  const enabledOrder = () => enabledWorkspaceApps(props.preferences).map((app) => app.id)
  const enabled = () => new Set(enabledOrder())
  const visible = () =>
    workspaceApps.filter(
      (app) =>
        (!enabledOnly() || enabled().has(app.id)) &&
        `${app.name} ${app.description}`.toLowerCase().includes(search().trim().toLowerCase())
    )
  const enabledApps = () => visible().filter((app) => enabled().has(app.id))
  const availableApps = () => visible().filter((app) => !enabled().has(app.id))
  const order = () => enabledOrder()

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
          when={visible().length > 0}
          fallback={
            <p class="workspace-app-library__empty" role="status">
              No apps match these filters.
            </p>
          }
        >
          <ListGroup label="In your sidebar">
            <For each={enabledApps()}>
              {(app) => (
                <AppLibraryRow
                  app={app}
                  enabled
                  enabledOrder={order()}
                  onOpen={props.onOpen}
                  onReorder={props.onReorder}
                  onSetEnabled={props.onSetEnabled}
                />
              )}
            </For>
          </ListGroup>
          <Show when={availableApps().length > 0}>
            <ListGroup label="Available">
              <For each={availableApps()}>
                {(app) => (
                  <AppLibraryRow
                    app={app}
                    enabled={false}
                    enabledOrder={order()}
                    onOpen={props.onOpen}
                    onReorder={props.onReorder}
                    onSetEnabled={props.onSetEnabled}
                  />
                )}
              </For>
            </ListGroup>
          </Show>
        </Show>
      </div>
      <footer class="workspace-app-library__footer">
        <ActionButton
          variant="ghost"
          size="sm"
          tooltip="Restore the default apps and sidebar order"
          onClick={props.onReset}
        >
          Reset Navigation
        </ActionButton>
        <p>
          External plugins, skills and connectors are managed in Plugins. Larger installable apps
          will appear here when their installation is supported.
        </p>
      </footer>
    </main>
  )
}
