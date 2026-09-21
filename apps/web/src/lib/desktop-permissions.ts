// The desktop shell's macOS permission service, bound to the bridge's guarded
// invoke path (issue #471). Browser-safe by construction: it only resolves
// through the injected `window.__adeaDesktop` bridge, so the web lane never
// constructs it — callers fall back to the typed-unavailable service from
// @adea-ai/dev-view/permissions, which renders honest `capability_unavailable`
// states instead of fixture statuses.
import type {
  MacPermissionsSnapshot,
  MacPermissionSettingsOpenResult,
} from '@adea-ai/types/desktop-permissions'

import { invoke } from './desktop-bridge'

export const desktopMacPermissionsService = Object.freeze({
  snapshot(options?: Readonly<{ force?: boolean }>): Promise<MacPermissionsSnapshot> {
    return invoke<MacPermissionsSnapshot>('desktop_permissions_snapshot', {
      force: options?.force ?? false,
    })
  },
  openSettings(permissionId: string): Promise<MacPermissionSettingsOpenResult> {
    return invoke<MacPermissionSettingsOpenResult>('desktop_permissions_open_settings', {
      permissionId,
    })
  },
})
