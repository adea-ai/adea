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

export function workspaceJsonResponse<T>(
  payload: T,
  resolution: WorkspacePrincipalResolution,
  request: Request,
  init?: ResponseInit
) {
  const response = Response.json(payload, init)
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
