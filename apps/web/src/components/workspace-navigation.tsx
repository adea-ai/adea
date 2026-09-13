'use client'

// The single workspace UI. Both lanes render this exact component: the web
// entry feeds it the cookie bootstrap, the desktop entry feeds it the shell
// session bootstrap. Anything desktop-only is a flag-guarded surface
// (`updates`, account handlers, `platform`), never a forked render tree.
import { createEffect, createSignal, Show } from 'solid-js'
import { useNavigate, useSearch } from '@tanstack/solid-router'
import type { AgentHqApiClient } from '@adea-ai/api-client'
import { settledData, useAgentListQuery } from '@adea-ai/data'
import { useWorkspaceState, workspaceStore } from '@adea-ai/state'
import type { WorkspaceSummary } from '@adea-ai/types'
import type {
  WorkspacePlatformServices,
  WorkspacePluginsProvider,
} from '@adea-ai/workspace-ui/platform'
import type { RegistryPluginsProviderOptions } from '@adea-ai/workspace-ui/plugins'
import type { WorkspaceView } from '@adea-ai/workspace-ui/workspace-view-toggle'
import { GlobalWorkspaceRail } from '@adea-ai/workspace-ui/global-workspace-rail'
import type { WorkspaceSearch } from '../start/routes/__root'
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
    <main class="conventional-workspace conventional-workspace--loading" aria-busy="true">
      <p>Opening workspace…</p>
    </main>
  )
}

function WorkspaceSettingsOverlay(props: {
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
}) {
  const agentsQuery = useAgentListQuery(props.client, () => props.workspace.id)
  return (
    <WorkspaceSettingsDialog
      accountAuthenticated={props.accountAuthenticated}
      accountLabel={props.accountLabel}
      agents={settledData(agentsQuery) ?? []}
      busy={props.busy}
      onClose={props.onClose}
      onOpenAgents={props.onOpenAgents}
      onSignIn={props.onSignIn}
      onSignOut={props.onSignOut}
      open={props.open}
      services={props.services}
      workspace={props.workspace}
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

export function WorkspaceNavigation(props: WorkspaceNavigationProps) {
  const [roomDesignerEnabled, setRoomDesignerEnabled] = createSignal(props.roomDesigner ?? false)
  const globalPanel = useWorkspaceState((state) => state.globalPanel)
  const selectedWorkspaceId = useWorkspaceState((state) => state.selectedWorkspaceId)
  const search = useSearch({ strict: false })
  const navigate = useNavigate()

  const view = (): WorkspaceView => {
    const value = currentSearch().view
    if (value === 'chat' || value === 'virtual') return value
    return props.virtual ? 'virtual' : 'chat'
  }
  const scene = () => {
    const value = currentSearch().scene
    return props.activeWorkspace?.scene ?? (value === 'work' ? 'work' : 'home')
  }
  const currentSearch = () => search() as WorkspaceSearch
  // The workspace search contract lives on the root route and the router's
  // custom codec preserves it verbatim, so a patch is written through one
  // typed seam instead of restating the generated search schema.
  const applySearch = (patch: Partial<WorkspaceSearch>) =>
    void navigate({
      search: { ...currentSearch(), ...patch } as never,
      // Carry the hash through: a search update must not drop a deep link such
      // as `#settings/privacy-data` while the dialog it opened is mounting.
      hash: window.location.hash.replace(/^#/, ''),
      replace: true,
    })
  const setViewParam = (nextView: WorkspaceView) => applySearch({ view: nextView })
  const setScene = (nextScene: 'home' | 'work') => applySearch({ scene: nextScene })

  const [hashSettingsOpen, setHashSettingsOpen] = createSignal(false)
  const settingsOpen = () => globalPanel() === 'settings' || hashSettingsOpen()

  createEffect(() => {
    const activeWorkspace = props.activeWorkspace
    if (!activeWorkspace) return
    if (selectedWorkspaceId() !== activeWorkspace.id)
      workspaceStore.getState().switchWorkspace(activeWorkspace.id, activeWorkspace.scene)
    workspaceStore.getState().setSelectedScene(activeWorkspace.scene)
    const currentScene = (search() as WorkspaceSearch).scene
    if (currentScene !== activeWorkspace.scene) void setScene(activeWorkspace.scene)
  })

  createEffect(() => {
    const openDeepLinkedSettings = () => {
      setHashSettingsOpen(window.location.hash.startsWith('#settings'))
      if (window.location.hash.startsWith('#settings'))
        workspaceStore.getState().setGlobalPanel('settings')
    }
    openDeepLinkedSettings()
    window.addEventListener('hashchange', openDeepLinkedSettings)
    return () => window.removeEventListener('hashchange', openDeepLinkedSettings)
  })

  const changeView = (nextView: WorkspaceView) => {
    void setViewParam(nextView)
  }
  const setRoomDesignerRoute = (enabled: boolean) => {
    setRoomDesignerEnabled(enabled)
    const nextUrl = new URL(window.location.href)
    nextUrl.searchParams.set('roomDesigner', enabled ? '1' : '0')
    if (enabled) nextUrl.searchParams.set('view', 'virtual')
    window.history.replaceState(null, '', nextUrl)
    if (enabled && view() !== 'virtual') void setViewParam('virtual')
  }
  const openSettings = (section: 'account' | 'input-notifications' | 'integrations') => {
    window.history.replaceState(null, '', `#settings/${section}`)
    setHashSettingsOpen(true)
    // Settings is a global overlay. Keep the current surface mounted so the
    // virtual scene does not disappear before its dialog can open.
    workspaceStore.getState().setGlobalPanel('settings')
  }
  const openSearch = () => {
    workspaceStore.getState().setGlobalPanel('search')
    if (view() !== 'chat') changeView('chat')
  }

  return (
    <div class={`workspace-frame workspace-frame--${view()}`}>
      <GlobalWorkspaceRail
        account={{
          authenticated: props.account.authenticated,
          busy: props.account.busy,
          label: props.account.label,
          onSignIn: props.account.onSignIn,
          onSignOut: () => void props.account.onSignOut(),
          ...(props.account.onOpenUpdates ? { onOpenUpdates: props.account.onOpenUpdates } : {}),
          platform: props.platform,
        }}
        onOpenNotifications={() => openSettings('input-notifications')}
        onOpenAbout={() => workspaceStore.getState().setGlobalPanel('about')}
        onOpenPlugins={() => workspaceStore.getState().setGlobalPanel('plugins')}
        onOpenSearch={openSearch}
        onOpenSettings={() => openSettings('account')}
        activeWorkspace={props.activeWorkspace}
        onWorkspaceChange={(workspace) => {
          if (workspace.id === props.activeWorkspace?.id) return
          void Promise.resolve(props.onAuthorizeWorkspace?.(workspace.id))
            .then(() => {
              workspaceStore.getState().switchWorkspace(workspace.id, workspace.scene)
              void setScene(workspace.scene)
            })
            .catch(() => undefined)
        }}
        onViewChange={changeView}
        view={view()}
        workspaces={props.workspaces}
      />
      <div class="workspace-frame__surface">
        <Show
          when={view() === 'virtual'}
          fallback={
            <ConventionalWorkspace
              client={props.client}
              manageSettings={false}
              onViewChange={changeView}
              services={props.services}
            />
          }
        >
          <Show
            when={roomDesignerEnabled()}
            fallback={
              <SpatialWorkspace
                {...props.virtualProps}
                apiClient={props.client}
                initialScene={scene()}
                onOpenRoomDesigner={() => setRoomDesignerRoute(true)}
                onWorkspaceViewChange={changeView}
                services={props.services}
                workspaceView={view()}
              />
            }
          >
            <RoomDesignerWorkspace
              initialCharacter={props.virtualProps.initialCharacter}
              initialScene={scene()}
              onClose={() => setRoomDesignerRoute(false)}
            />
          </Show>
        </Show>
      </div>
      <Show when={props.activeWorkspace && settingsOpen()}>
        <WorkspaceSettingsOverlay
          accountAuthenticated={props.account.authenticated}
          accountLabel={props.account.label}
          busy={props.account.busy}
          client={props.client}
          onClose={() => {
            setHashSettingsOpen(false)
            workspaceStore.getState().setGlobalPanel(null)
          }}
          onOpenAgents={() => {
            workspaceStore.getState().setActiveSurface('agents')
            workspaceStore.getState().setGlobalPanel(null)
            changeView('chat')
          }}
          onSignIn={props.account.onSignIn}
          onSignOut={() => void props.account.onSignOut()}
          open
          services={props.services}
          workspace={props.activeWorkspace!}
        />
      </Show>
      <PluginsDialog
        open={globalPanel() === 'plugins' && Boolean(props.activeWorkspace)}
        onClose={() => workspaceStore.getState().setGlobalPanel(null)}
        provider={props.services.plugins}
      />
      <WorkspaceAboutDialog
        appName={props.services.app?.name}
        open={globalPanel() === 'about'}
        onClose={() => workspaceStore.getState().setGlobalPanel(null)}
        platform={props.platform}
        version={props.services.app?.version}
      />
      <Show when={props.updates}>
        {(updates) => <VersionDialog open={updates().open} onOpenChange={updates().onOpenChange} />}
      </Show>
    </div>
  )
}
