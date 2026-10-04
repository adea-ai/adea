// Registration entry and composition root for the #472/#624 computer-use
// runtime.
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
// Frame publication (issue #624): the read direction of `desktop-frames-v1`
// is served by the capture stream (computeruse/capture.ts), which gates every
// attach on a FRESH screen-recording preflight and every publication tick on
// the lane's authority fences (generation, owner, live consent). Revocation
// paths (takeover, release, kill switch, crash, session teardown) stop
// attached streams synchronously through the wrapped lane registry. Capture
// is typed-unavailable — never stubbed — whenever the preflight cannot prove
// the grant.
//
// Engine seams: the input engine defaults to the real host implementation
// (fixed-argv osascript); the capture source defaults to the real macOS
// `screencapture` host tool (fixed argv, engine-owned temp path). Tests
// inject scripted engines, so CI never performs real input or capture.
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
import type { OwnerApprovalVerifier } from '../authority'
import { createComputerUseCapabilityService } from './capability'
import { createDesktopFrameStream, type DesktopFrameAuditEntry } from './capture'
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
  /**
   * Required. The durable owner-approval authority the consent gate consumes
   * its human-presence proof from; without it `dev.computeruse.consent` could
   * only trust a caller-supplied string.
   */
  approvalVerifier: OwnerApprovalVerifier
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
  /** Bounded, secret-free audit of frame publication decisions (#624). */
  audit?: (entry: DesktopFrameAuditEntry) => void
  /**
   * Publication tick interval for the desktop-frames read stream (#624);
   * defaults to one frame at the budget FPS. Evidence lanes shorten it so a
   * proof observes several boundaries without real-time waits.
   */
  frameTickMs?: number
  /**
   * Freshness window for the consent gate's permission re-verification;
   * defaults to the spec window. Evidence lanes shorten it so a flipped TCC
   * state is observable within a bounded test.
   */
  permissionFreshnessMs?: number
}>

export function registerComputerUseRuntime(input: ComputerUseRuntimeInput) {
  const baseLanes = createComputerUseLaneRegistry()
  // Synchronous frame-stream revocation (#624): every authority transfer or
  // kill path stops the lane's attached frame streams in the same call, so
  // the very next interaction after revocation cannot publish. The
  // publication ticks re-derive the same fences as defense in depth.
  let frameStreams: ReturnType<typeof createDesktopFrameStream> | undefined
  const lanes: ComputerUseLaneRegistry = {
    ...baseLanes,
    activate: (id, consent) => {
      const record = baseLanes.activate(id, consent)
      frameStreams?.stopForLane(id, 'stale_generation', 'computer-use lane generation changed')
      return record
    },
    takeover: (id, expectedGeneration) => {
      const record = baseLanes.takeover(id, expectedGeneration)
      frameStreams?.stopForLane(id, 'stale_generation', 'computer-use lane generation changed')
      return record
    },
    release: (id, expectedGeneration) => {
      const record = baseLanes.release(id, expectedGeneration)
      frameStreams?.stopForLane(id, 'stale_generation', 'computer-use lane generation changed')
      return record
    },
    close: (id, expectedGeneration) => {
      const record = baseLanes.close(id, expectedGeneration)
      frameStreams?.stopForLane(id, 'revoked', 'computer-use lane is closed')
      return record
    },
    markCrashed: (id) => {
      const record = baseLanes.markCrashed(id)
      frameStreams?.stopForLane(id, 'incompatible', 'computer-use lane is crashed')
      return record
    },
    closeForSession: (runtimeSessionId) => {
      const victims = baseLanes.list({ runtimeSessionId }).items.map((record) => record.id)
      baseLanes.closeForSession(runtimeSessionId)
      for (const id of victims)
        frameStreams?.stopForLane(id, 'revoked', 'computer-use lane is closed')
    },
  }
  const macPermissions = input.macPermissions ?? createMacPermissionService({})
  const capabilities = createComputerUseCapabilityService({
    permissions: macPermissions,
    platform: input.platform,
  })
  const gate = createConsentGate({
    permissions: macPermissions,
    capabilities,
    approvalVerifier: input.approvalVerifier,
    ...(input.permissionFreshnessMs !== undefined
      ? { freshnessMs: input.permissionFreshnessMs }
      : {}),
  })
  // The default engine runs the #471 fixed-argv host command runner (bounded
  // deadline); tests inject a scripted engine instead, so CI never performs
  // real input or capture.
  let engine: ComputerUseEngine | undefined =
    input.engine ?? createHostComputerUseEngine(createHostCommandRunner({ timeoutMs: 5_000 }))

  // Frame publication (issue #624): the read-direction desktop-frames-v1
  // handler gates every attach on a fresh capture preflight and serves
  // bounded, throttled, consent-fenced frames. Publication is composed
  // whenever a gateway exists — whether frames actually flow is decided by
  // the preflight and the fences, never by composition.
  frameStreams = input.gateway
    ? createDesktopFrameStream({
        lanes,
        gate,
        captureRow: async () => {
          const report = await capabilities.report({ force: true })
          return report.capabilities.find((row) => row.id === 'capture')
        },
        engine: () => engine,
        ...(input.audit ? { audit: input.audit } : {}),
        ...(input.frameTickMs !== undefined ? { tickMs: input.frameTickMs } : {}),
      })
    : undefined

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

  if (input.gateway && frameStreams) {
    input.gateway.registerStreamHandler('desktop-frames-v1', (session) => {
      if (session.grant.direction === 'read') {
        // Read direction: bounded frame publication behind the capture
        // preflight and the lane authority fences (#624). A lane whose
        // capture cannot be proven closes typed before any frame exists.
        frameStreams?.handleSession(session)
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
