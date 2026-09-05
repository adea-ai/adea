import 'server-only'

import { createNeonAuth, type NeonAuth } from '@neondatabase/auth/next/server'

import { createAuthAdapter } from './adapter'
import { readAuthConfig, type AuthEnvironment } from './config'
import { createNeonAuthDriver, type NeonSdk } from './neon-driver'
import { assertTrustedOrigin } from './security'

type RouteContext = { params: Promise<{ path: string[] }> }
type RouteMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT'

let cachedAuth: NeonAuth | undefined
let cachedConfig: ReturnType<typeof readAuthConfig> | undefined

function server(environment: AuthEnvironment = process.env) {
  if (!cachedAuth || !cachedConfig) {
    cachedConfig = readAuthConfig(environment)
    cachedAuth = createNeonAuth({
      baseUrl: cachedConfig.baseUrl,
      cookies: {
        sameSite: 'lax',
        secret: cachedConfig.cookieSecret,
        sessionDataTtl: cachedConfig.sessionDataTtl,
      },
      // Provider payloads and transport errors may contain PII or cookies. Agent HQ emits
      // only its own allowlisted auth events through createAuthEvent().
      logLevel: 'silent',
    })
  }
  return { auth: cachedAuth, config: cachedConfig }
}

export function createNeonServerAdapter(environment: AuthEnvironment = process.env) {
  const { auth } = server(environment)
  return createAuthAdapter(createNeonAuthDriver(auth as unknown as NeonSdk))
}

export async function handleNeonAuthRequest(
  method: RouteMethod,
  request: Request,
  context: RouteContext,
  environment: AuthEnvironment = process.env
): Promise<Response> {
  const { auth, config } = server(environment)
  const origin = request.headers.get('origin') ?? undefined

  // OAuth callbacks are top-level GET navigations and normally omit Origin. Every request that
  // supplies Origin, and every state-changing request, must match an exact allowlist entry.
  if (origin || method !== 'GET') {
    try {
      assertTrustedOrigin(origin, config.trustedOrigins)
    } catch {
      return Response.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  const handlers = auth.handler()
  return handlers[method](request, context)
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
