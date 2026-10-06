/*
 * Copyright (c) 2026 T3 Tools Inc.
 * Licensed under the MIT License.
 *
 * Mini-preview source sizing, transcribed from t3code
 * apps/web/src/components/preview/previewMiniPlayerLayout.ts (MIT), revision
 * 77bca8b2d76a1f42552e5eee7d277fcb1160347a. The shared FloatingPreview owns
 * the floating-player geometry (fit, clamp, resize); only the device source
 * size remains here. See NOTICE and docs/research/dev-view-donor-audit.md.
 */

export interface PreviewMiniPlayerSize {
  readonly width: number
  readonly height: number
}

export type DeviceScreenOrientation = 'portrait' | 'landscape_left' | 'landscape_right'
export interface DeviceScreenSize {
  readonly width: number
  readonly height: number
  readonly orientation: DeviceScreenOrientation
}
export type DevicePlatform = 'ios' | 'android'

/**
 * The device screen as the user sees it, so a rotated phone floats as a
 * landscape box. Before the stream reports its size the platform's usual
 * phone shape stands in.
 */
export function resolveDeviceMiniPlayerSourceSize(
  platform: DevicePlatform,
  screen: DeviceScreenSize | null
): PreviewMiniPlayerSize {
  if (!screen) {
    const width = 1_000
    return { width, height: width / (platform === 'ios' ? 9 / 19.5 : 9 / 20) }
  }
  const landscape =
    screen.orientation === 'landscape_left' || screen.orientation === 'landscape_right'
  const long = Math.max(screen.width, screen.height)
  const short = Math.min(screen.width, screen.height)
  return landscape ? { width: long, height: short } : { width: short, height: long }
}
