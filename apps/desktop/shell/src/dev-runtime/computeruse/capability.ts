// Computer-use capability probing (issues #472/#624). Every capability row is
// measured, never asserted: input derives from the #471 accessibility probe,
// capture mirrors the #471 screen-recording preflight (granted is available;
// anything less refuses with the probed state — issue #624), and
// accessibility-tree reading reports typed `capability_unavailable` naming the
// exact missing piece, because this lane has no authorized AX bridge (donor
// semantics: Orca's PermissionStatusSnapshot +
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
  'the screen-recording preflight could not answer on this host, so capture ' +
  'cannot be proven; capture refuses closed instead of guessing'

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

/**
 * The capture row mirrors the screen-recording preflight exactly: granted
 * proves available; denied and not_determined ride through as the probed
 * state; a missing, unprobeable, or non-answering row is typed-unavailable
 * naming the exact missing piece — never a stand-in for a probed state
 * (issue #624).
 */
function captureRow(snapshot: MacPermissionsSnapshot): ComputerUseCapabilityRow {
  const probedAt = snapshot.probedAt
  if (snapshot.hostPlatform !== 'macos') {
    return {
      id: 'capture',
      state: 'unavailable',
      unavailableReason: 'unsupported_platform',
      probedAt,
    }
  }
  const screenRecording = snapshot.permissions.find((entry) => entry.id === 'screen_recording')
  if (!screenRecording) {
    return {
      id: 'capture',
      state: 'unavailable',
      unavailableReason: 'capability_unavailable',
      missingPiece: 'the screen-recording permission row is missing from the probe snapshot',
      permissionId: 'screen_recording',
      probedAt,
    }
  }
  if (screenRecording.state === 'granted')
    return { id: 'capture', state: 'available', permissionId: 'screen_recording', probedAt }
  if (screenRecording.state === 'denied')
    return { id: 'capture', state: 'denied', permissionId: 'screen_recording', probedAt }
  if (screenRecording.state === 'not_determined')
    return { id: 'capture', state: 'not_determined', permissionId: 'screen_recording', probedAt }
  return {
    id: 'capture',
    state: 'unavailable',
    unavailableReason: screenRecording.unavailableReason ?? 'capability_unavailable',
    missingPiece: CAPTURE_MISSING_PIECE,
    permissionId: 'screen_recording',
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
        captureRow(snapshot),
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
