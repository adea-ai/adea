import 'server-only'

import type { AuthAdapter } from './adapter'
import {
  createBetterAuthContextAdapter,
  createBetterAuthServer,
  createPostgresAuthDatabase,
  handleBetterAuthRequest,
  type AuthRequestContextFactory,
  type BetterAuthInstance,
} from './better-auth-server'
import { readBetterAuthConfig, type AuthEnvironment } from './config'
import { createUnconfiguredDelivery, type AuthDelivery } from './delivery'

type RouteMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT'

let cachedAuth: BetterAuthInstance | undefined
let cachedConfig: ReturnType<typeof readBetterAuthConfig> | undefined

function config(environment: AuthEnvironment) {
  cachedConfig ??= readBetterAuthConfig(environment)
  return cachedConfig
}

/**
 * Builds (once per process) the self-hosted Better Auth service for the
 * configured Railway PostgreSQL instance. Verification and reset delivery
 * default to the fail-closed transport; a deployment supplies a real one.
 */
export function createBetterAuthService(
  environment: AuthEnvironment = process.env,
  delivery: AuthDelivery = createUnconfiguredDelivery()
): BetterAuthInstance {
  if (!cachedAuth) {
    const settings = config(environment)
    cachedAuth = createBetterAuthServer({
      config: settings,
      database: createPostgresAuthDatabase(settings.databaseUrl),
      delivery,
    })
  }
  return cachedAuth
}

/**
 * The server-side auth adapter the application calls. The name is retained for
 * the existing web and desktop call sites; the implementation is now the
 * self-hosted Better Auth service rather than a hosted Neon Auth SDK.
 */
export function createNeonServerAdapter(
  context: AuthRequestContextFactory,
  environment: AuthEnvironment = process.env
): AuthAdapter {
  return createBetterAuthContextAdapter(createBetterAuthService(environment), context)
}

/** Provider-neutral alias for {@link createNeonServerAdapter}. */
export const createAuthServerAdapter = createNeonServerAdapter

export async function handleNeonAuthRequest(
  method: RouteMethod,
  request: Request,
  _path?: string,
  environment: AuthEnvironment = process.env
): Promise<Response> {
  return handleBetterAuthRequest(
    createBetterAuthService(environment),
    method,
    request,
    config(environment)
  )
}

/** Provider-neutral alias for {@link handleNeonAuthRequest}. */
export const handleAuthRequest = handleNeonAuthRequest

export { createAuthAdapter, type AuthAdapter } from './adapter'
export { createBetterAuthDriver, type BetterAuthServerApi } from './better-auth-driver'
export {
  createBetterAuthServerAdapter,
  createBetterAuthContextAdapter,
  type AuthRequestContext,
  type AuthRequestContextFactory,
  type BetterAuthInstance,
} from './better-auth-server'
export {
  readAuthConfig,
  readBetterAuthConfig,
  type AuthConfig,
  type AuthEnvironment,
  type BetterAuthConfig,
} from './config'
export {
  AuthDeliveryUnavailableError,
  createRecordingAuthDelivery,
  createUnconfiguredDelivery,
  type AuthDelivery,
  type AuthDeliveryMessage,
} from './delivery'
export { normalizeNeonSession, normalizeProviderSession } from './session'
export {
  assertTrustedOrigin,
  createAuthorizationState,
  verifyAuthorizationState,
  type AuthorizationTransaction,
} from './security'
export {
  createDesktopAuthorizationCodeBroker,
  createDesktopSessionService,
  type DesktopAuthorizationCodeIssue,
  type DesktopAuthorizationCodeRecord,
  type DesktopAuthorizationCodeStore,
  type DesktopSessionCredential,
  type DesktopSessionPrincipal,
  type DesktopSessionRecord,
  type DesktopSessionStore,
} from './desktop-server'
export {
  desktopCorsHeaders,
  parseDesktopAuthorizationRequest,
  parseDesktopExchangeRequest,
  parseDesktopSessionRequest,
} from './desktop-http-server'
