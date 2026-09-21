// Computer-use lane registry (issue #472). A lane is a session-scoped grant
// over the execution host's real desktop: it is created for one runtime
// session, never becomes a global permission, and dies with that session.
// Identity rules mirror the browser lane registry (ADR 0006 semantics): lane
// IDs are immutable, the generation increments on every authority transfer
// (consent activation, takeover, release, close), and anything authorized
// under an old generation is inert. The registry owns only the lane state
// machine — capability and consent truth live in the consent gate, which
// re-derives every admission from the #471 permissions substrate.
import { randomUUID } from 'node:crypto'

import type {
  ComputerUseConsent,
  ComputerUseLane,
  Scope,
} from '../../../../../../packages/types/src/dev-runtime'

export type ComputerUseLaneRecord = ComputerUseLane &
  Readonly<{
    createdAt: string
    /** The active consent record; absent unless state is `granted`. */
    consent?: ComputerUseConsent
  }>

export type ComputerUseLaneState = ComputerUseLane['state']
export type ComputerUseOwner = ComputerUseLane['automationOwner']

export class ComputerUseLaneError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ComputerUseLaneError'
    this.code = code
  }
}

/** The base owner of a lane is always the agent: takeover is the exception. */
const BASE_OWNER: ComputerUseOwner = 'agent'

/** A consent is live only while its record is unexpired (kill switch drops it). */
function consentLive(record: ComputerUseLaneRecord, at: string): boolean {
  if (record.state !== 'granted' || !record.consent) return false
  return record.consent.expiresAt > at
}

export type CreateComputerUseLaneInput = Readonly<{
  scope: Scope
  runtimeSessionId: string
}>

export type ComputerUseRegistryOptions = Readonly<{
  now?: () => string
  randomId?: () => string
}>

export function createComputerUseLaneRegistry(options: ComputerUseRegistryOptions = {}) {
  const now = options.now ?? (() => new Date().toISOString())
  const randomId = options.randomId ?? (() => randomUUID())
  const lanes = new Map<string, ComputerUseLaneRecord>()

  function lane(id: string): ComputerUseLaneRecord {
    const record = lanes.get(id)
    if (!record) throw new ComputerUseLaneError('not_found', `computer-use lane ${id} is unknown`)
    return record
  }

  function assertGeneration(record: ComputerUseLaneRecord, expectedGeneration: number): void {
    if (!Number.isSafeInteger(expectedGeneration))
      throw new ComputerUseLaneError('stale_generation', 'expected generation must be an integer')
    if (record.generation !== expectedGeneration)
      throw new ComputerUseLaneError(
        'stale_generation',
        `lane generation moved to ${record.generation}`
      )
  }

  function save(record: ComputerUseLaneRecord): ComputerUseLaneRecord {
    lanes.set(record.id, record)
    return record
  }

  return {
    get: lane,

    create(input: CreateComputerUseLaneInput): ComputerUseLaneRecord {
      if (!input.runtimeSessionId || input.runtimeSessionId.length > 256)
        throw new ComputerUseLaneError('identity_mismatch', 'runtime session id is required')
      for (const value of [
        input.scope.accountId,
        input.scope.workspaceId,
        input.scope.runtimeNodeId,
      ]) {
        if (typeof value !== 'string' || value.length === 0)
          throw new ComputerUseLaneError('identity_mismatch', 'lane scope is incomplete')
      }
      const record: ComputerUseLaneRecord = {
        id: randomId(),
        scope: { ...input.scope },
        runtimeSessionId: input.runtimeSessionId,
        state: 'idle',
        automationOwner: BASE_OWNER,
        generation: 1,
        createdAt: now(),
      }
      return save(record)
    },

    /**
     * Binds an issued consent record to the lane. This is an authority
     * transfer (none → agent input authority), so the generation increments
     * and the consent record binds to the NEW generation — input grants
     * minted under the previous generation are inert from this moment.
     */
    activate(id: string, consent: ComputerUseConsent): ComputerUseLaneRecord {
      const record = lane(id)
      if (record.state === 'closed' || record.state === 'crashed')
        throw new ComputerUseLaneError('invalid_state', `lane is ${record.state}`)
      if (record.automationOwner === 'human_takeover')
        throw new ComputerUseLaneError(
          'invalid_state',
          'lane is under human takeover; release it before consenting'
        )
      if (consent.computerUseLaneId !== record.id || consent.generation !== record.generation + 1)
        throw new ComputerUseLaneError(
          'identity_mismatch',
          'consent record does not bind to this lane and its next generation'
        )
      return save({
        ...record,
        state: 'granted',
        generation: record.generation + 1,
        consent,
      })
    },

    /**
     * Human takeover: suspends agent input instantly and bumps the
     * generation, so every grant and consent minted before it is inert.
     * The consent record is dropped — Escape/release requires re-consent.
     */
    takeover(id: string, expectedGeneration: number): ComputerUseLaneRecord {
      const record = lane(id)
      assertGeneration(record, expectedGeneration)
      if (record.state === 'closed')
        throw new ComputerUseLaneError('invalid_state', 'lane is closed')
      if (record.automationOwner === 'human_takeover')
        throw new ComputerUseLaneError('invalid_state', 'lane is already under human takeover')
      return save({
        ...record,
        automationOwner: 'human_takeover',
        generation: record.generation + 1,
        state: 'suspended',
        consent: undefined,
      })
    },

    /** Releases human takeover back to the agent; the Escape path. */
    release(id: string, expectedGeneration: number): ComputerUseLaneRecord {
      const record = lane(id)
      assertGeneration(record, expectedGeneration)
      if (record.automationOwner !== 'human_takeover')
        throw new ComputerUseLaneError('invalid_state', 'lane is not under human takeover')
      return save({
        ...record,
        automationOwner: BASE_OWNER,
        generation: record.generation + 1,
        state: 'idle',
        consent: undefined,
      })
    },

    /**
     * The kill switch: closes the lane and revokes its input authority
     * immediately. Consent records die here; input streams bound to the old
     * generation are inert. Closing a closed lane is idempotent.
     */
    close(id: string, expectedGeneration: number): ComputerUseLaneRecord {
      const record = lane(id)
      assertGeneration(record, expectedGeneration)
      if (record.state === 'closed') return record
      return save({
        ...record,
        state: 'closed',
        automationOwner: 'none',
        generation: record.generation + 1,
        consent: undefined,
      })
    },

    /** Terminal engine fault; a crashed lane accepts nothing. */
    markCrashed(id: string): ComputerUseLaneRecord {
      const record = lane(id)
      if (record.state === 'closed') return record
      return save({
        ...record,
        state: 'crashed',
        automationOwner: 'none',
        consent: undefined,
      })
    },

    /**
     * Decides whether one authority claim may act on the lane. Stale
     * generations are inert (refused without mutating state); `none` accepts
     * nothing; a `human_takeover` lane accepts only the controlling user;
     * input additionally requires a live (unexpired, bound) consent record.
     */
    admit(
      record: ComputerUseLaneRecord,
      claim: Readonly<{
        principal: 'human' | 'agent'
        action: 'input' | 'capture' | 'observe'
        generation: number
      }>
    ): void {
      assertGeneration(record, claim.generation)
      if (record.state === 'closed')
        throw new ComputerUseLaneError('permission_denied', 'lane is closed')
      if (record.state === 'crashed')
        throw new ComputerUseLaneError('invalid_state', 'lane is crashed')
      if (record.automationOwner === 'none')
        throw new ComputerUseLaneError('permission_denied', 'lane accepts no automation input')
      if (record.automationOwner === 'human_takeover' && claim.principal !== 'human')
        throw new ComputerUseLaneError(
          'permission_denied',
          'agent input is suspended during human takeover'
        )
      if (claim.action === 'input' && claim.principal === 'agent' && !consentLive(record, now()))
        throw new ComputerUseLaneError(
          'permission_denied',
          'agent input requires a live consent record'
        )
    },

    list(
      filter: Readonly<{
        scope?: Scope
        runtimeSessionId?: string
        state?: ComputerUseLaneState
      }> = {},
      page: Readonly<{ cursor?: string; limit?: number }> = {}
    ): { items: readonly ComputerUseLaneRecord[]; nextCursor?: string } {
      const limit = Math.min(Math.max(page.limit ?? 100, 1), 500)
      const offset = page.cursor ? Number.parseInt(page.cursor, 10) || 0 : 0
      const all = [...lanes.values()]
        .filter(
          (record) =>
            (filter.scope === undefined ||
              (record.scope.accountId === filter.scope.accountId &&
                record.scope.workspaceId === filter.scope.workspaceId &&
                record.scope.runtimeNodeId === filter.scope.runtimeNodeId)) &&
            (filter.runtimeSessionId === undefined ||
              record.runtimeSessionId === filter.runtimeSessionId) &&
            (filter.state === undefined || record.state === filter.state)
        )
        .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
      const items = all.slice(offset, offset + limit)
      const nextCursor = offset + limit < all.length ? String(offset + limit) : undefined
      return { items, nextCursor }
    },

    closeForSession(runtimeSessionId: string): void {
      for (const record of lanes.values())
        if (
          record.runtimeSessionId === runtimeSessionId &&
          record.state !== 'closed' &&
          record.state !== 'crashed'
        )
          save({ ...record, state: 'closed', automationOwner: 'none', consent: undefined })
    },
  }
}

export type ComputerUseLaneRegistry = ReturnType<typeof createComputerUseLaneRegistry>
