import { createSimApi } from './sim-http'
import { desktopTrustedOrigins, withDesktopWorkspaceCors } from './desktop-workspace'

/**
 * Production stays closed until an approved entitlement authority and durable
 * code/session stores are supplied. A configured hostname alone grants nothing.
 * The local acceptance service composes the same HTTP boundary with explicit fixtures.
 */
function api(request: Request) {
  return createSimApi({
    frameOrigin: process.env.ADEA_SIM_ORIGIN,
    trustedHostOrigins: [new URL(request.url).origin, ...desktopTrustedOrigins()],
  })
}

export function simConfiguration(request: Request) {
  return withDesktopWorkspaceCors(api(request).configuration(), request)
}

export async function simLaunch(request: Request) {
  return withDesktopWorkspaceCors(await api(request).launch(request), request)
}
