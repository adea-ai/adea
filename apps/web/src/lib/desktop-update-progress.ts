// Believable download movement for the version dialog's progress bar.
//
// The shell's real downloads finish too fast to stream visible progress: the
// install invocation answers only when the whole download-verify-apply flow
// has completed, so the bar sat at its indeterminate start for the entire
// (short) operation and then jumped to done. While an install is in flight
// this wrapper answers status polls with a time-driven curve instead —
// monotonic, ease-out, capped below completion — and defers to the updater's
// own bytes the moment real streaming progress arrives and overtakes the
// curve, so genuine progress is never hidden or regressed.

import type { DesktopUpdate } from './desktop-update'

/** The updater surface this wraps: the three version-dialog calls. */
export type DesktopUpdateSurface = Readonly<{
  check(): Promise<DesktopUpdate>
  getStatus(): Promise<DesktopUpdate>
  install(expectedVersion: string): Promise<DesktopUpdate>
}>

/** Synthetic payloads pose as a ~48 MB archive, the ballpark of a full
 * desktop update; the unit matches the dialog's byte formatting. */
export const SYNTHETIC_DOWNLOAD_TOTAL_BYTES = 48 * 1024 * 1024

/** The curve reaches its cap in about this long, then creeps — long enough
 * to look like a real download, short enough to never outlast one. */
export const SYNTHETIC_DOWNLOAD_DURATION_MS = 24_000

/** The synthetic curve never reports completion on its own; the final jump
 * belongs to the updater's answer. */
export const SYNTHETIC_DOWNLOAD_CAP = 0.92

function easeOutCubic(t: number): number {
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t
  return 1 - (1 - clamped) ** 3
}

export function withSyntheticDownloadProgress(
  updater: DesktopUpdateSurface,
  options?: {
    now?: () => number
    durationMs?: number
    totalBytes?: number
    cap?: number
  }
): DesktopUpdateSurface {
  const now = options?.now ?? (() => Date.now())
  const durationMs = options?.durationMs ?? SYNTHETIC_DOWNLOAD_DURATION_MS
  const totalBytes = options?.totalBytes ?? SYNTHETIC_DOWNLOAD_TOTAL_BYTES
  const cap = options?.cap ?? SYNTHETIC_DOWNLOAD_CAP
  // Fraction of `totalBytes` already shown for the live install. Only ever
  // increases: neither the curve nor a switch to real bytes may move the bar
  // backwards.
  let installStartedAt: number | null = null
  let shownFraction = 0

  const syntheticFraction = () => {
    if (installStartedAt === null) return 0
    const elapsed = now() - installStartedAt
    return Math.min(cap, easeOutCubic(elapsed / durationMs) * cap)
  }

  return {
    check: () => updater.check(),
    install: async (expectedVersion) => {
      installStartedAt = now()
      shownFraction = 0
      try {
        return await updater.install(expectedVersion)
      } finally {
        installStartedAt = null
      }
    },
    getStatus: async () => {
      const status = await updater.getStatus()
      if (installStartedAt === null || status.phase !== 'downloading') return status
      const total = status.total_bytes
      const realFraction =
        total && total > 0 && status.downloaded_bytes > 0 ? status.downloaded_bytes / total : 0
      // Real progress is authoritative once the updater streams actual bytes
      // that reach the shown fraction; before that (a zeroed download or real
      // bytes still behind the curve) they would only drag the bar backwards.
      if (realFraction > 0 && realFraction >= shownFraction) {
        shownFraction = realFraction
        return status
      }
      shownFraction = Math.max(shownFraction, syntheticFraction())
      return {
        ...status,
        downloaded_bytes: Math.round(shownFraction * totalBytes),
        total_bytes: totalBytes,
      }
    },
  }
}
