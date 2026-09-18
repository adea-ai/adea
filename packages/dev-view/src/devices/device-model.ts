// Pure devices-pane model: inventory grouping and typed capability
// guidance. Kept component-free so decoder/reducer tests can import it in
// any condition (Orca availability strings, MIT, revision
// 403b62a8d8fa6e896a93acc4c15405be0f0b7dc7).
import type { DeviceInventoryItem } from '@adea-ai/types/dev-runtime'

export type DeviceInventoryGroup = Readonly<{
  platform: 'responsive' | 'ios' | 'android'
  label: string
  /** Typed guidance when the toolchain is missing; the list stays visible. */
  guidance?: string
  items: readonly DeviceInventoryItem[]
}>

export const IOS_CAPABILITY_GUIDANCE =
  'Xcode Simulator tools are unavailable. Install full Xcode, open it once, then select it with `sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer`.'
export const ANDROID_CAPABILITY_GUIDANCE =
  'Android SDK not found. Install Android Studio and set ANDROID_HOME.'

/**
 * Groups the verified inventory for display. Responsive ships first and
 * always works; iOS/Android render unavailable guidance truthfully when
 * their toolchains are absent (an empty list is never shown as "no devices").
 */
export function groupDeviceInventory(
  items: readonly DeviceInventoryItem[],
  availability: Readonly<{ ios: boolean; android: boolean }>
): readonly DeviceInventoryGroup[] {
  const ios = items.filter((item) => item.kind === 'ios_simulator' || item.kind === 'physical')
  const android = items.filter((item) => item.kind === 'android_emulator')
  return [
    {
      platform: 'responsive',
      label: 'Responsive',
      items: [],
    },
    {
      platform: 'ios',
      label: 'iOS simulators',
      ...(ios.length === 0 && !availability.ios ? { guidance: IOS_CAPABILITY_GUIDANCE } : {}),
      items: ios,
    },
    {
      platform: 'android',
      label: 'Android devices',
      ...(android.length === 0 && !availability.android
        ? { guidance: ANDROID_CAPABILITY_GUIDANCE }
        : {}),
      items: android,
    },
  ]
}
