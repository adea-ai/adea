import { createApiClient } from '@adea-ai/api-client'
import { SoundProvider } from '@adea-ai/audio'
import { useAgentListQuery } from '@adea-ai/data'
import { AgentHqQueryProvider } from '@adea-ai/data/provider'
import {
  createDesktopAuthorizationManager,
  createDesktopAuthorizationUrl,
  createDesktopHttpSessionBroker,
  createDesktopSessionManager,
  type DesktopAuthorizationAttempt,
  type DesktopSession,
  type DesktopSessionVault,
} from '@adea-ai/auth/desktop'
import { invoke } from '@tauri-apps/api/core'
import { getVersion } from '@tauri-apps/api/app'
import { listen } from '@tauri-apps/api/event'
import { lazy, StrictMode, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useWorkspaceStore } from '@adea-ai/state'
import { ThemeProvider } from '@adea-ai/ui/components/theme-provider'
import { ConventionalWorkspaceShell } from '@adea-ai/workspace-ui/conventional-workspace-shell'
import { GlobalWorkspaceRail } from '@adea-ai/workspace-ui/global-workspace-rail'
import type {
  WorkspacePlatformServices,
  WorkspacePluginsProvider,
} from '@adea-ai/workspace-ui/platform'
import type { WorkspaceView } from '@adea-ai/workspace-ui/workspace-view-toggle'

import { localContentAuthority } from './local-content'
import packageJson from '../package.json'
import { desktopSettingsProvider } from './preferences'
import { systemTranscriptionProvider } from './transcription'
import { VersionDialog } from './version-dialog'
import {
  bootstrapDesktopWorkspace,
  createWorkspaceRequestGuard,
  loadTemporaryWorkspaceCredential,
  type DesktopWorkspaceBootstrap,
} from './workspace-session'
import './styles.css'

const packageVersion = packageJson.version

// Injected by `vite.config.ts` from the same validated value the packaged CSP
// and the native authorization allowlist use (see `src-tauri/src/cloud.rs`).
const cloudOrigin = __ADEA_CLOUD_ORIGIN__

const SpatialDesktopWorkspace = lazy(() =>
  import('./desktop-workspace').then(({ DesktopWorkspace }) => ({ default: DesktopWorkspace }))
)

// Dialogs are infrequent overlays, so their code stays out of the startup
// chunk and loads the first time each one mounts.
const PluginsDialog = lazy(() =>
  import('@adea-ai/workspace-ui/plugins-dialog').then(({ PluginsDialog }) => ({
    default: PluginsDialog,
  }))
)
const WorkspaceAboutDialog = lazy(() =>
  import('@adea-ai/workspace-ui/workspace-about-dialog').then(({ WorkspaceAboutDialog }) => ({
    default: WorkspaceAboutDialog,
  }))
)
const WorkspaceSettingsDialog = lazy(() =>
  import('@adea-ai/workspace-ui/workspace-settings').then(({ WorkspaceSettingsDialog }) => ({
    default: WorkspaceSettingsDialog,
  }))
)

function DesktopSettingsOverlay({
  client,
  open,
  onClose,
  onOpenAgents,
  services,
  workspace,
}: Readonly<{
  client: ReturnType<typeof workspaceClient>
  onClose: () => void
  onOpenAgents: () => void
  open: boolean
  services: WorkspacePlatformServices
  workspace: DesktopWorkspaceBootstrap['workspace']
}>) {
  const agentsQuery = useAgentListQuery(client, workspace.id)
  return (
    <Suspense fallback={null}>
      <WorkspaceSettingsDialog
        accountAuthenticated={Boolean(services.account?.authenticated)}
        accountLabel={services.account?.label ?? 'Account'}
        agents={agentsQuery.data ?? []}
        busy={services.account?.busy ?? false}
        onClose={onClose}
        onOpenAgents={onOpenAgents}
        onSignIn={() => services.account?.onSignIn()}
        onSignOut={() => void services.account?.onSignOut()}
        open={open}
        services={services}
        workspace={workspace}
      />
    </Suspense>
  )
}

type AppStatus =
  | 'authenticated'
  | 'failed'
  | 'guest'
  | 'loading'
  | 'offline'
  | 'opening'
  | 'waiting'

const sessionVault: DesktopSessionVault = {
  clear: () => invoke('desktop_user_session_clear'),
  load: () => invoke<DesktopSession | null>('desktop_user_session_load'),
  save: (session) => invoke('desktop_user_session_save', { session }),
}
const temporaryVault = {
  clear: () => invoke<void>('desktop_temporary_workspace_clear'),
  load: () => invoke<string | null>('desktop_temporary_workspace_load'),
  save: (credential: string) => invoke<void>('desktop_temporary_workspace_save', { credential }),
}
const authorizationManager = createDesktopAuthorizationManager({
  vault: {
    clear: () => invoke('desktop_auth_attempt_clear'),
    load: () => invoke<DesktopAuthorizationAttempt | null>('desktop_auth_attempt_load'),
    save: (authorizationAttempt) =>
      invoke('desktop_auth_attempt_save', { attempt: authorizationAttempt }),
  },
})
const sessionManager = createDesktopSessionManager({
  broker: createDesktopHttpSessionBroker({ cloudOrigin }),
  vault: sessionVault,
})

function workspaceClient(session?: DesktopSession, temporaryCredential?: string) {
  return createApiClient({
    baseUrl: `${cloudOrigin}/api`,
    client: 'desktop',
    getDesktopSession: session
      ? () => ({ credential: session.credential, sessionId: session.sessionId })
      : undefined,
    getTemporaryCredential: temporaryCredential ? () => temporaryCredential : undefined,
  })
}

function DesktopApp() {
  const [status, setStatus] = useState<AppStatus>('loading')
  const [message, setMessage] = useState('Opening your workspace…')
  const [workspaceState, setWorkspaceState] = useState<DesktopWorkspaceBootstrap | null>(null)
  const [session, setSession] = useState<DesktopSession | undefined>()
  const [appVersion, setAppVersion] = useState<string>(packageVersion)
  const [updatesOpen, setUpdatesOpen] = useState(false)
  const [view, setView] = useState<WorkspaceView>(() =>
    new URLSearchParams(window.location.search).get('view') === 'virtual' ? 'virtual' : 'chat'
  )
  const selectedScene = useWorkspaceStore((state) => state.selectedScene)
  const selectedWorkspaceId = useWorkspaceStore((state) => state.selectedWorkspaceId)
  const globalPanel = useWorkspaceStore((state) => state.globalPanel)
  const setGlobalPanel = useWorkspaceStore((state) => state.setGlobalPanel)
  const setSelectedScene = useWorkspaceStore((state) => state.setSelectedScene)
  const switchWorkspace = useWorkspaceStore((state) => state.switchWorkspace)
  const temporaryCredentialRef = useRef<string | null>(null)
  const sessionRef = useRef<DesktopSession | undefined>(undefined)
  const workspaceIdRef = useRef<string | undefined>(undefined)
  const userIdRef = useRef<string | undefined>(undefined)
  const [plugins] = useState<WorkspacePluginsProvider>(() => {
    // The registry provider pulls in the marketplace catalog and its artifact
    // verification, so it loads the first time plugins are actually used.
    let provider: Promise<WorkspacePluginsProvider> | undefined
    let loaded: WorkspacePluginsProvider | undefined
    const load = () => {
      provider ??= import('@adea-ai/workspace-ui/plugins')
        .then(({ createRegistryPluginsProvider }) =>
          createRegistryPluginsProvider({
            client: () =>
              workspaceClient(sessionRef.current, temporaryCredentialRef.current ?? undefined),
            getWorkspaceId: () => workspaceIdRef.current,
            getUserId: () => userIdRef.current,
            requestedHarness: 'codex',
          })
        )
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
  })
  const workspaceRequestGuardRef = useRef(createWorkspaceRequestGuard())
  const authCallbackObservedRef = useRef(false)

  useEffect(() => {
    void getVersion()
      .then(setAppVersion)
      .catch(() => undefined)
  }, [])

  const openWorkspace = useCallback(
    async (activeSession?: DesktopSession) => {
      const requestIsCurrent = workspaceRequestGuardRef.current.begin()
      setSession(activeSession)
      sessionRef.current = activeSession
      setStatus('loading')
      setMessage(
        activeSession ? 'Opening your saved workspace…' : 'Opening a private guest workspace…'
      )
      try {
        let storedTemporaryCredential = temporaryCredentialRef.current
        if (!storedTemporaryCredential) {
          storedTemporaryCredential = await loadTemporaryWorkspaceCredential(temporaryVault.load)
        }
        const nextWorkspace = await bootstrapDesktopWorkspace({
          createClient: ({ session: clientSession, temporaryCredential }) =>
            workspaceClient(clientSession, temporaryCredential),
          session: activeSession,
          storedTemporaryCredential,
          onTemporaryCredentialClaimed: () => {
            temporaryCredentialRef.current = null
          },
          temporaryVault,
        })
        if (!requestIsCurrent()) return
        await localContentAuthority.authorizeWorkspace(nextWorkspace.workspace.id)
        if (!requestIsCurrent()) return
        switchWorkspace(nextWorkspace.workspace.id, nextWorkspace.workspace.scene)
        temporaryCredentialRef.current = nextWorkspace.temporaryCredential
        workspaceIdRef.current = nextWorkspace.workspace.id
        userIdRef.current = nextWorkspace.userId
        setWorkspaceState(nextWorkspace)
        setStatus(activeSession ? 'authenticated' : 'guest')
        setMessage(
          activeSession
            ? 'Your workspace is saved to your Adea account.'
            : nextWorkspace.temporaryCredentialPersisted
              ? 'You can use this workspace now. Sign in whenever you want to save it to an account.'
              : 'You can use this workspace now. Sign in before closing the app to save it to an account.'
        )
      } catch {
        if (!requestIsCurrent()) return
        setStatus('offline')
        setMessage('Adea could not reach the workspace service. Your local credentials are safe.')
      }
    },
    [switchWorkspace]
  )

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    void sessionManager.restore().then((sessionState) => {
      if (disposed || authCallbackObservedRef.current) return
      void openWorkspace(sessionState.status === 'authenticated' ? sessionState.session : undefined)
    })

    async function receiveCallback() {
      let callbackUrl: string | null
      try {
        callbackUrl = await invoke<string | null>('desktop_auth_take_callback')
      } catch {
        return
      }
      if (!callbackUrl || disposed) return
      authCallbackObservedRef.current = true
      workspaceRequestGuardRef.current.invalidate()
      try {
        const exchange = await authorizationManager.consume(callbackUrl)
        const sessionState = await sessionManager.completeSignIn(exchange)
        if (sessionState.status !== 'authenticated') throw new Error('Authentication failed')
        await openWorkspace(sessionState.session)
      } catch {
        setStatus('failed')
        setMessage(
          callbackUrl.includes('error=early_access')
            ? "Adea is in early access. Please reach out on github if you'd like to contribute."
            : 'The sign-in callback was invalid or expired. Your guest workspace is unchanged.'
        )
      }
    }

    void listen('desktop-auth-callback-ready', () => void receiveCallback()).then((dispose) => {
      if (disposed) return dispose()
      unlisten = dispose
      void receiveCallback()
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [openWorkspace])

  const activeWorkspace = workspaceState
    ? (workspaceState.workspaces.find(({ id }) => id === selectedWorkspaceId) ??
      workspaceState.workspace)
    : undefined

  useEffect(() => {
    if (!activeWorkspace) return
    workspaceIdRef.current = activeWorkspace.id
    setSelectedScene(activeWorkspace.scene)
  }, [activeWorkspace?.id, activeWorkspace?.scene, setSelectedScene])

  async function beginSignIn() {
    setStatus('opening')
    setMessage('Opening your system browser…')
    try {
      const nextAttempt = await authorizationManager.begin()
      await invoke('desktop_auth_start', {
        authorizationUrl: createDesktopAuthorizationUrl(cloudOrigin, nextAttempt),
      })
      setStatus('waiting')
      setMessage(
        'Finish signing in in your browser, then return here. This app will reopen automatically.'
      )
    } catch {
      await authorizationManager.cancel().catch(() => undefined)
      setStatus(workspaceState?.temporary ? 'guest' : 'failed')
      setMessage('Adea could not open the trusted sign-in page. Your workspace is unchanged.')
    }
  }

  async function signOut() {
    setUpdatesOpen(false)
    await sessionManager.signOut().catch(() => undefined)
    setSession(undefined)
    setWorkspaceState(null)
    await openWorkspace()
  }

  const busy = status === 'loading' || status === 'opening' || status === 'waiting'
  const changeView = (nextView: WorkspaceView) => {
    setView(nextView)
    const nextUrl = new URL(window.location.href)
    nextUrl.searchParams.set('view', nextView)
    window.history.replaceState(null, '', nextUrl)
  }

  if (workspaceState) {
    const client = workspaceClient(session, workspaceState.temporaryCredential ?? undefined)
    const services = {
      account: {
        authenticated: Boolean(session),
        busy,
        label: session ? (workspaceState.accountLabel ?? 'Account') : 'Sign in',
        onSignIn: () => void beginSignIn(),
        onSignOut: () => signOut(),
      },
      app: { name: 'Adea', platform: 'desktop' as const, version: appVersion },
      client,
      privateContent: localContentAuthority,
      plugins,
      settings: desktopSettingsProvider,
      transcription: systemTranscriptionProvider,
    }
    const openSettings = (section: 'account' | 'input-notifications' | 'integrations') => {
      window.history.replaceState(null, '', `#settings/${section}`)
      // Settings is a global overlay. Do not unmount the current surface before
      // the dialog can consume the panel state.
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
            authenticated: Boolean(session),
            busy,
            label: session ? (workspaceState.accountLabel ?? 'Account') : 'Not signed in',
            onSignIn: () => void beginSignIn(),
            onSignOut: () => void signOut(),
            onOpenUpdates: () => setUpdatesOpen(true),
            platform: 'desktop',
          }}
          activeWorkspace={activeWorkspace}
          onOpenNotifications={() => openSettings('input-notifications')}
          onOpenAbout={() => setGlobalPanel('about')}
          onOpenPlugins={() => setGlobalPanel('plugins')}
          onOpenSearch={openSearch}
          onOpenSettings={() => openSettings('account')}
          onWorkspaceChange={(workspace) => {
            if (workspace.id === activeWorkspace?.id) return
            void localContentAuthority
              .authorizeWorkspace(workspace.id)
              .then(() => switchWorkspace(workspace.id, workspace.scene))
              .catch(() => undefined)
          }}
          onViewChange={changeView}
          view={view}
          workspaces={workspaceState.workspaces}
        />
        <div className="workspace-frame__surface">
          {view === 'chat' ? (
            <ConventionalWorkspaceShell
              manageSettings={false}
              onViewChange={changeView}
              view={view}
              services={services}
            />
          ) : (
            <Suspense
              fallback={
                <main className="auth-shell" aria-busy="true">
                  <p>Opening virtual preview…</p>
                </main>
              }
            >
              <SpatialDesktopWorkspace
                key={activeWorkspace?.id ?? selectedScene}
                client={client}
                onWorkspaceViewChange={changeView}
                scene={selectedScene}
              />
            </Suspense>
          )}
        </div>
        {globalPanel === 'settings' ? (
          <DesktopSettingsOverlay
            client={client}
            onClose={() => setGlobalPanel(null)}
            onOpenAgents={() => {
              setGlobalPanel(null)
              changeView('chat')
            }}
            open
            services={services}
            workspace={activeWorkspace!}
          />
        ) : null}
        <Suspense fallback={null}>
          <PluginsDialog
            open={globalPanel === 'plugins' && Boolean(workspaceState.workspace)}
            onClose={() => setGlobalPanel(null)}
            provider={plugins}
          />
          <WorkspaceAboutDialog
            appName="Adea"
            open={globalPanel === 'about'}
            onClose={() => setGlobalPanel(null)}
            platform="desktop"
            version={appVersion}
          />
        </Suspense>
        <VersionDialog open={updatesOpen} onOpenChange={setUpdatesOpen} />
      </div>
    )
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel desktop-panel" aria-labelledby="desktop-title">
        <div className="workspace-heading">
          <div>
            <p className="auth-eyebrow">Adea desktop</p>
            <h1 className="auth-title" id="desktop-title">
              Your workspace, ready when you are.
            </h1>
          </div>
        </div>
        <p className="auth-introduction">
          Start immediately without an account. Sign in later to keep this workspace across devices.
        </p>

        <div className="status" role="status" aria-live="polite">
          <span className={`status-mark status-mark--${status}`} aria-hidden="true" />
          <p>{message}</p>
        </div>

        <div className="workspace-actions">
          {(status === 'offline' || status === 'failed') && (
            <>
              <button
                type="button"
                className="button-secondary"
                onClick={() => void openWorkspace(session)}
              >
                Try again
              </button>
              {!session && (
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => void beginSignIn()}
                >
                  Sign in
                </button>
              )}
            </>
          )}
        </div>

        <p className="privacy-note">
          Guest access is protected by a device-only keychain credential. Optional sign-in uses
          PKCE; no session token is placed in the browser callback URL.
        </p>
      </section>
    </main>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('Desktop application root is unavailable')
createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <AgentHqQueryProvider>
        <SoundProvider>
          <DesktopApp />
        </SoundProvider>
      </AgentHqQueryProvider>
    </ThemeProvider>
  </StrictMode>
)
