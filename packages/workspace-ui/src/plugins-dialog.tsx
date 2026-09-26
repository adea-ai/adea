import { Badge } from '@adea-ai/app-ui/components/ui/badge'
import { Button } from '@adea-ai/app-ui/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@adea-ai/app-ui/components/ui/dropdown-menu'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@adea-ai/app-ui/components/ui/empty'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Skeleton } from '@adea-ai/app-ui/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@adea-ai/app-ui/components/ui/tabs'
import {
  ArrowLeft,
  Blocks,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Filter,
  Search,
  ShieldCheck,
} from 'lucide-solid'
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'

import { keyedRows } from './keyed-rows'
import { ModalDialog } from './modal-dialog'
import { PluginLogo } from './plugin-logo'
import type { WorkspaceAppActivation, WorkspacePlugin, WorkspacePluginsProvider } from './platform'
import { workspaceAppActivation } from './platform'
import type { RailItem, RailPreferencesV1 } from './rail-preferences'
import {
  defaultPluginFilter,
  filterWorkspacePlugins,
  getPopularWorkspacePlugins,
  groupWorkspacePlugins,
  type WorkspacePluginFilter,
} from './plugins'

type PluginTab = 'marketplace' | 'navigation' | 'yours'

/**
 * Rail customization handed to the App Library by the shell. The dialog owns
 * the controls; the rail owns the truth.
 */
export type AppLibraryNavigation = Readonly<{
  items: readonly RailItem[]
  activeItemId?: string
  preferences: RailPreferencesV1
  onReorder: (id: string, direction: 'up' | 'down') => void
  onSetHidden: (id: string, hidden: boolean) => void
  onReset: () => void
}>

const typeOptions = [
  ['all', 'All types'],
  ['apps', 'Apps'],
  ['connectors', 'Connectors'],
  ['skills', 'Skills'],
] as const

const ownershipOptions = [
  ['all', 'All'],
  ['team', 'Team'],
  ['public', 'Public'],
] as const

const previewSkeletons = Array.from({ length: 7 })

function PluginFilterMenu(props: {
  filter: WorkspacePluginFilter
  onChange: (filter: WorkspacePluginFilter) => void
  onOpenChange: (open: boolean) => void
}) {
  const active = () => props.filter.type !== 'all' || props.filter.ownership !== 'all'
  return (
    <DropdownMenu onOpenChange={props.onOpenChange}>
      <DropdownMenuTrigger as={Button} variant="outline" size="sm" aria-pressed={active()}>
        <Filter data-icon="inline-start" aria-hidden="true" />
        Filter
        <Show when={active()}>
          <span class="plugins-filter__dot" aria-hidden="true" />
        </Show>
      </DropdownMenuTrigger>
      <DropdownMenuContent class="plugins-filter" align="start">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Type</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={props.filter.type}
            onChange={(type) =>
              props.onChange({ ...props.filter, type: type as WorkspacePluginFilter['type'] })
            }
          >
            <For each={typeOptions}>
              {([value, label]) => (
                <DropdownMenuRadioItem value={value}>{label}</DropdownMenuRadioItem>
              )}
            </For>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Ownership</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={props.filter.ownership}
            onChange={(ownership) =>
              props.onChange({
                ...props.filter,
                ownership: ownership as WorkspacePluginFilter['ownership'],
              })
            }
          >
            <For each={ownershipOptions}>
              {([value, label]) => (
                <DropdownMenuRadioItem value={value}>{label}</DropdownMenuRadioItem>
              )}
            </For>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function PluginBrowserRow(props: {
  disabled: boolean
  onSelect: () => void
  plugin: WorkspacePlugin
}) {
  return (
    <button
      type="button"
      class="plugins-browser__row"
      disabled={props.disabled}
      onClick={() => props.onSelect()}
    >
      <PluginLogo iconUrl={props.plugin.iconUrl} name={props.plugin.name} />
      <span class="plugins-browser__row-copy">
        <span class="plugins-browser__row-title">
          <strong>{props.plugin.name}</strong>
          <Show when={props.plugin.installed}>
            <Badge variant="secondary">Installed</Badge>
          </Show>
        </span>
        <small>{props.plugin.description}</small>
        <span class="plugins-browser__row-meta">
          {props.plugin.publisher} · {props.plugin.category}
        </span>
      </span>
      <ChevronRight aria-hidden="true" />
    </button>
  )
}

function usePluginPreviewCount(): () => number {
  const [wide, setWide] = createSignal(
    typeof window === 'undefined' || window.matchMedia('(min-width: 48rem)').matches
  )
  createEffect(() => {
    const query = window.matchMedia('(min-width: 48rem)')
    const onChange = (event: MediaQueryListEvent) => setWide(event.matches)
    query.addEventListener('change', onChange)
    onCleanup(() => query.removeEventListener('change', onChange))
  })
  // Wide viewports lay the grid out two columns; narrow ones use one. Three
  // rows either way.
  return () => (wide() ? 6 : 3)
}

function PluginBrowserGroup(props: {
  disabled: boolean
  expanded: boolean
  name: string
  onSelect: (pluginId: string) => void
  onToggle: () => void
  plugins: readonly WorkspacePlugin[]
  previewCount: number
}) {
  const id = () => `plugins-category-${props.name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  const preview = () =>
    props.expanded ? props.plugins : props.plugins.slice(0, props.previewCount)
  const hidden = () => props.plugins.slice(props.previewCount)
  // The filtered list changes on every search keystroke; keyed rows keep each
  // row's DOM alive so typing does not rebuild the grid each character.
  const pluginRows = keyedRows(preview, (plugin) => plugin.id)
  const expandLabel = () => {
    const nextNames = hidden()
      .slice(0, 2)
      .map((plugin) => plugin.name)
    return `See ${nextNames.join(', ')}${hidden().length > 2 ? ' and more' : ''}`
  }

  return (
    <section class="plugins-browser__group" aria-labelledby={id()}>
      <header class="plugins-browser__group-heading">
        <h3 id={id()}>{props.name}</h3>
        <span>{props.plugins.length}</span>
      </header>
      <div class="plugins-browser__grid">
        <For each={pluginRows()}>
          {(entry) => (
            <PluginBrowserRow
              disabled={props.disabled}
              onSelect={() => props.onSelect(entry.item().id)}
              plugin={entry.item()}
            />
          )}
        </For>
      </div>
      <Show when={hidden().length > 0}>
        <Button
          class="plugins-browser__more"
          disabled={props.disabled}
          onClick={() => props.onToggle()}
          size="sm"
          type="button"
          variant="ghost"
        >
          <Show
            when={props.expanded}
            fallback={
              <>
                {expandLabel()} <ChevronDown data-icon="inline-end" aria-hidden="true" />
              </>
            }
          >
            <>
              Show less <ChevronUp data-icon="inline-end" aria-hidden="true" />
            </>
          </Show>
        </Button>
      </Show>
    </section>
  )
}

/** The install refusal, in the user's terms, without leaking provider detail. */
function describeInstallFailure(error: unknown): string {
  const code = (error as { error?: { code?: string } } | null)?.error?.code
  if (code === 'verification-failure')
    return 'The catalog could not be verified, so this install was refused.'
  if (code === 'stale_catalog' || code === 'stale_version')
    return 'The catalog changed while you were looking. Reopen Plugins and try again.'
  return 'The install could not be started.'
}

function PluginListState(props: {
  catalogState: 'stale' | 'unavailable' | 'verification-failure'
  status: 'error' | 'loading'
}) {
  return (
    <Show
      when={props.status === 'loading'}
      fallback={
        <Empty role="alert">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Blocks aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>
              {props.catalogState === 'verification-failure'
                ? 'Plugin catalog could not be verified'
                : 'Plugin catalog unavailable'}
            </EmptyTitle>
            <EmptyDescription>
              {props.catalogState === 'verification-failure'
                ? 'The catalog was rejected because its signed metadata did not verify.'
                : 'Close Plugins and open it again to retry.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      }
    >
      <div class="plugins-browser__skeleton" aria-label="Loading plugins" aria-busy="true">
        <For each={previewSkeletons}>
          {() => (
            <div>
              <Skeleton class="plugins-browser__skeleton-mark" />
              <span>
                <Skeleton class="plugins-browser__skeleton-title" />
                <Skeleton class="plugins-browser__skeleton-copy" />
              </span>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

function PluginsEmpty(props: { query: string; tab: PluginTab }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Blocks aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>
          {props.tab === 'yours' ? 'No plugins added yet' : 'No matching plugins'}
        </EmptyTitle>
        <EmptyDescription>
          {props.tab === 'yours'
            ? 'Add a provider or skill from Marketplace and it will appear here.'
            : props.query.trim()
              ? `No plugins match “${props.query.trim()}”.`
              : 'No plugins match the current filters.'}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

function activationEntryId(activation: WorkspaceAppActivation): string {
  return activation.status === 'activatable' ? activation.entryId : ''
}

/** Human-readable explanation for every fail-closed activation rejection. */
const ACTIVATION_REJECTION_COPY: Record<
  Exclude<
    Extract<WorkspaceAppActivation, { status: 'activation-unavailable' }>['reason'],
    'not-installed' | 'catalog-only'
  >,
  string
> = {
  'untrusted-entry':
    'Activation unavailable: this entry id is not in this build’s trusted first-party registry. Only entries compiled into the app can execute interface code.',
  'integrity-failure':
    'Activation unavailable: the catalog entry digest does not match the compiled app entry. Refresh the catalog before activating.',
  'plan-unverified':
    'Activation unavailable: no verified Control Plane installation plan is bound to this app. Activation needs a verified plan.',
  stale:
    'Activation unavailable: the catalog record has no source revision, so its freshness cannot be proven. Refresh the catalog before activating.',
}

function activationUnavailableReason(activation: WorkspaceAppActivation): string {
  if (activation.status === 'activatable') return 'catalog-only'
  if (activation.reason === 'not-installed' || activation.reason === 'catalog-only')
    return activation.reason
  return ACTIVATION_REJECTION_COPY[activation.reason]
}

function AppActivationSection(props: { activation: WorkspaceAppActivation }) {
  const copy = () => activationUnavailableReason(props.activation)
  const isPlainReason = () =>
    props.activation.status === 'activatable' ||
    props.activation.reason === 'not-installed' ||
    props.activation.reason === 'catalog-only'
  return (
    <section class="plugins-detail__section" aria-labelledby="plugin-activation-heading">
      <h4 id="plugin-activation-heading">Activation</h4>
      <Show
        when={props.activation.status === 'activatable'}
        fallback={
          <p role="note">
            <ShieldCheck aria-hidden="true" />
            <Show when={isPlainReason()} fallback={<span>{copy()}</span>}>
              {copy() === 'not-installed'
                ? 'Activation unlocks after this app is installed.'
                : 'Activation unavailable: this catalog entry has no bundled first-party implementation. It can install metadata and connectors, but it cannot execute interface code.'}
            </Show>
          </p>
        }
      >
        <p>
          <Check aria-hidden="true" /> Bundled first-party app entry{' '}
          <code>{activationEntryId(props.activation)}</code> can activate.
        </p>
      </Show>
    </section>
  )
}

function PluginDetail(props: {
  onBack: () => void
  onUpdate: () => void
  plugin: WorkspacePlugin
  saving: boolean
}) {
  const activation = () => workspaceAppActivation(props.plugin)
  return (
    <article class="plugins-detail">
      <Button type="button" variant="ghost" size="sm" onClick={() => props.onBack()}>
        <ArrowLeft data-icon="inline-start" aria-hidden="true" />
        Back to plugins
      </Button>
      <header class="plugins-detail__hero">
        <PluginLogo iconUrl={props.plugin.iconUrl} name={props.plugin.name} />
        <div>
          <div class="plugins-detail__eyebrow">
            <Badge variant="outline">
              {props.plugin.kind === 'connector' ? 'Connector' : 'Skill'}
            </Badge>
            <Badge variant="secondary">{props.plugin.sourceId ?? props.plugin.source}</Badge>
            <span>{props.plugin.category}</span>
          </div>
          <h3>{props.plugin.name}</h3>
          <p>{props.plugin.description}</p>
          <small>Published by {props.plugin.publisher}</small>
        </div>
      </header>
      <div class="plugins-detail__actions">
        <Button
          type="button"
          variant={props.plugin.installed ? 'outline' : 'default'}
          disabled={props.saving || props.plugin.installationStatus !== 'available'}
          onClick={() => props.onUpdate()}
        >
          {props.saving
            ? 'Requesting…'
            : props.plugin.installationStatus === 'installed'
              ? 'Installed'
              : props.plugin.installationStatus === 'pending-authorization'
                ? 'Authorization pending'
                : props.plugin.installationStatus === 'rejected-by-policy'
                  ? 'Rejected by policy'
                  : props.plugin.installationStatus === 'superseded'
                    ? 'Superseded'
                    : props.plugin.installationStatus === 'unavailable'
                      ? 'Unavailable'
                      : 'Add'}
        </Button>
        <Show when={props.plugin.installed}>
          <span role="status">
            <Check aria-hidden="true" /> Installed through Control Plane
          </span>
        </Show>
      </div>
      <section class="plugins-detail__section" aria-labelledby="plugin-capabilities-heading">
        <h4 id="plugin-capabilities-heading">Capabilities</h4>
        <ul>
          <For each={props.plugin.capabilities}>
            {(capability) => (
              <li>
                <Check aria-hidden="true" /> {capability}
              </li>
            )}
          </For>
        </ul>
      </section>
      <section class="plugins-detail__section" aria-labelledby="plugin-connection-heading">
        <h4 id="plugin-connection-heading">Connection</h4>
        <p>
          <ShieldCheck aria-hidden="true" />
          {props.plugin.auth === 'oauth'
            ? 'OAuth provider'
            : props.plugin.auth === 'api-key'
              ? 'API credential provider'
              : 'Managed by this workspace'}
        </p>
        <small>
          Adding enables this provider in Adea. Account authorization and runtime execution stay
          within the authoritative Control Plane connection.
        </small>
      </section>
      <section class="plugins-detail__section" aria-labelledby="plugin-source-heading">
        <h4 id="plugin-source-heading">Bundle</h4>
        <p>{props.plugin.surfaces.map((surface) => surface.toLocaleUpperCase()).join(' · ')}</p>
        <small>
          {props.plugin.sourceUrl
            ? `Source: ${props.plugin.sourceUrl}.`
            : `Source: ${props.plugin.sourceId ?? props.plugin.source}.`}
          {props.plugin.sourceRevision ? ` Commit: ${props.plugin.sourceRevision}.` : ''}
          {props.plugin.license ? ` License: ${props.plugin.license}.` : ''}
          {props.plugin.contentResolution === 'metadata-only' ? ' Content is metadata-only.' : ''}
        </small>
      </section>
      <Show when={props.plugin.appSurface}>
        {(app) => (
          <section class="plugins-detail__section" aria-labelledby="plugin-app-heading">
            <h4 id="plugin-app-heading">App</h4>
            <small>
              Platforms: {app().supportedPlatforms.join(', ') || 'unspecified'}.
              {app().requestedPermissions.length > 0
                ? ` Requests: ${app().requestedPermissions.join(', ')}.`
                : ' Requests no additional permissions.'}
              {app().version ? ` Version ${app().version}.` : ''}
              {app().digest ? ` Digest ${app().digest}.` : ''}
            </small>
          </section>
        )}
      </Show>
      <Show when={props.plugin.appSurface}>
        <AppActivationSection activation={activation()} />
      </Show>
    </article>
  )
}

function NavigationMissing() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Blocks aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>Navigation is unavailable</EmptyTitle>
        <EmptyDescription>
          Open the App Library from the rail to manage navigation.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

function NavigationPanel(props: { navigation: AppLibraryNavigation }) {
  return (
    <div class="plugins-navigation">
      <p class="plugins-navigation__hint">
        Order and show the global rail entries. Core views stay recoverable: hiding one is temporary
        while it is active, and Reset Navigation restores the default rail.
      </p>
      <ul class="plugins-navigation__list">
        <For each={props.navigation.items}>
          {(item) => (
            <li class="plugins-navigation__row">
              <span class="plugins-navigation__label">
                <span class="plugins-navigation__name">{item.label}</span>
                <Show when={props.navigation.activeItemId === item.id}>
                  <Badge variant="secondary">Active</Badge>
                </Show>
              </span>
              <span class="plugins-navigation__controls">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move ${item.label} up`}
                  onClick={() => props.navigation.onReorder(item.id, 'up')}
                >
                  <ChevronUp aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move ${item.label} down`}
                  onClick={() => props.navigation.onReorder(item.id, 'down')}
                >
                  <ChevronDown aria-hidden="true" />
                </Button>
                <label class="plugins-navigation__visibility">
                  <input
                    type="checkbox"
                    checked={!props.navigation.preferences.hidden.includes(item.id)}
                    onChange={(event) =>
                      props.navigation.onSetHidden(item.id, !event.currentTarget.checked)
                    }
                  />
                  Show
                </label>
              </span>
            </li>
          )}
        </For>
      </ul>
      <Button type="button" variant="outline" size="sm" onClick={() => props.navigation.onReset()}>
        Reset Navigation
      </Button>
    </div>
  )
}

export function PluginsDialog(props: {
  onClose: () => void
  open: boolean
  provider?: WorkspacePluginsProvider
  navigation?: AppLibraryNavigation
}) {
  const previewCount = usePluginPreviewCount()
  const [expandedGroups, setExpandedGroups] = createSignal<ReadonlySet<string>>(new Set())
  const [plugins, setPlugins] = createSignal<readonly WorkspacePlugin[]>([])
  const [filterOpen, setFilterOpen] = createSignal(false)
  const [query, setQuery] = createSignal('')
  const [selectedId, setSelectedId] = createSignal<string | null>(null)
  const [status, setStatus] = createSignal<'idle' | 'loading' | 'saving'>('idle')
  // Whether the CATALOG itself failed to load — the one case that replaces the
  // list. An install refusal keeps the list and reports separately.
  const [catalogFailed, setCatalogFailed] = createSignal(false)
  const [installError, setInstallError] = createSignal<string | undefined>()
  const [catalogState, setCatalogState] = createSignal<
    'idle' | 'loading' | 'ready' | 'stale' | 'verification-failure' | 'unavailable'
  >('idle')
  const [tab, setTab] = createSignal<PluginTab>('marketplace')
  const [filters, setFilters] = createSignal<
    Record<'marketplace' | 'yours', WorkspacePluginFilter>
  >({
    marketplace: defaultPluginFilter,
    yours: defaultPluginFilter,
  })
  const activeFilter = () => filters()[browserTab()] ?? defaultPluginFilter
  const selected = createMemo(() => plugins().find(({ id }) => id === selectedId()))
  // The Navigation tab shows no browser; the list is computed as Discover so
  // the memo stays total without leaking the navigation value into the filter.
  const browserTab = (): 'marketplace' | 'yours' => {
    const current = tab()
    return current === 'navigation' ? 'marketplace' : current
  }
  const visible = createMemo(() =>
    filterWorkspacePlugins(plugins(), browserTab(), query(), activeFilter())
  )
  const groups = createMemo(() => {
    const grouped = groupWorkspacePlugins(visible())
    const showPopular =
      tab() === 'marketplace' &&
      query().trim().length === 0 &&
      activeFilter().type === 'all' &&
      activeFilter().ownership === 'all'
    return showPopular
      ? [{ category: 'Popular', plugins: getPopularWorkspacePlugins(visible()) }, ...grouped]
      : grouped
  })
  // Groups recompute on every search keystroke; key by category so group
  // sections keep their DOM instead of remounting per character.
  const groupRows = keyedRows(groups, (group) => group.category)

  createEffect(() => {
    const provider = props.provider
    if (!props.open) return
    setStatus('loading')
    setCatalogState('loading')
    let active = true
    void provider
      ?.list()
      .then((items) => {
        if (!active) return
        setPlugins(items)
        setStatus('idle')
        setCatalogState(provider.getState?.() ?? 'ready')
      })
      .catch(() => {
        if (!active) return
        setCatalogState(provider?.getState?.() ?? 'unavailable')
        setCatalogFailed(true)
        setStatus('idle')
      })
    if (!provider) {
      setCatalogState('unavailable')
      setCatalogFailed(true)
      setStatus('idle')
    }
    onCleanup(() => {
      active = false
    })
  })

  const close = () => {
    setExpandedGroups(new Set<string>())
    setFilterOpen(false)
    setSelectedId(null)
    props.onClose()
  }
  const update = async (plugin: WorkspacePlugin) => {
    if (!props.provider || status() === 'saving') return
    setInstallError(undefined)
    setStatus('saving')
    try {
      setPlugins(await props.provider.requestInstall(plugin.id))
      setStatus('idle')
      setCatalogState(props.provider.getState?.() ?? 'ready')
    } catch (error) {
      // An install rejection — a stale snapshot, a policy refusal, an unknown
      // release — is NOT a catalog failure. Setting `status` to 'error' routed
      // the whole browser into `PluginListState`, which destroyed a list that
      // had loaded fine and told the user the catalog was unavailable. Report
      // the install failure and keep the catalog on screen.
      setInstallError(describeInstallFailure(error))
      setStatus('idle')
    }
  }

  return (
    <ModalDialog
      class="plugins-dialog"
      description="Browse and manage apps, providers, and skills available to your agents."
      onClose={close}
      open={props.open}
      title="App Library"
    >
      <Show
        when={selected()}
        fallback={
          <Tabs
            class="plugins-browser"
            data-filter-open={filterOpen()}
            value={tab()}
            onChange={(value) => value && setTab(value as PluginTab)}
          >
            <TabsList variant="line" aria-label="App Library view" class="plugins-browser__tabs">
              <TabsTrigger value="marketplace">Discover</TabsTrigger>
              <TabsTrigger value="yours">Installed</TabsTrigger>
              <Show when={props.navigation}>
                {(navigation) => (
                  <TabsTrigger value="navigation">
                    Navigation ({navigation().items.length})
                  </TabsTrigger>
                )}
              </Show>
            </TabsList>
            <Show
              when={tab() !== 'navigation'}
              fallback={
                <Show when={props.navigation} fallback={<NavigationMissing />}>
                  {(navigation) => <NavigationPanel navigation={navigation()} />}
                </Show>
              }
            >
              <div class="plugins-browser__body">
                <Show when={installError()}>
                  {(message) => (
                    <p class="plugins-browser__install-error" role="alert">
                      {message()}
                    </p>
                  )}
                </Show>
                <div class="plugins-browser__bar">
                  <PluginFilterMenu
                    filter={activeFilter()}
                    onChange={(filter) =>
                      setFilters((current) => ({
                        ...current,
                        [browserTab()]: filter,
                      }))
                    }
                    onOpenChange={setFilterOpen}
                  />
                  <label class="plugins-browser__search">
                    <Search aria-hidden="true" />
                    <Input
                      type="search"
                      aria-label="Search plugins"
                      placeholder="Search plugins"
                      value={query()}
                      onInput={(event) => setQuery(event.currentTarget.value)}
                    />
                  </label>
                  <span class="plugins-browser__count" aria-live="polite">
                    {visible().length} {visible().length === 1 ? 'plugin' : 'plugins'}
                  </span>
                </div>
                <TabsContent value={tab()} class="plugins-browser__list">
                  <Show
                    when={status() !== 'loading' && !catalogFailed()}
                    fallback={
                      <PluginListState
                        catalogState={
                          catalogFailed()
                            ? catalogState() === 'verification-failure'
                              ? 'verification-failure'
                              : catalogState() === 'stale'
                                ? 'stale'
                                : 'unavailable'
                            : catalogState() === 'stale'
                              ? 'stale'
                              : 'unavailable'
                        }
                        status={catalogFailed() ? 'error' : 'loading'}
                      />
                    }
                  >
                    <Show
                      when={visible().length > 0}
                      fallback={<PluginsEmpty query={query()} tab={tab()} />}
                    >
                      <For each={groupRows()}>
                        {(entry) => (
                          <PluginBrowserGroup
                            disabled={filterOpen()}
                            expanded={expandedGroups().has(entry.item().category)}
                            name={entry.item().category}
                            onSelect={setSelectedId}
                            previewCount={previewCount()}
                            onToggle={() =>
                              setExpandedGroups((current) => {
                                const next = new Set<string>(current)
                                if (next.has(entry.item().category))
                                  next.delete(entry.item().category)
                                else next.add(entry.item().category)
                                return next
                              })
                            }
                            plugins={entry.item().plugins}
                          />
                        )}
                      </For>
                    </Show>
                  </Show>
                </TabsContent>
                <Show when={catalogState() === 'stale' && status() === 'idle'}>
                  <p class="plugins-browser__notice" role="status">
                    Showing the last-known-good catalog while the registry is unavailable.
                  </p>
                </Show>
                <Show when={catalogState() === 'verification-failure' && status() === 'idle'}>
                  <p class="plugins-browser__notice" role="alert">
                    The latest catalog failed integrity verification and was not accepted.
                  </p>
                </Show>
              </div>
            </Show>
          </Tabs>
        }
      >
        {(plugin) => (
          <PluginDetail
            onBack={() => setSelectedId(null)}
            onUpdate={() => void update(plugin())}
            plugin={plugin()}
            saving={status() === 'saving'}
          />
        )}
      </Show>
    </ModalDialog>
  )
}
