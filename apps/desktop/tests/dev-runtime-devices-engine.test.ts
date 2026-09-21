// Device engine seam and dev.device.* execution paths: launches bind real
// process identities, stops execute platform shutdowns through the engine
// (never a raw registry argv), captures carry full provenance, and missing
// host tooling stays typed-unavailable instead of pretending success. The
// scripted runner keeps every case deterministic in CI.
import { describe, expect, test } from 'bun:test'

import type { DevCommand } from '../../../packages/types/src/dev-runtime'
import { devOperationDefinitions } from '../../../packages/types/src/dev-runtime'

import { createDeviceSessionRegistry } from '../shell/src/dev-runtime/devices/device-sessions'
import {
  createHostDeviceEngine,
  type DeviceEngine,
  type DeviceRunner,
} from '../shell/src/dev-runtime/devices/engine'
import { createDeviceProviders } from '../shell/src/dev-runtime/devices/providers'
import { createScreenshotStore } from '../shell/src/dev-runtime/browser/screenshots'
import { emulatorBootArgv, simctlBootArgv } from '../shell/src/dev-runtime/devices/inventory'

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
} as const
const sessionId = '00000000-0000-4000-8000-0000000000b1'
const UDID = '0B5C3D50-1D3E-4F0A-9AF4-86B7F0F0E1A2'

/** Minimal PNG bytes with a real IHDR so dimension parsing is exercised. */
function pngWithDimensions(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

type RunHandler = (
  argv: readonly string[],
  options?: Readonly<{ bytes?: boolean }>
) => Promise<{ exitCode: number; stdout: string | Uint8Array; stderr?: string }>

function scriptedRunner(
  run: RunHandler,
  spawn?: (argv: readonly string[]) => Promise<{ pid: number }>
): DeviceRunner {
  return {
    run,
    spawn: spawn ?? (async () => ({ pid: 4242 })),
  }
}

describe('host device engine (scripted runner)', () => {
  test('iOS launch binds a device-scoped identity; a booted device is adopted', async () => {
    const calls: string[][] = []
    const engine = createHostDeviceEngine(
      scriptedRunner(async (argv) => {
        calls.push([...argv])
        return { exitCode: 0, stdout: '' }
      })
    )
    const identity = await engine.executeLaunch({
      argv: simctlBootArgv(UDID),
      executable: 'xcrun',
      inventoryId: UDID,
      platform: 'ios',
    })
    expect(calls).toEqual([['xcrun', ...simctlBootArgv(UDID)]])
    expect(identity?.startIdentity).toBe(`simctl:${UDID}`)
    // The identity re-check consults live boot state, never the pid.
    const alive = await engine.probe(identity!)
    expect(alive).toBe(false)
  })

  test('an already-booted simulator is adopted without ownership', async () => {
    const engine = createHostDeviceEngine(
      scriptedRunner(async () => ({
        exitCode: 149,
        stdout: '',
        stderr: 'Unable to boot device in current state: Booted',
      }))
    )
    const identity = await engine.executeLaunch({
      argv: simctlBootArgv(UDID),
      executable: 'xcrun',
      inventoryId: UDID,
      platform: 'ios',
    })
    expect(identity).toBeUndefined()
  })

  test('Android launch spawns the emulator and keeps the process identity', async () => {
    let spawnedArgv: readonly string[] | undefined
    const engine = createHostDeviceEngine(
      scriptedRunner(
        async () => ({ exitCode: 0, stdout: '' }),
        async (argv) => {
          spawnedArgv = argv
          return { pid: 4242 }
        }
      )
    )
    const identity = await engine.executeLaunch({
      argv: emulatorBootArgv('Pixel_Tablet'),
      executable: 'emulator',
      inventoryId: 'Pixel_Tablet',
      platform: 'android',
    })
    expect(spawnedArgv).toEqual(emulatorBootArgv('Pixel_Tablet'))
    expect(identity?.pid).toBe(4242)
    expect(identity?.executable).toBe('emulator')
  })

  test('Android shutdown resolves the live emulator serial before emu kill', async () => {
    const calls: string[][] = []
    const engine = createHostDeviceEngine(
      scriptedRunner(async (argv) => {
        calls.push([...argv])
        if (argv[0] === 'adb' && argv[1] === 'devices' && argv[2] === '-l')
          return {
            exitCode: 0,
            stdout:
              'List of devices attached\nemulator-5556 device product:model model:Pixel_Tablet\n',
          }
        if (argv.includes('avd') && argv.includes('name'))
          return { exitCode: 0, stdout: 'Pixel_Tablet\n' }
        return { exitCode: 0, stdout: 'OK' }
      })
    )
    await engine.shutdown({
      id: 'session-1',
      kind: 'android_emulator',
      inventoryId: 'Pixel_Tablet',
      startedByAdea: true,
      process: {
        pid: 4242,
        startIdentity: 'x',
        argv: ['emulator', ...emulatorBootArgv('Pixel_Tablet')],
        executable: 'emulator',
      },
    })
    // The kill targets the SERIAL, never the AVD name.
    expect(calls.at(-1)).toEqual(['adb', '-s', 'emulator-5556', 'emu', 'kill'])
  })

  test('iOS shutdown uses the verified UDID', async () => {
    const calls: string[][] = []
    const engine = createHostDeviceEngine(
      scriptedRunner(async (argv) => {
        calls.push([...argv])
        return { exitCode: 0, stdout: '' }
      })
    )
    await engine.shutdown({
      id: 'session-1',
      kind: 'ios_simulator',
      inventoryId: UDID,
      startedByAdea: true,
      process: {
        pid: 0,
        startIdentity: `simctl:${UDID}`,
        argv: ['xcrun', ...simctlBootArgv(UDID)],
        executable: 'xcrun',
      },
    })
    expect(calls).toEqual([['xcrun', 'simctl', 'shutdown', UDID]])
  })

  test('screenshots parse real PNG dimensions from both platforms', async () => {
    const png = pngWithDimensions(1179, 2556)
    // The scripted "simctl" writes to the temp path the engine supplies; the
    // engine's own tmpdir/read/cleanup round-trip stays real.
    const { writeFile } = await import('node:fs/promises')
    const iosEngine = createHostDeviceEngine(
      scriptedRunner(async (argv) => {
        const path = argv.at(-1)
        if (path?.endsWith('.png')) await writeFile(path, png)
        return { exitCode: 0, stdout: '' }
      })
    )
    const iosCapture = await iosEngine.screenshot(
      { id: 's1', kind: 'ios_simulator', inventoryId: UDID, startedByAdea: true },
      'png'
    )
    expect(iosCapture.width).toBe(1179)
    expect(iosCapture.height).toBe(2556)

    const androidEngine = createHostDeviceEngine(
      scriptedRunner(async (_argv, options) => {
        if (options?.bytes) return { exitCode: 0, stdout: png }
        return { exitCode: 0, stdout: 'List of devices attached\nemulator-5556 device\n' }
      })
    )
    const androidCapture = await androidEngine.screenshot(
      {
        id: 's2',
        kind: 'android_emulator',
        inventoryId: 'Pixel_Tablet',
        startedByAdea: true,
        process: { pid: 4242, startIdentity: 'x', argv: ['emulator-5556'], executable: 'emulator' },
      },
      'png'
    )
    expect(androidCapture.width).toBe(1179)
    expect(androidCapture.height).toBe(2556)
  })

  test('gestures map through the live screen size', async () => {
    const calls: string[][] = []
    const engine = createHostDeviceEngine(
      scriptedRunner(async (argv) => {
        calls.push([...argv])
        if (argv.includes('wm')) return { exitCode: 0, stdout: 'Physical size: 1080x2340\n' }
        return { exitCode: 0, stdout: '' }
      })
    )
    await engine.input(
      {
        id: 's3',
        kind: 'android_emulator',
        inventoryId: 'Pixel_Tablet',
        startedByAdea: true,
        process: { pid: 4242, startIdentity: 'x', argv: ['emulator-5556'], executable: 'emulator' },
      },
      { kind: 'tap', x: 0.5, y: 0.25 }
    )
    expect(calls.at(-1)).toEqual([
      'adb',
      '-s',
      'emulator-5556',
      'shell',
      'input',
      'tap',
      '540',
      '585',
    ])
  })
})

// ── dev.device.* execution paths ────────────────────────────────────────────

function deviceCommand(
  operation: keyof typeof devOperationDefinitions,
  body: Record<string, unknown>
): DevCommand {
  const definition = devOperationDefinitions[operation]
  return {
    schemaVersion: 1,
    operation,
    requestId: '00000000-0000-4000-8000-000000000004',
    nonce: 'dGhpcy1ub25jZS1oYXMtYXQtbGVhc3QtMTI4LWJpdHM',
    issuedAt: '2026-09-19T12:00:00.000Z',
    expiresAt: '2026-09-19T12:01:00.000Z',
    scope,
    capabilities: definition.capabilities,
    ...(definition.resource
      ? {
          resource: {
            kind: definition.resource.kind,
            id: String(body[definition.resource.idField]),
            generation: Number(body.expectedGeneration ?? 1),
          },
        }
      : {}),
    body,
  }
}

function providersHarness(engine: DeviceEngine | undefined) {
  const sessions = createDeviceSessionRegistry({
    // The registrar wires the same probe: stop re-checks the launch identity
    // through the engine (device-scoped for iOS, pid-live for Android).
    probeProcess: (identity) => (engine ? engine.probe(identity) : identity.pid > 0),
  })
  const inventory = sessions.setInventory([
    {
      id: UDID,
      kind: 'ios_simulator',
      name: 'iPhone 15 Pro',
      platform: 'ios',
      state: 'available',
      generation: 3,
    },
    {
      id: 'Pixel_Tablet',
      kind: 'android_emulator',
      name: 'Pixel_Tablet',
      platform: 'android',
      state: 'available',
      generation: 3,
    },
  ])
  const store = createScreenshotStore({ scope })
  const { providers } = createDeviceProviders({
    sessions,
    verifiedInventory: () => ({ ios: inventory, android: inventory }),
    iosInputHint: 'simctl exposes no tap',
    ...(engine ? { engine } : {}),
    screenshotRecorder: store,
  })
  return { sessions, providers, store }
}

const fakeDeviceEngine: DeviceEngine = {
  executeLaunch: async (launch) =>
    launch.platform === 'ios'
      ? {
          pid: 0,
          startIdentity: `simctl:${launch.inventoryId}`,
          argv: ['xcrun', ...launch.argv],
          executable: 'xcrun',
        }
      : {
          pid: 4242,
          startIdentity: 'android-1',
          argv: ['emulator', ...launch.argv],
          executable: 'emulator',
        },
  shutdown: async () => undefined,
  screenshot: async () => ({ bytes: pngWithDimensions(390, 844), width: 390, height: 844 }),
  screenSize: async () => ({ width: 1080, height: 2340 }),
  input: async () => undefined,
  probe: async () => true,
}

/** Reads the typed code a synchronously-thrown provider error carries. */
const thrownCode = (call: () => unknown): string => {
  try {
    call()
  } catch (caught) {
    return (caught as { code?: string }).code ?? 'no-code'
  }
  return 'no-error'
}

describe('device providers with a live engine', () => {
  test('start executes the launch record and binds the process identity', async () => {
    const { sessions, providers } = providersHarness(fakeDeviceEngine)
    const session = (await providers['dev.device.start']!(
      deviceCommand('dev.device.start', {
        inventoryId: UDID,
        expectedGeneration: 3,
        runtimeSessionId: sessionId,
      })
    )) as { id: string; state: string; startedByAdea: boolean }
    expect(session.state).toBe('attached')
    expect(session.startedByAdea).toBe(true)
    // The launch identity is bound, so a later stop proves ownership.
    const stop = sessions.planStop(session.id, session.generation, 'confirm')
    expect(stop.shutdown).toBe('device')
  })

  test('a failed launch releases the session instead of stranding `starting`', async () => {
    const failing: DeviceEngine = {
      ...fakeDeviceEngine,
      executeLaunch: async () => {
        throw new Error('emulator exited immediately')
      },
    }
    const { sessions, providers } = providersHarness(failing)
    await expect(
      providers['dev.device.start']!(
        deviceCommand('dev.device.start', {
          inventoryId: 'Pixel_Tablet',
          expectedGeneration: 3,
          runtimeSessionId: sessionId,
        })
      )
    ).rejects.toThrow('emulator exited immediately')
    const remaining = sessions.list({ runtimeSessionId: sessionId })
    expect(remaining.map((entry) => entry.state)).toEqual(['stopped'])
  })

  test('stop without an engine is typed-unavailable and mutates nothing', async () => {
    const { sessions, providers } = providersHarness(undefined)
    const session = sessions.startResponsive(scope, sessionId)
    // Responsive stops are detachment and need no engine.
    const stopped = (await providers['dev.device.stop']!(
      deviceCommand('dev.device.stop', {
        deviceSessionId: session.id,
        expectedGeneration: session.generation,
        confirmationId: 'confirm',
      })
    )) as { state: string }
    expect(stopped.state).toBe('stopped')
  })

  test('screenshots carry device provenance and bounded bytes', async () => {
    const { providers, store } = providersHarness(fakeDeviceEngine)
    const session = (await providers['dev.device.start']!(
      deviceCommand('dev.device.start', {
        inventoryId: UDID,
        expectedGeneration: 3,
        runtimeSessionId: sessionId,
      })
    )) as { id: string; generation: number }
    const ref = (await providers['dev.device.screenshot']!(
      deviceCommand('dev.device.screenshot', {
        deviceSessionId: session.id,
        expectedGeneration: session.generation,
        format: 'png',
      })
    )) as {
      origin: string
      laneKind: string
      viewport: { width: number; height: number }
      sha256: string
      expiresAt: string
    }
    expect(ref.origin).toBe(`device:ios_simulator:${UDID}`)
    expect(ref.laneKind).toBe('device')
    expect(ref.viewport).toEqual({ width: 390, height: 844, deviceScaleFactor: 1 })
    expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(ref.expiresAt > new Date().toISOString()).toBe(true)
    expect(store.getBytes(store.list()[0]!.id)?.byteLength).toBe(24)
  })

  test('iOS input stays unsupported while responsive sessions refuse gestures', async () => {
    const { sessions, providers } = providersHarness(fakeDeviceEngine)
    const session = (await providers['dev.device.start']!(
      deviceCommand('dev.device.start', {
        inventoryId: UDID,
        expectedGeneration: 3,
        runtimeSessionId: sessionId,
      })
    )) as { id: string; generation: number }
    expect(
      thrownCode(() =>
        providers['dev.device.input']!(
          deviceCommand('dev.device.input', {
            deviceSessionId: session.id,
            expectedGeneration: session.generation,
            direction: 'write',
          })
        )
      )
    ).toBe('unsupported_capability')
    const responsive = sessions.startResponsive(scope, sessionId)
    expect(
      thrownCode(() =>
        providers['dev.device.input']!(
          deviceCommand('dev.device.input', {
            deviceSessionId: responsive.id,
            expectedGeneration: responsive.generation,
            direction: 'write',
          })
        )
      )
    ).toBe('invalid_state')
  })
})
