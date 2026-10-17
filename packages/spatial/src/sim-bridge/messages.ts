import { boundedString, isPlainRecord, strictRecord } from './record'
import type { OriginAllowlist } from './origin'
import { SIM_SURFACES, type SimSurface } from './launch'
import { SIM_UNAVAILABLE_REASONS, type SimUnavailableReason } from './availability'

/**
 * Versioned message schema between the Adea host window and the hosted Agent Sim frame.
 *
 * The bridge is a closed set of typed messages and nothing else: there is no generic call,
 * eval, filesystem, native-bridge or credential message, and no field of any message may carry a
 * token. Every message is validated against the exact frame origin, the exact frame window, the
 * per-mount `bridgeId` the host issued, the protocol version and a strict payload shape. Anything
 * else is dropped and never acted on.
 */

export const SIM_BRIDGE_CHANNEL = 'adea.agent-sim.bridge'
export const SIM_BRIDGE_VERSION = 1
export const MAX_SIM_MESSAGE_BYTES = 2048

const BRIDGE_ID = /^[A-Za-z0-9_-]{16,64}$/
const LAUNCH_CODE = /^[A-Za-z0-9_-]{32,128}$/
const CHARACTER_ID = /^[A-Za-z0-9_.:-]{1,64}$/

export const SIM_FRAME_STATES = ['loading', 'running', 'unavailable', 'offline'] as const
export type SimFrameState = (typeof SIM_FRAME_STATES)[number]
export const SIM_FRAME_ERRORS = [
  'launch_rejected',
  'asset_unavailable',
  'engine_failed',
  'bridge_incompatible',
] as const
export type SimFrameError = (typeof SIM_FRAME_ERRORS)[number]

export type SimFrameMessage =
  | Readonly<{ type: 'frame.ready'; payload: Readonly<Record<string, never>> }>
  | Readonly<{
      type: 'frame.state'
      payload: Readonly<{ state: SimFrameState; reason?: SimUnavailableReason }>
    }>
  | Readonly<{ type: 'frame.close'; payload: Readonly<Record<string, never>> }>
  | Readonly<{ type: 'frame.error'; payload: Readonly<{ code: SimFrameError }> }>

export type SimHostMessage =
  | Readonly<{
      type: 'host.launch'
      payload: Readonly<{
        /** Opaque single-use code. It is exchanged at the sim origin for a sim-only session. */
        code: string
        expiresAt: string
        surface: SimSurface
        character?: string
      }>
    }>
  | Readonly<{ type: 'host.dispose'; payload: Readonly<Record<string, never>> }>

export type SimBridgeFailure =
  | 'origin_refused'
  | 'source_mismatch'
  | 'not_a_bridge_message'
  | 'version_unsupported'
  | 'bridge_mismatch'
  | 'unknown_type'
  | 'invalid_payload'
  | 'too_large'

export type SimBridgeResult<T> =
  | Readonly<{ ok: true; message: T }>
  | Readonly<{ ok: false; reason: SimBridgeFailure }>

export type SimMessageEventLike = Readonly<{ origin: unknown; source: unknown; data: unknown }>

const ENVELOPE_KEYS = ['channel', 'version', 'bridgeId', 'type', 'payload'] as const

function envelope(
  event: SimMessageEventLike,
  bridgeId: string
): SimBridgeResult<{ type: string; payload: unknown }> {
  const data = strictRecord(event.data, ENVELOPE_KEYS)
  if (!data || data.channel !== 'adea.agent-sim.bridge') return fail('not_a_bridge_message')
  if (data.version !== SIM_BRIDGE_VERSION) return fail('version_unsupported')
  if (data.bridgeId !== bridgeId) return fail('bridge_mismatch')
  if (typeof data.type !== 'string' || !isPlainRecord(data.payload)) return fail('invalid_payload')
  if (!withinBudget(data)) return fail('too_large')
  return { ok: true, message: { type: data.type, payload: data.payload } }
}

// Traversal limits for the size check. A record costs more than its keys so that even a cyclic
// structure (reachable through structured clone) exhausts the budget in a bounded number of steps.
const MAX_NODES = 32
const MAX_DEPTH = 3
const MAX_KEYS_PER_RECORD = 16
const RECORD_COST = 16

/**
 * A finite size check over plain data: strings, numbers, booleans and nested plain records. It
 * stops at `MAX_NODES` nodes, `MAX_DEPTH` levels and `MAX_KEYS_PER_RECORD` keys per record, charges
 * every record against the byte budget, and refuses accessors, so no input (cyclic, deep or wide)
 * can make it loop or run sender code.
 */
function withinBudget(value: unknown): boolean {
  let budget = MAX_SIM_MESSAGE_BYTES
  let nodes = 0
  const stack: { item: unknown; depth: number }[] = [{ item: value, depth: 0 }]
  while (stack.length > 0) {
    const { item, depth } = stack.pop()!
    if (++nodes > MAX_NODES) return false
    if (typeof item === 'string') budget -= item.length
    else if (typeof item === 'number' || typeof item === 'boolean') budget -= 8
    else if (isPlainRecord(item)) {
      if (depth >= MAX_DEPTH) return false
      const keys = Object.getOwnPropertyNames(item)
      if (keys.length > MAX_KEYS_PER_RECORD) return false
      budget -= RECORD_COST
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)
        // Reading through a getter would run sender-controlled code; refuse accessors outright.
        if (!descriptor || !('value' in descriptor)) return false
        budget -= key.length + 1
        stack.push({ item: descriptor.value, depth: depth + 1 })
      }
    } else if (item !== undefined) return false
    if (budget < 0) return false
  }
  return true
}

function fail<T>(reason: SimBridgeFailure): SimBridgeResult<T> {
  return { ok: false, reason }
}

export type SimHostContext = Readonly<{
  origins: OriginAllowlist
  /** The frame element's `contentWindow`, read when the event arrives. */
  frameWindow: unknown
  /** Issued by the host for this mount; the frame must echo it. */
  bridgeId: string
}>

/** Host side: accept a message only from the exact frame window at an allowlisted origin. */
export function parseFrameMessage(
  event: SimMessageEventLike,
  context: SimHostContext
): SimBridgeResult<SimFrameMessage> {
  if (!BRIDGE_ID.test(context.bridgeId)) return fail('bridge_mismatch')
  if (!context.origins.has(event.origin)) return fail('origin_refused')
  if (event.source == null || event.source !== context.frameWindow) return fail('source_mismatch')
  const opened = envelope(event, context.bridgeId)
  if (!opened.ok) return opened
  const { type, payload } = opened.message
  switch (type) {
    case 'frame.ready':
    case 'frame.close':
      return strictRecord(payload, [])
        ? { ok: true, message: { type, payload: {} } }
        : fail('invalid_payload')
    case 'frame.state': {
      const body = strictRecord(payload, ['state'], ['reason'])
      const state = SIM_FRAME_STATES.find((item) => item === body?.state)
      if (!body || !state) return fail('invalid_payload')
      const reason = SIM_UNAVAILABLE_REASONS.find((item) => item === body.reason)
      // A reason belongs to `unavailable` and nothing else.
      if ('reason' in body ? !reason || state !== 'unavailable' : state === 'unavailable')
        return fail('invalid_payload')
      return { ok: true, message: { type, payload: reason ? { state, reason } : { state } } }
    }
    case 'frame.error': {
      const body = strictRecord(payload, ['code'])
      const code = SIM_FRAME_ERRORS.find((item) => item === body?.code)
      return code ? { ok: true, message: { type, payload: { code } } } : fail('invalid_payload')
    }
    default:
      return fail('unknown_type')
  }
}

export type SimFrameContext = Readonly<{
  /** The exact origin of the Adea host that embeds this frame. */
  parentOrigin: string
  /** `window.parent`, compared by identity. */
  parentWindow: unknown
  bridgeId: string
}>

/** Frame side: accept a message only from the embedding host window at its exact origin. */
export function parseHostMessage(
  event: SimMessageEventLike,
  context: SimFrameContext
): SimBridgeResult<SimHostMessage> {
  if (!BRIDGE_ID.test(context.bridgeId)) return fail('bridge_mismatch')
  if (event.origin !== context.parentOrigin) return fail('origin_refused')
  if (event.source == null || event.source !== context.parentWindow) return fail('source_mismatch')
  const opened = envelope(event, context.bridgeId)
  if (!opened.ok) return opened
  const { type, payload } = opened.message
  switch (type) {
    case 'host.dispose':
      return strictRecord(payload, [])
        ? { ok: true, message: { type, payload: {} } }
        : fail('invalid_payload')
    case 'host.launch': {
      const body = strictRecord(payload, ['code', 'expiresAt', 'surface'], ['character'])
      const code = boundedString(body?.code, LAUNCH_CODE)
      const surface = SIM_SURFACES.find((item) => item === body?.surface)
      const expiresAt = body?.expiresAt
      const character =
        body && 'character' in body ? boundedString(body.character, CHARACTER_ID) : undefined
      if (
        !body ||
        !code ||
        !surface ||
        typeof expiresAt !== 'string' ||
        Number.isNaN(Date.parse(expiresAt)) ||
        character === null
      )
        return fail('invalid_payload')
      return {
        ok: true,
        message: {
          type,
          payload: { code, expiresAt, surface, ...(character ? { character } : {}) },
        },
      }
    }
    default:
      return fail('unknown_type')
  }
}

/** A fresh per-mount nonce: 128 random bits as base64url. The host issues it; the frame echoes it. */
export function createBridgeId(
  fill: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes)
): string {
  const bytes = fill(new Uint8Array(16))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function wrap(bridgeId: string, type: string, payload: object) {
  if (!BRIDGE_ID.test(bridgeId)) throw new Error('Invalid Agent Sim bridge id')
  return {
    channel: SIM_BRIDGE_CHANNEL,
    version: SIM_BRIDGE_VERSION,
    bridgeId,
    type,
    payload,
  } as const
}

export function frameEnvelope(bridgeId: string, message: SimFrameMessage) {
  return wrap(bridgeId, message.type, message.payload)
}

export function hostEnvelope(bridgeId: string, message: SimHostMessage) {
  return wrap(bridgeId, message.type, message.payload)
}

type PostTarget = Readonly<{ postMessage(message: unknown, targetOrigin: string): void }>

/** Host to frame. The target origin must be allowlisted; `*` can never be used. */
export function postToFrame(
  frameWindow: PostTarget,
  frameOrigin: string,
  origins: OriginAllowlist,
  bridgeId: string,
  message: SimHostMessage
): void {
  if (!origins.has(frameOrigin)) throw new Error('Refusing to post to an unlisted Agent Sim origin')
  frameWindow.postMessage(hostEnvelope(bridgeId, message), frameOrigin)
}

/** Frame to host. The target is the exact embedding origin the frame was configured with. */
export function postToHost(
  parentWindow: PostTarget,
  parentOrigin: string,
  bridgeId: string,
  message: SimFrameMessage
): void {
  if (parentOrigin === '*' || parentOrigin === 'null' || !parentOrigin.includes('://'))
    throw new Error('Refusing to post to a non-exact Agent Sim host origin')
  parentWindow.postMessage(frameEnvelope(bridgeId, message), parentOrigin)
}
