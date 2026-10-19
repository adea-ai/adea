// The packaged `adea://auth/callback` receiver (docs/specs/desktop-auth.md
// "The callback"). The scheme is registered declaratively in
// `electrobun.config.ts` (`app.urlSchemes`); Electrobun delivers the
// OS-opened URL to the Bun main process through its `open-url` event. This
// module owns the strict validation of that URL and its single-use routing
// into the existing shell handoff:
//
//   OS URL -> validate -> bind to the pending PKCE attempt -> write
//   `desktop-state/auth-callback.json` (the file `desktop_auth_take_callback`
//   reads and clears) -> publish `desktop-auth-callback-ready`.
//
// The PKCE binding itself (state/nonce equality, expiry, consumed attempts,
// credential/duplicate rejection) is implemented once in
// `packages/auth/src/desktop.ts` and shared by the browser and the shell. This
// module adds the checks that path does not make — exactly `code`, `nonce`,
// and `state`, no fragment, no userinfo — and the delivery-layer single use
// that keeps a re-delivered callback out of the handoff twice.
//
// Binding is probed on a CLONE of the pending attempt, so its `used` flag is
// never flipped here: the renderer's `consumeAuthorization` stays the
// authoritative single-use consumer. If this module consumed the attempt, the
// existing handoff would then refuse its own valid callback.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  consumeDesktopAuthorizationCallback,
  type DesktopAuthorizationAttempt,
} from '../../../../packages/auth/src/desktop'

export type { DesktopAuthorizationAttempt }

/** The one callback target the packaged shell accepts. */
export const DESKTOP_AUTH_CALLBACK_URL = 'adea://auth/callback'
/** The shell event that tells the renderer a callback is waiting in the handoff. */
export const DESKTOP_AUTH_CALLBACK_READY_EVENT = 'desktop-auth-callback-ready'

const DESKTOP_STATE_DIRECTORY = 'desktop-state'
const DESKTOP_AUTH_CALLBACK_FILE = 'auth-callback.json'
const DESKTOP_AUTH_CALLBACK_CODE = /^[A-Za-z0-9_-]{8,512}$/u
const DESKTOP_AUTH_CALLBACK_TOKEN = /^[A-Za-z0-9_-]{16,512}$/u
const EXPECTED_CALLBACK_PARAMETERS = ['code', 'nonce', 'state'] as const
// The authorize URL's forbidden set (docs/specs/desktop-auth.md) plus the bare
// `token` name. The exact-parameter check below already refuses every extra
// name; naming the credential set keeps the refusal typed and explicit.
const FORBIDDEN_CALLBACK_PARAMETERS = [
  'access_token',
  'id_token',
  'refresh_token',
  'session',
  'session_token',
  'token',
] as const

export type DesktopAuthCallbackRejection =
  | 'malformed'
  | 'untrusted-target'
  | 'credential-bearing'
  | 'duplicate-parameters'
  | 'unexpected-parameters'
  | 'fragment-present'
  | 'wrong-instance'
  | 'replay'
  | 'no-pending-attempt'
  | 'binding-failed'
  | 'delivery-failed'

export type DesktopAuthCallbackReceipt =
  | Readonly<{ status: 'delivered'; callback: string }>
  | Readonly<{ status: 'ignored'; reason: 'foreign-target' }>
  | Readonly<{ status: 'rejected'; reason: DesktopAuthCallbackRejection; detail?: string }>

export type DesktopAuthCallbackDelivery = Readonly<{
  rawUrl: string
  /**
   * The shell process this delivery was addressed to. Electrobun routes an
   * open-url to the running instance; a URL forwarded to any other instance
   * (the single-instance handoff) is refused rather than queued.
   */
  targetInstanceId: string
}>

export type ParsedDesktopAuthCallback =
  | Readonly<{ kind: 'callback'; callback: string; bindingKey: string }>
  | Readonly<{ kind: 'foreign' }>
  | Readonly<{
      kind: 'rejected'
      reason: DesktopAuthCallbackRejection
      detail?: string
    }>

/**
 * Strict callback parsing. Only `adea://auth/callback` with exactly `code`,
 * `nonce`, and `state` survives; every other URL is either foreign (another
 * scheme — file associations and ordinary links also arrive as open-url) or a
 * typed refusal. The returned `bindingKey` keys the receiver's replay ledger.
 */
export function parseDesktopAuthCallback(rawUrl: string): ParsedDesktopAuthCallback {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    return { detail: 'callback url is empty', kind: 'rejected', reason: 'malformed' }
  }
  // A different scheme is not ours: Electrobun also emits file:// URLs for
  // registered document types and ordinary links may reach the same channel.
  if (!/^adea:/iu.test(rawUrl)) return { kind: 'foreign' }

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { detail: 'callback url cannot be parsed', kind: 'rejected', reason: 'malformed' }
  }

  if (url.username !== '' || url.password !== '') {
    return {
      detail: 'callback target carries credentials',
      kind: 'rejected',
      reason: 'credential-bearing',
    }
  }
  if (`${url.protocol}//${url.host}${url.pathname}` !== DESKTOP_AUTH_CALLBACK_URL) {
    return {
      detail: 'callback target is not adea://auth/callback',
      kind: 'rejected',
      reason: 'untrusted-target',
    }
  }
  if (url.hash !== '') {
    return {
      detail: 'callback carries a fragment',
      kind: 'rejected',
      reason: 'fragment-present',
    }
  }
  if (FORBIDDEN_CALLBACK_PARAMETERS.some((parameter) => url.searchParams.has(parameter))) {
    return {
      detail: 'callback carries a credential parameter',
      kind: 'rejected',
      reason: 'credential-bearing',
    }
  }

  const names = [...url.searchParams.keys()]
  if (new Set(names).size !== names.length) {
    return {
      detail: 'callback repeats a parameter',
      kind: 'rejected',
      reason: 'duplicate-parameters',
    }
  }
  if (
    names.length !== EXPECTED_CALLBACK_PARAMETERS.length ||
    EXPECTED_CALLBACK_PARAMETERS.some((parameter) => !url.searchParams.has(parameter))
  ) {
    return {
      detail: 'callback must carry exactly code, nonce, and state',
      kind: 'rejected',
      reason: 'unexpected-parameters',
    }
  }

  const code = url.searchParams.get('code') ?? ''
  const nonce = url.searchParams.get('nonce') ?? ''
  const state = url.searchParams.get('state') ?? ''
  if (!DESKTOP_AUTH_CALLBACK_CODE.test(code)) {
    return { detail: 'callback code is invalid', kind: 'rejected', reason: 'malformed' }
  }
  if (!DESKTOP_AUTH_CALLBACK_TOKEN.test(nonce) || !DESKTOP_AUTH_CALLBACK_TOKEN.test(state)) {
    return {
      detail: 'callback nonce or state is invalid',
      kind: 'rejected',
      reason: 'malformed',
    }
  }

  return {
    bindingKey: `${nonce}.${state}`,
    callback: url.toString(),
    kind: 'callback',
  }
}

/** The handoff file `desktop_auth_take_callback` reads and clears. */
export function desktopAuthCallbackPath(dataDir: string): string {
  return join(dataDir, DESKTOP_STATE_DIRECTORY, DESKTOP_AUTH_CALLBACK_FILE)
}

/**
 * Queue one validated callback into the existing handoff. The write is
 * owner-only and atomic (temp file + rename) so the renderer never reads a
 * half-written JSON string.
 */
export function writeDesktopAuthCallback(dataDir: string, callback: string): void {
  const directory = join(dataDir, DESKTOP_STATE_DIRECTORY)
  mkdirSync(directory, { mode: 0o700, recursive: true })
  const target = join(directory, DESKTOP_AUTH_CALLBACK_FILE)
  const temporary = `${target}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(callback), { mode: 0o600 })
  renameSync(temporary, target)
}

export interface DesktopAuthCallbackReceiver {
  receive(delivery: DesktopAuthCallbackDelivery): Promise<DesktopAuthCallbackReceipt>
}

/**
 * The receiver. `loadAttempt` reads the existing pending PKCE attempt from the
 * shell's `desktop_auth_attempt_load` record; `deliver` routes a validated
 * callback into the shell handoff. The receiver never consumes the attempt and
 * never sees a credential: only the callback URL is delivered.
 */
export function createDesktopAuthCallbackReceiver({
  instanceId,
  loadAttempt,
  deliver,
  now = Date.now,
  onReceipt,
}: {
  instanceId: string
  loadAttempt: () =>
    | Promise<DesktopAuthorizationAttempt | null>
    | DesktopAuthorizationAttempt
    | null
  deliver: (callback: string) => Promise<void> | void
  now?: () => number
  onReceipt?: (receipt: DesktopAuthCallbackReceipt) => void
}): DesktopAuthCallbackReceiver {
  // One delivery per pending attempt. Keyed by the attempt's state/nonce, so a
  // second URL that matches the same attempt - even with a different code -
  // cannot reach the handoff. The attempt itself stays untouched for the
  // renderer's single-use consume.
  const deliveredBindings = new Set<string>()

  async function receive(
    delivery: DesktopAuthCallbackDelivery
  ): Promise<DesktopAuthCallbackReceipt> {
    const receipt = await route(delivery)
    onReceipt?.(receipt)
    return receipt
  }

  async function route({
    rawUrl,
    targetInstanceId,
  }: DesktopAuthCallbackDelivery): Promise<DesktopAuthCallbackReceipt> {
    const parsed = parseDesktopAuthCallback(rawUrl)
    if (parsed.kind === 'foreign') return { reason: 'foreign-target', status: 'ignored' }
    if (parsed.kind === 'rejected') {
      return {
        ...(parsed.detail ? { detail: parsed.detail } : {}),
        reason: parsed.reason,
        status: 'rejected',
      }
    }
    if (targetInstanceId !== instanceId) return { reason: 'wrong-instance', status: 'rejected' }
    if (deliveredBindings.has(parsed.bindingKey)) {
      return { reason: 'replay', status: 'rejected' }
    }

    let attempt: DesktopAuthorizationAttempt | null
    try {
      attempt = await loadAttempt()
    } catch {
      return { reason: 'no-pending-attempt', status: 'rejected' }
    }
    if (!attempt) return { reason: 'no-pending-attempt', status: 'rejected' }

    try {
      // Probe the shared binding contract on a clone: this exercises the
      // consumed, expired, state, and nonce checks without marking the stored
      // attempt used. The renderer's consume is the one that consumes.
      consumeDesktopAuthorizationCallback({ ...attempt }, parsed.callback, now())
    } catch (error) {
      return {
        detail: error instanceof Error ? error.message : 'callback binding failed',
        reason: 'binding-failed',
        status: 'rejected',
      }
    }

    try {
      await deliver(parsed.callback)
    } catch (error) {
      return {
        detail: error instanceof Error ? error.message : 'callback delivery failed',
        reason: 'delivery-failed',
        status: 'rejected',
      }
    }
    deliveredBindings.add(parsed.bindingKey)
    return { callback: parsed.callback, status: 'delivered' }
  }

  return { receive }
}
