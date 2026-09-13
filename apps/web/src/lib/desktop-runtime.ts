// Desktop runtime wiring for the single web UI. The shell injects the bridge
// and serves this client from loopback; everything below uses only
// browser-safe modules and the shell's command surface. The web lane never
// calls `desktopRuntime()`, so no session machinery is constructed there.
import { createApiClient, type AgentHqApiClient } from '@adea-ai/api-client'
import {
  createDesktopAuthorizationManager,
  createDesktopAuthorizationUrl,
  createDesktopHttpSessionBroker,
  createDesktopSessionManager,
  type DesktopAuthorizationAttempt,
  type DesktopAuthorizationExchange,
  type DesktopSession,
  type DesktopSessionVault,
} from '@adea-ai/auth/desktop'

import { invoke } from './desktop-bridge'

/**
 * The desktop shell's cloud origin. Injected by
 * `apps/web/vite.desktop.config.ts` from `ADEA_DESKTOP_CLOUD_ORIGIN`, which
 * `apps/desktop/scripts/client.mjs` fills from the canonical
 * `apps/desktop/scripts/cloud-config.mjs` value. The web build defines it as an
 * empty string and never reads it.
 */
declare const __ADEA_DESKTOP_CLOUD_ORIGIN__: string

export function desktopCloudOrigin(value = __ADEA_DESKTOP_CLOUD_ORIGIN__): string {
  if (typeof value !== 'string' || !value) {
    throw new Error('Desktop cloud origin is unavailable in this build')
  }
  return value
}

export type DesktopRuntime = Readonly<{
  beginAuthorization(): Promise<DesktopAuthorizationAttempt>
  cancelAuthorization(): Promise<void>
  consumeAuthorization(rawCallbackUrl: string): Promise<DesktopAuthorizationExchange>
  authorizationUrl(attempt: DesktopAuthorizationAttempt): string
  createClient(session?: DesktopSession, temporaryCredential?: string): AgentHqApiClient
  sessionManager: ReturnType<typeof createDesktopSessionManager>
  temporaryVault: Readonly<{
    clear(): Promise<void>
    load(): Promise<string | null>
    save(credential: string): Promise<void>
  }>
  getUserVersion(): Promise<string>
}>

let runtime: DesktopRuntime | undefined

function createDesktopRuntime(cloudOrigin: string): DesktopRuntime {
  const sessionVault: DesktopSessionVault = {
    clear: () => invoke('desktop_user_session_clear'),
    load: () => invoke<DesktopSession | null>('desktop_user_session_load'),
    save: (session) => invoke('desktop_user_session_save', { session }),
  }
  const temporaryVault = Object.freeze({
    clear: () => invoke<void>('desktop_temporary_workspace_clear'),
    load: () => invoke<string | null>('desktop_temporary_workspace_load'),
    save: (credential: string) => invoke<void>('desktop_temporary_workspace_save', { credential }),
  })
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

  function createClient(session?: DesktopSession, temporaryCredential?: string) {
    return createApiClient({
      baseUrl: `${cloudOrigin}/api`,
      client: 'desktop',
      getDesktopSession: session
        ? () => ({ credential: session.credential, sessionId: session.sessionId })
        : undefined,
      getTemporaryCredential: temporaryCredential ? () => temporaryCredential : undefined,
    })
  }

  return Object.freeze({
    beginAuthorization: () => authorizationManager.begin(),
    cancelAuthorization: () => authorizationManager.cancel(),
    consumeAuthorization: (rawCallbackUrl: string) => authorizationManager.consume(rawCallbackUrl),
    authorizationUrl: (attempt: DesktopAuthorizationAttempt) =>
      createDesktopAuthorizationUrl(cloudOrigin, attempt),
    createClient,
    sessionManager,
    temporaryVault,
    getUserVersion: () => invoke<string>('adea_app_version'),
  })
}

/** Memoized desktop runtime. Only valid in the desktop lane. */
export function desktopRuntime(): DesktopRuntime {
  runtime ??= createDesktopRuntime(desktopCloudOrigin())
  return runtime
}

/** Test seam: replace the memoized runtime. */
export function resetDesktopRuntime(): void {
  runtime = undefined
}
