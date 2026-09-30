import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Button } from '@adea-ai/ui/components/ui/button'
import {
  CatalogBrowser,
  CatalogDetail,
  CatalogDetailSection,
  type CatalogBrowserEntry,
  type CatalogBrowserGroup,
  type CatalogBrowserTab,
} from '@adea-ai/ui/components/composites/catalog-browser'
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
import { Checkbox } from '@adea-ai/ui/components/ui/checkbox'
import { Blocks, Check, ChevronDown, ChevronUp, Filter, ShieldCheck } from 'lucide-solid'
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'

import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { ModalDialog } from '@adea-ai/ui/components/ui/modal-dialog'
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

function toCatalogEntry(plugin: WorkspacePlugin): CatalogBrowserEntry<WorkspacePlugin> {
  return {
    id: plugin.id,
    value: plugin,
    name: plugin.name,
    description: plugin.description,
    category: plugin.category,
    publisher: plugin.publisher,
    installed: plugin.installed,
  }
}

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
      <DropdownMenuContent
        hideArrow
        placement="bottom-start"
        gutter={4}
        class="plugins-filter max-h-(--kb-popper-available-height) overflow-x-hidden overflow-y-auto"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel>Type</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={props.filter.type}
            onChange={(type: unknown) => {
              if (type !== 'all' && type !== 'apps' && type !== 'connectors' && type !== 'skills')
                return
              props.onChange({ ...props.filter, type })
            }}
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
            onChange={(ownership: unknown) => {
              if (ownership !== 'all' && ownership !== 'team' && ownership !== 'public') return
              props.onChange({ ...props.filter, ownership })
            }}
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

/** The install refusal, in the user's terms, without leaking provider detail. */
function describeInstallFailure(error: unknown): string {
  const code = (error as { error?: { code?: string } } | null)?.error?.code
  if (code === 'verification-failure')
    return 'The catalog could not be verified, so this install was refused.'
  if (code === 'stale_catalog' || code === 'stale_version')
    return 'The catalog changed while you were looking. Reopen Plugins and try again.'
  return 'The install could not be started.'
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
    <CatalogDetailSection title="Activation">
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
    </CatalogDetailSection>
  )
}

function PluginDetail(props: {
  onUpdate: () => void
  plugin: WorkspacePlugin
  saving: boolean
  installError?: string
}) {
  const activation = () => workspaceAppActivation(props.plugin)
  const installationNotice = () => {
    switch (props.plugin.installationStatus) {
      case 'pending-authorization':
        return 'This install request is waiting for workspace authorization.'
      case 'rejected-by-policy':
        return 'Workspace policy rejected this installation.'
      case 'superseded':
        return 'This release was superseded. Reopen Plugins to check the current catalog.'
      case 'unavailable':
        return 'This catalog entry is currently unavailable.'
      default:
        return undefined
    }
  }
  return (
    <CatalogDetail
      title={props.plugin.name}
      description={props.plugin.description}
      category={props.plugin.category}
      publisher={props.plugin.publisher}
      publishedByLabel={(publisher) => `Published by ${publisher}`}
      leading={<PluginLogo iconUrl={props.plugin.iconUrl} name={props.plugin.name} />}
      eyebrow={props.plugin.kind === 'connector' ? 'Connector' : 'Skill'}
      badges={<Badge variant="outline">{props.plugin.sourceId ?? props.plugin.source}</Badge>}
      action={
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
      }
      status={
        <div class="grid min-w-0 gap-2">
          <Show when={props.installError}>{(message) => <p role="alert">{message()}</p>}</Show>
          <Show when={props.plugin.installed}>
            <p role="status">
              <Check aria-hidden="true" /> Installed through Control Plane
            </p>
          </Show>
          <Show when={installationNotice()}>{(message) => <p role="status">{message()}</p>}</Show>
        </div>
      }
    >
      <CatalogDetailSection title="Capabilities">
        <ul class="grid gap-2 text-sm">
          <For each={props.plugin.capabilities}>
            {(capability) => (
              <li>
                <Check aria-hidden="true" /> {capability}
              </li>
            )}
          </For>
        </ul>
      </CatalogDetailSection>
      <CatalogDetailSection title="Connection">
        <p>
          <ShieldCheck aria-hidden="true" />{' '}
          {props.plugin.auth === 'oauth'
            ? 'OAuth provider'
            : props.plugin.auth === 'api-key'
              ? 'API credential provider'
              : 'Managed by this workspace'}
        </p>
        <p class="text-muted-foreground text-sm">
          Adding enables this provider in Adea. Account authorization and runtime execution stay
          within the authoritative Control Plane connection.
        </p>
      </CatalogDetailSection>
      <CatalogDetailSection title="Bundle">
        <p>{props.plugin.surfaces.map((surface) => surface.toLocaleUpperCase()).join(' · ')}</p>
        <p class="text-muted-foreground text-sm">
          {props.plugin.sourceUrl
            ? `Source: ${props.plugin.sourceUrl}.`
            : `Source: ${props.plugin.sourceId ?? props.plugin.source}.`}
          {props.plugin.sourceRevision ? ` Commit: ${props.plugin.sourceRevision}.` : ''}
          {props.plugin.license ? ` License: ${props.plugin.license}.` : ''}
          {props.plugin.contentResolution === 'metadata-only' ? ' Content is metadata-only.' : ''}
        </p>
      </CatalogDetailSection>
      <Show when={props.plugin.appSurface}>
        {(app) => (
          <CatalogDetailSection title="App">
            <p class="text-muted-foreground text-sm">
              Platforms: {app().supportedPlatforms.join(', ') || 'unspecified'}.
              {app().requestedPermissions.length > 0
                ? ` Requests: ${app().requestedPermissions.join(', ')}.`
                : ' Requests no additional permissions.'}
              {app().version ? ` Version ${app().version}.` : ''}
              {app().digest ? ` Digest ${app().digest}.` : ''}
            </p>
          </CatalogDetailSection>
        )}
      </Show>
      <Show when={props.plugin.appSurface}>
        <AppActivationSection activation={activation()} />
      </Show>
    </CatalogDetail>
  )
}

function NavigationMissing() {
  return (
    <Empty class="min-h-0 min-w-0 flex-1">
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
                <ActionButton
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  tooltip={`Move ${item.label} up`}
                  aria-label={`Move ${item.label} up`}
                  onClick={() => props.navigation.onReorder(item.id, 'up')}
                >
                  <ChevronUp aria-hidden="true" />
                </ActionButton>
                <ActionButton
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  tooltip={`Move ${item.label} down`}
                  aria-label={`Move ${item.label} down`}
                  onClick={() => props.navigation.onReorder(item.id, 'down')}
                >
                  <ChevronDown aria-hidden="true" />
                </ActionButton>
                <Checkbox
                  class="plugins-navigation__visibility"
                  label="Show"
                  checked={!props.navigation.preferences.hidden.includes(item.id)}
                  onChange={(checked: boolean) => props.navigation.onSetHidden(item.id, !checked)}
                />
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
  // The Navigation tab shows no browser; the list is computed as Discover so
  // the memo stays total without leaking the navigation value into the filter.
  const browserTab = (): 'marketplace' | 'yours' => {
    const current = tab()
    return current === 'navigation' ? 'marketplace' : current
  }
  const visible = createMemo(() =>
    filterWorkspacePlugins(plugins(), browserTab(), query(), activeFilter())
  )
  const entries = createMemo(() => plugins().map(toCatalogEntry))
  const groups = createMemo<readonly CatalogBrowserGroup<WorkspacePlugin>[]>(() => {
    const grouped = groupWorkspacePlugins(visible())
    const showPopular =
      tab() === 'marketplace' &&
      query().trim().length === 0 &&
      activeFilter().type === 'all' &&
      activeFilter().ownership === 'all'
    const ordered = showPopular
      ? [{ category: 'Popular', plugins: getPopularWorkspacePlugins(visible()) }, ...grouped]
      : grouped
    return ordered.map((group) => ({
      id: group.category,
      label: group.category,
      entries: group.plugins.map(toCatalogEntry),
    }))
  })
  const tabs = (): readonly CatalogBrowserTab[] => [
    { id: 'marketplace', label: 'Discover' },
    { id: 'yours', label: 'Installed' },
    ...(props.navigation
      ? [
          {
            id: 'navigation',
            label: `Navigation (${props.navigation.items.length})`,
            kind: 'supplemental' as const,
          },
        ]
      : []),
  ]
  const catalogStatus = () =>
    catalogFailed() ? 'error' : status() === 'loading' ? 'loading' : 'ready'
  const catalogError = () =>
    catalogState() === 'verification-failure'
      ? {
          title: 'Plugin catalog could not be verified',
          description: 'The catalog was rejected because its signed metadata did not verify.',
          role: 'alert' as const,
        }
      : {
          title: 'Plugin catalog unavailable',
          description: 'Close Plugins and open it again to retry.',
          role: 'alert' as const,
        }
  const emptyState = () =>
    tab() === 'yours'
      ? {
          title: 'No plugins added yet',
          description: 'Add a provider or skill from Marketplace and it will appear here.',
        }
      : {
          title: 'No matching plugins',
          description: query().trim()
            ? `No plugins match “${query().trim()}”.`
            : 'No plugins match the current filters.',
        }
  const notices = () => [
    ...(catalogState() === 'stale' && status() === 'idle'
      ? [
          {
            id: 'stale-catalog',
            role: 'status' as const,
            message: 'Showing the last-known-good catalog while the registry is unavailable.',
          },
        ]
      : []),
    ...(catalogState() === 'verification-failure' && status() === 'idle'
      ? [
          {
            id: 'verification-failure',
            role: 'alert' as const,
            message: 'The latest catalog failed integrity verification and was not accepted.',
          },
        ]
      : []),
  ]

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
      modal={false}
      class="conventional-dialog plugins-dialog"
      description="Browse and manage apps, providers, and skills available to your agents."
      onClose={close}
      open={props.open}
      title="Plugins"
    >
      <CatalogBrowser
        class="plugins-browser"
        open={props.open}
        tabs={tabs()}
        tab={tab()}
        tabsLabel="Plugins view"
        onTabChange={(value) => setTab(value as PluginTab)}
        renderSupplementalView={(value) =>
          value === 'navigation' ? (
            <Show when={props.navigation} fallback={<NavigationMissing />}>
              {(navigation) => <NavigationPanel navigation={navigation()} />}
            </Show>
          ) : undefined
        }
        query={query()}
        onQueryChange={setQuery}
        searchLabel="Search plugins"
        searchPlaceholder="Search plugins"
        resultsRegionLabel="Plugin results"
        filterControl={
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
        }
        resultCount={visible().length}
        resultLabel={(count) => `${count} ${count === 1 ? 'plugin' : 'plugins'}`}
        loadingLabel="Loading plugins"
        status={catalogStatus()}
        catalogError={catalogError()}
        installError={installError()}
        notices={notices()}
        emptyState={emptyState()}
        groups={groups()}
        entries={entries()}
        selectedId={selectedId()}
        onSelect={(plugin) => setSelectedId(plugin.id)}
        onBack={() => setSelectedId(null)}
        backLabel="Back to plugins"
        detailRegionLabel="Plugin details"
        installedLabel="Installed"
        publishedByLabel={(publisher) => `Published by ${publisher}`}
        showMoreLabel={(hidden) => {
          const names = hidden.slice(0, 2).map((entry) => entry.name)
          return `See ${names.join(', ')}${hidden.length > 2 ? ' and more' : ''}`
        }}
        showLessLabel="Show less"
        interactionDisabled={filterOpen()}
        renderIcon={(plugin) => <PluginLogo iconUrl={plugin.iconUrl} name={plugin.name} />}
        renderDetail={(plugin) => (
          <PluginDetail
            onUpdate={() => void update(plugin)}
            plugin={plugin}
            saving={status() === 'saving'}
            installError={installError()}
          />
        )}
      />
    </ModalDialog>
  )
}
