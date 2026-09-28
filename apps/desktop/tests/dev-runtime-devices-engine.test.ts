// Device engine seam and dev.device.* execution paths: launches bind real
// process identities, stops execute platform shutdowns through the engine
// (never a raw registry argv), captures carry full provenance, and missing
// host tooling stays typed-unavailable instead of pretending success. The
// scripted runner keeps every case deterministic in CI.
import { describe, expect, test } from 'bun:test'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'

import type {
  DevCommand,
  DevOperation,
  DeviceCapabilityReport,
  DeviceInventoryItem,
} from '../../../packages/types/src/dev-runtime'
import {
  devCommandProofMessage,
  devOperationDefinitions,
} from '../../../packages/types/src/dev-runtime'

import { createChannelAuthority } from '../shell/src/dev-runtime/channel/authority'
import { createDeviceSessionRegistry } from '../shell/src/dev-runtime/devices/device-sessions'
import {
  createHostDeviceEngine,
  type DeviceEngine,
  type DeviceRunner,
} from '../shell/src/dev-runtime/devices/engine'
import {
  createDeviceProviders,
  deviceProviderError,
} from '../shell/src/dev-runtime/devices/providers'
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

function providersHarness(
  engine: DeviceEngine | undefined,
  inventoryItems: Readonly<{
    ios?: readonly DeviceInventoryItem[]
    android?: readonly DeviceInventoryItem[]
  }> = {},
  platformCapabilities: DeviceCapabilityReport = {
    items: [
      { platform: 'ios', state: 'available', observedAt: '2026-09-27T00:00:00.000Z' },
      { platform: 'android', state: 'available', observedAt: '2026-09-27T00:00:00.000Z' },
    ],
    observedAt: '2026-09-27T00:00:00.000Z',
  }
) {
  const sessions = createDeviceSessionRegistry({
    // The registrar wires the same probe: stop re-checks the launch identity
    // through the engine (device-scoped for iOS, pid-live for Android).
    probeProcess: (identity) => (engine ? engine.probe(identity) : identity.pid > 0),
  })
  const iosItems = inventoryItems.ios ?? [
    {
      id: UDID,
      kind: 'ios_simulator',
      name: 'iPhone 15 Pro',
      platform: 'ios',
      state: 'available',
      generation: 3,
      observedAt: '2026-09-27T00:00:00.000Z',
    },
  ]
  const androidItems = inventoryItems.android ?? [
    {
      id: 'Pixel_Tablet',
      kind: 'android_emulator',
      name: 'Pixel_Tablet',
      platform: 'android',
      state: 'available',
      generation: 3,
      observedAt: '2026-09-27T00:00:00.000Z',
    },
  ]
  const allItems = [...iosItems, ...androidItems]
  const observed = sessions.setInventory(allItems)
  const iosInventory = { items: iosItems, observedAt: observed.observedAt }
  const androidInventory = { items: androidItems, observedAt: observed.observedAt }
  const store = createScreenshotStore({ scope })
  const { providers } = createDeviceProviders({
    sessions,
    verifiedInventory: () => ({ ios: iosInventory, android: androidInventory }),
    platformCapabilities: () => platformCapabilities,
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
  test('returns the host capability report through the read-only operation', async () => {
    const report: DeviceCapabilityReport = {
      items: [
        {
          platform: 'ios',
          state: 'unavailable',
          missingPiece: 'xcrun_simctl',
          observedAt: '2026-09-27T00:00:00.000Z',
        },
        { platform: 'android', state: 'available', observedAt: '2026-09-27T00:00:00.000Z' },
      ],
      observedAt: '2026-09-27T00:00:00.000Z',
    }
    const { providers } = providersHarness(undefined, {}, report)

    expect(
      await providers['dev.device.capabilities']!(deviceCommand('dev.device.capabilities', {}))
    ).toEqual(report)
  })

  test('responsive inventory supports the bound list-to-start path without host tooling', async () => {
    const { providers } = providersHarness(undefined)
    const page = providers['dev.device.list']!(deviceCommand('dev.device.list', {})) as {
      items: { id: string; kind: string; generation: number; state: string }[]
    }
    const responsive = page.items.find((item) => item.kind === 'responsive')
    expect(responsive).toMatchObject({ id: 'adea:responsive', generation: 1, state: 'available' })
    const session = await providers['dev.device.start']!(
      deviceCommand('dev.device.start', {
        inventoryId: responsive!.id,
        expectedGeneration: responsive!.generation,
        runtimeSessionId: sessionId,
      })
    )
    expect(session).toMatchObject({ inventoryId: 'adea:responsive', state: 'attached', scope })
    const limited = providers['dev.device.list']!(
      deviceCommand('dev.device.list', { limit: 1 })
    ) as { items: { kind: string }[] }
    expect(limited.items.map((item) => item.kind)).toEqual(['responsive'])
    const filtered = providers['dev.device.list']!(
      deviceCommand('dev.device.list', { kind: 'ios_simulator' })
    ) as { items: { kind: string }[] }
    expect(filtered.items.every((item) => item.kind === 'ios_simulator')).toBe(true)
  })

  test('responsive start rejects a stale inventory generation', async () => {
    const { providers } = providersHarness(undefined)
    await expect(
      providers['dev.device.start']!(
        deviceCommand('dev.device.start', {
          inventoryId: 'adea:responsive',
          expectedGeneration: 2,
          runtimeSessionId: sessionId,
        })
      )
    ).rejects.toMatchObject({ code: 'stale_generation' })
  })

  test('an Android AVD named responsive still starts through the Android launch path', async () => {
    const launches: Array<Parameters<DeviceEngine['executeLaunch']>[0]> = []
    const engine: DeviceEngine = {
      ...fakeDeviceEngine,
      executeLaunch: async (launch) => {
        launches.push(launch)
        return fakeDeviceEngine.executeLaunch(launch)
      },
    }
    const { providers } = providersHarness(engine, {
      ios: [],
      android: [
        {
          id: 'responsive',
          kind: 'android_emulator',
          name: 'responsive',
          platform: 'android',
          state: 'available',
          generation: 1,
          observedAt: '2026-09-27T00:00:00.000Z',
        },
      ],
    })
    const page = providers['dev.device.list']!(deviceCommand('dev.device.list', {})) as {
      items: { id: string; kind: string; generation: number }[]
    }
    const avd = page.items.find(
      (item) => item.id === 'responsive' && item.kind === 'android_emulator'
    )
    expect(page.items.filter((item) => item.id === 'responsive')).toHaveLength(1)
    const session = (await providers['dev.device.start']!(
      deviceCommand('dev.device.start', {
        inventoryId: avd!.id,
        expectedGeneration: avd!.generation,
        runtimeSessionId: sessionId,
      })
    )) as { inventoryId: string; kind: string; state: string; startedByAdea: boolean }

    expect(session).toMatchObject({
      inventoryId: 'responsive',
      kind: 'android_emulator',
      state: 'attached',
      startedByAdea: true,
    })
    expect(launches).toHaveLength(1)
    expect(launches[0]).toMatchObject({
      executable: 'emulator',
      inventoryId: 'responsive',
      platform: 'android',
    })
  })

  test('a UUID-shaped Android inventory ID follows its verified platform', async () => {
    const inventoryId = '00000000-0000-4000-8000-000000000123'
    const launches: Array<Parameters<DeviceEngine['executeLaunch']>[0]> = []
    const engine: DeviceEngine = {
      ...fakeDeviceEngine,
      executeLaunch: async (launch) => {
        launches.push(launch)
        return fakeDeviceEngine.executeLaunch(launch)
      },
    }
    const { providers } = providersHarness(engine, {
      ios: [],
      android: [
        {
          id: inventoryId,
          kind: 'android_emulator',
          name: 'UUIDNamedAVD',
          platform: 'android',
          state: 'available',
          generation: 3,
          observedAt: '2026-09-27T00:00:00.000Z',
        },
      ],
    })

    const session = (await providers['dev.device.start']!(
      deviceCommand('dev.device.start', {
        inventoryId,
        expectedGeneration: 3,
        runtimeSessionId: sessionId,
      })
    )) as { inventoryId: string; kind: string; state: string }

    expect(session).toMatchObject({
      inventoryId,
      kind: 'android_emulator',
      state: 'attached',
    })
    expect(launches).toHaveLength(1)
    expect(launches[0]).toMatchObject({
      executable: 'emulator',
      argv: ['-avd', 'UUIDNamedAVD', '-no-window', '-no-snapshot', '-no-boot-anim'],
      platform: 'android',
    })
  })

  test('a non-UUID iOS inventory ID follows its verified platform', async () => {
    const inventoryId = 'simulator-opaque-7'
    const launches: Array<Parameters<DeviceEngine['executeLaunch']>[0]> = []
    const engine: DeviceEngine = {
      ...fakeDeviceEngine,
      executeLaunch: async (launch) => {
        launches.push(launch)
        return fakeDeviceEngine.executeLaunch(launch)
      },
    }
    const { providers } = providersHarness(engine, {
      ios: [
        {
          id: inventoryId,
          kind: 'ios_simulator',
          name: 'Opaque Simulator',
          platform: 'ios',
          state: 'available',
          generation: 3,
          observedAt: '2026-09-27T00:00:00.000Z',
        },
      ],
      android: [],
    })

    const session = (await providers['dev.device.start']!(
      deviceCommand('dev.device.start', {
        inventoryId,
        expectedGeneration: 3,
        runtimeSessionId: sessionId,
      })
    )) as { inventoryId: string; kind: string; state: string }

    expect(session).toMatchObject({ inventoryId, kind: 'ios_simulator', state: 'attached' })
    expect(launches).toHaveLength(1)
    expect(launches[0]).toMatchObject({
      executable: 'xcrun',
      argv: ['simctl', 'boot', inventoryId],
      platform: 'ios',
    })
  })

  test('ambiguous opaque inventory IDs fail closed instead of selecting a platform', async () => {
    const inventoryId = 'shared-opaque-id'
    const launches: Array<Parameters<DeviceEngine['executeLaunch']>[0]> = []
    const engine: DeviceEngine = {
      ...fakeDeviceEngine,
      executeLaunch: async (launch) => {
        launches.push(launch)
        return fakeDeviceEngine.executeLaunch(launch)
      },
    }
    const { providers } = providersHarness(engine, {
      ios: [
        {
          id: inventoryId,
          kind: 'ios_simulator',
          name: 'Opaque Simulator',
          platform: 'ios',
          state: 'available',
          generation: 3,
          observedAt: '2026-09-27T00:00:00.000Z',
        },
      ],
      android: [
        {
          id: inventoryId,
          kind: 'android_emulator',
          name: 'Opaque AVD',
          platform: 'android',
          state: 'available',
          generation: 3,
          observedAt: '2026-09-27T00:00:00.000Z',
        },
      ],
    })

    expect(
      thrownCode(() => providers['dev.device.list']!(deviceCommand('dev.device.list', {})))
    ).toBe('identity_mismatch')
    await expect(
      providers['dev.device.start']!(
        deviceCommand('dev.device.start', {
          inventoryId,
          expectedGeneration: 3,
          runtimeSessionId: sessionId,
        })
      )
    ).rejects.toMatchObject({ code: 'identity_mismatch' })
    expect(launches).toHaveLength(0)
  })

  test('signed resource-bound starts use verified platform and recover after launch failure', async () => {
    const inventoryId = '00000000-0000-4000-8000-000000000456'
    const launches: Array<Parameters<DeviceEngine['executeLaunch']>[0]> = []
    let failFirstLaunch = true
    const engine: DeviceEngine = {
      ...fakeDeviceEngine,
      executeLaunch: async (launch) => {
        launches.push(launch)
        if (failFirstLaunch) {
          failFirstLaunch = false
          throw new Error('scripted emulator launch failure')
        }
        return fakeDeviceEngine.executeLaunch(launch)
      },
    }
    const { sessions, providers } = providersHarness(engine, {
      ios: [],
      android: [
        {
          id: inventoryId,
          kind: 'android_emulator',
          name: 'UUIDNamedAVD',
          platform: 'android',
          state: 'available',
          generation: 7,
          observedAt: '2026-09-27T00:00:00.000Z',
        },
      ],
    })
    const authority = createChannelAuthority({
      shellHost: '127.0.0.1',
      shellOrigin: 'https://127.0.0.1:4789',
    })
    for (const operation of ['dev.device.list', 'dev.device.start'] as const) {
      const provider = providers[operation]!
      authority.registerCommandProvider(operation, async (command) => {
        try {
          return await provider(command)
        } catch (error) {
          throw deviceProviderError(error)
        }
      })
    }
    const bootstrap = authority.issueLaunchBootstrap()
    const now = Date.now()
    const handshake = authority.handshake(
      {
        schemaVersion: 1,
        method: 'dev.runtime.handshake.v1',
        requestId: randomUUID(),
        bootstrap,
        supportedProtocolVersions: ['1'],
        nonce: randomBytes(16).toString('base64url'),
        issuedAt: new Date(now - 1000).toISOString(),
        expiresAt: new Date(now + 30_000).toISOString(),
      },
      { trusted: true }
    )
    expect(handshake.ok).toBe(true)
    if (!handshake.ok) throw new Error('channel handshake refused')
    const identity = {
      channelId: handshake.channelId,
      clientCredentialId: handshake.clientCredentialId,
    }
    const secret = Buffer.from(handshake.clientSecret, 'base64url')
    const issue = (
      operation: DevOperation,
      body: Record<string, unknown>,
      resource?: DevCommand['resource']
    ): DevCommand => ({
      schemaVersion: 1,
      operation,
      requestId: randomUUID(),
      nonce: randomBytes(16).toString('base64url'),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      scope,
      capabilities: devOperationDefinitions[operation].capabilities,
      ...(resource ? { resource } : {}),
      body,
    })
    const execute = (command: DevCommand) => {
      const proof = createHmac('sha256', secret)
        .update(
          devCommandProofMessage({
            channelId: identity.channelId,
            clientCredentialId: identity.clientCredentialId,
            command,
          }),
          'utf8'
        )
        .digest('base64url')
      return authority.execute(
        {
          channelId: identity.channelId,
          clientCredentialId: identity.clientCredentialId,
          command,
          proof,
        },
        { trusted: true }
      )
    }

    const listed = await execute(issue('dev.device.list', {}))
    expect(listed.ok).toBe(true)
    if (!listed.ok) throw new Error('signed inventory list failed')
    const listedItem = (listed.value as { items: { id: string; generation: number }[] }).items.find(
      (item) => item.id === inventoryId
    )!

    const startCommand = (expectedGeneration: number) =>
      issue(
        'dev.device.start',
        { inventoryId, expectedGeneration, runtimeSessionId: sessionId },
        { kind: 'device_inventory', id: inventoryId, generation: expectedGeneration }
      )
    const stale = await execute(startCommand(listedItem.generation - 1))
    expect(stale).toMatchObject({ ok: false, error: { code: 'stale_generation' } })

    const failed = await execute(startCommand(listedItem.generation))
    expect(failed).toMatchObject({ ok: false, error: { code: 'invalid_state' } })
    expect(sessions.list({ runtimeSessionId: sessionId }).map((item) => item.state)).toEqual([
      'stopped',
    ])

    const recovered = await execute(startCommand(listedItem.generation))
    expect(recovered.ok).toBe(true)
    if (!recovered.ok) throw new Error('retry after launch failure did not recover')
    expect(recovered.value).toMatchObject({
      inventoryId,
      kind: 'android_emulator',
      state: 'attached',
      startedByAdea: true,
    })
    expect(launches.map((launch) => launch.platform)).toEqual(['android', 'android'])
    expect(sessions.list({ runtimeSessionId: sessionId }).map((item) => item.state)).toEqual([
      'stopped',
      'attached',
    ])
  })

  test('reserved responsive inventory ID collisions fail closed in list', () => {
    const { providers } = providersHarness(undefined, {
      ios: [],
      android: [
        {
          id: 'adea:responsive',
          kind: 'android_emulator',
          name: 'malformed AVD collision',
          platform: 'android',
          state: 'available',
          generation: 1,
          observedAt: '2026-09-27T00:00:00.000Z',
        },
      ],
    })

    expect(
      thrownCode(() => providers['dev.device.list']!(deviceCommand('dev.device.list', {})))
    ).toBe('identity_mismatch')
  })

  test('reserved responsive inventory ID collisions fail closed in start', async () => {
    const launches: Array<Parameters<DeviceEngine['executeLaunch']>[0]> = []
    const engine: DeviceEngine = {
      ...fakeDeviceEngine,
      executeLaunch: async (launch) => {
        launches.push(launch)
        return fakeDeviceEngine.executeLaunch(launch)
      },
    }
    const { providers } = providersHarness(engine, {
      ios: [],
      android: [
        {
          id: 'adea:responsive',
          kind: 'android_emulator',
          name: 'malformed AVD collision',
          platform: 'android',
          state: 'available',
          generation: 1,
          observedAt: '2026-09-27T00:00:00.000Z',
        },
      ],
    })

    await expect(
      providers['dev.device.start']!(
        deviceCommand('dev.device.start', {
          inventoryId: 'adea:responsive',
          expectedGeneration: 1,
          runtimeSessionId: sessionId,
        })
      )
    ).rejects.toMatchObject({ code: 'identity_mismatch' })
    expect(launches).toHaveLength(0)
  })

  test('session listing stays inside the command account, workspace and runtime node', () => {
    const { sessions, providers } = providersHarness(undefined)
    const own = sessions.startResponsive(scope, sessionId)
    for (const field of ['accountId', 'workspaceId', 'runtimeNodeId'] as const)
      sessions.startResponsive(
        { ...scope, [field]: '00000000-0000-4000-8000-000000000099' },
        sessionId
      )
    const ownOther = sessions.startResponsive(scope, '00000000-0000-4000-8000-0000000000b2')
    const filtered = providers['dev.device.sessions']!(
      deviceCommand('dev.device.sessions', { runtimeSessionId: sessionId })
    ) as { items: { id: string }[] }
    expect(filtered.items.map((item) => item.id)).toEqual([own.id])
    const all = providers['dev.device.sessions']!(deviceCommand('dev.device.sessions', {})) as {
      items: { id: string }[]
    }
    expect(all.items.map((item) => item.id)).toEqual([own.id, ownOther.id])
  })

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
