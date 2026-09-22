// Desktop runtime entry for the single workspace UI. The shell injects
// `window.__adeaDesktop` before this client boots, so this entry owns only the
// shell session bootstrap (guest credential, PKCE sign-in) and the start
// surface; the workspace itself renders through the shared
// `WorkspaceNavigation`.
import { createEffect, createMemo, createSignal, Show } from 'solid-js'
import type { AgentHqApiClient } from '@adea-ai/api-client'
import type { DesktopSession } from '@adea-ai/auth/desktop'
import { useWorkspaceState, workspaceStore } from '@adea-ai/state'
import type { WorkspacePlatformServices } from '@adea-ai/workspace-ui/platform'
import type { WorkspaceSummary } from '@adea-ai/types'
import { invoke, listen } from '../lib/desktop-bridge'
import { createDesktopDevRuntimeService } from '../lib/desktop-dev-runtime'
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
import { DesktopFirstRunChat } from './desktop-first-run-chat'
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

export function DesktopWorkspaceEntry(props: {
  virtual: boolean
  virtualProps: WorkspaceShellProps
  roomDesigner?: boolean
}) {
  const runtime = desktopRuntime()
  const [status, setStatus] = createSignal<AppStatus>('loading')
  const [message, setMessage] = createSignal('Opening your workspace…')
  const [workspaceState, setWorkspaceState] = createSignal<DesktopWorkspaceBootstrap | null>(null)
  const [session, setSession] = createSignal<DesktopSession | undefined>()
  const [appVersion, setAppVersion] = createSignal('0.0.0')
  const [updatesOpen, setUpdatesOpen] = createSignal(false)
  const selectedWorkspaceId = useWorkspaceState((state) => state.selectedWorkspaceId)
  let temporaryCredential: string | null = null
  let clientRef: AgentHqApiClient | undefined
  const workspaceRequestGuard = createWorkspaceRequestGuard()
  let authCallbackObserved = false
  const activeWorkspace = (): WorkspaceSummary | undefined => {
    const state = workspaceState()
    return state
      ? (state.workspaces.find(({ id }) => id === selectedWorkspaceId()) ?? state.workspace)
      : undefined
  }
  // The plugins provider reads these lazily, so accessors deliver the current
  // ids directly — no mutable variables synchronized through effects.
  const plugins = createDeferredPluginsProvider({
    client: () => clientRef!,
    getWorkspaceId: () => activeWorkspace()?.id,
    getUserId: () => workspaceState()?.userId,
    requestedHarness: 'codex',
  })

  createEffect(() => {
    void runtime
      .getUserVersion()
      .then((version) => setAppVersion(version))
      .catch(() => undefined)
  })

  const openWorkspace = async (activeSession?: DesktopSession) => {
    const requestIsCurrent = workspaceRequestGuard.begin()
    setSession(activeSession)
    setStatus('loading')
    setMessage(
      activeSession ? 'Opening your saved workspace…' : 'Opening a private guest workspace…'
    )
    try {
      let storedTemporaryCredential = temporaryCredential
      if (!storedTemporaryCredential) {
        storedTemporaryCredential = await loadTemporaryWorkspaceCredential(
          runtime.temporaryVault.load
        )
      }
      const nextWorkspace = await bootstrapDesktopWorkspace({
        createClient: ({ session: clientSession, temporaryCredential: guestCredential }) =>
          runtime.createClient(clientSession, guestCredential),
        session: activeSession,
        storedTemporaryCredential,
        onTemporaryCredentialClaimed: () => {
          temporaryCredential = null
        },
        temporaryVault: runtime.temporaryVault,
      })
      if (!requestIsCurrent()) return
      await localContentAuthority.authorizeWorkspace(nextWorkspace.workspace.id)
      if (!requestIsCurrent()) return
      workspaceStore
        .getState()
        .switchWorkspace(nextWorkspace.workspace.id, nextWorkspace.workspace.scene)
      temporaryCredential = nextWorkspace.temporaryCredential
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
  }

  createEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    void runtime.sessionManager.restore().then((sessionState) => {
      if (disposed || authCallbackObserved) return
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
      authCallbackObserved = true
      workspaceRequestGuard.invalidate()
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
  })

  createEffect(() => {
    const workspace = activeWorkspace()
    if (!workspace) return
    void localContentAuthority.authorizeWorkspace(workspace.id).catch(() => undefined)
  })

  // Stable identity: every reactive reader must get the same client for a
  // given session/workspace — creating one per call means each accessor read
  // allocates a fresh client and breaks reference equality for consumers.
  const client = createMemo(() => {
    const state = workspaceState()
    if (!state) return clientRef
    const nextClient = runtime.createClient(session(), state.temporaryCredential ?? undefined)
    clientRef = nextClient
    return nextClient
  })

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
      setStatus(workspaceState()?.temporary ? 'guest' : 'failed')
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

  const busy = () => status() === 'loading' || status() === 'opening' || status() === 'waiting'

  return (
    <Show
      when={activeWorkspace()}
      fallback={
        <DesktopStartSurface
          busy={busy()}
          message={message()}
          onRetry={() => void openWorkspace(session())}
          onSignIn={() => void beginSignIn()}
          showSignIn={!session() && status() !== 'waiting' && status() !== 'opening'}
          status={status()}
        />
      }
    >
      {(workspace) => (
        <DesktopWorkspace
          accountLabel={workspaceState()?.accountLabel ?? undefined}
          activeWorkspace={workspace()}
          appVersion={appVersion()}
          busy={busy()}
          client={client()!}
          plugins={plugins}
          roomDesigner={props.roomDesigner ?? false}
          session={session()}
          onBeginSignIn={beginSignIn}
          onSignOut={signOut}
          onUpdatesOpenChange={setUpdatesOpen}
          updatesOpen={updatesOpen()}
          virtual={props.virtual}
          virtualProps={props.virtualProps}
          workspaces={workspaceState()?.workspaces ?? []}
        />
      )}
    </Show>
  )
}

function DesktopWorkspace(props: {
  accountLabel?: string
  activeWorkspace: WorkspaceSummary
  appVersion: string
  busy: boolean
  client: AgentHqApiClient
  plugins: ReturnType<typeof createDeferredPluginsProvider>
  roomDesigner: boolean
  session: DesktopSession | undefined
  onBeginSignIn: () => Promise<void>
  onSignOut: () => Promise<void>
  onUpdatesOpenChange: (open: boolean) => void
  updatesOpen: boolean
  virtual: boolean
  virtualProps: WorkspaceShellProps
  workspaces: readonly WorkspaceSummary[]
}) {
  const signedIn = () => Boolean(props.session)
  const accountLabel = () => (signedIn() ? (props.accountLabel ?? 'Account') : 'Not signed in')
  // Invariant services are built once: rebuilding the object per evaluation
  // would also rebuild the dev runtime service on every busy/version update.
  const devRuntime = createDesktopDevRuntimeService()
  const services = (): WorkspacePlatformServices => ({
    account: {
      authenticated: signedIn(),
      busy: props.busy,
      label: accountLabel(),
      onSignIn: () => void props.onBeginSignIn(),
      onSignOut: () => void props.onSignOut(),
    },
    app: { name: 'Adea', platform: 'desktop', version: props.appVersion },
    capabilities: desktopCapabilityProvider,
    client: props.client,
    devRuntime,
    privateContent: localContentAuthority,
    plugins: props.plugins,
    settings: desktopSettingsProvider,
    transcription: systemTranscriptionProvider,
  })

  return (
    <WorkspaceNavigation
      account={{
        authenticated: signedIn(),
        busy: props.busy,
        label: accountLabel(),
        onOpenUpdates: () => props.onUpdatesOpenChange(true),
        onSignIn: () => void props.onBeginSignIn(),
        onSignOut: () => void props.onSignOut(),
      }}
      activeWorkspace={props.activeWorkspace}
      chatEntry={(fallback) => (
        <DesktopFirstRunChat
          client={props.client}
          fallback={fallback}
          onOpenDev={() => {
            const nextUrl = new URL(window.location.href)
            nextUrl.searchParams.set('view', 'dev')
            window.history.replaceState(null, '', nextUrl)
            window.dispatchEvent(new PopStateEvent('popstate'))
          }}
          runtime={devRuntime}
          onSignIn={props.onBeginSignIn}
          temporary={!signedIn()}
          workspaceId={props.activeWorkspace.id}
        />
      )}
      client={props.client}
      onAuthorizeWorkspace={(workspaceId) => localContentAuthority.authorizeWorkspace(workspaceId)}
      platform="desktop"
      roomDesigner={props.roomDesigner}
      services={services()}
      updates={{ open: props.updatesOpen, onOpenChange: props.onUpdatesOpenChange }}
      virtual={props.virtual}
      virtualProps={props.virtualProps}
      workspaces={props.workspaces}
    />
  )
}

function DesktopStartSurface(props: {
  busy: boolean
  message: string
  onRetry(): void
  onSignIn(): void
  showSignIn: boolean
  status: AppStatus
}) {
  return (
    <main class="auth-shell">
      <section class="auth-panel" aria-labelledby="desktop-title" aria-busy={props.busy}>
        <p class="auth-eyebrow">Adea desktop</p>
        <h1 class="auth-title" id="desktop-title">
          Your workspace, ready when you are.
        </h1>
        <p class="auth-introduction">
          Start immediately without an account. Sign in later to keep this workspace across devices.
        </p>

        <div class="auth-status" role="status" aria-live="polite">
          <span
            class={`auth-status__mark auth-status__mark--${statusMark[props.status]}`}
            aria-hidden="true"
          />
          <p>{props.message}</p>
        </div>

        <div class="auth-actions">
          <Show when={props.status === 'offline' || props.status === 'failed'}>
            <button type="button" class="auth-action" onClick={() => props.onRetry()}>
              Try again
            </button>
            <Show when={props.showSignIn}>
              <button
                type="button"
                class="auth-action auth-action-secondary"
                onClick={() => props.onSignIn()}
              >
                Sign in
              </button>
            </Show>
          </Show>
        </div>

        <p class="auth-note">
          Guest access is protected by a device-only keychain credential. Optional sign-in uses
          PKCE; no session token is placed in the browser callback URL.
        </p>
      </section>
    </main>
  )
}
