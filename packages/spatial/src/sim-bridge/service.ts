import { createOriginAllowlist } from './origin'
import {
  MAX_SIM_LAUNCH_TTL_MS,
  parseSimLaunchRequest,
  parseSimSessionExchangeRequest,
  type LaunchCodeBinding,
  type LaunchCodeRedemption,
  type SimLaunchGrant,
  type SimPlatform,
  type SimSessionExchangeResult,
  type SimSurface,
} from './launch'
import { MAX_SIM_SESSION_SECONDS, buildSimSessionSetCookie } from './cookie'

/**
 * Backend logic for the hosted Agent Sim launch, written against injectable ports.
 *
 * Nothing here picks an entitlement source, a sim origin or a storage engine: the caller supplies
 * each as a port or a config value, and an absent value fails closed as `not_configured`. The
 * module does no I/O, owns no endpoint and is not imported by the app. A real deployment adds the
 * HTTP routes, the durable stores and the entitlement lookup around it.
 *
 * Two entry points mirror the two steps of the launch contract in `launch.ts`:
 *
 * - `createSimLaunchIssuer` (Adea backend): checks the signed-in account's entitlement and issues a
 *   single-use code bound to the host's `bridgeId`, the sim origin and the surface.
 * - `createSimSessionExchange` (sim origin): redeems that code once and mints a sim-only session
 *   whose value travels only in the `Set-Cookie` header, never in a body.
 */

type MaybePromise<T> = T | Promise<T>

export type SimEntitlementQuery = Readonly<{
  workspaceId: string
  surface: SimSurface
  /**
   * The platform the client says it is. It is a hint for the entitlement source and never proof
   * of anything: localhost, an embedded secret or a desktop shell's claim cannot entitle a launch.
   */
  platform: SimPlatform
}>

export type SimEntitlementVerdict = 'entitled' | 'not_entitled' | 'unauthenticated' | 'unavailable'

/**
 * Decides whether the account behind the current request may launch. The port is bound to that
 * request's authenticated session by whoever builds it, so no account identity passes through the
 * launch request body.
 */
export type SimEntitlementChecker = (
  query: SimEntitlementQuery
) => MaybePromise<SimEntitlementVerdict>

/** Durable single-use code storage. `createLaunchCodeLedger()` is the in-memory reference. */
export type SimLaunchCodeStore = Readonly<{
  issue(code: string, binding: LaunchCodeBinding, expiresAt: number): MaybePromise<void>
  redeem(
    code: string,
    presented: Omit<LaunchCodeBinding, 'surface'>,
    now: number
  ): MaybePromise<LaunchCodeRedemption>
}>

export type SimSessionRecord = Readonly<{ surface: SimSurface; expiresAt: number }>

/** Where the sim origin keeps the sessions it mints; looked up later by the asset gate. */
export type SimSessionStore = Readonly<{
  save(value: string, record: SimSessionRecord): MaybePromise<void>
}>

type Clock = () => number
type RandomBytes = (length: number) => Uint8Array

const systemClock: Clock = () => Date.now()
const systemRandom: RandomBytes = (length) => crypto.getRandomValues(new Uint8Array(length))

const DEFAULT_LAUNCH_TTL_MS = 60_000
const DEFAULT_SESSION_SECONDS = MAX_SIM_SESSION_SECONDS
const CODE_BYTES = 32
const SESSION_BYTES = 32

export type SimLaunchIssuerConfig = Readonly<{
  /** The sim origin to embed. Absent or invalid means "not configured", never a default. */
  frameOrigin: string | null | undefined
  allowLoopbackHttp?: boolean
  entitlement: SimEntitlementChecker
  store: SimLaunchCodeStore
  /** Code lifetime in milliseconds, clamped to the contract maximum. */
  codeTtlMs?: number
  now?: Clock
  randomBytes?: RandomBytes
}>

export type SimLaunchIssueResult = SimLaunchGrant | Readonly<{ status: 'invalid_request' }>

/** The backend half of the launch: a request body in, a grant (or a refusal) out. */
export function createSimLaunchIssuer(
  config: SimLaunchIssuerConfig
): (body: unknown) => Promise<SimLaunchIssueResult> {
  const frameOrigin = configuredOrigin(config.frameOrigin, config.allowLoopbackHttp === true)
  const now = config.now ?? systemClock
  const random = config.randomBytes ?? systemRandom
  const ttl = Math.min(
    Math.max(1, Math.floor(config.codeTtlMs ?? DEFAULT_LAUNCH_TTL_MS)),
    MAX_SIM_LAUNCH_TTL_MS
  )

  return async (body) => {
    const request = parseSimLaunchRequest(body)
    if (!request) return { status: 'invalid_request' }
    if (!frameOrigin) return { status: 'unavailable', reason: 'not_configured' }

    let verdict: SimEntitlementVerdict
    try {
      verdict = await config.entitlement({
        workspaceId: request.workspaceId,
        surface: request.surface,
        platform: request.platform,
      })
    } catch {
      return { status: 'unavailable', reason: 'service_unavailable' }
    }
    if (verdict === 'unauthenticated') return { status: 'denied', reason: 'unauthenticated' }
    if (verdict === 'not_entitled') return { status: 'denied', reason: 'not_entitled' }
    // Anything but an explicit "entitled" fails closed, including a verdict this code does not know.
    if (verdict !== 'entitled') return { status: 'unavailable', reason: 'service_unavailable' }

    const code = base64url(random(CODE_BYTES))
    const expiresAt = now() + ttl
    try {
      await config.store.issue(
        code,
        { bridgeId: request.bridgeId, origin: frameOrigin, surface: request.surface },
        expiresAt
      )
    } catch {
      return { status: 'unavailable', reason: 'service_unavailable' }
    }
    return {
      status: 'granted',
      code,
      expiresAt: new Date(expiresAt).toISOString(),
      surface: request.surface,
      frameOrigin,
    }
  }
}

export type SimSessionExchangeConfig = Readonly<{
  /** This sim origin, as the issuer bound it into the code. Absent or invalid is "not configured". */
  origin: string | null | undefined
  allowLoopbackHttp?: boolean
  store: SimLaunchCodeStore
  sessions: SimSessionStore
  /** Session lifetime in seconds, clamped to the contract maximum. */
  sessionSeconds?: number
  now?: Clock
  randomBytes?: RandomBytes
}>

/** What the sim origin answers: a JSON body, plus the cookie header only for a new session. */
export type SimSessionExchangeResponse = Readonly<{
  body: SimSessionExchangeResult | Readonly<{ status: 'invalid_request' }>
  setCookie?: string
}>

/** The sim origin's half of the launch: redeems a code once and sets the sim-only cookie. */
export function createSimSessionExchange(
  config: SimSessionExchangeConfig
): (body: unknown) => Promise<SimSessionExchangeResponse> {
  const origin = configuredOrigin(config.origin, config.allowLoopbackHttp === true)
  const now = config.now ?? systemClock
  const random = config.randomBytes ?? systemRandom
  const seconds = Math.min(
    Math.max(1, Math.floor(config.sessionSeconds ?? DEFAULT_SESSION_SECONDS)),
    MAX_SIM_SESSION_SECONDS
  )

  return async (body) => {
    const request = parseSimSessionExchangeRequest(body)
    if (!request) return { body: { status: 'invalid_request' } }
    if (!origin) return { body: { status: 'unavailable' } }

    let redemption: LaunchCodeRedemption
    try {
      redemption = await config.store.redeem(
        request.code,
        { bridgeId: request.bridgeId, origin },
        now()
      )
    } catch {
      return { body: { status: 'unavailable' } }
    }
    if (!redemption.ok) {
      // An unknown code carries no more information than an expired one; the reply never says
      // whether a code ever existed.
      const reason = redemption.reason === 'unknown' ? 'code_expired' : redemption.reason
      return { body: { status: 'rejected', reason } }
    }

    const value = base64url(random(SESSION_BYTES))
    const expiresAt = now() + seconds * 1000
    try {
      await config.sessions.save(value, { surface: redemption.surface, expiresAt })
    } catch {
      return { body: { status: 'unavailable' } }
    }
    return {
      body: { status: 'session', expiresAt: new Date(expiresAt).toISOString() },
      setCookie: buildSimSessionSetCookie(value, seconds),
    }
  }
}

function configuredOrigin(origin: unknown, allowLoopbackHttp: boolean): string | null {
  if (origin == null) return null
  try {
    return createOriginAllowlist([origin], { allowLoopbackHttp }).origins[0] ?? null
  } catch {
    return null
  }
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}
