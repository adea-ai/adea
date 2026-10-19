import { canonicalBridgeOrigin } from '@adea-ai/spatial/sim-bridge'

/** The isolation settings the host is built from. Route, asset and CSP policy are not configurable here. */
export type SimHostIsolation = {
  /** The exact origin the frame is served from. */
  origin: string
  /** The exact origins allowed to embed the frame. Non-empty, distinct from `origin`, on other cookie hosts. */
  parentOrigins: readonly string[]
  /** Permits `http://` loopback origins. Only acceptance fixtures set it. */
  allowLoopbackHttp?: boolean
}

export type ValidatedSimHostIsolation = Readonly<{
  origin: string
  parentOrigins: readonly string[]
  allowLoopbackHttp: boolean
}>

/**
 * Validates the isolation settings and returns them frozen. It throws on anything missing or malformed, so the host
 * never starts from partial or default values. The rules are the ones the host has always enforced: exact origins,
 * distinct frame and parent origins, and a separate cookie host.
 */
export function createSimHostIsolation(input: unknown): ValidatedSimHostIsolation {
  if (!input || typeof input !== 'object')
    throw new Error('Hosted Sim needs an isolation configuration')
  const value = input as Partial<Record<keyof SimHostIsolation, unknown>>
  if (value.allowLoopbackHttp !== undefined && typeof value.allowLoopbackHttp !== 'boolean')
    throw new Error('Hosted Sim allowLoopbackHttp must be a boolean')
  const allowLoopbackHttp = value.allowLoopbackHttp === true
  const canonical = { allowLoopbackHttp }

  const origin = canonicalBridgeOrigin(value.origin, canonical)
  if (!Array.isArray(value.parentOrigins) || value.parentOrigins.length === 0)
    throw new Error('Hosted Sim needs at least one parent origin')
  const parents = value.parentOrigins.map((item) => canonicalBridgeOrigin(item, canonical))
  if (!origin || parents.some((item) => !item) || parents.includes(origin)) {
    throw new Error('Hosted Sim needs distinct canonical frame and parent origins')
  }
  if (new Set(parents).size !== parents.length)
    throw new Error('Hosted Sim parent origins must be distinct')
  // Keep the exact-origin allowlists above and on every request. Cookies have
  // hostname scope rather than port scope, so additionally reject a shared
  // cookie host: different ports alone cannot isolate the Sim-only cookie.
  if (parents.some((parent) => new URL(parent!).hostname === new URL(origin).hostname)) {
    throw new Error('Hosted Sim requires a separate cookie host')
  }

  return Object.freeze({
    origin,
    parentOrigins: Object.freeze(parents as string[]),
    allowLoopbackHttp,
  })
}
