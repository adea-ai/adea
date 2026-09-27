import { Input } from '@adea-ai/ui/components/ui/input'
import { Button } from '@adea-ai/ui/components/ui/button'
import {
  ChevronDown,
  ChevronUp,
  Check,
  Code2,
  GitBranch,
  LayoutGrid,
  Map,
  MessageSquareText,
} from 'lucide-solid'
import { createSignal, For, Show } from 'solid-js'
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
  preferences: RailPreferencesV1
  onSetEnabled(id: WorkspaceAppId, enabled: boolean): void
  onOpen(id: WorkspaceAppId): void
  onReorder(id: WorkspaceAppId, direction: 'down' | 'up'): void
  onReset(): void
}) {
  const [enabledOnly, setEnabledOnly] = createSignal(false)
  const [search, setSearch] = createSignal('')
  const enabled = () => new Set(enabledWorkspaceApps(props.preferences).map((app) => app.id))
  const visible = () =>
    workspaceApps.filter(
      (app) =>
        (!enabledOnly() || enabled().has(app.id)) &&
        `${app.name} ${app.description}`.toLowerCase().includes(search().trim().toLowerCase())
    )
  return (
    <main class="workspace-app-library" aria-labelledby="workspace-app-library-title">
      <header class="workspace-app-library__header">
        <div>
          <h1 id="workspace-app-library-title">App Library</h1>
          <p>Choose the views and tools in your workspace.</p>
        </div>
        <label class="workspace-app-library__search">
          <span class="visually-hidden">Search apps</span>
          <Input
            type="search"
            placeholder="Search apps"
            value={search()}
            onInput={(event) => setSearch(event.currentTarget.value)}
          />
        </label>
      </header>
      <Button
        variant="ghost"
        size="sm"
        class="workspace-app-library__filter"
        aria-pressed={enabledOnly()}
        onClick={() => setEnabledOnly(!enabledOnly())}
      >
        Show enabled only
      </Button>
      <div class="workspace-app-library__grid">
        <For each={visible()}>
          {(app) => {
            const Icon = APP_ICONS[app.id]
            return (
              <article class="workspace-app-library__app" data-enabled={enabled().has(app.id)}>
                <Button
                  variant={enabled().has(app.id) ? 'secondary' : 'outline'}
                  size="icon-lg"
                  class="workspace-app-library__icon"
                  aria-label={`${enabled().has(app.id) ? 'Disable' : 'Enable'} ${app.name}`}
                  aria-pressed={enabled().has(app.id)}
                  onClick={() => props.onSetEnabled(app.id, !enabled().has(app.id))}
                >
                  <Icon aria-hidden="true" />
                </Button>
                <Show when={enabled().has(app.id)}>
                  <Check class="workspace-app-library__check" aria-hidden="true" />
                </Show>
                <h2>{app.name}</h2>
                <p>{app.description}</p>
                <span>{enabled().has(app.id) ? 'In sidebar' : 'Disabled'}</span>
                <Show when={enabled().has(app.id)}>
                  <Button variant="ghost" size="sm" onClick={() => props.onOpen(app.id)}>
                    Open {app.name}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Move ${app.name} up`}
                    onClick={() => props.onReorder(app.id, 'up')}
                    disabled={props.preferences.order.indexOf(app.id) === 0}
                  >
                    <ChevronUp aria-hidden="true" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Move ${app.name} down`}
                    onClick={() => props.onReorder(app.id, 'down')}
                    disabled={
                      props.preferences.order.indexOf(app.id) === props.preferences.order.length - 1
                    }
                  >
                    <ChevronDown aria-hidden="true" />
                  </Button>
                </Show>
              </article>
            )
          }}
        </For>
      </div>
      <Show when={visible().length === 0}>
        <p role="status">No apps match these filters.</p>
      </Show>
      <Button variant="outline" size="sm" onClick={props.onReset}>
        Reset Navigation
      </Button>
      <p class="workspace-app-library__note">
        External plugins, skills and connectors are managed in Plugins. Larger installable apps will
        appear here when their installation is supported.
      </p>
    </main>
  )
}
