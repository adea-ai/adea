import { NextResponse } from 'next/server'

import type { WorkspacePrincipalResolution } from './workspace-principal'
import {
  desktopTrustedOrigins,
  trustedDesktopWorkspaceRequest,
  withDesktopWorkspaceCors,
} from './desktop-workspace'
import { TEMPORARY_SESSION_COOKIE } from './temporary-session'

export function workspaceJsonResponse<T>(
  payload: T,
  resolution: WorkspacePrincipalResolution,
  request: Request,
  init?: ResponseInit
) {
  const response = NextResponse.json(payload, init)
  const desktopRequest = trustedDesktopWorkspaceRequest(request, desktopTrustedOrigins())
  if (resolution.createdCredential && resolution.expiresAt && !desktopRequest) {
    response.cookies.set(TEMPORARY_SESSION_COOKIE, resolution.createdCredential, {
      expires: resolution.expiresAt,
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    })
  } else if (resolution.clearTemporaryCredential) {
    response.cookies.delete(TEMPORARY_SESSION_COOKIE)
  }
  return withDesktopWorkspaceCors(response, request)
}

export function workspaceUnavailableResponse(request: Request, status = 404) {
  return withDesktopWorkspaceCors(
    NextResponse.json(
      { code: 'workspace_unavailable', message: 'Workspace unavailable' },
      { status }
    ),
    request
  )
}

export function workspaceInvalidRequestResponse(request: Request) {
  return withDesktopWorkspaceCors(
    NextResponse.json({ code: 'invalid_request', message: 'Invalid request' }, { status: 400 }),
    request
  )
}
