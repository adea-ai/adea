import { boundedString, isoInstant, ownDataValue, strictRecord } from './record'
import type { OriginAllowlist } from './origin'

/**
 * Launch contract between the Adea host, the Adea backend and the hosted Agent Sim origin.
 *
 * 1. The host asks the Adea backend to launch a surface (`SimLaunchRequest`). The backend checks
 *    the signed-in account's entitlement; localhost, an embedded secret or the desktop shell's
 *    claimed identity are never proof of it.
 * 2. A granted reply carries one opaque, single-use, short-lived `code`, bound to the host's
 *    `bridgeId`, the sim origin and the surface. It is not a session and not a credential for any
 *    other Adea API.
 * 3. The host posts the code to the sim frame (`host.launch`). The frame calls the sim origin's
 *    exchange (`SimSessionExchangeRequest`); the sim origin redeems the code once and sets a
 *    sim-only session cookie (see `cookie.ts`). No token appears in any request or response body.
 *
 * Every parser here is strict: unknown keys, wrong types and token-looking extras are refused.
 */

export const SIM_LAUNCH_SCHEMA_VERSION = 1
/** A launch code is useless after this long, whatever the backend says. */
export const MAX_SIM_LAUNCH_TTL_MS = 120_000

export const SIM_SURFACES = ['hq', 'character-designer', 'room-designer'] as const
export type SimSurface = (typeof SIM_SURFACES)[number]
export const SIM_PLATFORMS = ['desktop', 'web'] as const
export type SimPlatform = (typeof SIM_PLATFORMS)[number]

const BRIDGE_ID = /^[A-Za-z0-9_-]{16,64}$/
const LAUNCH_CODE = /^[A-Za-z0-9_-]{32,128}$/
const WORKSPACE_ID = /^[A-Za-z0-9_.:-]{1,128}$/

export type SimLaunchRequest = Readonly<{
  schemaVersion: typeof SIM_LAUNCH_SCHEMA_VERSION
  workspaceId: string
  surface: SimSurface
  platform: SimPlatform
  bridgeId: string
}>

export type SimLaunchDeniedReason = 'unauthenticated' | 'not_entitled'
export type SimLaunchUnavailableReason = 'not_configured' | 'service_unavailable'

export type SimLaunchGrant =
  | Readonly<{
      status: 'granted'
      code: string
      expiresAt: string
      surface: SimSurface
      frameOrigin: string
    }>
  | Readonly<{ status: 'denied'; reason: SimLaunchDeniedReason }>
  | Readonly<{ status: 'unavailable'; reason: SimLaunchUnavailableReason }>

export type SimSessionExchangeRequest = Readonly<{
  schemaVersion: typeof SIM_LAUNCH_SCHEMA_VERSION
  code: string
  bridgeId: string
}>

export type SimSessionRejectedReason =
  | 'code_expired'
  | 'code_used'
  | 'not_entitled'
  | 'origin_refused'

export type SimSessionExchangeResult =
  | Readonly<{ status: 'session'; expiresAt: string }>
  | Readonly<{ status: 'rejected'; reason: SimSessionRejectedReason }>
  | Readonly<{ status: 'unavailable' }>

const DENIED_REASONS = ['unauthenticated', 'not_entitled'] as const
const UNAVAILABLE_REASONS = ['not_configured', 'service_unavailable'] as const
const REJECTED_REASONS = ['code_expired', 'code_used', 'not_entitled', 'origin_refused'] as const

export function parseSimLaunchRequest(value: unknown): SimLaunchRequest | null {
  const body = strictRecord(value, [
    'schemaVersion',
    'workspaceId',
    'surface',
    'platform',
    'bridgeId',
  ])
  if (!body || body.schemaVersion !== SIM_LAUNCH_SCHEMA_VERSION) return null
  const workspaceId = boundedString(body.workspaceId, WORKSPACE_ID)
  const bridgeId = boundedString(body.bridgeId, BRIDGE_ID)
  const surface = SIM_SURFACES.find((item) => item === body.surface)
  const platform = SIM_PLATFORMS.find((item) => item === body.platform)
  if (!workspaceId || !bridgeId || !surface || !platform) return null
  return { schemaVersion: SIM_LAUNCH_SCHEMA_VERSION, workspaceId, surface, platform, bridgeId }
}

export type SimGrantExpectation = Readonly<{
  origins: OriginAllowlist
  /** Epoch milliseconds the host considers "now". */
  now: number
  /** The surface the host asked for; a grant for any other surface is refused. */
  surface: SimSurface
}>

/**
 * The backend's launch reply, or null when it is malformed, stale, longer-lived than the contract
 * allows, for another surface, or points at a frame origin the host did not allowlist.
 */
export function parseSimLaunchGrant(
  value: unknown,
  expected: SimGrantExpectation
): SimLaunchGrant | null {
  const status = ownDataValue(value, 'status')
  if (status === 'denied') {
    const body = strictRecord(value, ['status', 'reason'])
    const reason = DENIED_REASONS.find((item) => item === body?.reason)
    return reason ? { status, reason } : null
  }
  if (status === 'unavailable') {
    const body = strictRecord(value, ['status', 'reason'])
    const reason = UNAVAILABLE_REASONS.find((item) => item === body?.reason)
    return reason ? { status, reason } : null
  }
  if (status !== 'granted') return null
  const body = strictRecord(value, ['status', 'code', 'expiresAt', 'surface', 'frameOrigin'])
  const code = boundedString(body?.code, LAUNCH_CODE)
  const expiresAt = isoInstant(body?.expiresAt)
  const surface = SIM_SURFACES.find((item) => item === body?.surface)
  const frameOrigin = body?.frameOrigin
  if (!body || !code || expiresAt === null || surface !== expected.surface) return null
  if (!expected.origins.has(frameOrigin) || typeof frameOrigin !== 'string') return null
  if (expiresAt <= expected.now || expiresAt > expected.now + MAX_SIM_LAUNCH_TTL_MS) return null
  return { status, code, expiresAt: body.expiresAt as string, surface, frameOrigin }
}

export function parseSimSessionExchangeRequest(value: unknown): SimSessionExchangeRequest | null {
  const body = strictRecord(value, ['schemaVersion', 'code', 'bridgeId'])
  if (!body || body.schemaVersion !== SIM_LAUNCH_SCHEMA_VERSION) return null
  const code = boundedString(body.code, LAUNCH_CODE)
  const bridgeId = boundedString(body.bridgeId, BRIDGE_ID)
  return code && bridgeId ? { schemaVersion: SIM_LAUNCH_SCHEMA_VERSION, code, bridgeId } : null
}

/** The sim origin's exchange reply. A session reply carries its expiry and nothing else. */
export function parseSimSessionExchangeResult(value: unknown): SimSessionExchangeResult | null {
  const status = ownDataValue(value, 'status')
  if (status === 'unavailable') return strictRecord(value, ['status']) ? { status } : null
  if (status === 'rejected') {
    const body = strictRecord(value, ['status', 'reason'])
    const reason = REJECTED_REASONS.find((item) => item === body?.reason)
    return reason ? { status, reason } : null
  }
  if (status !== 'session') return null
  const body = strictRecord(value, ['status', 'expiresAt'])
  return body && isoInstant(body.expiresAt) !== null
    ? { status, expiresAt: body.expiresAt as string }
    : null
}

export type SimLaunchPayload = Readonly<{
  code: string
  expiresAt: string
  surface: SimSurface
  character?: string
}>

/**
 * Frame side: accepts the first launch payload still inside its window and refuses every later one,
 * so a replayed or duplicated `host.launch` can never trigger a second exchange.
 */
export function createLaunchOnce(): Readonly<{
  take(payload: SimLaunchPayload, now: number): SimLaunchPayload | null
}> {
  let taken = false
  return {
    take(payload, now) {
      if (taken) return null
      const expiresAt = isoInstant(payload.expiresAt)
      if (expiresAt === null || expiresAt <= now) return null
      taken = true
      return payload
    },
  }
}

export type LaunchCodeBinding = Readonly<{ bridgeId: string; origin: string; surface: SimSurface }>
export type LaunchCodeRedemption =
  | Readonly<{ ok: true; surface: SimSurface }>
  | Readonly<{ ok: false; reason: 'unknown' | 'code_expired' | 'code_used' | 'origin_refused' }>

/**
 * Reference single-use semantics for the backend's code exchange, used by the local bootstrap tests.
 * A code redeems at most once: it is spent by its first presentation, whether or not that
 * presentation matched the binding, so a leaked code cannot be retried with guessed bindings.
 * A durable implementation keeps the same observable behaviour.
 */
export function createLaunchCodeLedger(): Readonly<{
  issue(code: string, binding: LaunchCodeBinding, expiresAt: number): void
  redeem(
    code: string,
    presented: Omit<LaunchCodeBinding, 'surface'>,
    now: number
  ): LaunchCodeRedemption
}> {
  const entries = new Map<
    string,
    { binding: LaunchCodeBinding; expiresAt: number; spent: boolean }
  >()
  return {
    issue(code, binding, expiresAt) {
      if (!Number.isFinite(expiresAt)) throw new RangeError('launch code expiry must be finite')
      entries.set(code, { binding, expiresAt, spent: false })
    },
    redeem(code, presented, now) {
      // An unusable clock reading cannot prove the code is still live, so it fails closed. Nothing
      // is spent: the comparison below would otherwise be false for NaN and let an expired code pass.
      if (!Number.isFinite(now)) return { ok: false, reason: 'code_expired' }
      const entry = entries.get(code)
      if (!entry) return { ok: false, reason: 'unknown' }
      if (entry.spent) return { ok: false, reason: 'code_used' }
      entry.spent = true
      if (entry.expiresAt <= now) return { ok: false, reason: 'code_expired' }
      if (
        entry.binding.bridgeId !== presented.bridgeId ||
        entry.binding.origin !== presented.origin
      )
        return { ok: false, reason: 'origin_refused' }
      return { ok: true, surface: entry.binding.surface }
    },
  }
}
