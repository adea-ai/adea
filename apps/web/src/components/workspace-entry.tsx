'use client'

import dynamic from 'next/dynamic'
import { useEffect, useState } from 'react'
import { createApiClient } from '@agent-hq/api-client'
import { useWorkspaceBootstrapQuery } from '@agent-hq/data'
import { useWorkspaceStore } from '@agent-hq/state'
import { GlobalWorkspaceRail } from '@agent-hq/workspace-ui/global-workspace-rail'
import type { WorkspacePlatformServices } from '@agent-hq/workspace-ui/platform'
import { createBrowserPluginsProvider } from '@agent-hq/workspace-ui/plugins'
import { createBrowserSettingsProvider } from '@agent-hq/workspace-ui/preferences'
import type { WorkspaceView } from '@agent-hq/workspace-ui/workspace-view-toggle'
import { parseAsStringLiteral, useQueryState } from 'nuqs'
import type { WorkspaceShellProps } from './workspace-shell'

const ConventionalWorkspace = dynamic(
  () =>
    import('./conventional-workspace-entry').then(
      ({ ConventionalWorkspaceEntry }) => ConventionalWorkspaceEntry
    ),
  { loading: () => <WorkspaceEntryLoading /> }
)

const SpatialWorkspace = dynamic(
  () => import('./workspace-shell').then(({ WorkspaceShell }) => WorkspaceShell),
  { loading: () => <WorkspaceEntryLoading /> }
)

const PluginsDialog = dynamic(
  () => import('@agent-hq/workspace-ui/plugins-dialog').then((module) => module.PluginsDialog),
  { ssr: false }
)

function WorkspaceEntryLoading() {
  return (
    <main className="conventional-workspace conventional-workspace--loading" aria-busy="true">
      <p>Opening workspace…</p>
    </main>
  )
}

export function WorkspaceEntry({
  spatial,
  spatialProps,
}: Readonly<{ spatial: boolean; spatialProps: WorkspaceShellProps }>) {
  const [client] = useState(() => createApiClient())
  const [services] = useState<WorkspacePlatformServices>(() => ({
    account: {
      onSignIn: () => window.location.assign('/auth/sign-in?returnTo=%2F'),
      onSignOut: async () => {
        const { createNeonClientAdapter } = await import('@agent-hq/auth/client')
        await createNeonClientAdapter().signOut()
        window.location.assign('/')
      },
    },
    app: { name: 'Agent HQ Web', platform: 'web' },
    plugins: createBrowserPluginsProvider(),
    settings: createBrowserSettingsProvider(),
  }))
  const bootstrap = useWorkspaceBootstrapQuery(client)
  const globalPanel = useWorkspaceStore((state) => state.globalPanel)
  const selectedWorkspaceId = useWorkspaceStore((state) => state.selectedWorkspaceId)
  const setGlobalPanel = useWorkspaceStore((state) => state.setGlobalPanel)
  const setSelectedChannelId = useWorkspaceStore((state) => state.setSelectedChannelId)
  const setSelectedRoomId = useWorkspaceStore((state) => state.setSelectedRoomId)
  const setSelectedScene = useWorkspaceStore((state) => state.setSelectedScene)
  const setSelectedWorkspaceId = useWorkspaceStore((state) => state.setSelectedWorkspaceId)
  const [viewParam, setViewParam] = useQueryState(
    'view',
    parseAsStringLiteral(['chat', 'spatial'] as const)
      .withDefault(spatial ? 'spatial' : 'chat')
      .withOptions({ clearOnDefault: false, history: 'replace' })
  )
  const [scene, setScene] = useQueryState(
    'scene',
    parseAsStringLiteral(['home', 'work'] as const)
      .withDefault(spatialProps.initialScene)
      .withOptions({ clearOnDefault: false, history: 'replace' })
  )
  const view: WorkspaceView = viewParam === 'spatial' ? 'virtual' : 'chat'
  const activeWorkspace =
    bootstrap.data?.workspaces.find(({ id }) => id === selectedWorkspaceId) ??
    bootstrap.data?.activeWorkspace

  useEffect(() => setSelectedScene(scene), [scene, setSelectedScene])

  const changeView = (nextView: WorkspaceView) => {
    void setViewParam(nextView === 'virtual' ? 'spatial' : 'chat')
  }
  const openSettings = (section: 'account' | 'input-notifications' | 'integrations') => {
    window.history.replaceState(null, '', `#settings/${section}`)
    setGlobalPanel('settings')
  }
  const openSearch = () => {
    setGlobalPanel('search')
    if (view !== 'chat') changeView('chat')
  }

  return (
    <div className={`workspace-frame workspace-frame--${view}`}>
      <GlobalWorkspaceRail
        onOpenNotifications={() => openSettings('input-notifications')}
        onOpenPlugins={() => setGlobalPanel('plugins')}
        onOpenSearch={openSearch}
        onOpenSettings={() => openSettings('account')}
        activeWorkspace={activeWorkspace}
        onWorkspaceChange={(workspace) => {
          setSelectedWorkspaceId(workspace.id)
          setSelectedRoomId(null)
          setSelectedChannelId(null)
          setSelectedScene(workspace.scene)
          void setScene(workspace.scene)
        }}
        onViewChange={changeView}
        view={view}
        workspaces={bootstrap.data?.workspaces ?? []}
      />
      <div className="workspace-frame__surface">
        {view === 'virtual' ? (
          <SpatialWorkspace
            {...spatialProps}
            apiClient={client}
            initialScene={scene}
            onWorkspaceViewChange={changeView}
            services={services}
            workspaceView={view}
          />
        ) : (
          <ConventionalWorkspace client={client} onViewChange={changeView} services={services} />
        )}
      </div>
      <PluginsDialog
        open={globalPanel === 'plugins'}
        onClose={() => setGlobalPanel(null)}
        provider={services.plugins}
      />
    </div>
  )
}
