// #422 device adapters. Inventory fixture cases translated from Orca's
// emulator backend tests (MIT, revision
// 403b62a8d8fa6e896a93acc4c15405be0f0b7dc7); capability-unavailable,
// stop-identity, and argv-template cases come from the issue's hardening
// list (fixed argv from verified inventory; stop only Adea-launched
// still-matching processes).
import { describe, expect, test } from 'bun:test'

import {
  ADB_DEVICES_ARGV,
  adbEmuKillArgv,
  androidGestureArgv,
  emulatorBootArgv,
  mergeAndroidDevices,
  normalizedToDevicePixels,
  parseAdbDevices,
  parseAvdList,
  parseSimctlDevicesJson,
  SIMCTL_LIST_ARGV,
  simctlBootArgv,
  simctlScreenshotArgv,
  simctlShutdownArgv,
} from '../shell/src/dev-runtime/devices/inventory'
import {
  createDeviceSessionRegistry,
  DeviceSessionError,
  type DeviceProcessIdentity,
} from '../shell/src/dev-runtime/devices/device-sessions'

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
} as const
const sessionId = '00000000-0000-4000-8000-0000000000b1'

describe('inventory parsing', () => {
  test('parses simctl devices JSON with runtime promotion (orca fixture)', () => {
    const stdout = JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
          {
            name: 'iPhone 16',
            udid: '11111111-1111-1111-1111-111111111111',
            state: 'Booted',
            isAvailable: true,
          },
          { name: 'iPad Pro', udid: '22222222-2222-2222-2222-222222222222', state: 'Shutdown' },
          { noUdid: true },
        ],
      },
    })
    const devices = parseSimctlDevicesJson(stdout)
    expect(devices).toHaveLength(2)
    expect(devices[0]).toMatchObject({
      name: 'iPhone 16',
      state: 'Booted',
      runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-18-0',
    })
    expect(parseSimctlDevicesJson('')).toEqual([])
    expect(parseSimctlDevicesJson('not json')).toEqual([])
  })

  test('parses adb devices including the two-word no-permissions state', () => {
    const stdout = [
      'List of devices attached',
      'emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64',
      'ABC123                 device usb:1-1 product:Pixel_8 model:Pixel_8',
      'emulator-5556          offline',
      'XYZ789                 no permissions (missing udev rules?); usb:1-2',
      '',
    ].join('\n')
    const devices = parseAdbDevices(stdout)
    expect(devices).toHaveLength(4)
    expect(devices[0]).toMatchObject({ serial: 'emulator-5554', state: 'device', isEmulator: true })
    expect(devices[1]).toMatchObject({ serial: 'ABC123', isEmulator: false, model: 'Pixel_8' })
    expect(devices[2]).toMatchObject({ serial: 'emulator-5556', state: 'offline' })
    expect(devices[3]).toMatchObject({ serial: 'XYZ789', state: 'no permissions' })
  })

  test('parses AVD lists and drops log-prefix lines (orca fixture)', () => {
    expect(
      parseAvdList(
        ['Pixel_7', '', 'Pixel_Tablet', 'WARNING  something', 'No AVD specified'].join('\n')
      )
    ).toEqual(['Pixel_7', 'Pixel_Tablet'])
  })

  test('merges running devices with shutdown AVDs (orca fixture)', () => {
    const merged = mergeAndroidDevices(
      parseAdbDevices(
        'List of devices attached\nemulator-5554 device product:x model:sdk_gphone64'
      ),
      ['Pixel_7', 'Pixel_Tablet'],
      new Map([['emulator-5554', 'Pixel_7']])
    )
    expect(merged).toEqual([
      {
        id: 'emulator-5554',
        name: 'Pixel_7',
        state: 'booted',
        detail: 'emulator',
        isEmulator: true,
      },
      {
        id: 'Pixel_Tablet',
        name: 'Pixel_Tablet',
        state: 'shutdown',
        detail: 'avd',
        isEmulator: true,
      },
    ])
  })

  test('fixed argv templates for every probe and control command', () => {
    expect(SIMCTL_LIST_ARGV).toEqual(['simctl', 'list', 'devices', '-j'])
    expect(ADB_DEVICES_ARGV).toEqual(['devices', '-l'])
    expect(simctlBootArgv('udid-1')).toEqual(['simctl', 'boot', 'udid-1'])
    expect(simctlShutdownArgv('udid-1')).toEqual(['simctl', 'shutdown', 'udid-1'])
    expect(simctlScreenshotArgv('udid-1', '/tmp/shot.png')).toEqual([
      'simctl',
      'io',
      'udid-1',
      'screenshot',
      '/tmp/shot.png',
    ])
    expect(emulatorBootArgv('Pixel_Tablet')).toEqual([
      '-avd',
      'Pixel_Tablet',
      '-no-window',
      '-no-snapshot',
      '-no-boot-anim',
    ])
    expect(adbEmuKillArgv('emulator-5554')).toEqual(['-s', 'emulator-5554', 'emu', 'kill'])
  })
})

describe('gesture argv', () => {
  const screen = { width: 1080, height: 2400 }

  test('converts normalized coordinates to clamped device pixels (orca fixture)', () => {
    expect(normalizedToDevicePixels(0.5, 1080)).toBe(540)
    expect(normalizedToDevicePixels(0, 1080)).toBe(0)
    expect(normalizedToDevicePixels(-1, 1080)).toBe(0)
    expect(normalizedToDevicePixels(1, 1080)).toBe(1079)
  })

  test('tap, swipe, text, and button map to fixed adb argv', () => {
    expect(androidGestureArgv('emulator-5554', { kind: 'tap', x: 0.5, y: 0.5 }, screen)).toEqual([
      '-s',
      'emulator-5554',
      'shell',
      'input',
      'tap',
      '540',
      '1200',
    ])
    expect(
      androidGestureArgv(
        'emulator-5554',
        { kind: 'swipe', fromX: 0, fromY: 0, toX: 1, toY: 1, durationMs: 5000 },
        screen
      )
    ).toEqual(['-s', 'emulator-5554', 'shell', 'input', 'swipe', '0', '0', '1079', '2399', '5000'])
    expect(androidGestureArgv('emulator-5554', { kind: 'text', text: 'hi there' }, screen)).toEqual(
      ['-s', 'emulator-5554', 'shell', 'input', 'text', 'hi%sthere']
    )
    expect(
      androidGestureArgv('emulator-5554', { kind: 'key', code: 'back', action: 'down' }, screen)
    ).toEqual(['-s', 'emulator-5554', 'shell', 'input', 'keyevent', '4'])
    expect(() =>
      androidGestureArgv('emulator-5554', { kind: 'key', code: 'detach', action: 'down' }, screen)
    ).toThrow(/unknown Android hardware button/)
  })
})

describe('device session registry', () => {
  test('responsive sessions always start and own no process', () => {
    const sessions = createDeviceSessionRegistry()
    const session = sessions.startResponsive(scope, sessionId)
    expect(session).toMatchObject({ kind: 'responsive', state: 'attached', startedByAdea: false })
    expect(() => sessions.planStop(session.id, 1, 'confirm')).toThrow(/responsive/)
  })

  test('start binds to verified inventory IDs and generations only', () => {
    const sessions = createDeviceSessionRegistry()
    const inventory = sessions.setInventory([inventoryItem()])
    expect(() =>
      sessions.planStart(scope, {
        runtimeSessionId: sessionId,
        inventoryId: 'not-in-inventory',
        expectedGeneration: 4,
        inventory,
        platform: 'ios',
      })
    ).toThrow(/verified inventory/)
    const { session, launch } = sessions.planStart(scope, {
      runtimeSessionId: sessionId,
      inventoryId: inventoryItem().id,
      expectedGeneration: 4,
      inventory,
      platform: 'ios',
    })
    expect(launch).toEqual({
      argv: simctlBootArgv(inventoryItem().id),
      executable: 'xcrun',
      inventoryId: inventoryItem().id,
    })
    expect(session.state).toBe('starting')
    expectCode(
      () =>
        sessions.planStart(scope, {
          runtimeSessionId: sessionId,
          inventoryId: inventoryItem().id,
          expectedGeneration: 3,
          inventory,
          platform: 'ios',
        }),
      'stale_generation'
    )
  })

  test('stop requires an Adea launch record and a matching start identity', () => {
    let processAlive = true
    const identity: DeviceProcessIdentity = {
      pid: 4321,
      startIdentity: 'start-1',
      argv: emulatorBootArgv('Pixel_Tablet'),
      executable: 'emulator',
    }
    const sessions = createDeviceSessionRegistry({
      probeProcess: () => processAlive,
    })
    const inventory = sessions.setInventory([
      inventoryItem({
        id: 'Pixel_Tablet',
        name: 'Pixel_Tablet',
        kind: 'android_emulator',
        platform: 'android',
      }),
    ])
    const { session } = sessions.planStart(scope, {
      runtimeSessionId: sessionId,
      inventoryId: 'Pixel_Tablet',
      expectedGeneration: 4,
      inventory,
      platform: 'android',
    })
    sessions.markLaunched(session.id, identity)
    expectCode(
      () => sessions.planStop(session.id, session.generation, undefined),
      'permission_denied'
    )
    processAlive = false
    // A replaced process is never signalled: identity recheck fails first.
    expectCode(
      () => sessions.planStop(session.id, session.generation, 'confirm'),
      'ownership_unproven'
    )
    processAlive = true
    const stopped = sessions.planStop(session.id, session.generation, 'confirm')
    expect(stopped.shutdownArgv).toEqual(adbEmuKillArgv('Pixel_Tablet'))
    expect(sessions.markStopped(session.id).state).toBe('stopped')
  })

  test('an already-booted device is adopted, never shut down', () => {
    const sessions = createDeviceSessionRegistry()
    const inventory = sessions.setInventory([inventoryItem()])
    const { session } = sessions.planStart(scope, {
      runtimeSessionId: sessionId,
      inventoryId: inventoryItem().id,
      expectedGeneration: 4,
      inventory,
      platform: 'ios',
    })
    const adopted = sessions.markLaunched(session.id, undefined)
    expect(adopted.startedByAdea).toBe(false)
    const stop = sessions.planStop(adopted.id, adopted.generation, 'confirm')
    expect(stop.shutdownArgv).toBeUndefined()
    expect(sessions.markStopped(adopted.id).state).toBe('stopped')
  })

  test('stale generation stop is refused', () => {
    const sessions = createDeviceSessionRegistry()
    const session = sessions.startResponsive(scope, sessionId)
    expectCode(() => sessions.planStop(session.id, 99, 'confirm'), 'stale_generation')
  })
})

const inventoryItem = (overrides: Partial<{ id: string; name: string; state: string }> = {}) => ({
  id: '11111111-1111-1111-1111-111111111111',
  kind: 'ios_simulator' as const,
  name: 'iPhone 16',
  platform: 'ios',
  state: 'available' as const,
  generation: 4,
  observedAt: '2026-09-18T12:00:00.000Z',
  ...overrides,
})

function expectCode(run: () => unknown, code: string) {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(DeviceSessionError)
    expect((error as DeviceSessionError).code).toBe(code)
    return
  }
  throw new Error(`expected DeviceSessionError ${code}`)
}
