// Registration entry for the #422 browser/device providers.
//
// `createChannelAuthority` gates every command; this module registers the
// browser and device providers onto it so `dev.browser.*` / `dev.device.*`
// operations dispatch through the M10 execute path, and binds the
// `browser-frames-v1` stream handler to the bounded-publication screencast.
//
// Stream-grant note: the provider seam accepts channel identity, but this
// registration has no live browser/device frame engine. Attach/input therefore
// remain typed-unavailable until the stream engine and #400 event attachment
// are installed; never mint a grant for a stream that cannot be served.
import type { DevCommand, DevOperation } from '../../../../../../packages/types/src/dev-runtime'

import { createDeviceSessionRegistry, type VerifiedInventory } from '../devices/device-sessions'
import { parseAdbDevices, parseAvdList, parseSimctlDevicesJson } from '../devices/inventory'
import { createDeviceProviders, deviceProviderError } from '../devices/providers'
import type { ChannelAuthority } from '../channel/authority'
import type { ChannelGateway } from '../channel/server'
import { createCookieImportService } from './cookie-import'
import { createBrowserLaneRegistry } from './lane-registry'
import { evaluateNavigation, type AdeaOwnedService } from './navigation-policy'
import { createPortInventory } from './port-inventory'
import { browserProviderError, createBrowserProviders } from './providers'
import { createScreenshotStore } from './screenshots'

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

export function registerBrowserDeviceRuntime(input: BrowserDeviceRuntimeInput) {
  const lanes = createBrowserLaneRegistry()
  const cookies = createCookieImportService()
  const screenshots = createScreenshotStore({ scope: input.scope ?? LOCAL_SCOPE })
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
  const deviceSessions = createDeviceSessionRegistry()
  let verifiedInventory: { ios?: VerifiedInventory; android?: VerifiedInventory } = {}
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
    verifiedInventory = {
      ...(iosItems.length ? { ios: { items: iosItems, observedAt } } : {}),
      ...(androidItems.length ? { android: { items: androidItems, observedAt } } : {}),
    }
  }
  void refreshInventory()

  const browser = createBrowserProviders({
    lanes,
    resolveDns: input.resolveDns ?? (async () => []),
    ownedServices: input.ownedServices ?? (() => []),
    screenshotRecorder: screenshots,
  })
  input.authority.registerStreamProvider('browser-frames-v1')
  input.authority.registerStreamProvider('device-frames-v1')
  const devices = createDeviceProviders({
    sessions: deviceSessions,
    verifiedInventory: () => verifiedInventory,
    iosInputHint: 'simctl exposes no tap; a future automation helper may add it',
  })
  if (input.gateway) {
    input.gateway.registerStreamHandler('browser-frames-v1', unavailableStream)
    input.gateway.registerStreamHandler('device-frames-v1', unavailableStream)
  }

  function register(
    providers: Partial<
      Record<
        string,
        (
          command: DevCommand,
          identity?: import('../channel/authority').ChannelIdentity
        ) => unknown | Promise<unknown>
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
  }
}

export type BrowserDeviceRuntime = ReturnType<typeof registerBrowserDeviceRuntime>
