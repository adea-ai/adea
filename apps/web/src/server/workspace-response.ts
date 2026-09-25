import type { WorkspacePrincipalResolution } from './workspace-principal'
import {
  desktopTrustedOrigins,
  trustedDesktopWorkspaceRequest,
  withDesktopWorkspaceCors,
} from './desktop-workspace'
import { TEMPORARY_SESSION_COOKIE } from './temporary-session'

function temporarySessionCookie(value: string, expires: Date): string {
  // Mirrors the Set-Cookie serialization Next's response cookies produced for
  // this attribute set: value, Path, Expires, HttpOnly, SameSite, Secure.
  const attributes = [
    `${TEMPORARY_SESSION_COOKIE}=${value}`,
    'Path=/',
    `Expires=${expires.toUTCString()}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(process.env.NODE_ENV === 'production' ? ['Secure'] : []),
  ]
  return attributes.join('; ')
}

function expiredTemporarySessionCookie(): string {
  return [
    `${TEMPORARY_SESSION_COOKIE}=`,
    'Path=/',
    'Max-Age=0',
    `Expires=${new Date(0).toUTCString()}`,
  ].join('; ')
}

function withSessionHeaders(
  response: Response,
  resolution: WorkspacePrincipalResolution,
  request: Request
) {
  const desktopRequest = trustedDesktopWorkspaceRequest(request, desktopTrustedOrigins())
  if (resolution.createdCredential && resolution.expiresAt && !desktopRequest) {
    response.headers.append(
      'set-cookie',
      temporarySessionCookie(resolution.createdCredential, resolution.expiresAt)
    )
  } else if (resolution.clearTemporaryCredential) {
    response.headers.append('set-cookie', expiredTemporarySessionCookie())
  }
  return withDesktopWorkspaceCors(response, request)
}

export function workspaceJsonResponse<T>(
  payload: T,
  resolution: WorkspacePrincipalResolution,
  request: Request,
  init?: ResponseInit
) {
  return withSessionHeaders(Response.json(payload, init), resolution, request)
}

/**
 * Streams an upstream body through untouched instead of parsing and
 * re-serializing it in the worker.
 *
 * The marketplace catalog is tens of megabytes; reading it into a value and
 * encoding it again holds both copies at once, which trips Cloudflare's
 * resource limits and reaches the client as a failed read of an otherwise
 * healthy request. The body is deliberately not inspected here.
 */
export function workspaceStreamResponse(
  upstream: Response,
  resolution: WorkspacePrincipalResolution,
  request: Request,
  init?: ResponseInit
) {
  const headers = new Headers(init?.headers)
  headers.set('content-type', upstream.headers.get('content-type') ?? 'application/json')
  return withSessionHeaders(
    new Response(upstream.body, { status: upstream.status, headers }),
    resolution,
    request
  )
}

export function workspaceUnavailableResponse(request: Request, status = 404) {
  return withDesktopWorkspaceCors(
    Response.json({ code: 'workspace_unavailable', message: 'Workspace unavailable' }, { status }),
    request
  )
}

export function workspaceInvalidRequestResponse(request: Request) {
  return withDesktopWorkspaceCors(
    Response.json({ code: 'invalid_request', message: 'Invalid request' }, { status: 400 }),
    request
  )
}
