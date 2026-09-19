// Registration entry and composition root for the #422 browser/device
// runtime.
//
// `createChannelAuthority` gates every command; this module registers the
// browser and device providers onto it so `dev.browser.*` / `dev.device.*`
// operations dispatch through the M10 execute path. Stream grants for
// `browser-frames-v1` / `device-frames-v1` are minted by the channel
// authority against the CALLER'S authenticated channel identity — a grant is
// bound to its channel, scope, resource, and generation, is single-use at
// attach, and expires (never minted for a stream no handler can serve: the
// gateway closes typed-`incompatible` until a frame engine is installed via
// `attachFrameHandler`).
//
// Engine seams: browser lane engines (Bun.WebView / CDP) and the device
// engine (simctl/adb/emulator host tooling) install through
// `attachBrowserEngine` / `setDeviceEngine`; without a browser engine the
// live-target operations return typed `capability_unavailable`. The device
// engine defaults to the real host implementation — its absence is a genuine
// toolchain absence, not omitted wiring.
import type { DevCommand, DevOperation } from '../../../../../../packages/types/src/dev-runtime'

import { createDeviceSessionRegistry, type VerifiedInventory } from '../devices/device-sessions'
import { createBunDeviceRunner, createHostDeviceEngine, type DeviceEngine } from '../devices/engine'
import { parseAdbDevices, parseAvdList, parseSimctlDevicesJson } from '../devices/inventory'
import { createDeviceProviders, deviceProviderError } from '../devices/providers'
import type { ChannelAuthority, ChannelIdentity } from '../channel/authority'
import type { ChannelGateway } from '../channel/server'
import { createCookieImportService } from './cookie-import'
import { createBrowserLaneRegistry } from './lane-registry'
import { evaluateNavigation, type AdeaOwnedService } from './navigation-policy'
import { createPortInventory } from './port-inventory'
import { browserProviderError, createBrowserProviders, type LaneEngine } from './providers'
import { createScreenshotStore, type ScreenshotStore } from './screenshots'

export type BrowserDeviceRuntimeInput = Readonly<{
  authority: ChannelAuthority
  gateway?: ChannelGateway
  /** Loopback services proven Adea-owned (launch/session metadata). */
  ownedServices?: () => readonly AdeaOwnedService[]
  /** Runs the optional loopback listener scan; failures are non-fatal. */
  runLsof?: () => Promise<string>
  /** DNS resolution for the navigation policy's rebinding check. */
  resolveDns?: (hostname: string) => Promise<readonly { address: string; family: 4 | 6 }[]>
  /** Runtime-node scope projection for the local shell (single node). */
  scope?: { accountId: string; workspaceId: string; runtimeNodeId: string }
  /** Overrides the host device engine (tests inject scripted runners). */
  deviceEngine?: DeviceEngine
}>

async function runDeviceProbe(argv: string[]): Promise<string> {
  try {
    const process = Bun.spawn(argv, { stdout: 'pipe', stderr: 'ignore' })
    const stdout = await new Response(process.stdout).text()
    await process.exited
    return stdout
  } catch {
    return ''
  }
}

const unavailableStream = (session: { close: (code: 'incompatible', reason?: string) => void }) =>
  session.close('incompatible', 'browser/device frame engine unavailable')

const LOCAL_SCOPE = {
  accountId: '00000000-0000-4000-8000-000000000000',
  workspaceId: '00000000-0000-4000-8000-000000000000',
  runtimeNodeId: '00000000-0000-4000-8000-000000000000',
} as const

type StreamProtocol = 'browser-frames-v1' | 'device-frames-v1'

export function registerBrowserDeviceRuntime(input: BrowserDeviceRuntimeInput) {
  const lanes = createBrowserLaneRegistry()
  const cookies = createCookieImportService()
  const screenshots: ScreenshotStore = createScreenshotStore({ scope: input.scope ?? LOCAL_SCOPE })
  const ports = createPortInventory({
    scope: input.scope ?? LOCAL_SCOPE,
    runLsof: input.runLsof ?? (() => Promise.reject(new Error('lsof unavailable'))),
    ownedServices: () =>
      (input.ownedServices?.() ?? []).map((service) => ({
        port: service.port,
        processRecordId: service.ownerId,
        ownerId: service.ownerId,
      })),
  })

  const deviceEngine: DeviceEngine =
    input.deviceEngine ?? createHostDeviceEngine(createBunDeviceRunner())
  const deviceSessions = createDeviceSessionRegistry({
    // Stop re-checks the launch identity immediately before signalling: an
    // iOS identity is device-scoped (boot state), an Android one is the
    // launched emulator process.
    probeProcess: (identity) => deviceEngine.probe(identity),
  })

  // Inventory probing: real host tooling where installed, parsed into
  // verified inventory items. Each refresh where the observed membership
  // changed bumps a generation so device start binds to verified facts.
  let verifiedInventory: { ios?: VerifiedInventory; android?: VerifiedInventory } = {}
  let inventoryGeneration = 0
  let inventorySignature = ''
  const refreshInventory = async () => {
    const observedAt = new Date().toISOString()
    const simctl = await runDeviceProbe(['xcrun', 'simctl', 'list', 'devices', '-j'])
    const adb = await runDeviceProbe(['adb', 'devices', '-l'])
    const avds = await runDeviceProbe(['emulator', '-list-avds'])
    const iosItems = parseSimctlDevicesJson(simctl).map((device) => ({
      id: device.udid,
      kind: 'ios_simulator' as const,
      name: device.name,
      platform: 'ios' as const,
      state: device.isAvailable === false ? ('offline' as const) : ('available' as const),
      generation: 0,
      observedAt,
    }))
    const androidItems = [
      ...parseAdbDevices(adb).map((device) => ({
        id: device.serial,
        kind: device.isEmulator ? ('android_emulator' as const) : ('physical' as const),
        name: device.model ?? device.serial,
        platform: 'android' as const,
        state: device.state === 'device' ? ('available' as const) : ('offline' as const),
        generation: 0,
        observedAt,
      })),
      ...parseAvdList(avds).map((name) => ({
        id: name,
        kind: 'android_emulator' as const,
        name,
        platform: 'android' as const,
        state: 'available' as const,
        generation: 0,
        observedAt,
      })),
    ]
    const items = [...iosItems, ...androidItems]
    const signature = JSON.stringify(items.map((item) => [item.id, item.state]))
    if (signature !== inventorySignature) inventoryGeneration += 1
    inventorySignature = signature
    const generated = items.map((item) => ({ ...item, generation: inventoryGeneration }))
    deviceSessions.setInventory(generated)
    verifiedInventory = {
      ...(iosItems.length
        ? { ios: { items: generated.filter((i) => i.platform === 'ios'), observedAt } }
        : {}),
      ...(androidItems.length
        ? { android: { items: generated.filter((i) => i.platform === 'android'), observedAt } }
        : {}),
    }
  }
  void refreshInventory()

  // Attach/input mint stream grants through the channel authority against
  // the caller's authenticated identity: bound to the channel, scope,
  // resource generation, single-use at attach, and expiring.
  const mintGrant =
    (protocol: StreamProtocol) =>
    (req: {
      identity: ChannelIdentity
      scope: DevCommand['scope']
      resource: { kind: string; id: string; generation: number }
      direction: 'read' | 'write'
      fromSequence?: string
    }) =>
      input.authority.mintStreamGrant({
        identity: req.identity,
        protocol,
        scope: req.scope,
        resource: req.resource,
        direction: req.direction,
        fromSequence: req.fromSequence,
      })

  const browser = createBrowserProviders({
    lanes,
    resolveDns: input.resolveDns ?? (async () => []),
    ownedServices: input.ownedServices ?? (() => []),
    screenshotRecorder: screenshots,
    mintStreamGrant: mintGrant('browser-frames-v1'),
  })
  input.authority.registerStreamProvider('browser-frames-v1')
  input.authority.registerStreamProvider('device-frames-v1')
  const devices = createDeviceProviders({
    sessions: deviceSessions,
    verifiedInventory: () => verifiedInventory,
    iosInputHint: 'simctl exposes no tap; a future automation helper may add it',
    engine: deviceEngine,
    screenshotRecorder: screenshots,
    mintStreamGrant: mintGrant('device-frames-v1'),
  })
  if (input.gateway) {
    // Frame streams stay typed-`incompatible` until a frame engine publishes
    // through `attachFrameHandler`; grants are never minted for streams the
    // gateway cannot serve.
    input.gateway.registerStreamHandler('browser-frames-v1', unavailableStream)
    input.gateway.registerStreamHandler('device-frames-v1', unavailableStream)
  }

  function register(
    providers: Partial<
      Record<
        string,
        (command: DevCommand, identity?: ChannelIdentity) => unknown | Promise<unknown>
      >
    >,
    mapError: (error: unknown) => Error
  ): number {
    let count = 0
    for (const [operation, handler] of Object.entries(providers)) {
      if (!handler) continue
      input.authority.registerCommandProvider(
        operation as DevOperation,
        async (command: DevCommand, identity) => {
          try {
            return await handler(command, identity)
          } catch (error) {
            throw mapError(error)
          }
        }
      )
      count += 1
    }
    return count
  }

  const browserCount = register(browser.providers, browserProviderError)
  const deviceCount = register(devices.providers, deviceProviderError)

  return {
    lanes,
    cookies,
    screenshots,
    ports,
    deviceSessions,
    navigation: evaluateNavigation,
    diagnosticsFor: browser.diagnosticsFor,
    registeredCommandCount: browserCount + deviceCount,
    /** Composition seam: installs (or clears) the live browser lane engine. */
    attachBrowserEngine(engine: LaneEngine | undefined): void {
      browser.setEngine(engine)
    },
    /** Composition seam: swaps the device engine (host tooling by default). */
    setDeviceEngine(engine: DeviceEngine | undefined): void {
      devices.setEngine(engine)
    },
    /**
     * Composition seam: a frame engine takes over a frames stream (bounded
     * screencast publication, gesture intake). Registering replaces the
     * typed-unavailable close for that protocol.
     */
    attachFrameHandler(
      protocol: StreamProtocol,
      handler: Parameters<ChannelGateway['registerStreamHandler']>[1]
    ): void {
      input.gateway?.registerStreamHandler(protocol, handler)
    },
    /** Re-probes host device inventory (launch metadata refresh). */
    refreshDevices: refreshInventory,
    deviceEngine,
  }
}

export type BrowserDeviceRuntime = ReturnType<typeof registerBrowserDeviceRuntime>
