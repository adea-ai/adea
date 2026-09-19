// dev.browser.* command providers and the browser-frames-v1 stream mapping.
//
// Handlers run behind the M10 gate (which has already verified the channel,
// proof, replay, expiry, registry capabilities, and scope shape); these
// handlers enforce the resource-level preconditions: lane existence, scope
// identity, expected generation, lane permission policy, and the navigation
// SSRF policy. Operations that require a live lane engine (Bun.WebView for
// the task-owned lane, CDP for the user-context lane) are wired through an
// injectable engine seam; without one they return the typed
// `capability_unavailable` instead of pretending success.
import type {
  DevCommand,
  DevErrorCode,
  DevStreamGrant,
  ScreenshotRef,
} from '../../../../../../packages/types/src/dev-runtime'
import type { ChannelIdentity } from '../channel/authority'

import { CookieImportError } from './cookie-import'
import { createLaneDiagnostics, type LaneDiagnostics } from './diagnostics'
import {
  BrowserLaneError,
  type BrowserLaneRegistry,
  type BrowserLaneRecord,
  type LaneKind,
} from './lane-registry'
import {
  evaluateNavigation,
  type AdeaOwnedService,
  type LaneHostAddress,
} from './navigation-policy'
import { ScreenshotStoreError } from './screenshots'

export class DevCommandProviderError extends Error {
  readonly code: DevErrorCode
  readonly retryable: boolean
  constructor(code: DevErrorCode, message: string, retryable = false) {
    super(message)
    this.name = 'DevCommandProviderError'
    this.code = code
    this.retryable = retryable
  }
}

/** One navigation/target view of a lane owned by a live engine. */
export type LaneEngine = Readonly<{
  /** Lists live targets (pages/frames/workers) for the lane. */
  targets(lane: BrowserLaneRecord): readonly Readonly<{
    id: string
    type: 'page' | 'frame' | 'worker'
    url: string
    title: string
  }>[]
  /** Captures a PNG/JPEG/WebP screenshot of the lane's active target. */
  screenshot(
    lane: BrowserLaneRecord,
    input: Readonly<{ targetId?: string; format: 'png' | 'jpeg' | 'webp'; quality?: number }>
  ): Promise<Readonly<{ bytes: Uint8Array; width: number; height: number }>>
  /** Reads a DOM element description for the picker/inspect flow. */
  inspect(
    lane: BrowserLaneRecord,
    input: Readonly<{ targetId: string; selector?: string }>
  ): Promise<
    Readonly<{
      nodeId?: string
      role?: string
      name?: string
      bounds?: { x: number; y: number; width: number; height: number }
    }>
  >
  /** Applies a navigation inside the engine after policy admitted it. */
  navigate(
    lane: BrowserLaneRecord,
    url: string
  ): Promise<Readonly<{ targetId: string; status?: number }>>
}>

export type ScreenshotRecorder = Readonly<{
  record(input: {
    bytes: Uint8Array
    format: 'png' | 'jpeg' | 'webp'
    width: number
    height: number
    provenance: {
      ownerId: string
      laneKind: 'human_embedded' | 'task_owned' | 'user_context' | 'device'
      profileId?: string
      origin: string
      viewport: { width: number; height: number; deviceScaleFactor: number }
      redacted: boolean
    }
  }): ScreenshotRef
}>

export type BrowserProvidersInput = Readonly<{
  lanes: BrowserLaneRegistry
  mintStreamGrant?: (input: {
    identity: ChannelIdentity
    scope: DevCommand['scope']
    resource: { kind: 'browser_lane'; id: string; generation: number }
    direction: 'read' | 'write'
    fromSequence?: string
  }) => DevStreamGrant
  diagnostics?: Map<string, LaneDiagnostics>
  /** Resolves a hostname to addresses for the SSRF/rebinding check. */
  resolveDns: (hostname: string) => Promise<readonly LaneHostAddress[]>
  /** Proven Adea-owned loopback services on this runtime node. */
  ownedServices: () => readonly AdeaOwnedService[]
  /** Live lane engine seam; absent engines fail typed-unavailable. */
  engine?: LaneEngine
  screenshotRecorder: ScreenshotRecorder
}>

function assertScopeMatch(command: DevCommand, lane: BrowserLaneRecord): void {
  const scope = command.scope
  if (
    lane.scope.accountId !== scope.accountId ||
    lane.scope.workspaceId !== scope.workspaceId ||
    lane.scope.runtimeNodeId !== scope.runtimeNodeId
  )
    throw new DevCommandProviderError(
      'profile_scope_denied',
      'lane belongs to another account/workspace/runtime node'
    )
}

function body(command: DevCommand): Record<string, unknown> {
  return command.body as Record<string, unknown>
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new DevCommandProviderError('invalid_state', `body.${field} is required`)
  return value
}

export function createBrowserProviders(input: BrowserProvidersInput) {
  const diagnostics = input.diagnostics ?? new Map<string, LaneDiagnostics>()
  const diagnosticsFor = (laneId: string): LaneDiagnostics => {
    const existing = diagnostics.get(laneId)
    if (existing) return existing
    const created = createLaneDiagnostics()
    diagnostics.set(laneId, created)
    return created
  }

  function laneFor(command: DevCommand): BrowserLaneRecord {
    const laneId = requireString(body(command).browserLaneId, 'browserLaneId')
    const lane = input.lanes.get(laneId)
    assertScopeMatch(command, lane)
    return lane
  }

  function expectedGeneration(command: DevCommand): number {
    const value = body(command).expectedGeneration
    if (typeof value !== 'number')
      throw new DevCommandProviderError('stale_generation', 'body.expectedGeneration is required')
    return value
  }

  function assertGeneration(lane: BrowserLaneRecord, expected: number): void {
    if (lane.generation !== expected)
      throw new DevCommandProviderError(
        'stale_generation',
        `lane generation is ${lane.generation}, command expected ${expected}`
      )
  }

  const unavailableEngine = (): never => {
    throw new DevCommandProviderError(
      'capability_unavailable',
      'no lane engine is attached for this browser lane',
      true
    )
  }

  const providers: Partial<
    Record<string, (command: DevCommand, identity?: ChannelIdentity) => unknown | Promise<unknown>>
  > = {
    'dev.browser.laneCreate': (command) => {
      const req = body(command)
      const runtimeSessionId = requireString(req.runtimeSessionId, 'runtimeSessionId')
      const kind = requireString(req.kind, 'kind') as LaneKind
      if (!['human_embedded', 'task_owned', 'user_context'].includes(kind))
        throw new DevCommandProviderError('invalid_state', 'unknown lane kind')
      const lane = input.lanes.create({
        scope: command.scope,
        runtimeSessionId,
        kind,
        profilePolicyId: typeof req.profilePolicyId === 'string' ? req.profilePolicyId : undefined,
      })
      diagnosticsFor(lane.id)
      return lane
    },
    'dev.browser.lanes': (command) => {
      const req = body(command)
      const page = input.lanes.list(
        {
          scope: command.scope,
          runtimeSessionId:
            typeof req.runtimeSessionId === 'string' ? req.runtimeSessionId : undefined,
          kind: typeof req.kind === 'string' ? (req.kind as LaneKind) : undefined,
        },
        {
          cursor: typeof req.cursor === 'string' ? req.cursor : undefined,
          limit: typeof req.limit === 'number' ? req.limit : undefined,
        }
      )
      return {
        items: page.items,
        nextCursor: page.nextCursor,
        observedAt: new Date().toISOString(),
      }
    },
    'dev.browser.laneClose': (command) => {
      const lane = laneFor(command)
      const expected = expectedGeneration(command)
      assertGeneration(lane, expected)
      return input.lanes.close(lane.id, expected)
    },
    'dev.browser.navigate': async (command) => {
      const lane = laneFor(command)
      assertGeneration(lane, expectedGeneration(command))
      const url = requireString(body(command).url, 'url')
      const owned = input.ownedServices()
      let resolved: LaneHostAddress[] = []
      try {
        resolved = [...(await input.resolveDns(new URL(url).hostname))]
      } catch {
        resolved = []
      }
      const decision = evaluateNavigation({
        url,
        resolvedAddresses: resolved,
        ownedServices: owned,
      })
      if (!decision.allowed) {
        diagnosticsFor(lane.id).policy(`navigation refused: ${decision.reason}`)
        throw new DevCommandProviderError(
          decision.code === 'ssrf_blocked' ? 'ssrf_blocked' : 'navigation_blocked',
          decision.reason
        )
      }
      input.lanes.navigate(lane.id)
      try {
        const result = input.engine
          ? await input.engine.navigate(lane, decision.normalizedUrl)
          : unavailableEngine()
        const ready = input.lanes.markReady(lane.id)
        return {
          browserLaneId: ready.id,
          targetId: result.targetId,
          finalUrl: decision.normalizedUrl,
          ...(result.status !== undefined ? { status: result.status } : {}),
          generation: ready.generation,
          observedAt: new Date().toISOString(),
        }
      } catch (error) {
        if (error instanceof DevCommandProviderError) {
          // Host tools are optional: an unavailable engine rolls back the
          // transient navigating state so recovery can retry; a real engine
          // fault is terminal for this generation.
          if (error.code === 'capability_unavailable') input.lanes.markIdle(lane.id)
          throw error
        }
        input.lanes.markCrashed(lane.id)
        diagnosticsFor(lane.id).crash('lane crashed during navigation')
        throw new DevCommandProviderError(
          'crash_loop',
          'lane engine crashed during navigation',
          true
        )
      }
    },
    'dev.browser.targets': (command) => {
      const lane = laneFor(command)
      const targets = input.engine ? input.engine.targets(lane) : unavailableEngine()
      return {
        items: targets.map((target) => ({
          ...target,
          browserLaneId: lane.id,
          generation: lane.generation,
        })),
        observedAt: new Date().toISOString(),
      }
    },
    'dev.browser.viewport': (command) => {
      const lane = laneFor(command)
      const req = body(command)
      return input.lanes.viewport(lane.id, expectedGeneration(command), {
        width: Number(req.width),
        height: Number(req.height),
        deviceScaleFactor: Number(req.deviceScaleFactor),
        mobile: req.mobile === true,
      })
    },
    'dev.browser.screenshot': async (command) => {
      const lane = laneFor(command)
      assertGeneration(lane, expectedGeneration(command))
      const req = body(command)
      const format = requireString(req.format, 'format') as 'png' | 'jpeg' | 'webp'
      const capture = input.engine
        ? await input.engine.screenshot(lane, {
            targetId: typeof req.targetId === 'string' ? req.targetId : undefined,
            format,
            quality: typeof req.quality === 'number' ? req.quality : undefined,
          })
        : unavailableEngine()
      return input.screenshotRecorder.record({
        bytes: capture.bytes,
        format,
        width: capture.width,
        height: capture.height,
        provenance: {
          ownerId: lane.id,
          laneKind: lane.kind,
          profileId: lane.profileId,
          origin: lane.state,
          viewport: {
            width: lane.viewport.width,
            height: lane.viewport.height,
            deviceScaleFactor: lane.viewport.deviceScaleFactor,
          },
          redacted: true,
        },
      })
    },
    'dev.browser.annotate': (command) => {
      const lane = laneFor(command)
      assertGeneration(lane, expectedGeneration(command))
      // Annotations persist with the screenshot provenance inside the engine
      // seam; without an attached engine the operation stays typed-unavailable.
      return unavailableEngine()
    },
    'dev.browser.inspect': async (command) => {
      const lane = laneFor(command)
      assertGeneration(lane, expectedGeneration(command))
      const req = body(command)
      const targetId = requireString(req.targetId, 'targetId')
      const inspection = input.engine
        ? await input.engine.inspect(lane, {
            targetId,
            selector: typeof req.selector === 'string' ? req.selector : undefined,
          })
        : unavailableEngine()
      return { ...inspection, targetId, observedAt: new Date().toISOString() }
    },
    'dev.browser.diagnostics': (command) => {
      const lane = laneFor(command)
      const req = body(command)
      const page = diagnosticsFor(lane.id).page(
        typeof req.cursor === 'string' ? req.cursor : undefined,
        typeof req.limit === 'number' ? req.limit : undefined
      )
      return {
        items: page.items,
        nextCursor: page.nextCursor,
        observedAt: new Date().toISOString(),
      }
    },
    'dev.browser.takeover': (command) => {
      const lane = laneFor(command)
      return input.lanes.takeover(lane.id, expectedGeneration(command))
    },
    'dev.browser.release': (command) => {
      const lane = laneFor(command)
      return input.lanes.release(lane.id, expectedGeneration(command))
    },
    'dev.browser.profileReset': (command) => {
      const lane = laneFor(command)
      const confirmationId = requireString(body(command).confirmationId, 'confirmationId')
      return input.lanes.profileReset(lane.id, expectedGeneration(command), confirmationId)
    },
    'dev.browser.profilePolicies': () => ({
      items: input.lanes.profilePolicies(),
      observedAt: new Date().toISOString(),
    }),
    'dev.browser.attach': (command, identity) => {
      const lane = laneFor(command)
      assertGeneration(lane, expectedGeneration(command))
      const requestBody = body(command)
      if (!identity || !input.mintStreamGrant)
        throw new DevCommandProviderError(
          'capability_unavailable',
          'channel stream grant unavailable',
          true
        )
      return input.mintStreamGrant({
        identity,
        scope: command.scope,
        resource: { kind: 'browser_lane', id: lane.id, generation: lane.generation },
        direction: 'read',
        fromSequence:
          typeof requestBody.fromSequence === 'string' ? requestBody.fromSequence : undefined,
      })
    },
    'dev.browser.input': (command, identity) => {
      const lane = laneFor(command)
      assertGeneration(lane, expectedGeneration(command))
      const requestBody = body(command)
      if (!identity || !input.mintStreamGrant)
        throw new DevCommandProviderError(
          'capability_unavailable',
          'channel stream grant unavailable',
          true
        )
      return input.mintStreamGrant({
        identity,
        scope: command.scope,
        resource: { kind: 'browser_lane', id: lane.id, generation: lane.generation },
        direction: 'write',
        fromSequence:
          typeof requestBody.fromSequence === 'string' ? requestBody.fromSequence : undefined,
      })
    },
    'dev.browser.cookieImportPlan': (command) => {
      const lane = laneFor(command)
      assertGeneration(lane, expectedGeneration(command))
      // Plan building needs the source-profile reader seam, owned by the
      // vault integration; without it the plan/commit pair stays
      // typed-unavailable.
      return unavailableEngine()
    },
    'dev.browser.cookieImportCommit': (command) => {
      laneFor(command)
      return unavailableEngine()
    },
  }

  // Every handler is wrapped async so provider failures surface as typed
  // DevError codes through the M10 execute reply, never as raw throws.
  const mapped: Partial<
    Record<string, (command: DevCommand, identity?: ChannelIdentity) => Promise<unknown>>
  > = {}
  for (const [operation, handler] of Object.entries(providers)) {
    if (!handler) continue
    mapped[operation] = async (command: DevCommand, identity?: ChannelIdentity) => {
      try {
        return await handler(command, identity)
      } catch (error) {
        throw browserProviderError(error)
      }
    }
  }

  return { providers: mapped, diagnosticsFor }
}

export function browserProviderError(error: unknown): DevCommandProviderError {
  if (error instanceof DevCommandProviderError) return error
  if (error instanceof BrowserLaneError)
    return new DevCommandProviderError(
      error.code as DevErrorCode,
      error.message,
      error.code === 'invalid_state'
    )
  if (error instanceof CookieImportError)
    return new DevCommandProviderError(error.code as DevErrorCode, error.message)
  if (error instanceof ScreenshotStoreError)
    return new DevCommandProviderError(error.code as DevErrorCode, error.message)
  return new DevCommandProviderError('invalid_state', 'browser provider failed', false)
}
