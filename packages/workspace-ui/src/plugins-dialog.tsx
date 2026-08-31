import { useEffect, useMemo, useState } from 'react'
import { Button } from '@agent-hq/ui/components/ui/button'
import { Input } from '@agent-hq/ui/components/ui/input'
import { ArrowLeft, Blocks, ChevronRight, Plug, Search, Sparkles } from 'lucide-react'

import { ModalDialog } from './modal-dialog'
import type { WorkspacePlugin, WorkspacePluginsProvider } from './platform'
import { filterWorkspacePlugins } from './plugins'

export function PluginsDialog({
  onClose,
  open,
  provider,
}: Readonly<{
  onClose: () => void
  open: boolean
  provider?: WorkspacePluginsProvider
}>) {
  const [plugins, setPlugins] = useState<readonly WorkspacePlugin[]>([])
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [status, setStatus] = useState<'error' | 'idle' | 'loading' | 'saving'>('idle')
  const [tab, setTab] = useState<'marketplace' | 'yours'>('marketplace')
  const selected = plugins.find(({ id }) => id === selectedId)
  const visible = useMemo(() => filterWorkspacePlugins(plugins, tab, query), [plugins, query, tab])

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
      description="Browse and manage the connectors and skills available to this app."
      onClose={close}
      open={open}
      title="Plugins"
    >
      {selected ? (
        <article className="plugins-detail">
          <Button type="button" variant="ghost" size="sm" onClick={() => setSelectedId(null)}>
            <ArrowLeft aria-hidden="true" /> Back to plugins
          </Button>
          <div className="plugins-detail__mark" aria-hidden="true">
            {selected.kind === 'connector' ? <Plug /> : <Sparkles />}
          </div>
          <div>
            <p>{selected.kind === 'connector' ? 'Connector' : 'Skill'}</p>
            <h3>{selected.name}</h3>
            <p>{selected.description}</p>
            <small>Published by {selected.publisher}</small>
          </div>
          <Button
            type="button"
            variant={selected.installed ? 'outline' : 'default'}
            disabled={status === 'saving'}
            onClick={() => void update(selected, !selected.installed)}
          >
            {status === 'saving'
              ? 'Saving…'
              : selected.installed
                ? 'Remove from Agent HQ'
                : 'Add to Agent HQ'}
          </Button>
          <p className="plugins-dialog__notice">
            Enabling a plugin saves it to this app. Runtime credentials and execution remain scoped
            to the authoritative Control Plane connection.
          </p>
        </article>
      ) : (
        <div className="plugins-browser">
          <div className="plugins-browser__tabs" role="tablist" aria-label="Plugins view">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'marketplace'}
              onClick={() => setTab('marketplace')}
            >
              Marketplace
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'yours'}
              onClick={() => setTab('yours')}
            >
              Yours
            </button>
          </div>
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
          <div className="plugins-browser__list" aria-live="polite">
            {status === 'loading' ? <p>Loading plugins…</p> : null}
            {status === 'error' ? (
              <p role="alert">The plugin catalog is unavailable. Try opening it again.</p>
            ) : null}
            {status !== 'loading' && status !== 'error' && visible.length === 0 ? (
              <div className="plugins-browser__empty">
                <Blocks aria-hidden="true" />
                <h3>{tab === 'yours' ? 'No plugins added yet' : 'No matching plugins'}</h3>
                <p>
                  {tab === 'yours'
                    ? 'Add a connector or skill from Marketplace and it will appear here.'
                    : `No plugins match “${query.trim()}”.`}
                </p>
              </div>
            ) : null}
            {visible.map((plugin) => (
              <button
                type="button"
                className="plugins-browser__row"
                key={plugin.id}
                onClick={() => setSelectedId(plugin.id)}
              >
                <span className="plugins-browser__mark" aria-hidden="true">
                  {plugin.kind === 'connector' ? <Plug /> : <Sparkles />}
                </span>
                <span>
                  <strong>{plugin.name}</strong>
                  <small>{plugin.description}</small>
                  <em>{plugin.installed ? 'Added' : plugin.kind}</em>
                </span>
                <ChevronRight aria-hidden="true" />
              </button>
            ))}
          </div>
        </div>
      )}
    </ModalDialog>
  )
}
