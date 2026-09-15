import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Button } from '@adea-ai/ui/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@adea-ai/ui/components/ui/dropdown-menu'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@adea-ai/ui/components/ui/empty'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Skeleton } from '@adea-ai/ui/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@adea-ai/ui/components/ui/tabs'
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

import { ModalDialog } from './modal-dialog'
import { PluginLogo } from './plugin-logo'
import type { WorkspacePlugin, WorkspacePluginsProvider } from './platform'
import {
  defaultPluginFilter,
  filterWorkspacePlugins,
  getPopularWorkspacePlugins,
  groupWorkspacePlugins,
  type WorkspacePluginFilter,
} from './plugins'

type PluginTab = 'marketplace' | 'yours'

const typeOptions = [
  ['all', 'All types'],
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
        <For each={preview()}>
          {(plugin) => (
            <PluginBrowserRow
              disabled={props.disabled}
              onSelect={() => props.onSelect(plugin.id)}
              plugin={plugin}
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

/**
 * The catalog is account-gated: the Control Plane has no grant for an
 * unauthenticated (guest) workspace, so every catalog fetch fails for one.
 * Saying "unavailable, retry" sent guests into a loop — offer the sign-in
 * action that actually unblocks the marketplace.
 */
function PluginSignInState(props: { onSignIn?: () => void }) {
  return (
    <Empty role="status">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Blocks aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>Sign in to browse plugins</EmptyTitle>
        <EmptyDescription>
          The plugin marketplace is available once you sign in to your Adea account.
        </EmptyDescription>
      </EmptyHeader>
      <Show when={props.onSignIn}>
        {(onSignIn) => (
          <Button type="button" onClick={() => onSignIn()()}>
            Sign in
          </Button>
        )}
      </Show>
    </Empty>
  )
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

function PluginDetail(props: {
  onBack: () => void
  onUpdate: () => void
  plugin: WorkspacePlugin
  saving: boolean
}) {
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
    </article>
  )
}

export function PluginsDialog(props: {
  onClose: () => void
  open: boolean
  provider?: WorkspacePluginsProvider
  /** False when the session is an unauthenticated guest: the catalog is account-gated. */
  authenticated?: boolean
  onSignIn?: () => void
}) {
  const previewCount = usePluginPreviewCount()
  const [expandedGroups, setExpandedGroups] = createSignal<ReadonlySet<string>>(new Set())
  const [plugins, setPlugins] = createSignal<readonly WorkspacePlugin[]>([])
  const [filterOpen, setFilterOpen] = createSignal(false)
  const [query, setQuery] = createSignal('')
  const [selectedId, setSelectedId] = createSignal<string | null>(null)
  const [status, setStatus] = createSignal<'error' | 'idle' | 'loading' | 'saving'>('idle')
  const [catalogState, setCatalogState] = createSignal<
    'idle' | 'loading' | 'ready' | 'stale' | 'verification-failure' | 'unavailable'
  >('idle')
  const [tab, setTab] = createSignal<PluginTab>('marketplace')
  const [filters, setFilters] = createSignal<Record<PluginTab, WorkspacePluginFilter>>({
    marketplace: defaultPluginFilter,
    yours: defaultPluginFilter,
  })
  const activeFilter = () => filters()[tab()]
  const selected = createMemo(() => plugins().find(({ id }) => id === selectedId()))
  const visible = createMemo(() =>
    filterWorkspacePlugins(plugins(), tab(), query(), activeFilter())
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
        setStatus('error')
      })
    if (!provider) {
      setCatalogState('unavailable')
      setStatus('error')
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
    setStatus('saving')
    try {
      setPlugins(await props.provider.requestInstall(plugin.id))
      setStatus('idle')
      setCatalogState(props.provider.getState?.() ?? 'ready')
    } catch {
      setCatalogState(props.provider.getState?.() ?? 'unavailable')
      setStatus('error')
    }
  }

  return (
    <ModalDialog
      class="plugins-dialog"
      description="Browse and manage providers and skills available to your agents."
      onClose={close}
      open={props.open}
      title="Plugins"
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
            <TabsList variant="line" aria-label="Plugins view" class="plugins-browser__tabs">
              <TabsTrigger value="marketplace">Marketplace</TabsTrigger>
              <TabsTrigger value="yours">Yours</TabsTrigger>
            </TabsList>
            <div class="plugins-browser__bar">
              <PluginFilterMenu
                filter={activeFilter()}
                onChange={(filter) => setFilters((current) => ({ ...current, [tab()]: filter }))}
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
                when={status() !== 'loading' && status() !== 'error'}
                fallback={
                  <Show
                    when={props.authenticated === false}
                    fallback={
                      <PluginListState
                        catalogState={
                          catalogState() === 'verification-failure'
                            ? 'verification-failure'
                            : catalogState() === 'stale'
                              ? 'stale'
                              : 'unavailable'
                        }
                        status={status() === 'error' ? 'error' : 'loading'}
                      />
                    }
                  >
                    <PluginSignInState onSignIn={() => props.onSignIn?.()} />
                  </Show>
                }
              >
                <Show
                  when={visible().length > 0}
                  fallback={<PluginsEmpty query={query()} tab={tab()} />}
                >
                  <For each={groups()}>
                    {(group) => (
                      <PluginBrowserGroup
                        disabled={filterOpen()}
                        expanded={expandedGroups().has(group.category)}
                        name={group.category}
                        onSelect={setSelectedId}
                        previewCount={previewCount()}
                        onToggle={() =>
                          setExpandedGroups((current) => {
                            const next = new Set<string>(current)
                            if (next.has(group.category)) next.delete(group.category)
                            else next.add(group.category)
                            return next
                          })
                        }
                        plugins={group.plugins}
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
