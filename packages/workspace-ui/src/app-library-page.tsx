import { InputGroup, InputGroupAddon, InputGroupInput } from '@adea-ai/ui/components/ui/input-group'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { ListGroup, ListRowControl } from '@adea-ai/ui/components/composites/list-row'
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
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
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
  const enabledOrder = createMemo(() =>
    enabledWorkspaceApps(props.preferences).map((app) => app.id)
  )
  const enabled = createMemo(() => new Set(enabledOrder()))
  const query = createMemo(() => search().trim().toLowerCase())
  const groups = [true, false].map((isEnabled) => ({
    label: isEnabled ? 'In your sidebar' : 'Available',
    apps: createMemo(() =>
      enabledOnly() && !isEnabled
        ? []
        : workspaceApps.filter(
            (app) =>
              enabled().has(app.id) === isEnabled &&
              `${app.name} ${app.description}`.toLowerCase().includes(query())
          )
    ),
    enabled: isEnabled,
  }))

  const renderRow = (app: WorkspaceApp, isEnabled: boolean) => {
    const Icon = APP_ICONS[app.id]
    const position = () => enabledOrder().indexOf(app.id)

    return (
      <ListRowControl
        leading={<Icon aria-hidden="true" />}
        description={app.description}
        trailing={
          <Show
            when={isEnabled}
            fallback={
              <ActionButton
                variant="outline"
                size="sm"
                tooltip={`Add ${app.name} to your sidebar`}
                aria-label={`Enable ${app.name}`}
                onClick={() => props.onSetEnabled(app.id, true)}
              >
                Enable
              </ActionButton>
            }
          >
            <>
              <ActionButton
                variant="ghost"
                size="sm"
                tooltip={`Switch to ${app.name}`}
                onClick={() => props.onOpen(app.id)}
              >
                Open {app.name}
              </ActionButton>
              <ActionButton
                variant="ghost"
                size="icon-sm"
                aria-label={`Move ${app.name} up`}
                tooltip={
                  position() === 0
                    ? `${app.name} is already first in your sidebar`
                    : `Move ${app.name} earlier in your sidebar`
                }
                disabled={position() === 0}
                onClick={() => props.onReorder(app.id, 'up')}
              >
                <ChevronUp aria-hidden="true" />
              </ActionButton>
              <ActionButton
                variant="ghost"
                size="icon-sm"
                aria-label={`Move ${app.name} down`}
                tooltip={
                  position() === enabledOrder().length - 1
                    ? `${app.name} is already last in your sidebar`
                    : `Move ${app.name} later in your sidebar`
                }
                disabled={position() === enabledOrder().length - 1}
                onClick={() => props.onReorder(app.id, 'down')}
              >
                <ChevronDown aria-hidden="true" />
              </ActionButton>
              <ActionButton
                variant="ghost"
                size="sm"
                aria-label={`Disable ${app.name}`}
                tooltip={`Remove ${app.name} from your sidebar`}
                onClick={() => props.onSetEnabled(app.id, false)}
              >
                Disable
              </ActionButton>
            </>
          </Show>
        }
      >
        {app.name}
      </ListRowControl>
    )
  }

  return (
    <main class="workspace-app-library" aria-labelledby="workspace-app-library-title">
      <header class="workspace-app-library__header">
        <div class="workspace-app-library__heading">
          <h1 id="workspace-app-library-title">App Library</h1>
          <p>Choose the views and tools in your workspace.</p>
        </div>
        <div class="workspace-app-library__controls">
          <InputGroup class="workspace-app-library__search">
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
        <Show when={groups.every((group) => group.apps().length === 0)}>
          <p class="workspace-app-library__empty" role="status">
            No apps match these filters.
          </p>
        </Show>
        {groups.map((group) => (
          <Show when={group.apps().length > 0}>
            <ListGroup label={group.label} role="group" aria-label={group.label}>
              <For each={group.apps()}>{(app) => renderRow(app, group.enabled)}</For>
            </ListGroup>
          </Show>
        ))}
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
