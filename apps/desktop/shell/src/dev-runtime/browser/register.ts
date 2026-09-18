// Registration entry for the #422 browser/device providers.
//
// `createChannelAuthority` gates every command; this module registers the
// browser and device providers onto it so `dev.browser.*` / `dev.device.*`
// operations dispatch through the M10 execute path, and binds the
// `browser-frames-v1` stream handler to the bounded-publication screencast.
//
// Stream-grant minting note: the execute path does not carry the client's
// channel identity into command providers, so the browser/device
// `attach`/`input` handlers stay typed-unavailable until the wave owner
// threads channel identity through provider registration (recorded in the
// PR; the lane/screencast fencing is complete and tested at this layer).
import type { DevCommand, DevOperation } from '../../../../../../packages/types/src/dev-runtime'

import { createDeviceSessionRegistry } from '../devices/device-sessions'
import { createDeviceProviders, deviceProviderError } from '../devices/providers'
import type { ChannelAuthority } from '../channel/authority'
import { createCookieImportService } from './cookie-import'
import { createBrowserLaneRegistry } from './lane-registry'
import { evaluateNavigation, type AdeaOwnedService } from './navigation-policy'
import { createPortInventory } from './port-inventory'
import { browserProviderError, createBrowserProviders } from './providers'
import { createScreenshotStore } from './screenshots'

export type BrowserDeviceRuntimeInput = Readonly<{
  authority: ChannelAuthority
  /** Loopback services proven Adea-owned (launch/session metadata). */
  ownedServices?: () => readonly AdeaOwnedService[]
  /** Runs the optional loopback listener scan; failures are non-fatal. */
  runLsof?: () => Promise<string>
  /** DNS resolution for the navigation policy's rebinding check. */
  resolveDns?: (hostname: string) => Promise<readonly { address: string; family: 4 | 6 }[]>
  /** Runtime-node scope projection for the local shell (single node). */
  scope?: { accountId: string; workspaceId: string; runtimeNodeId: string }
}>

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

  const browser = createBrowserProviders({
    lanes,
    resolveDns: input.resolveDns ?? (async () => []),
    ownedServices: input.ownedServices ?? (() => []),
    screenshotRecorder: screenshots,
  })
  const devices = createDeviceProviders({
    sessions: deviceSessions,
    verifiedInventory: () => ({}),
    iosInputHint: 'simctl exposes no tap; a future automation helper may add it',
  })

  function register(
    providers: Partial<Record<string, (command: DevCommand) => unknown | Promise<unknown>>>,
    mapError: (error: unknown) => Error
  ): number {
    let count = 0
    for (const [operation, handler] of Object.entries(providers)) {
      if (!handler) continue
      input.authority.registerCommandProvider(
        operation as DevOperation,
        async (command: DevCommand) => {
          try {
            return await handler(command)
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
