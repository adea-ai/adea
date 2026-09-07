import 'server-only'

import {
  consumeDesktopAuthorizationCode,
  createUserWithAuthIdentity,
  createDesktopSessionRecord,
  findUserPrincipalsByAuthIdentity,
  revokeDesktopSessionRecord,
  resolveDesktopSessionRecord,
  rotateDesktopSessionRecord,
  saveDesktopAuthorizationCode,
  setUserDisplayNameIfMissing,
} from '@adea-ai/db'
import {
  createDesktopAuthorizationCodeBroker,
  createDesktopSessionService,
  desktopCorsHeaders,
  parseDesktopExchangeRequest,
  parseDesktopSessionRequest,
  type DesktopAuthorizationCodeStore,
  type DesktopSessionStore,
} from '@adea-ai/auth/server'

import { applicationDatabase } from './database'
import { desktopTrustedOrigins } from './desktop-workspace'

export { desktopTrustedOrigins } from './desktop-workspace'

function codeStore(): DesktopAuthorizationCodeStore {
  return {
    consume: (codeDigest) => consumeDesktopAuthorizationCode(applicationDatabase(), codeDigest),
    save: (record) => saveDesktopAuthorizationCode(applicationDatabase(), record),
  }
}

function sessionStore(): DesktopSessionStore {
  return {
    create: (record) => createDesktopSessionRecord(applicationDatabase(), record),
    revoke: (input) => revokeDesktopSessionRecord(applicationDatabase(), input),
    resolve: (input) => resolveDesktopSessionRecord(applicationDatabase(), input),
    rotate: (input) => rotateDesktopSessionRecord(applicationDatabase(), input),
  }
}

export function desktopSessionService() {
  return createDesktopSessionService({ store: sessionStore() })
}

export async function resolveDesktopSessionPrincipal(request: Request) {
  const credential = parseDesktopSessionRequest(request, desktopTrustedOrigins())
  const principal = await desktopSessionService().resolve(credential)
  return principal ? Object.freeze({ kind: 'user' as const, userId: principal.userId }) : null
}

export function desktopAuthorizationBroker() {
  const sessions = desktopSessionService()
  return createDesktopAuthorizationCodeBroker({
    issueSession: sessions.issue,
    store: codeStore(),
  })
}

export function desktopPrincipalMapping() {
  return {
    findUserPrincipals: (identity: Readonly<{ provider: string; subject: string }>) =>
      findUserPrincipalsByAuthIdentity(applicationDatabase(), identity),
    provision: (input: Parameters<typeof createUserWithAuthIdentity>[1]) =>
      createUserWithAuthIdentity(applicationDatabase(), input),
    setDisplayNameIfMissing: (input: Readonly<{ displayName: string; userId: string }>) =>
      setUserDisplayNameIfMissing(applicationDatabase(), input),
  }
}

export function desktopCorsPreflight(request: Request) {
  const origin = request.headers.get('origin') ?? ''
  if (!desktopTrustedOrigins().includes(origin)) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-headers': 'Authorization, Content-Type, X-Adea-Desktop-Session',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-origin': origin,
      'access-control-max-age': '600',
      vary: 'Origin',
    },
  })
}

export async function desktopExchangeResponse(request: Request) {
  const origin = request.headers.get('origin') ?? ''
  const trustedOrigins = desktopTrustedOrigins()
  try {
    const exchange = await parseDesktopExchangeRequest(request, trustedOrigins)
    const session = await desktopAuthorizationBroker().exchange(exchange)
    return Response.json(session, { headers: desktopCorsHeaders(origin, trustedOrigins) })
  } catch {
    return Response.json(
      { error: 'Desktop authorization exchange failed' },
      { headers: desktopCorsHeaders(origin, trustedOrigins), status: 400 }
    )
  }
}

export async function desktopSessionResponse(
  request: Request,
  action: 'logout' | 'refresh' | 'revoke'
) {
  const origin = request.headers.get('origin') ?? ''
  const trustedOrigins = desktopTrustedOrigins()
  try {
    const credential = parseDesktopSessionRequest(request, trustedOrigins)
    const service = desktopSessionService()
    if (action === 'refresh') {
      const session = await service.refresh(credential)
      return Response.json(session, { headers: desktopCorsHeaders(origin, trustedOrigins) })
    }
    await service[action](credential)
    return new Response(null, {
      headers: desktopCorsHeaders(origin, trustedOrigins),
      status: 204,
    })
  } catch {
    return Response.json(
      { error: 'Desktop session is unavailable' },
      { headers: desktopCorsHeaders(origin, trustedOrigins), status: 401 }
    )
  }
}
