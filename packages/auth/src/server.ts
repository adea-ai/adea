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
import { readBetterAuthConfig, type AuthEnvironment, type BetterAuthConfig } from './config'
import { createUnconfiguredDelivery, type AuthDelivery } from './delivery'

type RouteMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT'

/**
 * A self-hosted Better Auth service plus the teardown that releases its
 * database connection.
 */
export type BetterAuthService = Readonly<{
  auth: BetterAuthInstance
  close(): Promise<void>
  config: BetterAuthConfig
}>

export type AuthServiceConsumer = Readonly<{
  /**
   * Registers the service teardown with the caller's request scope so a Worker
   * releases its database socket when the request ends. Without it the caller
   * owns `close()`.
   */
  registerCleanup?: (close: () => Promise<void>) => void
  /**
   * The verification and password-reset transport for this request. Omitted, the
   * service uses the fail-closed default, which rejects every message.
   */
  delivery?: AuthDelivery
}>

/**
 * Builds a fresh, request-owned self-hosted Better Auth service for the
 * configured Railway PostgreSQL instance. Nothing is cached at module scope: a
 * Cloudflare Worker isolate serves many requests, and a process-global
 * connection would leak one request's socket into another. The caller closes
 * the returned service (or registers `close` with its request scope).
 */
export function createBetterAuthService(
  environment: AuthEnvironment = process.env,
  delivery: AuthDelivery = createUnconfiguredDelivery()
): BetterAuthService {
  const settings = readBetterAuthConfig(environment)
  // `readBetterAuthConfig` verifies the URL opts into TLS for hosted databases.
  // Keep its SSL query parameters intact so `pg` applies that exact policy.
  const database = createPostgresAuthDatabase(settings.databaseUrl)
  return {
    auth: createBetterAuthServer({ config: settings, database: database.database, delivery }),
    close: database.close,
    config: settings,
  }
}

/**
 * The server-side auth adapter the application calls. The implementation uses
 * the self-hosted Better Auth service. Pass a
 * `consumer.registerCleanup` (for example the app's `registerRequestCleanup`)
 * so the request-owned connection is released with the request.
 */
export function createAuthServerAdapter(
  context: AuthRequestContextFactory,
  environment: AuthEnvironment = process.env,
  consumer: AuthServiceConsumer = {}
): AuthAdapter {
  const service = createBetterAuthService(environment, consumer.delivery)
  consumer.registerCleanup?.(service.close)
  return createBetterAuthContextAdapter(service.auth, context)
}

export async function handleAuthRequest(
  method: RouteMethod,
  request: Request,
  _path?: string,
  environment: AuthEnvironment = process.env,
  consumer: AuthServiceConsumer = {}
): Promise<Response> {
  const service = createBetterAuthService(environment, consumer.delivery)
  try {
    return await handleBetterAuthRequest(service.auth, method, request, service.config)
  } finally {
    await service.close()
  }
}

export { createAuthAdapter, type AuthAdapter } from './adapter'
export { createBetterAuthDriver, type BetterAuthServerApi } from './better-auth-driver'
export {
  createBetterAuthServerAdapter,
  createBetterAuthContextAdapter,
  type AuthRequestContext,
  type AuthRequestContextFactory,
  type BetterAuthInstance,
} from './better-auth-server'
export { readBetterAuthConfig, type AuthEnvironment, type BetterAuthConfig } from './config'
export {
  AuthDeliveryUnavailableError,
  createRecordingAuthDelivery,
  createUnconfiguredDelivery,
  type AuthDelivery,
  type AuthDeliveryMessage,
} from './delivery'
export { normalizeProviderSession } from './session'
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
export {
  AuthDeliveryFailedError,
  AuthDeliveryRejectedError,
  createServerAuthDelivery,
  type AuthMessageKind,
  type AuthMessageTransport,
  type ServerAuthDeliveryOptions,
} from './delivery-server'
