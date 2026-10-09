import { desktopTrustedOrigins, trustedDesktopWorkspaceRequest } from './desktop-workspace'

export function parseWorkspaceDeletion(
  value: unknown
): Readonly<{ confirmationName: string; expectedVersion: number }> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { confirmationName, expectedVersion, phase } = value as Record<string, unknown>
  if (
    (phase !== undefined && phase !== 'prepare') ||
    typeof confirmationName !== 'string' ||
    confirmationName.length < 1 ||
    confirmationName.length > 80 ||
    typeof expectedVersion !== 'number' ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1
  )
    return null
  return { confirmationName, expectedVersion }
}

/** Cookie-authenticated destructive requests also check the browser's origin. */
export function workspaceDeletionOriginAllowed(request: Request): boolean {
  if (trustedDesktopWorkspaceRequest(request, desktopTrustedOrigins())) return true
  const origin = request.headers.get('origin')
  return (
    request.headers.get('sec-fetch-site') !== 'cross-site' &&
    (!origin || origin === new URL(request.url).origin)
  )
}
