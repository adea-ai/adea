// The packaged `adea://auth/callback` receiver (docs/specs/desktop-auth.md
// "The callback"): strict target/parameter validation, one-use binding to the
// pending PKCE attempt, and routing into the existing shell handoff. The native
// boundary — Electrobun's `app.on('open-url')` — is mocked here; no OS
// scheme registration runs, and no real credentials are touched.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createDesktopAuthorizationAttempt,
  type DesktopAuthorizationAttempt,
} from '../../../packages/auth/src/desktop'
import {
  DESKTOP_AUTH_CALLBACK_READY_EVENT,
  createDesktopAuthCallbackReceiver,
  parseDesktopAuthCallback,
  writeDesktopAuthCallback,
  type DesktopAuthCallbackDelivery,
  type DesktopAuthCallbackRejection,
  type DesktopAuthCallbackReceipt,
  type DesktopAuthCallbackReceiver,
} from '../shell/src/auth-callback'
import { createDesktopAuthCallbackChannel } from '../shell/src/auth-callback-channel'
import { createCommandSurface } from '../shell/src/commands'

const INSTANCE = 'instance-primary'
const CODE = 'code-1234567890'
const WRONG_INSTANCE = 'instance-secondary'

async function pendingAttempt(
  overrides: Partial<DesktopAuthorizationAttempt> = {}
): Promise<DesktopAuthorizationAttempt> {
  const attempt = await createDesktopAuthorizationAttempt({ now: 1_000 })
  return { ...attempt, ...overrides }
}

function callbackFor(attempt: DesktopAuthorizationAttempt, code = CODE): string {
  return `adea://auth/callback?code=${code}&nonce=${attempt.nonce}&state=${attempt.state}`
}

function createReceiver(
  attempt: DesktopAuthorizationAttempt | null,
  {
    deliver = () => {},
    instanceId = INSTANCE,
    now = () => 2_000,
  }: {
    deliver?: (callback: string) => void
    instanceId?: string
    now?: () => number
  } = {}
): { delivered: string[]; receiver: DesktopAuthCallbackReceiver } {
  const delivered: string[] = []
  const receiver = createDesktopAuthCallbackReceiver({
    deliver: (callback) => {
      delivered.push(callback)
      deliver(callback)
    },
    instanceId,
    loadAttempt: () => attempt,
    now,
  })
  return { delivered, receiver }
}

async function receive(
  receiver: DesktopAuthCallbackReceiver,
  rawUrl: string,
  targetInstanceId = INSTANCE
): Promise<DesktopAuthCallbackReceipt> {
  const delivery: DesktopAuthCallbackDelivery = { rawUrl, targetInstanceId }
  return receiver.receive(delivery)
}

describe('desktop auth callback native channel', () => {
  test('buffers a cold-launch URL until the receiver attaches, then drains it once', () => {
    const handlers: Array<(payload: { url?: unknown }) => void> = []
    const app = {
      on: (name: 'open-url', handler: (payload: { url?: unknown }) => void) => {
        expect(name).toBe('open-url')
        handlers.push(handler)
        return () => handlers.splice(handlers.indexOf(handler), 1)
      },
    }
    const channel = createDesktopAuthCallbackChannel(app)
    const openUrl = handlers[0]!

    // The OS opened the app with the callback before the receiver existed
    // (cold start): Electrobun delivers it as an open-url.
    openUrl({ url: 'adea://auth/callback?code=abcdefgh&nonce=nnnn&state=ssss' })

    const seen: string[] = []
    channel.attach((url) => seen.push(url))
    expect(seen).toEqual(['adea://auth/callback?code=abcdefgh&nonce=nnnn&state=ssss'])

    channel.dispose()
    openUrl({ url: 'adea://auth/callback?code=later' })
    expect(seen).toHaveLength(1)
  })

  test('forwards a warm URL to the attached receiver and ignores empty payloads', () => {
    let handler: ((payload: { url?: unknown }) => void) | undefined
    const app = {
      on: (_name: 'open-url', next: (payload: { url?: unknown }) => void) => {
        handler = next
        return () => {
          handler = undefined
        }
      },
    }
    const channel = createDesktopAuthCallbackChannel(app)
    const seen: string[] = []
    channel.attach((url) => seen.push(url))

    handler!({ url: '' })
    handler!({})
    handler!({ url: 'adea://auth/callback?code=warm' })
    expect(seen).toEqual(['adea://auth/callback?code=warm'])
  })
})

describe('desktop auth callback parsing', () => {
  test('accepts exactly adea://auth/callback with code, nonce, and state', async () => {
    const attempt = await pendingAttempt()
    const url = callbackFor(attempt)
    expect(parseDesktopAuthCallback(url)).toEqual({
      bindingKey: `${attempt.nonce}.${attempt.state}`,
      callback: url,
      kind: 'callback',
    })
  })

  test('treats a different scheme as a foreign URL rather than a refusal', async () => {
    const attempt = await pendingAttempt()
    expect(parseDesktopAuthCallback(`https://auth/callback?code=${CODE}`)).toEqual({
      kind: 'foreign',
    })
    expect(parseDesktopAuthCallback('file:///tmp/notes.txt')).toEqual({ kind: 'foreign' })
    // A foreign URL never reaches binding, so it cannot consume the attempt.
    const { delivered, receiver } = createReceiver(attempt)
    expect(await receive(receiver, 'file:///tmp/notes.txt')).toEqual({
      reason: 'foreign-target',
      status: 'ignored',
    })
    expect(delivered).toHaveLength(0)
  })

  const rejections: Array<{
    label: string
    reason: DesktopAuthCallbackRejection
    url: (callback: string) => string
  }> = [
    {
      label: 'an adea target that is not the callback',
      reason: 'untrusted-target',
      url: (callback) => callback.replace('adea://auth/callback', 'adea://evil/callback'),
    },
    {
      label: 'credentials in the target',
      reason: 'credential-bearing',
      url: (callback) => callback.replace('adea://auth/', 'adea://user:secret@auth/'),
    },
    {
      label: 'an unusable adea URL',
      reason: 'malformed',
      url: () => 'adea://[',
    },
    {
      label: 'a fragment',
      reason: 'fragment-present',
      url: (callback) => `${callback}#fragment`,
    },
    {
      label: 'a credential parameter',
      reason: 'credential-bearing',
      url: (callback) => `${callback}&access_token=stolen`,
    },
    {
      label: 'a bare token parameter',
      reason: 'credential-bearing',
      url: (callback) => `${callback}&token=stolen`,
    },
    {
      label: 'a repeated parameter',
      reason: 'duplicate-parameters',
      url: (callback) => `${callback}&code=another-code`,
    },
    {
      label: 'an extra parameter',
      reason: 'unexpected-parameters',
      url: (callback) => `${callback}&scope=full`,
    },
    {
      label: 'a missing parameter',
      reason: 'unexpected-parameters',
      url: (callback) => callback.replace(/&state=[^&]+/u, ''),
    },
    {
      label: 'a short code',
      reason: 'malformed',
      url: () => 'adea://auth/callback?code=abc&nonce=nnnnnnnnnnnnnnnn&state=ssssssssssssssss',
    },
    {
      label: 'a short nonce',
      reason: 'malformed',
      url: (callback) => callback.replace(/nonce=[^&]+/u, 'nonce=n'),
    },
  ]

  for (const { label, reason, url } of rejections) {
    test(`refuses ${label}`, async () => {
      const attempt = await pendingAttempt()
      const { delivered, receiver } = createReceiver(attempt)
      const receipt = await receive(receiver, url(callbackFor(attempt)))
      expect(receipt).toMatchObject({ reason, status: 'rejected' })
      expect(delivered).toHaveLength(0)
    })
  }
})

describe('desktop auth callback routing', () => {
  test('writes the validated callback into the existing handoff and reads it once', async () => {
    const attempt = await pendingAttempt()
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-auth-callback-'))
    try {
      const receiver = createDesktopAuthCallbackReceiver({
        deliver: (callback) => writeDesktopAuthCallback(dataDir, callback),
        instanceId: INSTANCE,
        loadAttempt: () => attempt,
        now: () => 2_000,
      })
      const url = callbackFor(attempt)

      expect(await receive(receiver, url)).toEqual({ callback: url, status: 'delivered' })
      // The handoff file holds the JSON string `desktop_auth_take_callback`
      // reads and clears.
      const stored = readFileSync(join(dataDir, 'desktop-state', 'auth-callback.json'), 'utf8')
      expect(JSON.parse(stored)).toBe(url)

      const invoke = createCommandSurface(dataDir)
      expect(invoke('desktop_auth_take_callback')).toEqual({ ok: true, value: url })
      expect(existsSync(join(dataDir, 'desktop-state', 'auth-callback.json'))).toBe(false)
      expect(invoke('desktop_auth_take_callback')).toEqual({ ok: true, value: null })

      // The receiver probes binding on a clone: the stored attempt is left for
      // the renderer's own single-use consume.
      expect(attempt.used).toBe(false)
    } finally {
      rmSync(dataDir, { force: true, recursive: true })
    }
  })

  test('refuses a callback addressed to another instance', async () => {
    const attempt = await pendingAttempt()
    const { delivered, receiver } = createReceiver(attempt)
    expect(await receive(receiver, callbackFor(attempt), WRONG_INSTANCE)).toEqual({
      reason: 'wrong-instance',
      status: 'rejected',
    })
    expect(delivered).toHaveLength(0)
  })

  test('refuses a re-delivered callback for the same attempt', async () => {
    const attempt = await pendingAttempt()
    const { delivered, receiver } = createReceiver(attempt)
    const url = callbackFor(attempt)
    expect(await receive(receiver, url)).toEqual({ callback: url, status: 'delivered' })
    // A second delivery — even with a fresh code — cannot reach the handoff.
    expect(await receive(receiver, callbackFor(attempt, 'code-9999999999'))).toEqual({
      reason: 'replay',
      status: 'rejected',
    })
    expect(delivered).toEqual([url])
  })

  test('refuses a callback when no PKCE attempt is pending', async () => {
    const attempt = await pendingAttempt()
    const { delivered, receiver } = createReceiver(null)
    expect(await receive(receiver, callbackFor(attempt))).toEqual({
      reason: 'no-pending-attempt',
      status: 'rejected',
    })
    expect(delivered).toHaveLength(0)
  })

  const bindingFailures: Array<{
    detail: string
    label: string
    attempt: (attempt: DesktopAuthorizationAttempt) => Partial<DesktopAuthorizationAttempt>
    now?: () => number
  }> = [
    {
      detail: 'already consumed',
      label: 'an already consumed attempt',
      attempt: () => ({ used: true }),
    },
    {
      detail: 'expired',
      label: 'an expired attempt',
      attempt: () => ({}),
      now: () => 10_000_000,
    },
    {
      detail: 'state mismatch',
      label: 'a state mismatch',
      attempt: (attempt) => ({ state: 'x'.repeat(attempt.state.length) }),
    },
    {
      detail: 'nonce mismatch',
      label: 'a nonce mismatch',
      attempt: (attempt) => ({ nonce: 'x'.repeat(attempt.nonce.length) }),
    },
  ]

  for (const { attempt: mutate, detail, label, now } of bindingFailures) {
    test(`refuses ${label}`, async () => {
      const base = await pendingAttempt()
      const { delivered, receiver } = createReceiver({ ...base, ...mutate(base) }, { now })
      const receipt = await receive(receiver, callbackFor(base))
      expect(receipt).toMatchObject({ reason: 'binding-failed', status: 'rejected' })
      expect(receipt.status === 'rejected' && receipt.detail).toContain(detail)
      expect(delivered).toHaveLength(0)
    })
  }
})

describe('desktop auth callback packaging', () => {
  const shellDir = join(import.meta.dir, '../shell')

  test('registers the adea scheme declaratively for packaged builds', () => {
    const config = readFileSync(join(shellDir, 'electrobun.config.ts'), 'utf8')
    expect(config).toContain("urlSchemes: ['adea']")
  })

  test('wires the receiver into the shell entry behind the open-url event', () => {
    const entry = readFileSync(join(shellDir, 'src/bun/index.ts'), 'utf8')
    expect(entry).toContain('createDesktopAuthCallbackChannel')
    expect(entry).toContain('createDesktopAuthCallbackReceiver')
    expect(entry).toContain('writeDesktopAuthCallback')
    expect(entry).toContain('desktop_auth_attempt_load')
    // The queued callback announces itself to the renderer that takes it.
    expect(entry).toContain('DESKTOP_AUTH_CALLBACK_READY_EVENT')
    expect(DESKTOP_AUTH_CALLBACK_READY_EVENT).toBe('desktop-auth-callback-ready')
  })

  test('declares the open-url seam instead of guessing the Electrobun runtime', () => {
    const ambient = readFileSync(join(shellDir, 'src/electrobun.d.ts'), 'utf8')
    expect(ambient).toContain("on(name: 'open-url'")
  })
})
