import 'server-only'

import {
  createAuthServer,
  handleAuthProxyRequest,
  resolveNeonAuthLogging,
  type NeonAuthServer,
  type RequestContextFactory,
} from '@neondatabase/auth/server'

import { createAuthAdapter } from './adapter'
import { readAuthConfig, type AuthEnvironment } from './config'
import { createNeonAuthDriver, type NeonSdk } from './neon-driver'
import { assertTrustedOrigin } from './security'

type RouteMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT'

let cachedAuth: NeonAuthServer | undefined
let cachedAuthContext: RequestContextFactory | undefined
let cachedConfig: ReturnType<typeof readAuthConfig> | undefined

function config(environment: AuthEnvironment) {
  cachedConfig ??= readAuthConfig(environment)
  return cachedConfig
}

// Provider payloads and transport errors may contain PII or cookies. Adea
// emits only its own allowlisted auth events through createAuthEvent().
const silentLog = () => resolveNeonAuthLogging({ logLevel: 'silent' })

export function createNeonServerAdapter(
  context: RequestContextFactory,
  environment: AuthEnvironment = process.env
) {
  if (!cachedAuth || cachedAuthContext !== context) {
    cachedAuthContext = context
    cachedAuth = createAuthServer({
      baseUrl: config(environment).baseUrl,
      context,
      cookieSecret: config(environment).cookieSecret,
      sessionDataTtl: config(environment).sessionDataTtl,
      sameSite: 'lax',
      log: silentLog(),
    })
  }
  return createAuthAdapter(createNeonAuthDriver(cachedAuth as unknown as NeonSdk))
}

export async function handleNeonAuthRequest(
  method: RouteMethod,
  request: Request,
  path: string,
  environment: AuthEnvironment = process.env
): Promise<Response> {
  const settings = config(environment)
  const origin = request.headers.get('origin') ?? undefined

  // OAuth callbacks are top-level GET navigations and normally omit Origin. Every request that
  // supplies Origin, and every state-changing request, must match an exact allowlist entry.
  if (origin || method !== 'GET') {
    try {
      assertTrustedOrigin(origin, settings.trustedOrigins)
    } catch {
      return Response.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  // The proxy is a plain Request -> Response pipe; it never consults the
  // host framework's request context, so no factory is involved here.
  return handleAuthProxyRequest({
    request,
    path,
    baseUrl: settings.baseUrl,
    cookieSecret: settings.cookieSecret,
    sessionDataTtl: settings.sessionDataTtl,
    sameSite: 'lax',
    log: silentLog(),
  })
}

export { readAuthConfig } from './config'
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
