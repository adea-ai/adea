// Device lane engine: the seam between the dev.device.* providers and the
// host tooling (`xcrun simctl`, `adb`, `emulator`). Every command is a fixed
// argv template whose free elements come from verified inventory or the
// session's own launch record — never caller text. Process ownership follows
// the spec's rule: stop signals only a device whose launch identity still
// matches; an iOS identity is device-scoped (`simctl boot` exits, so the
// launch record carries the UDID, and the probe re-checks live boot state).
// The default runner shells out through Bun.spawn; tests inject a scripted
// runner so CI never needs host tooling.
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DeviceGesture } from '../../../../../../packages/types/src/dev-runtime'

import type { DeviceProcessIdentity, DeviceSessionRecord } from './device-sessions'
import {
  adbAvdNameArgv,
  adbEmuKillArgv,
  adbScreencapArgv,
  ADB_DEVICES_ARGV,
  androidGestureArgv,
  DeviceSessionError,
  emulatorBootArgv,
  parseAdbDevices,
  simctlScreenshotArgv,
  simctlShutdownArgv,
} from './inventory'

export type DeviceRunnerResult = Readonly<{
  exitCode: number
  stdout: string | Uint8Array
  stderr?: string
}>

export type DeviceRunner = Readonly<{
  /** Bounded command that exits on its own (probes, gestures, shutdown). */
  run(argv: readonly string[], options?: Readonly<{ bytes?: boolean }>): Promise<DeviceRunnerResult>
  /** Long-lived launch (the emulator process); resolves once spawned. */
  spawn(argv: readonly string[]): Promise<Readonly<{ pid: number }>>
}>

export type DeviceLaunchSpec = Readonly<{
  argv: readonly string[]
  executable: string
  inventoryId: string
  platform: 'ios' | 'android'
}>

/** The subset of a session record the engine needs to act on a device. */
export type ManagedDevice = Readonly<
  Pick<DeviceSessionRecord, 'id' | 'kind' | 'inventoryId' | 'startedByAdea'> & {
    process?: DeviceProcessIdentity
  }
>

export type DeviceEngine = Readonly<{
  /**
   * Executes a launch record from the session registry. Returns the bound
   * process identity, or `undefined` when the device was already booted and
   * is adopted without ownership (Adea may use it, never shut it down).
   */
  executeLaunch(launch: DeviceLaunchSpec): Promise<DeviceProcessIdentity | undefined>
  /** Shuts down a device this session launched and still owns. */
  shutdown(device: ManagedDevice): Promise<void>
  /** Captures a PNG of the device display. */
  screenshot(
    device: ManagedDevice,
    format: 'png' | 'jpeg' | 'webp'
  ): Promise<Readonly<{ bytes: Uint8Array; width: number; height: number }>>
  /** The device's addressable screen size in pixels (Android input mapping). */
  screenSize(device: ManagedDevice): Promise<Readonly<{ width: number; height: number }>>
  /** Delivers one gesture through the platform's input tooling. */
  input(device: ManagedDevice, gesture: DeviceGesture): Promise<void>
  /** Re-checks a launch identity immediately before any stop. */
  probe(identity: DeviceProcessIdentity): Promise<boolean>
}>

function identityDigest(argv: readonly string[], pid: number): string {
  return createHash('sha256')
    .update(`${pid}\u001f${argv.join('\u001f')}`, 'utf8')
    .digest('hex')
}

/** Extracts pixel dimensions from a PNG's IHDR chunk (width at byte 16). */
function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (
    bytes.byteLength < 24 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[12] !== 0x49 ||
    bytes[13] !== 0x48 ||
    bytes[14] !== 0x44 ||
    bytes[15] !== 0x52
  )
    throw new DeviceSessionError('invalid_state', 'device screenshot is not a decodable PNG')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/** Prefixes the tool executable onto the fixed argv template. */
const full = (argv: readonly string[], executable: string): string[] => [executable, ...argv]

export function createHostDeviceEngine(runner: DeviceRunner): DeviceEngine {
  async function resolveAndroidSerial(device: ManagedDevice): Promise<string> {
    // The emulator serial (`emulator-5554`-style) only exists once booted;
    // resolve it from the live adb list by matching the session's AVD name.
    const listed = await runner.run(full(ADB_DEVICES_ARGV, 'adb'))
    if (listed.exitCode !== 0 || typeof listed.stdout !== 'string')
      throw new DeviceSessionError('invalid_state', 'adb devices did not report a device list')
    for (const entry of parseAdbDevices(listed.stdout)) {
      if (!entry.isEmulator || entry.state !== 'device') continue
      const name = await runner.run(full(adbAvdNameArgv(entry.serial), 'adb'))
      const avdName =
        typeof name.stdout === 'string' ? (name.stdout.split(/\r?\n/)[0] ?? '').trim() : ''
      if (avdName === device.inventoryId) return entry.serial
    }
    throw new DeviceSessionError(
      'ownership_unproven',
      `no running emulator matches the session launch record for ${device.inventoryId}`
    )
  }

  async function androidSerialFor(device: ManagedDevice): Promise<string> {
    if (device.process && device.process.pid > 0) {
      // Launched here: prefer the serial recorded on the launch record.
      const serial = device.process.argv.find((part) => part.startsWith('emulator-'))
      if (serial) return serial
    }
    return resolveAndroidSerial(device)
  }

  async function screenSizeOf(
    device: ManagedDevice
  ): Promise<Readonly<{ width: number; height: number }>> {
    if (device.kind !== 'android_emulator' && device.kind !== 'physical')
      throw new DeviceSessionError(
        'unsupported_capability',
        'screen size applies to Android devices'
      )
    const serial = await androidSerialFor(device)
    const result = await runner.run(['adb', '-s', serial, 'shell', 'wm', 'size'])
    const text = typeof result.stdout === 'string' ? result.stdout : ''
    const match = /Physical size:\s*(\d+)x(\d+)/.exec(text)
    if (!match)
      throw new DeviceSessionError('invalid_state', 'adb did not report a physical screen size')
    return { width: Number(match[1]), height: Number(match[2]) }
  }

  return {
    async executeLaunch(launch) {
      if (launch.platform === 'ios') {
        const result = await runner.run(full(launch.argv, launch.executable))
        if (result.exitCode !== 0) {
          const output = `${typeof result.stdout === 'string' ? result.stdout : ''}${result.stderr ?? ''}`
          // A device that was already booted is adopted without ownership:
          // Adea may use it but may never shut it down.
          if (/already booted|state.{0,4}Booted/i.test(output)) return undefined
          throw new DeviceSessionError(
            'invalid_state',
            `simulator boot failed with exit code ${result.exitCode}`
          )
        }
        // The launch record's inventory ID IS the verified UDID.
        const udid = launch.inventoryId
        return {
          // The `simctl boot` process exits immediately; ownership is
          // device-scoped (startIdentity names the UDID) and `probe`
          // re-checks live boot state, never this placeholder pid.
          pid: 0,
          startIdentity: `simctl:${udid}`,
          argv: [launch.executable, ...launch.argv],
          executable: launch.executable,
        }
      }
      const spawned = await runner.spawn(emulatorBootArgv(launch.inventoryId))
      const argv = [launch.executable, ...launch.argv]
      return {
        pid: spawned.pid,
        startIdentity: identityDigest(argv, spawned.pid),
        argv,
        executable: launch.executable,
      }
    },

    async shutdown(device) {
      if (!device.startedByAdea || !device.process)
        throw new DeviceSessionError(
          'ownership_unproven',
          'device was not launched by Adea; it is never signalled'
        )
      if (device.kind === 'ios_simulator') {
        const result = await runner.run(full(simctlShutdownArgv(device.inventoryId), 'xcrun'))
        if (result.exitCode !== 0)
          throw new DeviceSessionError(
            'invalid_state',
            `simulator shutdown failed with exit code ${result.exitCode}`
          )
        return
      }
      const serial = await androidSerialFor(device)
      const result = await runner.run(full(adbEmuKillArgv(serial), 'adb'))
      if (result.exitCode !== 0)
        throw new DeviceSessionError(
          'invalid_state',
          `emulator shutdown failed with exit code ${result.exitCode}`
        )
    },

    async screenshot(device, format) {
      if (format !== 'png')
        throw new DeviceSessionError('unsupported_capability', 'device captures are PNG')
      if (device.kind === 'ios_simulator') {
        const directory = await mkdtemp(join(tmpdir(), 'adea-device-capture-'))
        const path = join(directory, 'screen.png')
        try {
          const result = await runner.run(
            full(simctlScreenshotArgv(device.inventoryId, path), 'xcrun')
          )
          if (result.exitCode !== 0)
            throw new DeviceSessionError(
              'invalid_state',
              `simulator screenshot failed with exit code ${result.exitCode}`
            )
          const bytes = await readFile(path)
          return { bytes: new Uint8Array(bytes), ...pngDimensions(new Uint8Array(bytes)) }
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      }
      if (device.kind === 'android_emulator') {
        const serial = await androidSerialFor(device)
        const result = await runner.run(full(adbScreencapArgv(serial), 'adb'), { bytes: true })
        if (result.exitCode !== 0 || typeof result.stdout === 'string')
          throw new DeviceSessionError(
            'invalid_state',
            `device screenshot failed with exit code ${result.exitCode}`
          )
        return { bytes: result.stdout, ...pngDimensions(result.stdout) }
      }
      throw new DeviceSessionError(
        'unsupported_capability',
        `${device.kind} sessions have no device display to capture`
      )
    },

    async screenSize(device) {
      return screenSizeOf(device)
    },

    async input(device, gesture) {
      if (device.kind !== 'android_emulator' && device.kind !== 'physical')
        throw new DeviceSessionError(
          'unsupported_capability',
          'gesture input requires Android input tooling'
        )
      const serial = await androidSerialFor(device)
      const size = await screenSizeOf(device)
      const result = await runner.run(full(androidGestureArgv(serial, gesture, size), 'adb'))
      if (result.exitCode !== 0)
        throw new DeviceSessionError(
          'invalid_state',
          `gesture delivery failed with exit code ${result.exitCode}`
        )
    },

    async probe(identity) {
      if (identity.startIdentity.startsWith('simctl:')) {
        // Device-scoped iOS identity: the UDID must still be Booted.
        const udid = identity.startIdentity.slice('simctl:'.length)
        const result = await runner.run(['xcrun', 'simctl', 'list', 'devices'])
        const text = typeof result.stdout === 'string' ? result.stdout : ''
        return new RegExp(
          `^\\s*${udid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+\\(Booted\\)`,
          'm'
        ).test(text)
      }
      if (!(identity.pid > 0)) return false
      const result = await runner.run(['ps', '-p', String(identity.pid)])
      return result.exitCode === 0
    },
  }
}

/** The production runner: fixed-argv commands through Bun.spawn. */
export function createBunDeviceRunner(): DeviceRunner {
  return {
    async run(argv, options) {
      const process = Bun.spawn([...argv], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
      const [stdout, stderr] = await Promise.all([
        options?.bytes
          ? new Response(process.stdout).arrayBuffer().then((buffer) => new Uint8Array(buffer))
          : new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ])
      const exitCode = await process.exited
      return { exitCode, stdout, stderr }
    },
    async spawn(argv) {
      const process = Bun.spawn([...argv], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' })
      return { pid: process.pid }
    },
  }
}
