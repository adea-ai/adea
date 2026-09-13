'use client'

// The single workspace UI. Both lanes render this exact component: the web
// entry feeds it the cookie bootstrap, the desktop entry feeds it the shell
// session bootstrap. Anything desktop-only is a flag-guarded surface
// (`updates`, account handlers, `platform`), never a forked render tree.
import { useEffect, useState } from 'react'
import type { AgentHqApiClient } from '@adea-ai/api-client'
import { useAgentListQuery } from '@adea-ai/data'
import { useWorkspaceStore } from '@adea-ai/state'
import type { WorkspaceSummary } from '@adea-ai/types'
import type {
  WorkspacePlatformServices,
  WorkspacePluginsProvider,
} from '@adea-ai/workspace-ui/platform'
import type { RegistryPluginsProviderOptions } from '@adea-ai/workspace-ui/plugins'
import type { WorkspaceView } from '@adea-ai/workspace-ui/workspace-view-toggle'
import { parseAsStringLiteral, useQueryState } from 'nuqs'
import { VersionDialog } from './version-dialog'
import lazyComponent from './lazy-component'
import type { WorkspaceShellProps } from './workspace-shell'

const ConventionalWorkspace = lazyComponent(
  () =>
    import('./conventional-workspace-entry').then(
      ({ ConventionalWorkspaceEntry }) => ConventionalWorkspaceEntry
    ),
  { loading: () => <WorkspaceEntryLoading /> }
)

const SpatialWorkspace = lazyComponent(
  () => import('./workspace-shell').then(({ WorkspaceShell }) => WorkspaceShell),
  { loading: () => <WorkspaceEntryLoading /> }
)

const RoomDesignerWorkspace = lazyComponent(
  () => import('./room-designer-entry').then(({ RoomDesignerEntry }) => RoomDesignerEntry),
  { loading: () => <WorkspaceEntryLoading /> }
)

const GlobalWorkspaceRail = lazyComponent(
  () =>
    import('@adea-ai/workspace-ui/global-workspace-rail').then(
      ({ GlobalWorkspaceRail: Rail }) => Rail
    ),
  { loading: () => <WorkspaceRailLoading />, ssr: false }
)

const WorkspaceAboutDialog = lazyComponent(
  () =>
    import('@adea-ai/workspace-ui/workspace-about-dialog').then(
      ({ WorkspaceAboutDialog: AboutDialog }) => AboutDialog
    ),
  { ssr: false }
)

const PluginsDialog = lazyComponent(
  () => import('@adea-ai/workspace-ui/plugins-dialog').then((module) => module.PluginsDialog),
  { ssr: false }
)

const WorkspaceSettingsDialog = lazyComponent(
  () =>
    import('@adea-ai/workspace-ui/workspace-settings').then(
      ({ WorkspaceSettingsDialog: SettingsDialog }) => SettingsDialog
    ),
  { ssr: false }
)

function WorkspaceEntryLoading() {
  return (
    <main className="conventional-workspace conventional-workspace--loading" aria-busy="true">
      <p>Opening workspace…</p>
    </main>
  )
}

function WorkspaceRailLoading() {
  return <nav className="global-rail global-rail--loading" aria-hidden="true" />
}

function WorkspaceSettingsOverlay({
  accountAuthenticated,
  accountLabel,
  busy,
  client,
  onClose,
  onOpenAgents,
  onSignIn,
  onSignOut,
  open,
  services,
  workspace,
}: Readonly<{
  accountAuthenticated: boolean
  accountLabel: string
  busy: boolean
  client: AgentHqApiClient
  onClose: () => void
  onOpenAgents: () => void
  onSignIn: () => void
  onSignOut: () => void
  open: boolean
  services: WorkspacePlatformServices
  workspace: WorkspaceSummary
}>) {
  const agentsQuery = useAgentListQuery(client, workspace.id)
  return (
    <WorkspaceSettingsDialog
      accountAuthenticated={accountAuthenticated}
      accountLabel={accountLabel}
      agents={agentsQuery.data ?? []}
      busy={busy}
      onClose={onClose}
      onOpenAgents={onOpenAgents}
      onSignIn={onSignIn}
      onSignOut={onSignOut}
      open={open}
      services={services}
      workspace={workspace}
    />
  )
}

export function createDeferredPluginsProvider(
  options: RegistryPluginsProviderOptions
): WorkspacePluginsProvider {
  let provider: Promise<WorkspacePluginsProvider> | undefined
  let loaded: WorkspacePluginsProvider | undefined
  const load = () => {
    provider ??= import('@adea-ai/workspace-ui/plugins')
      .then(({ createRegistryPluginsProvider }) => createRegistryPluginsProvider(options))
      .then((value) => {
        loaded = value
        return value
      })
    return provider
  }
  return {
    getState: () => loaded?.getState?.() ?? 'idle',
    list: () => load().then((value) => value.list()),
    requestInstall: (pluginId) => load().then((value) => value.requestInstall(pluginId)),
  }
}

export type WorkspaceNavigationAccount = Readonly<{
  authenticated: boolean
  busy: boolean
  label: string
  onOpenUpdates?(): void
  onSignIn(): void
  onSignOut(): void | Promise<void>
}>

export type WorkspaceNavigationProps = Readonly<{
  account: WorkspaceNavigationAccount
  activeWorkspace?: WorkspaceSummary
  client: AgentHqApiClient
  /** Desktop authorizes local content per workspace before switching. */
  onAuthorizeWorkspace?(workspaceId: string): Promise<void>
  platform: 'desktop' | 'web'
  roomDesigner?: boolean
  services: WorkspacePlatformServices
  updates?: Readonly<{ open: boolean; onOpenChange(open: boolean): void }>
  virtual: boolean
  virtualProps: WorkspaceShellProps
  workspaces: readonly WorkspaceSummary[]
}>

export function WorkspaceNavigation({
  account,
  activeWorkspace,
  client,
  onAuthorizeWorkspace,
  platform,
  roomDesigner = false,
  services,
  updates,
  virtual,
  virtualProps,
  workspaces,
}: WorkspaceNavigationProps) {
  const [roomDesignerEnabled, setRoomDesignerEnabled] = useState(roomDesigner)
  const globalPanel = useWorkspaceStore((state) => state.globalPanel)
  const selectedWorkspaceId = useWorkspaceStore((state) => state.selectedWorkspaceId)
  const setActiveSurface = useWorkspaceStore((state) => state.setActiveSurface)
  const setGlobalPanel = useWorkspaceStore((state) => state.setGlobalPanel)
  const setSelectedScene = useWorkspaceStore((state) => state.setSelectedScene)
  const switchWorkspace = useWorkspaceStore((state) => state.switchWorkspace)
  const [viewParam, setViewParam] = useQueryState(
    'view',
    parseAsStringLiteral(['chat', 'virtual'] as const)
      .withDefault(virtual ? 'virtual' : 'chat')
      .withOptions({ clearOnDefault: false, history: 'replace' })
  )
  const [sceneParam, setScene] = useQueryState(
    'scene',
    parseAsStringLiteral(['home', 'work'] as const)
      .withDefault(virtualProps.initialScene)
      .withOptions({ clearOnDefault: false, history: 'replace' })
  )
  const view: WorkspaceView = viewParam
  const scene = activeWorkspace?.scene ?? sceneParam
  const hashSettingsOpen =
    typeof window !== 'undefined' && window.location.hash.startsWith('#settings')
  const settingsOpen = globalPanel === 'settings' || hashSettingsOpen

  useEffect(() => {
    if (!activeWorkspace) return
    if (selectedWorkspaceId !== activeWorkspace.id)
      switchWorkspace(activeWorkspace.id, activeWorkspace.scene)
    setSelectedScene(activeWorkspace.scene)
    if (sceneParam !== activeWorkspace.scene) void setScene(activeWorkspace.scene)
  }, [
    activeWorkspace?.id,
    activeWorkspace?.scene,
    sceneParam,
    selectedWorkspaceId,
    setScene,
    setSelectedScene,
    switchWorkspace,
  ])

  useEffect(() => {
    const openDeepLinkedSettings = () => {
      if (window.location.hash.startsWith('#settings')) setGlobalPanel('settings')
    }
    openDeepLinkedSettings()
    window.addEventListener('hashchange', openDeepLinkedSettings)
    return () => window.removeEventListener('hashchange', openDeepLinkedSettings)
  }, [setGlobalPanel])

  const changeView = (nextView: WorkspaceView) => {
    void setViewParam(nextView)
  }
  const setRoomDesignerRoute = (enabled: boolean) => {
    setRoomDesignerEnabled(enabled)
    const nextUrl = new URL(window.location.href)
    nextUrl.searchParams.set('roomDesigner', enabled ? '1' : '0')
    if (enabled) nextUrl.searchParams.set('view', 'virtual')
    window.history.replaceState(null, '', nextUrl)
    if (enabled && view !== 'virtual') void setViewParam('virtual')
  }
  const openSettings = (section: 'account' | 'input-notifications' | 'integrations') => {
    window.history.replaceState(null, '', `#settings/${section}`)
    // Settings is a global overlay. Keep the current surface mounted so the
    // virtual scene does not disappear before its dialog can open.
    setGlobalPanel('settings')
  }
  const openSearch = () => {
    setGlobalPanel('search')
    if (view !== 'chat') changeView('chat')
  }

  return (
    <div className={`workspace-frame workspace-frame--${view}`}>
      <GlobalWorkspaceRail
        account={{
          authenticated: account.authenticated,
          busy: account.busy,
          label: account.label,
          onSignIn: account.onSignIn,
          onSignOut: () => void account.onSignOut(),
          ...(account.onOpenUpdates ? { onOpenUpdates: account.onOpenUpdates } : {}),
          platform,
        }}
        onOpenNotifications={() => openSettings('input-notifications')}
        onOpenAbout={() => setGlobalPanel('about')}
        onOpenPlugins={() => setGlobalPanel('plugins')}
        onOpenSearch={openSearch}
        onOpenSettings={() => openSettings('account')}
        activeWorkspace={activeWorkspace}
        onWorkspaceChange={(workspace) => {
          if (workspace.id === activeWorkspace?.id) return
          void Promise.resolve(onAuthorizeWorkspace?.(workspace.id))
            .then(() => {
              switchWorkspace(workspace.id, workspace.scene)
              void setScene(workspace.scene)
            })
            .catch(() => undefined)
        }}
        onViewChange={changeView}
        view={view}
        workspaces={workspaces}
      />
      <div className="workspace-frame__surface">
        {view === 'virtual' ? (
          roomDesignerEnabled ? (
            <RoomDesignerWorkspace
              key={activeWorkspace?.id ?? scene}
              initialCharacter={virtualProps.initialCharacter}
              initialScene={scene}
              onClose={() => setRoomDesignerRoute(false)}
            />
          ) : (
            <SpatialWorkspace
              key={activeWorkspace?.id ?? scene}
              {...virtualProps}
              apiClient={client}
              initialScene={scene}
              onOpenRoomDesigner={() => setRoomDesignerRoute(true)}
              onWorkspaceViewChange={changeView}
              services={services}
              workspaceView={view}
            />
          )
        ) : (
          <ConventionalWorkspace
            client={client}
            manageSettings={false}
            onViewChange={changeView}
            services={services}
          />
        )}
      </div>
      {activeWorkspace && settingsOpen ? (
        <WorkspaceSettingsOverlay
          accountAuthenticated={account.authenticated}
          accountLabel={account.label}
          busy={account.busy}
          client={client}
          onClose={() => setGlobalPanel(null)}
          onOpenAgents={() => {
            setActiveSurface('agents')
            setGlobalPanel(null)
            changeView('chat')
          }}
          onSignIn={account.onSignIn}
          onSignOut={() => void account.onSignOut()}
          open
          services={services}
          workspace={activeWorkspace}
        />
      ) : null}
      <PluginsDialog
        open={globalPanel === 'plugins' && Boolean(activeWorkspace)}
        onClose={() => setGlobalPanel(null)}
        provider={services.plugins}
      />
      <WorkspaceAboutDialog
        appName={services.app?.name}
        open={globalPanel === 'about'}
        onClose={() => setGlobalPanel(null)}
        platform={platform}
        version={services.app?.version}
      />
      {updates ? <VersionDialog open={updates.open} onOpenChange={updates.onOpenChange} /> : null}
    </div>
  )
}
