import { Input } from '@adea-ai/ui/components/ui/input'
import { Button } from '@adea-ai/ui/components/ui/button'
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
import { enabledWorkspaceApps, workspaceApps, type WorkspaceAppId } from './workspace-apps'

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

  return (
    <main class="workspace-app-library" aria-labelledby="workspace-app-library-title">
      <header class="workspace-app-library__header">
        <div class="workspace-app-library__heading">
          <h1 id="workspace-app-library-title">App Library</h1>
          <p>Choose the views and tools in your workspace.</p>
        </div>
        <div class="workspace-app-library__controls">
          <label class="workspace-app-library__search">
            <Search aria-hidden="true" class="workspace-app-library__search-icon" />
            <span class="sr-only">Search apps</span>
            <Input
              ref={(element) => (searchInput = element)}
              type="search"
              placeholder="Search apps"
              value={search()}
              onInput={(event) => setSearch(event.currentTarget.value)}
            />
          </label>
          <Button
            variant={enabledOnly() ? 'secondary' : 'outline'}
            size="sm"
            aria-pressed={enabledOnly()}
            onClick={() => setEnabledOnly(!enabledOnly())}
          >
            Show enabled only
          </Button>
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
              {(app) => {
                const Icon = APP_ICONS[app.id]
                return (
                  <ListRow
                    class="workspace-app-library__row"
                    leading={
                      <span class="workspace-app-library__icon" aria-hidden="true">
                        <Icon />
                      </span>
                    }
                    description={app.description}
                    trailing={
                      <span class="workspace-app-library__actions">
                        <Badge variant="secondary">In sidebar</Badge>
                        <Button variant="ghost" size="sm" onClick={() => props.onOpen(app.id)}>
                          Open {app.name}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Move ${app.name} up`}
                          disabled={enabledOrder().indexOf(app.id) === 0}
                          onClick={() => props.onReorder(app.id, 'up')}
                        >
                          <ChevronUp aria-hidden="true" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Move ${app.name} down`}
                          disabled={enabledOrder().indexOf(app.id) === enabledOrder().length - 1}
                          onClick={() => props.onReorder(app.id, 'down')}
                        >
                          <ChevronDown aria-hidden="true" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Disable ${app.name}`}
                          onClick={() => props.onSetEnabled(app.id, false)}
                        >
                          Disable
                        </Button>
                      </span>
                    }
                  >
                    {app.name}
                  </ListRow>
                )
              }}
            </For>
          </ListGroup>
          <Show when={availableApps().length > 0}>
            <ListGroup label="Available">
              <For each={availableApps()}>
                {(app) => {
                  const Icon = APP_ICONS[app.id]
                  return (
                    <ListRow
                      class="workspace-app-library__row"
                      leading={
                        <span
                          class="workspace-app-library__icon workspace-app-library__icon--muted"
                          aria-hidden="true"
                        >
                          <Icon />
                        </span>
                      }
                      description={app.description}
                      trailing={
                        <span class="workspace-app-library__actions">
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={`Enable ${app.name}`}
                            onClick={() => props.onSetEnabled(app.id, true)}
                          >
                            Enable
                          </Button>
                        </span>
                      }
                    >
                      {app.name}
                    </ListRow>
                  )
                }}
              </For>
            </ListGroup>
          </Show>
        </Show>
      </div>
      <footer class="workspace-app-library__footer">
        <Button variant="ghost" size="sm" onClick={props.onReset}>
          Reset Navigation
        </Button>
        <p>
          External plugins, skills and connectors are managed in Plugins. Larger installable apps
          will appear here when their installation is supported.
        </p>
      </footer>
    </main>
  )
}
