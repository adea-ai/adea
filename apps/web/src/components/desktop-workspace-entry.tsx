'use client'

// Desktop runtime entry for the single workspace UI. The shell injects
// `window.__adeaDesktop` before this client boots, so this entry owns only the
// shell session bootstrap (guest credential, PKCE sign-in) and the start
// surface; the workspace itself renders through the shared
// `WorkspaceNavigation`.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentHqApiClient } from '@adea-ai/api-client'
import type { DesktopSession } from '@adea-ai/auth/desktop'
import { useWorkspaceStore } from '@adea-ai/state'
import type { WorkspacePlatformServices } from '@adea-ai/workspace-ui/platform'
import { invoke, listen } from '../lib/desktop-bridge'
import { localContentAuthority } from '../lib/desktop-local-content'
import {
  desktopCapabilityProvider,
  desktopSettingsProvider,
  systemTranscriptionProvider,
} from '../lib/desktop-platform-services'
import { desktopRuntime } from '../lib/desktop-runtime'
import {
  bootstrapDesktopWorkspace,
  createWorkspaceRequestGuard,
  loadTemporaryWorkspaceCredential,
  type DesktopWorkspaceBootstrap,
} from '../lib/desktop-workspace-session'
import { createDeferredPluginsProvider, WorkspaceNavigation } from './workspace-navigation'
import type { WorkspaceShellProps } from './workspace-shell'

type AppStatus =
  | 'authenticated'
  | 'failed'
  | 'guest'
  | 'loading'
  | 'offline'
  | 'opening'
  | 'waiting'

const statusMark: Record<AppStatus, string> = {
  authenticated: 'ready',
  failed: 'error',
  guest: 'active',
  loading: 'active',
  offline: 'warning',
  opening: 'active',
  waiting: 'active',
}

export function DesktopWorkspaceEntry({
  virtual,
  virtualProps,
  roomDesigner = false,
}: Readonly<{
  virtual: boolean
  virtualProps: WorkspaceShellProps
  roomDesigner?: boolean
}>) {
  const runtime = desktopRuntime()
  const [status, setStatus] = useState<AppStatus>('loading')
  const [message, setMessage] = useState('Opening your workspace…')
  const [workspaceState, setWorkspaceState] = useState<DesktopWorkspaceBootstrap | null>(null)
  const [session, setSession] = useState<DesktopSession | undefined>()
  const [appVersion, setAppVersion] = useState('0.0.0')
  const [updatesOpen, setUpdatesOpen] = useState(false)
  const selectedWorkspaceId = useWorkspaceStore((state) => state.selectedWorkspaceId)
  const switchWorkspace = useWorkspaceStore((state) => state.switchWorkspace)
  const temporaryCredentialRef = useRef<string | null>(null)
  const sessionRef = useRef<DesktopSession | undefined>(undefined)
  const workspaceIdRef = useRef<string | undefined>(undefined)
  const userIdRef = useRef<string | undefined>(undefined)
  const clientRef = useRef<AgentHqApiClient | undefined>(undefined)
  const workspaceRequestGuardRef = useRef(createWorkspaceRequestGuard())
  const authCallbackObservedRef = useRef(false)
  const [plugins] = useState(() =>
    createDeferredPluginsProvider({
      client: () => clientRef.current!,
      getWorkspaceId: () => workspaceIdRef.current,
      getUserId: () => userIdRef.current,
      requestedHarness: 'codex',
    })
  )

  useEffect(() => {
    void runtime
      .getUserVersion()
      .then(setAppVersion)
      .catch(() => undefined)
  }, [runtime])

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
          storedTemporaryCredential = await loadTemporaryWorkspaceCredential(
            runtime.temporaryVault.load
          )
        }
        const nextWorkspace = await bootstrapDesktopWorkspace({
          createClient: ({ session: clientSession, temporaryCredential }) =>
            runtime.createClient(clientSession, temporaryCredential),
          session: activeSession,
          storedTemporaryCredential,
          onTemporaryCredentialClaimed: () => {
            temporaryCredentialRef.current = null
          },
          temporaryVault: runtime.temporaryVault,
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
    [runtime, switchWorkspace]
  )

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    void runtime.sessionManager.restore().then((sessionState) => {
      if (disposed || authCallbackObservedRef.current) return
      void openWorkspace(sessionState.status === 'authenticated' ? sessionState.session : undefined)
    })

    async function receiveCallback() {
      let callbackUrl: string | null
      try {
        callbackUrl = await invoke<string | null>('desktop_auth_take_callback').catch(() => null)
      } catch {
        return
      }
      if (!callbackUrl || disposed) return
      authCallbackObservedRef.current = true
      workspaceRequestGuardRef.current.invalidate()
      try {
        const exchange = await runtime.consumeAuthorization(callbackUrl)
        const sessionState = await runtime.sessionManager.completeSignIn(exchange)
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
  }, [openWorkspace, runtime])

  const activeWorkspace = workspaceState
    ? (workspaceState.workspaces.find(({ id }) => id === selectedWorkspaceId) ??
      workspaceState.workspace)
    : undefined

  useEffect(() => {
    if (!activeWorkspace) return
    workspaceIdRef.current = activeWorkspace.id
    void localContentAuthority.authorizeWorkspace(activeWorkspace.id).catch(() => undefined)
  }, [activeWorkspace?.id])

  const client = useMemo(
    () => runtime.createClient(session, workspaceState?.temporaryCredential ?? undefined),
    [runtime, session, workspaceState?.temporaryCredential]
  )
  useEffect(() => {
    clientRef.current = client
  }, [client])

  async function beginSignIn() {
    setStatus('opening')
    setMessage('Opening your system browser…')
    try {
      const nextAttempt = await runtime.beginAuthorization()
      await invoke('desktop_auth_start', {
        authorizationUrl: runtime.authorizationUrl(nextAttempt),
      })
      setStatus('waiting')
      setMessage(
        'Finish signing in in your browser, then return here. This app will reopen automatically.'
      )
    } catch {
      await runtime.cancelAuthorization().catch(() => undefined)
      setStatus(workspaceState?.temporary ? 'guest' : 'failed')
      setMessage('Adea could not open the trusted sign-in page. Your workspace is unchanged.')
    }
  }

  async function signOut() {
    setUpdatesOpen(false)
    await runtime.sessionManager.signOut().catch(() => undefined)
    setSession(undefined)
    setWorkspaceState(null)
    await openWorkspace()
  }

  const busy = status === 'loading' || status === 'opening' || status === 'waiting'

  if (!workspaceState || !activeWorkspace) {
    return (
      <DesktopStartSurface
        busy={busy}
        message={message}
        onRetry={() => void openWorkspace(session)}
        onSignIn={() => void beginSignIn()}
        showSignIn={!session && status !== 'waiting' && status !== 'opening'}
        status={status}
      />
    )
  }

  const services: WorkspacePlatformServices = {
    account: {
      authenticated: Boolean(session),
      busy,
      label: session ? (workspaceState.accountLabel ?? 'Account') : 'Not signed in',
      onSignIn: () => void beginSignIn(),
      onSignOut: () => void signOut(),
    },
    app: { name: 'Adea', platform: 'desktop', version: appVersion },
    capabilities: desktopCapabilityProvider,
    client,
    privateContent: localContentAuthority,
    plugins,
    settings: desktopSettingsProvider,
    transcription: systemTranscriptionProvider,
  }

  return (
    <WorkspaceNavigation
      account={{
        authenticated: Boolean(session),
        busy,
        label: session ? (workspaceState.accountLabel ?? 'Account') : 'Not signed in',
        onOpenUpdates: () => setUpdatesOpen(true),
        onSignIn: () => void beginSignIn(),
        onSignOut: () => void signOut(),
      }}
      activeWorkspace={activeWorkspace}
      client={client}
      onAuthorizeWorkspace={(workspaceId) => localContentAuthority.authorizeWorkspace(workspaceId)}
      platform="desktop"
      roomDesigner={roomDesigner}
      services={services}
      updates={{ open: updatesOpen, onOpenChange: setUpdatesOpen }}
      virtual={virtual}
      virtualProps={virtualProps}
      workspaces={workspaceState.workspaces}
    />
  )
}

function DesktopStartSurface({
  busy,
  message,
  onRetry,
  onSignIn,
  showSignIn,
  status,
}: Readonly<{
  busy: boolean
  message: string
  onRetry(): void
  onSignIn(): void
  showSignIn: boolean
  status: AppStatus
}>) {
  return (
    <main className="auth-shell">
      <section className="auth-panel" aria-labelledby="desktop-title" aria-busy={busy}>
        <p className="auth-eyebrow">Adea desktop</p>
        <h1 className="auth-title" id="desktop-title">
          Your workspace, ready when you are.
        </h1>
        <p className="auth-introduction">
          Start immediately without an account. Sign in later to keep this workspace across devices.
        </p>

        <div className="auth-status" role="status" aria-live="polite">
          <span
            className={`auth-status__mark auth-status__mark--${statusMark[status]}`}
            aria-hidden="true"
          />
          <p>{message}</p>
        </div>

        <div className="auth-actions">
          {(status === 'offline' || status === 'failed') && (
            <>
              <button type="button" className="auth-action" onClick={onRetry}>
                Try again
              </button>
              {showSignIn ? (
                <button
                  type="button"
                  className="auth-action auth-action-secondary"
                  onClick={onSignIn}
                >
                  Sign in
                </button>
              ) : null}
            </>
          )}
        </div>

        <p className="auth-note">
          Guest access is protected by a device-only keychain credential. Optional sign-in uses
          PKCE; no session token is placed in the browser callback URL.
        </p>
      </section>
    </main>
  )
}
