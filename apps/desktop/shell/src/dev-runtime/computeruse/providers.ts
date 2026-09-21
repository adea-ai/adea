// dev.computeruse.* command providers (issue #472).
//
// Handlers run behind the M10 gate (which has already verified the channel,
// proof, replay, expiry, capability set, and scope shape); these handlers
// enforce the resource-level preconditions in order: lane existence, scope
// identity, expected generation, automation owner, live consent record, and
// fresh permission state. Every admission decision is made from
// provider-owned state — a consent id, engine, or harness claim is only ever
// a lookup key, never authority (the browser lane's per-hop admission-ledger
// pattern). Operations that need a live engine are wired through an
// injectable seam; without one they return typed `capability_unavailable`
// instead of pretending success.
import { decodeCbor } from '../../../../../../packages/types/src/dev-runtime'
import type {
  DevCommand,
  DevErrorCode,
  DevStreamGrant,
} from '../../../../../../packages/types/src/dev-runtime'
import type { ChannelIdentity } from '../channel/authority'
import type { ComputerUseCapabilityReport } from '../../../../../../packages/types/src/dev-runtime'
import {
  SCREENCAST_BUDGET_DEFAULTS,
  createLaneScreencast,
  type ScreencastBudget,
} from '../browser/screencast'
import {
  ComputerUseLaneError,
  type ComputerUseLaneRecord,
  type ComputerUseLaneRegistry,
} from './lane-registry'
import { ComputerUseGateError, type ComputerUseConsentGate } from './consent-gate'
import {
  ComputerUseEngineError,
  decodeComputerUseInputEvent,
  type ComputerUseEngine,
} from './engine'

export class ComputerUseProviderError extends Error {
  readonly code: DevErrorCode
  readonly retryable: boolean
  readonly remediation?: { action: string; parameters?: Record<string, string> }
  constructor(
    code: DevErrorCode,
    message: string,
    retryable = false,
    remediation?: { action: string; parameters?: Record<string, string> }
  ) {
    super(message)
    this.name = 'ComputerUseProviderError'
    this.code = code
    this.retryable = retryable
    this.remediation = remediation
  }
}

export type ComputerUseProvidersInput = Readonly<{
  lanes: ComputerUseLaneRegistry
  gate: ComputerUseConsentGate
  capabilities: () => Promise<ComputerUseCapabilityReport>
  engine?: () => ComputerUseEngine | undefined
  mintStreamGrant?: (input: {
    identity: ChannelIdentity
    scope: DevCommand['scope']
    resource: { kind: 'computeruse_lane'; id: string; generation: number }
    direction: 'read' | 'write'
    fromSequence?: string
  }) => DevStreamGrant
  /** Overrides the 240-events/second ledger cap (tests shrink it). */
  inputBudget?: Partial<ScreencastBudget>
  /** Bounded, secret-free audit of every authority decision. */
  audit?: (
    entry: Readonly<{
      operation: string
      laneId: string
      generation: number
      decision: 'allowed' | 'refused'
      code?: string
      detail?: string
    }>
  ) => void
}>

function assertScopeMatch(command: DevCommand, lane: ComputerUseLaneRecord): void {
  const scope = command.scope
  if (
    lane.scope.accountId !== scope.accountId ||
    lane.scope.workspaceId !== scope.workspaceId ||
    lane.scope.runtimeNodeId !== scope.runtimeNodeId
  )
    throw new ComputerUseProviderError(
      'profile_scope_denied',
      'lane belongs to another account/workspace/runtime node'
    )
}

function body(command: DevCommand): Record<string, unknown> {
  return command.body as Record<string, unknown>
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new ComputerUseProviderError('invalid_state', `body.${field} is required`)
  return value
}

export function createComputerUseProviders(input: ComputerUseProvidersInput) {
  /**
   * Per-lane input admission ledgers: a bounded screencast (generation
   * fencing, sliding 240-events/second window, byte caps). Replay of an old
   * frame is already refused by the wire layer's monotonic sequence —
   * identical legitimate keystrokes must stay allowed, so events are never
   * content-compared here.
   */
  const ledgers = new Map<string, { screencast: ReturnType<typeof createLaneScreencast> }>()
  const ledgerFor = (laneId: string) => {
    const existing = ledgers.get(laneId)
    if (existing) return existing
    const created = {
      screencast: createLaneScreencast({
        budget: { ...SCREENCAST_BUDGET_DEFAULTS, ...input.inputBudget },
      }),
    }
    ledgers.set(laneId, created)
    return created
  }

  function laneFor(command: DevCommand): ComputerUseLaneRecord {
    const laneId = requireString(body(command).computerUseLaneId, 'computerUseLaneId')
    const lane = input.lanes.get(laneId)
    assertScopeMatch(command, lane)
    return lane
  }

  function expectedGeneration(command: DevCommand): number {
    const value = body(command).expectedGeneration
    if (typeof value !== 'number')
      throw new ComputerUseProviderError('stale_generation', 'body.expectedGeneration is required')
    return value
  }

  function assertGeneration(lane: ComputerUseLaneRecord, expected: number): void {
    if (lane.generation !== expected)
      throw new ComputerUseProviderError(
        'stale_generation',
        `lane generation is ${lane.generation}, command expected ${expected}`
      )
  }

  const audit = (entry: Parameters<NonNullable<ComputerUseProvidersInput['audit']>>[0]) =>
    input.audit?.(entry)

  function unavailableEngine(): ComputerUseEngine {
    throw new ComputerUseProviderError(
      'capability_unavailable',
      'no computer-use engine is attached for this lane',
      true
    )
  }

  function mintGrant(
    command: DevCommand,
    identity: ChannelIdentity | undefined,
    lane: ComputerUseLaneRecord,
    direction: 'read' | 'write',
    fromSequence: string | undefined
  ): DevStreamGrant {
    if (!identity || !input.mintStreamGrant)
      throw new ComputerUseProviderError(
        'capability_unavailable',
        'channel stream grant unavailable',
        true
      )
    return input.mintStreamGrant({
      identity,
      scope: command.scope,
      resource: { kind: 'computeruse_lane', id: lane.id, generation: lane.generation },
      direction,
      ...(fromSequence !== undefined ? { fromSequence } : {}),
    })
  }

  const handlers: Partial<
    Record<string, (command: DevCommand, identity?: ChannelIdentity) => unknown | Promise<unknown>>
  > = {
    'dev.computeruse.capabilities': async () => input.capabilities(),

    'dev.computeruse.laneCreate': (command) => {
      const runtimeSessionId = requireString(body(command).runtimeSessionId, 'runtimeSessionId')
      return input.lanes.create({ scope: command.scope, runtimeSessionId })
    },

    'dev.computeruse.lanes': (command) => {
      const req = body(command)
      const page = input.lanes.list(
        {
          scope: command.scope,
          runtimeSessionId:
            typeof req.runtimeSessionId === 'string' ? req.runtimeSessionId : undefined,
          state:
            typeof req.state === 'string'
              ? (req.state as ComputerUseLaneRecord['state'])
              : undefined,
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

    /**
     * Consent issuance: the only door to input authority. The gate proves
     * the #471 permission state fresh; the registry binds the record to the
     * next generation so everything minted before is inert.
     */
    'dev.computeruse.consent': async (command) => {
      const lane = laneFor(command)
      const expected = expectedGeneration(command)
      assertGeneration(lane, expected)
      const confirmationId = requireString(body(command).confirmationId, 'confirmationId')
      try {
        const consent = await input.gate.issue({
          scope: command.scope,
          lane: {
            id: lane.id,
            runtimeSessionId: lane.runtimeSessionId,
            generation: lane.generation,
          },
          confirmationId,
        })
        const activated = input.lanes.activate(lane.id, consent)
        audit({
          operation: 'dev.computeruse.consent',
          laneId: lane.id,
          generation: activated.generation,
          decision: 'allowed',
        })
        return consent
      } catch (error) {
        audit({
          operation: 'dev.computeruse.consent',
          laneId: lane.id,
          generation: lane.generation,
          decision: 'refused',
          code: error instanceof Error ? error.name : 'unknown',
          detail: error instanceof Error ? error.message.slice(0, 160) : undefined,
        })
        throw error
      }
    },

    'dev.computeruse.attach': (command, identity) => {
      const lane = laneFor(command)
      assertGeneration(lane, expectedGeneration(command))
      const requestBody = body(command)
      return mintGrant(
        command,
        identity,
        lane,
        'read',
        typeof requestBody.fromSequence === 'string' ? requestBody.fromSequence : undefined
      )
    },

    /**
     * Input grant minting: consumes the single-use consent record, re-checks
     * lane ownership/generation, and only then mints the write-direction
     * stream grant bound to the lane resource and generation.
     */
    'dev.computeruse.input': (command, identity) => {
      const lane = laneFor(command)
      const expected = expectedGeneration(command)
      assertGeneration(lane, expected)
      const requestBody = body(command)
      const consentId = requireString(requestBody.consentId, 'consentId')
      input.gate.consume({ consentId, scope: command.scope, laneId: lane.id, generation: expected })
      input.lanes.admit(lane, { principal: 'agent', action: 'input', generation: expected })
      audit({
        operation: 'dev.computeruse.input',
        laneId: lane.id,
        generation: expected,
        decision: 'allowed',
      })
      return mintGrant(
        command,
        identity,
        lane,
        'write',
        typeof requestBody.fromSequence === 'string' ? requestBody.fromSequence : undefined
      )
    },

    /** Human takeover: suspends agent input instantly (kill path no. 1). */
    'dev.computeruse.takeover': (command) => {
      const lane = laneFor(command)
      const expected = expectedGeneration(command)
      const taken = input.lanes.takeover(lane.id, expected)
      input.gate.revokeForLane(lane.id)
      ledgers.delete(lane.id)
      audit({
        operation: 'dev.computeruse.takeover',
        laneId: lane.id,
        generation: taken.generation,
        decision: 'allowed',
      })
      return taken
    },

    /** Escape path: release back to the agent; re-consent is required. */
    'dev.computeruse.release': (command) => {
      const lane = laneFor(command)
      const expected = expectedGeneration(command)
      const released = input.lanes.release(lane.id, expected)
      input.gate.revokeForLane(lane.id)
      ledgers.delete(lane.id)
      audit({
        operation: 'dev.computeruse.release',
        laneId: lane.id,
        generation: released.generation,
        decision: 'allowed',
      })
      return released
    },

    /** The kill switch: close revokes input authority immediately. */
    'dev.computeruse.laneClose': (command) => {
      const lane = laneFor(command)
      const expected = expectedGeneration(command)
      const closed = input.lanes.close(lane.id, expected)
      input.gate.revokeForLane(lane.id)
      ledgers.delete(lane.id)
      audit({
        operation: 'dev.computeruse.laneClose',
        laneId: lane.id,
        generation: closed.generation,
        decision: 'allowed',
      })
      return closed
    },
  }

  // Every handler is wrapped async so provider failures surface as typed
  // DevError codes through the M10 execute reply, never as raw throws.
  const mapped: Partial<
    Record<string, (command: DevCommand, identity?: ChannelIdentity) => Promise<unknown>>
  > = {}
  for (const [operation, handler] of Object.entries(handlers)) {
    if (!handler) continue
    mapped[operation] = async (command: DevCommand, identity?: ChannelIdentity) => {
      try {
        return await handler(command, identity)
      } catch (error) {
        throw computerUseProviderError(error)
      }
    }
  }

  return {
    providers: mapped,

    /**
     * Serves one write-direction `desktop-frames-v1` input frame. Called by
     * the registrar's stream handler after the wire layer has verified
     * direction, sequence order, grant generation, and frame size. The gate
     * re-derives the rest: lane state, ownership, live consent freshness,
     * generation fencing, rate cap, and replay of an identical event.
     */
    async admitInputFrame(frame: {
      laneId: string
      generation: number
      sequence: string
      bytes: Uint8Array
    }): Promise<{ accepted: true }> {
      const lane = input.lanes.get(frame.laneId)
      input.lanes.admit(lane, { principal: 'agent', action: 'input', generation: frame.generation })
      if (lane.consent) await input.gate.verifyFresh(lane.consent.consentId)
      let decoded: { value: unknown }
      try {
        decoded = decodeCbor(frame.bytes)
      } catch {
        throw new ComputerUseProviderError('invalid_state', 'input frame is not canonical CBOR')
      }
      const event = decodeComputerUseInputEvent(decoded.value)
      const ledger = ledgerFor(frame.laneId)
      const verdict = ledger.screencast.admitInput(
        {
          sequence: frame.sequence,
          generation: frame.generation,
          viewportSequence: 0,
          bytes: frame.bytes,
        },
        frame.generation
      )
      if ('accepted' in verdict) {
        const engine = input.engine?.() ?? unavailableEngine()
        try {
          await engine.injectInput(event)
        } catch (error) {
          // A TCC refusal means the permission state moved: kill the lane's
          // input authority immediately instead of letting the agent retry.
          if (error instanceof ComputerUseEngineError && error.code === 'permission_denied') {
            input.lanes.markCrashed(lane.id)
            input.gate.revokeForLane(lane.id)
          }
          throw error
        }
        audit({
          operation: 'desktop-frames-v1.input',
          laneId: frame.laneId,
          generation: frame.generation,
          decision: 'allowed',
          detail: `${event.kind} (${frame.bytes.byteLength}B)`,
        })
        return { accepted: true }
      }
      audit({
        operation: 'desktop-frames-v1.input',
        laneId: frame.laneId,
        generation: frame.generation,
        decision: 'refused',
        code: verdict.rejected,
      })
      if (verdict.rejected === 'stale_generation')
        throw new ComputerUseProviderError('stale_generation', 'input generation is stale')
      if (verdict.rejected === 'rate_limited')
        throw new ComputerUseProviderError('rate_limited', 'input rate cap exceeded')
      throw new ComputerUseProviderError('backpressure', 'input refused by the lane ledger')
    },

    /** Drops the per-lane ledger when a lane disappears. */
    forgetLane(laneId: string): void {
      ledgers.delete(laneId)
    },
  }
}

export function computerUseProviderError(error: unknown): ComputerUseProviderError {
  if (error instanceof ComputerUseProviderError) return error
  if (error instanceof ComputerUseGateError)
    return new ComputerUseProviderError(
      error.code as DevErrorCode,
      error.message,
      error.retryable,
      error.remediation
    )
  if (error instanceof ComputerUseLaneError)
    return new ComputerUseProviderError(
      error.code as DevErrorCode,
      error.message,
      error.code === 'invalid_state'
    )
  if (error instanceof ComputerUseEngineError) {
    const code = (
      {
        permission_denied: 'permission_denied',
        capability_unavailable: 'capability_unavailable',
        invalid_state: 'invalid_state',
        timeout: 'timeout',
        spawn_failed: 'spawn_failed',
      } as const
    )[error.code]
    return new ComputerUseProviderError(code, error.message, error.retryable, error.remediation)
  }
  return new ComputerUseProviderError('invalid_state', 'computer-use provider failed', false)
}
