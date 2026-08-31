import { useEffect, useMemo, useState } from 'react'
import { Badge } from '@agent-hq/ui/components/ui/badge'
import { Button } from '@agent-hq/ui/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@agent-hq/ui/components/ui/dropdown-menu'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@agent-hq/ui/components/ui/empty'
import { Input } from '@agent-hq/ui/components/ui/input'
import { Skeleton } from '@agent-hq/ui/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@agent-hq/ui/components/ui/tabs'
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
} from 'lucide-react'

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

function PluginFilterMenu({
  filter,
  onChange,
  onOpenChange,
}: Readonly<{
  filter: WorkspacePluginFilter
  onChange: (filter: WorkspacePluginFilter) => void
  onOpenChange: (open: boolean) => void
}>) {
  const active = filter.type !== 'all' || filter.ownership !== 'all'
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        render={
          <Button type="button" variant="outline" size="sm" aria-pressed={active}>
            <Filter data-icon="inline-start" aria-hidden="true" />
            Filter
            {active ? <span className="plugins-filter__dot" aria-hidden="true" /> : null}
          </Button>
        }
      />
      <DropdownMenuContent className="plugins-filter" align="start">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Type</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={filter.type}
            onValueChange={(type) =>
              onChange({ ...filter, type: type as WorkspacePluginFilter['type'] })
            }
          >
            {typeOptions.map(([value, label]) => (
              <DropdownMenuRadioItem key={value} value={value}>
                {label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Ownership</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={filter.ownership}
            onValueChange={(ownership) =>
              onChange({
                ...filter,
                ownership: ownership as WorkspacePluginFilter['ownership'],
              })
            }
          >
            {ownershipOptions.map(([value, label]) => (
              <DropdownMenuRadioItem key={value} value={value}>
                {label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function PluginBrowserRow({
  disabled,
  onSelect,
  plugin,
}: Readonly<{ disabled: boolean; onSelect: () => void; plugin: WorkspacePlugin }>) {
  return (
    <button type="button" className="plugins-browser__row" disabled={disabled} onClick={onSelect}>
      <PluginLogo iconKey={plugin.iconKey} name={plugin.name} />
      <span className="plugins-browser__row-copy">
        <span className="plugins-browser__row-title">
          <strong>{plugin.name}</strong>
          {plugin.installed ? <Badge variant="secondary">Added</Badge> : null}
        </span>
        <small>{plugin.description}</small>
        <span className="plugins-browser__row-meta">
          {plugin.publisher} · {plugin.category}
        </span>
      </span>
      <ChevronRight aria-hidden="true" />
    </button>
  )
}

function PluginBrowserGroup({
  disabled,
  expanded,
  name,
  onSelect,
  onToggle,
  plugins,
}: Readonly<{
  disabled: boolean
  expanded: boolean
  name: string
  onSelect: (pluginId: string) => void
  onToggle: () => void
  plugins: readonly WorkspacePlugin[]
}>) {
  const id = `plugins-category-${name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  const preview = expanded ? plugins : plugins.slice(0, 6)
  const hidden = plugins.slice(6)
  const nextNames = hidden.slice(0, 2).map((plugin) => plugin.name)
  const expandLabel = `See ${nextNames.join(', ')}${hidden.length > 2 ? ' and more' : ''}`

  return (
    <section className="plugins-browser__group" aria-labelledby={id}>
      <header className="plugins-browser__group-heading">
        <h3 id={id}>{name}</h3>
        <span>{plugins.length}</span>
      </header>
      <div className="plugins-browser__grid">
        {preview.map((plugin) => (
          <PluginBrowserRow
            disabled={disabled}
            key={plugin.id}
            onSelect={() => onSelect(plugin.id)}
            plugin={plugin}
          />
        ))}
      </div>
      {hidden.length > 0 ? (
        <Button
          className="plugins-browser__more"
          disabled={disabled}
          onClick={onToggle}
          size="sm"
          type="button"
          variant="ghost"
        >
          {expanded ? (
            <>
              Show less <ChevronUp data-icon="inline-end" aria-hidden="true" />
            </>
          ) : (
            <>
              {expandLabel} <ChevronDown data-icon="inline-end" aria-hidden="true" />
            </>
          )}
        </Button>
      ) : null}
    </section>
  )
}

function PluginListState({ status }: Readonly<{ status: 'error' | 'loading' }>) {
  if (status === 'error') {
    return (
      <Empty role="alert">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Blocks aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>Plugin catalog unavailable</EmptyTitle>
          <EmptyDescription>Close Plugins and open it again to retry.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <div className="plugins-browser__skeleton" aria-label="Loading plugins" aria-busy="true">
      {Array.from({ length: 7 }, (_, index) => (
        <div key={index}>
          <Skeleton className="plugins-browser__skeleton-mark" />
          <span>
            <Skeleton className="plugins-browser__skeleton-title" />
            <Skeleton className="plugins-browser__skeleton-copy" />
          </span>
        </div>
      ))}
    </div>
  )
}

function PluginsEmpty({ query, tab }: Readonly<{ query: string; tab: PluginTab }>) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Blocks aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>{tab === 'yours' ? 'No plugins added yet' : 'No matching plugins'}</EmptyTitle>
        <EmptyDescription>
          {tab === 'yours'
            ? 'Add a provider or skill from Marketplace and it will appear here.'
            : query.trim()
              ? `No plugins match “${query.trim()}”.`
              : 'No plugins match the current filters.'}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

function PluginDetail({
  onBack,
  onUpdate,
  plugin,
  saving,
}: Readonly<{
  onBack: () => void
  onUpdate: (installed: boolean) => void
  plugin: WorkspacePlugin
  saving: boolean
}>) {
  return (
    <article className="plugins-detail">
      <Button type="button" variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft data-icon="inline-start" aria-hidden="true" />
        Back to plugins
      </Button>
      <header className="plugins-detail__hero">
        <PluginLogo iconKey={plugin.iconKey} name={plugin.name} />
        <div>
          <div className="plugins-detail__eyebrow">
            <Badge variant="outline">{plugin.kind === 'connector' ? 'Connector' : 'Skill'}</Badge>
            <Badge variant="secondary">
              {plugin.source === 'codex-official'
                ? 'Codex official'
                : plugin.source === 'agent-hq'
                  ? 'Agent HQ'
                  : 'Community'}
            </Badge>
            <span>{plugin.category}</span>
          </div>
          <h3>{plugin.name}</h3>
          <p>{plugin.description}</p>
          <small>Published by {plugin.publisher}</small>
        </div>
      </header>
      <div className="plugins-detail__actions">
        <Button
          type="button"
          variant={plugin.installed ? 'outline' : 'default'}
          disabled={saving}
          onClick={() => onUpdate(!plugin.installed)}
        >
          {saving ? 'Saving…' : plugin.installed ? 'Remove' : 'Add'}
        </Button>
        {plugin.installed ? (
          <span role="status">
            <Check aria-hidden="true" /> Added to Agent HQ
          </span>
        ) : null}
      </div>
      <section className="plugins-detail__section" aria-labelledby="plugin-capabilities-heading">
        <h4 id="plugin-capabilities-heading">Capabilities</h4>
        <ul>
          {plugin.capabilities.map((capability) => (
            <li key={capability}>
              <Check aria-hidden="true" /> {capability}
            </li>
          ))}
        </ul>
      </section>
      <section className="plugins-detail__section" aria-labelledby="plugin-connection-heading">
        <h4 id="plugin-connection-heading">Connection</h4>
        <p>
          <ShieldCheck aria-hidden="true" />
          {plugin.auth === 'oauth'
            ? 'OAuth provider'
            : plugin.auth === 'api-key'
              ? 'API credential provider'
              : 'Managed by this workspace'}
        </p>
        <small>
          Adding enables this provider in Agent HQ. Account authorization and runtime execution stay
          within the authoritative Control Plane connection.
        </small>
      </section>
      <section className="plugins-detail__section" aria-labelledby="plugin-source-heading">
        <h4 id="plugin-source-heading">Bundle</h4>
        <p>{plugin.surfaces.map((surface) => surface.toLocaleUpperCase()).join(' · ')}</p>
        <small>
          {plugin.source === 'codex-official'
            ? `Pinned from openai/plugins${plugin.sourceRevision ? ` at ${plugin.sourceRevision.slice(0, 12)}` : ''}.`
            : 'Maintained by Agent HQ.'}
          {plugin.license ? ` License: ${plugin.license}.` : ''}
        </small>
      </section>
    </article>
  )
}

export function PluginsDialog({
  onClose,
  open,
  provider,
}: Readonly<{
  onClose: () => void
  open: boolean
  provider?: WorkspacePluginsProvider
}>) {
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set())
  const [plugins, setPlugins] = useState<readonly WorkspacePlugin[]>([])
  const [filterOpen, setFilterOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [status, setStatus] = useState<'error' | 'idle' | 'loading' | 'saving'>('idle')
  const [tab, setTab] = useState<PluginTab>('marketplace')
  const [filters, setFilters] = useState<Record<PluginTab, WorkspacePluginFilter>>({
    marketplace: defaultPluginFilter,
    yours: defaultPluginFilter,
  })
  const activeFilter = filters[tab]
  const selected = plugins.find(({ id }) => id === selectedId)
  const visible = useMemo(
    () => filterWorkspacePlugins(plugins, tab, query, activeFilter),
    [activeFilter, plugins, query, tab]
  )
  const grouped = useMemo(() => groupWorkspacePlugins(visible), [visible])
  const groups = useMemo(() => {
    const showPopular =
      tab === 'marketplace' &&
      query.trim().length === 0 &&
      activeFilter.type === 'all' &&
      activeFilter.ownership === 'all'
    return showPopular
      ? [{ category: 'Popular', plugins: getPopularWorkspacePlugins(visible) }, ...grouped]
      : grouped
  }, [activeFilter, grouped, query, tab, visible])

  useEffect(() => {
    if (!open) return
    setStatus('loading')
    let active = true
    void provider
      ?.list()
      .then((items) => {
        if (!active) return
        setPlugins(items)
        setStatus('idle')
      })
      .catch(() => active && setStatus('error'))
    if (!provider) setStatus('error')
    return () => {
      active = false
    }
  }, [open, provider])

  const close = () => {
    setExpandedGroups(new Set())
    setFilterOpen(false)
    setSelectedId(null)
    onClose()
  }
  const update = async (plugin: WorkspacePlugin, installed: boolean) => {
    if (!provider || status === 'saving') return
    setStatus('saving')
    try {
      setPlugins(await provider.setInstalled(plugin.id, installed))
      setStatus('idle')
    } catch {
      setStatus('error')
    }
  }

  return (
    <ModalDialog
      className="plugins-dialog"
      description="Browse and manage providers and skills available to your agents."
      onClose={close}
      open={open}
      title="Plugins"
    >
      {selected ? (
        <PluginDetail
          onBack={() => setSelectedId(null)}
          onUpdate={(installed) => void update(selected, installed)}
          plugin={selected}
          saving={status === 'saving'}
        />
      ) : (
        <Tabs
          className="plugins-browser"
          data-filter-open={filterOpen}
          value={tab}
          onValueChange={(value) => setTab(value as PluginTab)}
        >
          <TabsList variant="line" aria-label="Plugins view" className="plugins-browser__tabs">
            <TabsTrigger value="marketplace">Marketplace</TabsTrigger>
            <TabsTrigger value="yours">Yours</TabsTrigger>
          </TabsList>
          <div className="plugins-browser__bar">
            <PluginFilterMenu
              filter={activeFilter}
              onChange={(filter) => setFilters((current) => ({ ...current, [tab]: filter }))}
              onOpenChange={setFilterOpen}
            />
            <label className="plugins-browser__search">
              <Search aria-hidden="true" />
              <Input
                type="search"
                aria-label="Search plugins"
                placeholder="Search plugins"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </label>
            <span className="plugins-browser__count" aria-live="polite">
              {visible.length} {visible.length === 1 ? 'plugin' : 'plugins'}
            </span>
          </div>
          <TabsContent value={tab} className="plugins-browser__list">
            {status === 'loading' || status === 'error' ? (
              <PluginListState status={status} />
            ) : visible.length === 0 ? (
              <PluginsEmpty query={query} tab={tab} />
            ) : (
              groups.map((group) => (
                <PluginBrowserGroup
                  disabled={filterOpen}
                  expanded={expandedGroups.has(group.category)}
                  key={group.category}
                  name={group.category}
                  onSelect={setSelectedId}
                  onToggle={() =>
                    setExpandedGroups((current) => {
                      const next = new Set(current)
                      if (next.has(group.category)) next.delete(group.category)
                      else next.add(group.category)
                      return next
                    })
                  }
                  plugins={group.plugins}
                />
              ))
            )}
          </TabsContent>
        </Tabs>
      )}
    </ModalDialog>
  )
}
