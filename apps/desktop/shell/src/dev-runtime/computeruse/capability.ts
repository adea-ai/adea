// Computer-use capability probing (issue #472). Every capability row is
// measured, never asserted: input derives from the #471 accessibility probe,
// and capture / accessibility-tree reading report typed
// `capability_unavailable` naming the exact missing piece, because this lane
// deliberately has no native screen-recording helper and no authorized AX
// bridge yet (donor semantics: Orca's PermissionStatusSnapshot +
// ScreenCapturePermissionPreflightSafety "refuse closed unless proven" rule,
// MIT, revision 403b62a8d8fa6e896a93acc4c15405be0f0b7dc7, translated to the
// Bun lane; see NOTICE and docs/research/dev-view-donor-audit.md).
import { createHash } from 'node:crypto'

import type {
  ComputerUseCapabilityReport,
  ComputerUseCapabilityRow,
} from '../../../../../../packages/types/src/dev-runtime'
import type { MacPermissionsSnapshot } from '../../../../../../packages/types/src/desktop-permissions'
import type { MacPermissionService } from '../../desktop-permissions'

export const INPUT_MISSING_PIECE_UNPROBEABLE =
  'the accessibility permission cannot be probed on this host, so input cannot be proven'

export const CAPTURE_MISSING_PIECE =
  'no command-line probe or native helper exists for the screen-recording TCC ' +
  'service in this lane; the native capture helper is deferred, so capture ' +
  'refuses closed instead of guessing'

export const AX_TREE_MISSING_PIECE =
  'no authorized accessibility-tree bridge exists in this lane; reading the AX ' +
  'tree stays typed-unavailable until one lands'

export type ComputerUseCapabilityService = Readonly<{
  /** Builds the capability report from a (fresh) #471 permission snapshot. */
  report(options?: Readonly<{ force?: boolean }>): Promise<ComputerUseCapabilityReport>
  /** Stable digest over the permission states a consent record binds to. */
  permissionDigest(snapshot: MacPermissionsSnapshot): string
}>

function accessibilityRow(
  snapshot: MacPermissionsSnapshot,
  hostProvidesInputTool: boolean
): ComputerUseCapabilityRow {
  const probedAt = snapshot.probedAt
  if (snapshot.hostPlatform !== 'macos') {
    return {
      id: 'input',
      state: 'unavailable',
      unavailableReason: 'unsupported_platform',
      probedAt,
    }
  }
  const accessibility = snapshot.permissions.find((entry) => entry.id === 'accessibility')
  if (!accessibility) {
    return {
      id: 'input',
      state: 'unavailable',
      unavailableReason: 'capability_unavailable',
      missingPiece: 'the accessibility permission row is missing from the probe snapshot',
      permissionId: 'accessibility',
      probedAt,
    }
  }
  if (accessibility.state === 'granted' && !hostProvidesInputTool) {
    return {
      id: 'input',
      state: 'unavailable',
      unavailableReason: 'capability_unavailable',
      missingPiece: 'the host input tool is missing',
      permissionId: 'accessibility',
      probedAt,
    }
  }
  if (accessibility.state === 'granted')
    return { id: 'input', state: 'available', permissionId: 'accessibility', probedAt }
  if (accessibility.state === 'denied')
    return { id: 'input', state: 'denied', permissionId: 'accessibility', probedAt }
  if (accessibility.state === 'not_determined')
    return { id: 'input', state: 'not_determined', permissionId: 'accessibility', probedAt }
  return {
    id: 'input',
    state: 'unavailable',
    unavailableReason: accessibility.unavailableReason ?? 'capability_unavailable',
    missingPiece: INPUT_MISSING_PIECE_UNPROBEABLE,
    permissionId: 'accessibility',
    probedAt,
  }
}

export function createComputerUseCapabilityService(input: {
  /** The #471 shell permission authority; this lane only consumes it. */
  permissions: MacPermissionService
  platform?: NodeJS.Platform
  /** Injectable host-tool check; defaults to the macOS system osascript. */
  hostProvidesInputTool?: () => boolean
}): ComputerUseCapabilityService {
  const platform = input.platform ?? process.platform
  const hostProvidesInputTool = input.hostProvidesInputTool ?? (() => platform === 'darwin')

  return Object.freeze({
    async report(options) {
      const snapshot = await input.permissions.snapshot(options)
      const capabilities: ComputerUseCapabilityRow[] = [
        accessibilityRow(snapshot, hostProvidesInputTool()),
        {
          id: 'capture',
          state: 'unavailable',
          unavailableReason:
            snapshot.hostPlatform === 'macos' ? 'capability_unavailable' : 'unsupported_platform',
          ...(snapshot.hostPlatform === 'macos' ? { missingPiece: CAPTURE_MISSING_PIECE } : {}),
          probedAt: snapshot.probedAt,
        },
        {
          id: 'ax_tree',
          state: 'unavailable',
          unavailableReason:
            snapshot.hostPlatform === 'macos' ? 'capability_unavailable' : 'unsupported_platform',
          ...(snapshot.hostPlatform === 'macos' ? { missingPiece: AX_TREE_MISSING_PIECE } : {}),
          probedAt: snapshot.probedAt,
        },
      ]
      return {
        hostPlatform: snapshot.hostPlatform,
        capabilities,
        probedAt: snapshot.probedAt,
      } satisfies ComputerUseCapabilityReport
    },

    permissionDigest(snapshot) {
      // The digest binds a consent record to the exact permission states it
      // was minted against (ids + states only — never probe detail text).
      const canonical = snapshot.permissions
        .map((entry) => `${entry.id}=${entry.state}`)
        .toSorted()
        .join('\n')
      return createHash('sha256')
        .update(`adea-computer-use-consent\u0000${canonical}`, 'utf8')
        .digest('hex')
    },
  })
}
