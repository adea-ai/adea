// Registration entry and composition root for the #472 computer-use runtime.
//
// `createChannelAuthority` gates every command; this module registers the
// computer-use providers onto it so `dev.computeruse.*` operations dispatch
// through the M10 execute path. The permission substrate is the #471 shell
// service (consumed, never modified): consent records are minted against
// fresh snapshots and re-verified inside their freshness window. Stream
// grants for `desktop-frames-v1` are minted by the channel authority against
// the CALLER'S authenticated channel identity — single-use at attach,
// expiring, bound to the lane resource and generation.
//
// Engine seams: the capture engine stays absent in this lane (the native
// screen-recording helper is deferred), so read-direction frame streams
// close typed-`incompatible` exactly like the browser lane's until a frame
// engine is attached. The input engine defaults to the real host
// implementation (fixed-argv osascript) — its absence on a host is a genuine
// toolchain absence, and the consent gate refuses admission long before the
// engine runs where the accessibility grant cannot be proven.
import type {
  DevCommand,
  DevOperation,
  DevStreamFrame,
} from '../../../../../../packages/types/src/dev-runtime'

import {
  createHostCommandRunner,
  createMacPermissionService,
  type MacPermissionService,
} from '../../desktop-permissions'
import type { ChannelAuthority, ChannelIdentity } from '../channel/authority'
import type { ChannelGateway } from '../channel/server'
import { createComputerUseCapabilityService } from './capability'
import { createConsentGate } from './consent-gate'
import { createHostComputerUseEngine, type ComputerUseEngine } from './engine'
import { createComputerUseLaneRegistry, type ComputerUseLaneRegistry } from './lane-registry'
import {
  computerUseProviderError,
  createComputerUseProviders,
  type ComputerUseProviderError,
} from './providers'

export type ComputerUseRuntimeInput = Readonly<{
  authority: ChannelAuthority
  gateway?: ChannelGateway
  /** Runtime-node scope projection for the local shell (single node). */
  scope?: { accountId: string; workspaceId: string; runtimeNodeId: string }
  /** Overrides the #471 permission service (tests inject scripted probes). */
  macPermissions?: MacPermissionService
  /** Overrides the host input engine (tests inject scripted engines). */
  engine?: ComputerUseEngine
  /**
   * Pins the host platform class for the capability report's input-tool
   * default (macOS provides the system osascript); defaults to
   * `process.platform`. Tests and non-macOS host adapters inject it so the
   * granted-flow logic stays exercisable on every lane.
   */
  platform?: NodeJS.Platform
}>

const unavailableStream = (session: { close: (code: 'incompatible', reason?: string) => void }) =>
  session.close('incompatible', 'desktop frame engine unavailable (native capture helper deferred)')

export function registerComputerUseRuntime(input: ComputerUseRuntimeInput) {
  const lanes: ComputerUseLaneRegistry = createComputerUseLaneRegistry()
  const macPermissions = input.macPermissions ?? createMacPermissionService({})
  const capabilities = createComputerUseCapabilityService({
    permissions: macPermissions,
    platform: input.platform,
  })
  const gate = createConsentGate({ permissions: macPermissions, capabilities })
  // The default engine runs the #471 fixed-argv host command runner (bounded
  // deadline); tests inject a scripted engine instead, so CI never performs
  // real input.
  let engine: ComputerUseEngine | undefined =
    input.engine ?? createHostComputerUseEngine(createHostCommandRunner({ timeoutMs: 5_000 }))

  const computerUseProviders = createComputerUseProviders({
    lanes,
    gate,
    capabilities: () => capabilities.report(),
    engine: () => engine,
    mintStreamGrant: (req) =>
      input.authority.mintStreamGrant({
        identity: req.identity,
        protocol: 'desktop-frames-v1',
        scope: req.scope,
        resource: req.resource,
        direction: req.direction,
        fromSequence: req.fromSequence,
      }),
  })

  input.authority.registerStreamProvider('desktop-frames-v1')

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

  const registered = register(computerUseProviders.providers, computerUseProviderError)

  if (input.gateway) {
    input.gateway.registerStreamHandler('desktop-frames-v1', (session) => {
      if (session.grant.direction === 'read') {
        unavailableStream(session)
        return
      }
      // Write direction: input frames. The wire layer has verified
      // direction, monotonic sequence, grant generation, and frame size;
      // every authority decision is re-derived here from provider state.
      session.onFrame = (frame: DevStreamFrame) => {
        if (frame.type !== 'input') {
          session.close('incompatible', 'only input frames ride a desktop write stream')
          return
        }
        const laneId = session.grant.resource.id
        void computerUseProviders
          .admitInputFrame({
            laneId,
            generation: frame.generation,
            sequence: frame.sequence,
            bytes: frame.bytes,
          })
          .catch((error: ComputerUseProviderError) => {
            // A gate refusal closes the stream; stale generation closes it
            // typed so the client knows the grant is inert.
            const code =
              error.code === 'stale_generation'
                ? 'stale_generation'
                : error.code === 'rate_limited'
                  ? 'backpressure'
                  : 'revoked'
            session.close(code, error.message)
          })
      }
    })
  }

  return {
    lanes,
    gate,
    capabilities,
    registeredCommandCount: registered,
    /** Composition seam: swaps the input engine (tests inject scripted ones). */
    setEngine(next: ComputerUseEngine | undefined): void {
      engine = next
    },
    /**
     * Session teardown: closes every lane of the session (the grant dies
     * with its HarnessRun) and drops their consent records.
     */
    closeForSession(runtimeSessionId: string): void {
      lanes.closeForSession(runtimeSessionId)
    },
  }
}

export type ComputerUseRuntime = ReturnType<typeof registerComputerUseRuntime>
