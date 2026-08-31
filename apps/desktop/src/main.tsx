import { createApiClient } from '@agent-hq/api-client'
import { SoundProvider } from '@agent-hq/audio'
import { AgentHqQueryProvider } from '@agent-hq/data/provider'
import {
  createDesktopAuthorizationManager,
  createDesktopAuthorizationUrl,
  createDesktopHttpSessionBroker,
  createDesktopSessionManager,
  type DesktopAuthorizationAttempt,
  type DesktopSession,
  type DesktopSessionVault,
} from '@agent-hq/auth/desktop'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { lazy, StrictMode, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useWorkspaceStore } from '@agent-hq/state'
import { ThemeProvider } from '@agent-hq/ui/components/theme-provider'
import {
  ConventionalWorkspaceShell,
  createBrowserPluginsProvider,
  GlobalWorkspaceRail,
  PluginsDialog,
  WorkspaceAboutDialog,
  type WorkspaceView,
} from '@agent-hq/workspace-ui'

import { localContentAuthority } from './local-content'
import { desktopSettingsProvider } from './preferences'
import { systemTranscriptionProvider } from './transcription'
import {
  bootstrapDesktopWorkspace,
  createWorkspaceRequestGuard,
  loadTemporaryWorkspaceCredential,
  type DesktopWorkspaceBootstrap,
} from './workspace-session'
import './styles.css'

const cloudOrigin = import.meta.env.VITE_AGENT_HQ_CLOUD_ORIGIN || 'https://agent-hq-site.vercel.app'

const SpatialDesktopWorkspace = lazy(() =>
  import('./desktop-workspace').then(({ DesktopWorkspace }) => ({ default: DesktopWorkspace }))
)

type AppStatus =
  'authenticated' | 'failed' | 'guest' | 'loading' | 'offline' | 'opening' | 'waiting'

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
  const [plugins] = useState(() => createBrowserPluginsProvider())
  const [view, setView] = useState<WorkspaceView>(() =>
    new URLSearchParams(window.location.search).get('view') === 'spatial' ? 'virtual' : 'chat'
  )
  const selectedScene = useWorkspaceStore((state) => state.selectedScene)
  const globalPanel = useWorkspaceStore((state) => state.globalPanel)
  const setGlobalPanel = useWorkspaceStore((state) => state.setGlobalPanel)
  const setSelectedChannelId = useWorkspaceStore((state) => state.setSelectedChannelId)
  const setSelectedRoomId = useWorkspaceStore((state) => state.setSelectedRoomId)
  const setSelectedScene = useWorkspaceStore((state) => state.setSelectedScene)
  const setSelectedWorkspaceId = useWorkspaceStore((state) => state.setSelectedWorkspaceId)
  const temporaryCredentialRef = useRef<string | null>(null)
  const workspaceRequestGuardRef = useRef(createWorkspaceRequestGuard())
  const authCallbackObservedRef = useRef(false)

  const openWorkspace = useCallback(async (activeSession?: DesktopSession) => {
    const requestIsCurrent = workspaceRequestGuardRef.current.begin()
    setSession(activeSession)
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
      temporaryCredentialRef.current = nextWorkspace.temporaryCredential
      setWorkspaceState(nextWorkspace)
      setStatus(activeSession ? 'authenticated' : 'guest')
      setMessage(
        activeSession
          ? 'Your workspace is saved to your Agent HQ account.'
          : nextWorkspace.temporaryCredentialPersisted
            ? 'You can use this workspace now. Sign in whenever you want to save it to an account.'
            : 'You can use this workspace now. Sign in before closing the app to save it to an account.'
      )
    } catch {
      if (!requestIsCurrent()) return
      setStatus('offline')
      setMessage('Agent HQ could not reach the workspace service. Your local credentials are safe.')
    }
  }, [])

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
          'The sign-in callback was invalid or expired. Your guest workspace is unchanged.'
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

  useEffect(() => {
    if (workspaceState) setSelectedScene(workspaceState.workspace.scene)
  }, [setSelectedScene, workspaceState])

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
      setMessage('Agent HQ could not open the trusted sign-in page. Your workspace is unchanged.')
    }
  }

  async function signOut() {
    await sessionManager.signOut().catch(() => undefined)
    setSession(undefined)
    setWorkspaceState(null)
    await openWorkspace()
  }

  const busy = status === 'loading' || status === 'opening' || status === 'waiting'
  const changeView = (nextView: WorkspaceView) => {
    setView(nextView)
    const nextUrl = new URL(window.location.href)
    nextUrl.searchParams.set('view', nextView === 'virtual' ? 'spatial' : 'chat')
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
      app: { name: 'Agent HQ Desktop', platform: 'desktop' as const },
      client,
      privateContent: localContentAuthority,
      plugins,
      settings: desktopSettingsProvider,
      transcription: systemTranscriptionProvider,
    }
    const openSettings = (section: 'account' | 'input-notifications' | 'integrations') => {
      window.history.replaceState(null, '', `#settings/${section}`)
      setGlobalPanel('settings')
      if (view !== 'chat') changeView('chat')
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
          }}
          activeWorkspace={workspaceState.workspace}
          onOpenNotifications={() => openSettings('input-notifications')}
          onOpenAbout={() => setGlobalPanel('about')}
          onOpenPlugins={() => setGlobalPanel('plugins')}
          onOpenSearch={openSearch}
          onOpenSettings={() => openSettings('account')}
          onWorkspaceChange={(workspace) => {
            setSelectedWorkspaceId(workspace.id)
            setSelectedRoomId(null)
            setSelectedChannelId(null)
            setSelectedScene(workspace.scene)
          }}
          onViewChange={changeView}
          view={view}
          workspaces={[workspaceState.workspace]}
        />
        <div className="workspace-frame__surface">
          {view === 'chat' ? (
            <ConventionalWorkspaceShell onViewChange={changeView} view={view} services={services} />
          ) : (
            <Suspense
              fallback={
                <main className="auth-shell" aria-busy="true">
                  <p>Opening spatial preview…</p>
                </main>
              }
            >
              <SpatialDesktopWorkspace
                message={message}
                status={status}
                client={client}
                onWorkspaceViewChange={changeView}
                scene={selectedScene}
              />
            </Suspense>
          )}
        </div>
        <PluginsDialog
          open={globalPanel === 'plugins'}
          onClose={() => setGlobalPanel(null)}
          provider={plugins}
        />
        <WorkspaceAboutDialog
          appName="Agent HQ Desktop"
          open={globalPanel === 'about'}
          onClose={() => setGlobalPanel(null)}
          platform="desktop"
        />
      </div>
    )
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel desktop-panel" aria-labelledby="desktop-title">
        <div className="workspace-heading">
          <div>
            <p className="auth-eyebrow">Agent HQ desktop</p>
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
            <button
              type="button"
              className="button-secondary"
              onClick={() => void openWorkspace(session)}
            >
              Try again
            </button>
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
