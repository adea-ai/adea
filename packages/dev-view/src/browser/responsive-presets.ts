/*
 * Responsive emulation presets. Preset shape and the mobile user-agent
 * derivation follow Orca's browser-manager-viewport/browser-viewport-user-agent
 * units (MIT, revision 403b62a8d8fa6e896a93acc4c15405be0f0b7dc7): a mobile
 * preset must carry matching client hints or UA-sniffing sites flag the
 * desktop-hint leak. Presets are always available (Dev Runtime spec).
 */

export type ResponsivePresetId =
  | 'responsive'
  | 'iphone_15_pro'
  | 'pixel_8'
  | 'ipad_mini'
  | 'galaxy_tab_s9'
  | 'desktop_1080p'

export type ResponsiveOrientation = 'portrait' | 'landscape'

export type ResponsivePreset = Readonly<{
  id: ResponsivePresetId
  label: string
  kind: 'responsive' | 'ios_simulator' | 'android_emulator' | 'desktop'
  width: number
  height: number
  deviceScaleFactor: number
  mobile: boolean
  /** Portrait dimensions are width<height; landscape swaps them. */
  defaultOrientation: ResponsiveOrientation
}>

export const RESPONSIVE_PRESETS: readonly ResponsivePreset[] = Object.freeze([
  {
    id: 'responsive',
    label: 'Responsive',
    kind: 'responsive',
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    defaultOrientation: 'portrait',
  },
  {
    id: 'iphone_15_pro',
    label: 'iPhone 15 Pro',
    kind: 'ios_simulator',
    width: 393,
    height: 852,
    deviceScaleFactor: 3,
    mobile: true,
    defaultOrientation: 'portrait',
  },
  {
    id: 'pixel_8',
    label: 'Pixel 8',
    kind: 'android_emulator',
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
    defaultOrientation: 'portrait',
  },
  {
    id: 'ipad_mini',
    label: 'iPad Mini',
    kind: 'ios_simulator',
    width: 744,
    height: 1133,
    deviceScaleFactor: 2,
    mobile: true,
    defaultOrientation: 'portrait',
  },
  {
    id: 'galaxy_tab_s9',
    label: 'Galaxy Tab S9',
    kind: 'android_emulator',
    width: 800,
    height: 1280,
    deviceScaleFactor: 2.25,
    mobile: true,
    defaultOrientation: 'portrait',
  },
  {
    id: 'desktop_1080p',
    label: 'Desktop 1080p',
    kind: 'desktop',
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
    defaultOrientation: 'landscape',
  },
])

export function presetById(id: ResponsivePresetId): ResponsivePreset {
  const preset = RESPONSIVE_PRESETS.find((entry) => entry.id === id)
  if (!preset) throw new Error(`unknown responsive preset ${id}`)
  return preset
}

/** Resolves the viewport a preset produces at the chosen orientation. */
export function resolvePresetViewport(
  preset: ResponsivePreset,
  orientation: ResponsiveOrientation = preset.defaultOrientation
): Readonly<{
  width: number
  height: number
  deviceScaleFactor: number
  mobile: boolean
  rotated: boolean
}> {
  const rotated = orientation !== preset.defaultOrientation
  return {
    width: rotated ? preset.height : preset.width,
    height: rotated ? preset.width : preset.height,
    deviceScaleFactor: preset.deviceScaleFactor,
    mobile: preset.mobile,
    rotated,
  }
}

/**
 * The mobile user-agent override for an emulated device. A mobile UA must be
 * accompanied by matching client-hint metadata (Orca: "userAgentMetadata must
 * accompany the mobile UA so client hints match, or bot-detection flags the
 * desktop-hint leak"). The Chrome major comes from the lane's own UA so the
 * emulated device never travels with a foreign engine version.
 */
export function buildMobileUserAgentOverride(
  baseUserAgent: string,
  chromeMajorHint?: string
): Readonly<{
  userAgent: string
  userAgentMetadata: {
    brands: { brand: string; version: string }[]
    fullVersionList: { brand: string; version: string }[]
    fullVersion: string
    platform: string
    platformVersion: string
    architecture: string
    model: string
    mobile: boolean
  }
}> {
  const match = baseUserAgent.match(/Chrome\/(\d+)/)
  const major = match?.[1] ?? chromeMajorHint ?? '134'
  return {
    userAgent: `Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/${major}.0.0.0 Mobile/15E148 Safari/604.1`,
    userAgentMetadata: {
      brands: [
        { brand: 'Google Chrome', version: major },
        { brand: 'Chromium', version: major },
        { brand: 'Not/A)Brand', version: '24' },
      ],
      fullVersionList: [
        { brand: 'Google Chrome', version: `${major}.0.0.0` },
        { brand: 'Chromium', version: `${major}.0.0.0` },
        { brand: 'Not/A)Brand', version: '24.0.0.0' },
      ],
      fullVersion: `${major}.0.0.0`,
      platform: 'iOS',
      platformVersion: '17.0',
      architecture: '',
      model: 'iPhone',
      mobile: true,
    },
  }
}
