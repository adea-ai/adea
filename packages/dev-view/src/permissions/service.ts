// The permissions page's service port (issue #471). The pane never touches
// the bridge directly: a lane injects a service, and the desktop lane binds
// it to the guarded invoke path (apps/web/src/lib/desktop-permissions.ts).
// A lane with no shell — plain web dev mode — injects the unavailable service
// below, whose snapshot reports typed `capability_unavailable` for every
// permission. There are no fixture states and no fake granted/denied rows in
// any production path.
import type {
  MacPermissionsSnapshot,
  MacPermissionSettingsOpenResult,
} from '@adea-ai/types/desktop-permissions'

import { macPermissionIds } from '@adea-ai/types/desktop-permissions'

export type MacPermissionsPageService = Readonly<{
  snapshot(options?: Readonly<{ force?: boolean }>): Promise<MacPermissionsSnapshot>
  openSettings(permissionId: string): Promise<MacPermissionSettingsOpenResult>
}>

/**
 * The truthful empty service: every permission is `unavailable` because this
 * lane has no way to probe the host. Used by the web lane and as the pane's
 * fallback when a snapshot call fails, so a broken bridge degrades to honest
 * "Cannot check" rows instead of stale or invented statuses.
 */
export function createUnavailableMacPermissionsService(options?: {
  reason?: 'capability_unavailable' | 'unsupported_platform'
  now?: () => string
}): MacPermissionsPageService {
  const now = options?.now ?? (() => new Date().toISOString())
  const unavailable = (): MacPermissionsSnapshot => ({
    hostPlatform: options?.reason === 'unsupported_platform' ? 'other' : 'unknown',
    permissions: macPermissionIds.map((id) => ({
      id,
      state: 'unavailable' as const,
      unavailableReason: options?.reason ?? ('capability_unavailable' as const),
      probedAt: now(),
    })),
    probedAt: now(),
  })
  return Object.freeze({
    snapshot: async () => unavailable(),
    openSettings: async (permissionId) => {
      throw new Error(
        `System Settings cannot be opened from this lane (requested: ${permissionId})`
      )
    },
  })
}
