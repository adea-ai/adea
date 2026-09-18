// Capability-gated device inventory and the fixed argv templates. iOS uses
// `xcrun simctl`; Android uses
// `adb`/`emulator` with fixed argv templates and verified inventory IDs
// (Dev Runtime spec, "Browser and device lanes"). Parsing fixtures and
// guidance strings follow Orca's emulator backends (MIT, revision
// 403b62a8d8fa6e896a93acc4c15405be0f0b7dc7). Missing tooling is a typed,
// actionable unavailable state — never a silent empty list.

import type { DeviceGesture } from '../../../../../../packages/types/src/dev-runtime'

export class DeviceSessionError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'DeviceSessionError'
    this.code = code
  }
}

/** Fixed argv for the iOS inventory probe, run via `xcrun`. */
export const SIMCTL_LIST_ARGV: readonly string[] = ['simctl', 'list', 'devices', '-j']
export const XCRUN_VERSION_ARGV: readonly string[] = ['--version']
/** Fixed argv for the Android inventory probes. */
export const ADB_DEVICES_ARGV: readonly string[] = ['devices', '-l']
export const EMULATOR_LIST_AVDS_ARGV: readonly string[] = ['-list-avds']
export const ADB_VERSION_ARGV: readonly string[] = ['version']

export const IOS_CAPABILITY_HINT =
  'Xcode Simulator tools are unavailable. Install full Xcode, open it once, then select it with `sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer`.'
export const ANDROID_CAPABILITY_HINT =
  'Android SDK not found. Install Android Studio and set ANDROID_HOME.'

export type SimctlDevice = Readonly<{
  name: string
  udid: string
  state: string
  runtime: string
  isAvailable: boolean | undefined
}>

/**
 * Parses `xcrun simctl list devices -j`. The devices map is keyed by runtime
 * (the key becomes the runtime); entries without a UDID are skipped. All
 * devices are returned — availability filtering happens in the mapping layer.
 * (Orca simctl-simulator-devices parse, including empty-output tolerance.)
 */
export function parseSimctlDevicesJson(stdout: string): readonly SimctlDevice[] {
  let data: unknown
  try {
    data = JSON.parse(stdout || '{}')
  } catch {
    return []
  }
  const root = data as { devices?: Record<string, unknown> }
  if (!root.devices || typeof root.devices !== 'object') return []
  const devices: SimctlDevice[] = []
  for (const [runtime, entries] of Object.entries(root.devices)) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue
      const item = entry as {
        name?: unknown
        udid?: unknown
        state?: unknown
        isAvailable?: unknown
      }
      if (typeof item.udid !== 'string' || item.udid.length === 0) continue
      devices.push({
        name: typeof item.name === 'string' && item.name.length > 0 ? item.name : item.udid,
        udid: item.udid,
        state: typeof item.state === 'string' ? item.state : 'unknown',
        runtime,
        isAvailable: typeof item.isAvailable === 'boolean' ? item.isAvailable : undefined,
      })
    }
  }
  return devices
}

export type AdbDevice = Readonly<{
  serial: string
  state: string
  model: string | null
  isEmulator: boolean
}>

/**
 * Parses `adb devices -l`. `no permissions` is the only two-word state;
 * `offline`/`unauthorized`/`bootloader` are preserved so the UI can show
 * them; only `device` counts as running. (Orca adb-devices parse.)
 */
export function parseAdbDevices(stdout: string): readonly AdbDevice[] {
  const devices: AdbDevice[] = []
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line === 'List of devices attached') continue
    const tokens = line.split(/\s+/)
    const serial = tokens[0]
    if (!serial) continue
    let state: string
    let keyValues: string[]
    if (tokens[1] === 'no' && tokens[2] === 'permissions') {
      state = 'no permissions'
      keyValues = tokens.slice(3)
    } else {
      state = tokens[1] ?? 'unknown'
      keyValues = tokens.slice(2)
    }
    let model: string | null = null
    for (const token of keyValues) {
      const colon = token.indexOf(':')
      if (colon <= 0) continue
      const key = token.slice(0, colon)
      const value = token.slice(colon + 1)
      if ((key === 'model:' || key === 'model') && value) {
        model = value
        break
      }
    }
    devices.push({ serial, state, model, isEmulator: serial.startsWith('emulator-') })
  }
  return devices
}

/** Parses `emulator -list-avds`, dropping blanks and adb log-prefix lines. */
export function parseAvdList(stdout: string): readonly string[] {
  const logPrefix = /^(INFO|WARNING|ERROR|DEBUG|VERBOSE|PANIC)\s /
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('No AVD') && !logPrefix.test(line))
}

export type MergedAndroidDevice = Readonly<{
  id: string
  name: string
  state: 'booted' | 'shutdown'
  detail: 'emulator' | 'device' | 'avd'
  isEmulator: boolean
}>

/** Merges running adb devices with shutdown AVDs (Orca mergeAndroidDevices). */
export function mergeAndroidDevices(
  running: readonly AdbDevice[],
  avds: readonly string[],
  runningAvdNameBySerial: ReadonlyMap<string, string>
): readonly MergedAndroidDevice[] {
  const merged: MergedAndroidDevice[] = []
  const bootedAvdNames = new Set<string>()
  for (const device of running) {
    const avdName = device.isEmulator ? (runningAvdNameBySerial.get(device.serial) ?? null) : null
    if (avdName) bootedAvdNames.add(avdName)
    merged.push({
      id: device.serial,
      name: avdName ?? device.model ?? device.serial,
      state: 'booted',
      detail: device.isEmulator ? 'emulator' : 'device',
      isEmulator: device.isEmulator,
    })
  }
  for (const avd of avds) {
    if (bootedAvdNames.has(avd)) continue
    merged.push({ id: avd, name: avd, state: 'shutdown', detail: 'avd', isEmulator: true })
  }
  return merged
}

// ── Fixed argv templates ────────────────────────────────────────────────────

export const simctlBootArgv = (udid: string): readonly string[] => ['simctl', 'boot', udid]
export const simctlShutdownArgv = (udid: string): readonly string[] => ['simctl', 'shutdown', udid]
export const simctlScreenshotArgv = (udid: string, path: string): readonly string[] => [
  'simctl',
  'io',
  udid,
  'screenshot',
  path,
]
export const adbEmuKillArgv = (serial: string): readonly string[] => ['-s', serial, 'emu', 'kill']
export const adbScreencapArgv = (serial: string): readonly string[] => [
  '-s',
  serial,
  'exec-out',
  'screencap',
  '-p',
]
export const emulatorBootArgv = (avdName: string): readonly string[] => [
  '-avd',
  avdName,
  '-no-window',
  '-no-snapshot',
  '-no-boot-anim',
]
export const adbBootCompletedArgv = (serial: string): readonly string[] => [
  '-s',
  serial,
  'shell',
  'getprop',
  'sys.boot_completed',
]
export const adbAvdNameArgv = (serial: string): readonly string[] => [
  '-s',
  serial,
  'emu',
  'avd',
  'name',
]

// ── Gesture argv (Orca android-input-mapping) ──────────────────────────────

export const ANDROID_KEY_CODES: Readonly<Record<string, string>> = Object.freeze({
  home: '3',
  back: '4',
  recents: '187',
  app_switch: '187',
  recent: '187',
  overview: '187',
  power: '26',
  lock: '26',
  volume_up: '24',
  volup: '24',
  volume_down: '25',
  voldown: '25',
})

/** 0..1 → device pixel, clamped to the addressable range [0, dimension-1]. */
export function normalizedToDevicePixels(normalized: number, dimension: number): number {
  if (!Number.isFinite(normalized) || normalized <= 0) return 0
  const scaled = Math.round(normalized * dimension)
  return Math.min(scaled, Math.max(0, dimension - 1))
}

export function androidGestureArgv(
  serial: string,
  gesture: DeviceGesture,
  screenSize: Readonly<{ width: number; height: number }>
): readonly string[] {
  const prefix = ['-s', serial, 'shell']
  if (gesture.kind === 'tap') {
    return [
      ...prefix,
      'input',
      'tap',
      String(normalizedToDevicePixels(gesture.x, screenSize.width)),
      String(normalizedToDevicePixels(gesture.y, screenSize.height)),
    ]
  }
  if (gesture.kind === 'swipe') {
    return [
      ...prefix,
      'input',
      'swipe',
      String(normalizedToDevicePixels(gesture.fromX, screenSize.width)),
      String(normalizedToDevicePixels(gesture.fromY, screenSize.height)),
      String(normalizedToDevicePixels(gesture.toX, screenSize.width)),
      String(normalizedToDevicePixels(gesture.toY, screenSize.height)),
      String(Math.min(Math.max(gesture.durationMs, 10), 10_000)),
    ]
  }
  if (gesture.kind === 'text') {
    // adb's `input text` cannot carry spaces literally; the donor and the
    // Android shell convention encode them as %s. Newlines are unsupported.
    return [...prefix, 'input', 'text', gesture.text.replace(/ /g, '%s')]
  }
  const code = ANDROID_KEY_CODES[gesture.code]
  if (code === undefined)
    throw new DeviceSessionError(
      'unsupported_capability',
      `unknown Android hardware button: ${gesture.code}`
    )
  return [...prefix, 'input', 'keyevent', code]
}
