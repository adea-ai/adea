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
  createDesktopAuthorizationManager,
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
import {
  DESKTOP_AUTH_CALLBACK_MAX_BUFFERED,
  DESKTOP_AUTH_CALLBACK_MAX_URL_LENGTH,
  createDesktopAuthCallbackChannel,
} from '../shell/src/auth-callback-channel'
import { createCommandSurface } from '../shell/src/commands'
import {
  createMemoryKeychainPort,
  type DesktopAuthKeychainPort,
} from '../shell/src/desktop-auth-store'

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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, reject, resolve }
}

function createMockOpenUrlApp(): {
  app: { on(name: 'open-url', handler: (payload: { url?: unknown }) => void): unknown }
  emit: (url: string) => void
} {
  let handler: ((payload: { url?: unknown }) => void) | undefined
  return {
    app: {
      on: (_name: 'open-url', next: (payload: { url?: unknown }) => void) => {
        handler = next
        return () => {
          handler = undefined
        }
      },
    },
    emit: (url) => handler?.({ url }),
  }
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

  test('accepts a URL at the length bound and drops one byte over it', () => {
    const { app, emit } = createMockOpenUrlApp()
    const channel = createDesktopAuthCallbackChannel(app)
    const seen: string[] = []
    channel.attach((url) => seen.push(url))

    const atLimit = 'a'.repeat(DESKTOP_AUTH_CALLBACK_MAX_URL_LENGTH)
    emit(atLimit)
    emit(`${atLimit}a`)
    expect(seen).toEqual([atLimit])
  })

  test('bounds the pre-attach buffer and drops overflow, keeping arrival order', () => {
    const { app, emit } = createMockOpenUrlApp()
    const channel = createDesktopAuthCallbackChannel(app)
    for (let index = 0; index < DESKTOP_AUTH_CALLBACK_MAX_BUFFERED + 3; index += 1) {
      emit(`adea://auth/callback?code=code-${String(index).padStart(8, '0')}`)
    }

    const seen: string[] = []
    channel.attach((url) => seen.push(url))
    expect(seen).toHaveLength(DESKTOP_AUTH_CALLBACK_MAX_BUFFERED)
    expect(seen[0]).toBe('adea://auth/callback?code=code-00000000')
    expect(seen.at(-1)).toBe(
      `adea://auth/callback?code=code-${String(DESKTOP_AUTH_CALLBACK_MAX_BUFFERED - 1).padStart(8, '0')}`
    )
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
  test('shares the injected auth store from attempt save through renderer consume', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-auth-callback-store-'))
    try {
      const keychain = createMemoryKeychainPort()
      const invoke = createCommandSurface(dataDir, { authKeychain: keychain })
      const commandValue = <T>(command: string, args?: Record<string, unknown>): T => {
        const result = invoke(command, args)
        if (result instanceof Promise) throw new Error(`${command} unexpectedly became async`)
        if (!result.ok) throw new Error(result.error)
        return result.value as T
      }
      const manager = createDesktopAuthorizationManager({
        createAttempt: () => createDesktopAuthorizationAttempt({ now: 1_000 }),
        vault: {
          clear: async () => {
            commandValue('desktop_auth_attempt_clear')
          },
          load: async () =>
            commandValue<DesktopAuthorizationAttempt | null>('desktop_auth_attempt_load'),
          save: async (attempt) => {
            commandValue('desktop_auth_attempt_save', { attempt })
          },
        },
      })

      const attempt = await manager.begin()
      expect(commandValue<DesktopAuthorizationAttempt | null>('desktop_auth_attempt_load')).toEqual(
        attempt
      )

      const receiver = createDesktopAuthCallbackReceiver({
        deliver: (callback) => writeDesktopAuthCallback(dataDir, callback),
        instanceId: INSTANCE,
        loadAttempt: () =>
          commandValue<DesktopAuthorizationAttempt | null>('desktop_auth_attempt_load'),
        now: () => 2_000,
      })
      const callback = callbackFor(attempt)
      expect(await receive(receiver, callback)).toEqual({ callback, status: 'delivered' })
      expect(commandValue<string | null>('desktop_auth_take_callback')).toBe(callback)
      expect(commandValue<string | null>('desktop_auth_take_callback')).toBeNull()

      // The receiver validates on a clone. The renderer's manager owns the
      // actual consume and clears the same keychain-backed attempt.
      expect(
        commandValue<DesktopAuthorizationAttempt | null>('desktop_auth_attempt_load')?.used
      ).toBe(false)
      expect(await manager.consume(callback, 2_000)).toEqual({
        code: CODE,
        codeVerifier: attempt.codeVerifier,
        nonce: attempt.nonce,
        redirectUri: 'adea://auth/callback',
      })
      expect(
        commandValue<DesktopAuthorizationAttempt | null>('desktop_auth_attempt_load')
      ).toBeNull()
      await expect(manager.consume(callback, 2_000)).rejects.toThrow('unavailable')
    } finally {
      rmSync(dataDir, { force: true, recursive: true })
    }
  })

  test('fails closed when the injected credential store denies callback attempt reads', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-auth-callback-denied-'))
    try {
      const deniedKeychain: DesktopAuthKeychainPort = {
        delete: () => {
          throw new Error('credential store denied')
        },
        get: () => {
          throw new Error('credential store denied')
        },
        set: () => {
          throw new Error('credential store denied')
        },
      }
      const invoke = createCommandSurface(dataDir, { authKeychain: deniedKeychain })
      const receiver = createDesktopAuthCallbackReceiver({
        deliver: (callback) => writeDesktopAuthCallback(dataDir, callback),
        instanceId: INSTANCE,
        loadAttempt: () => {
          const result = invoke('desktop_auth_attempt_load')
          if (result instanceof Promise) throw new Error('attempt load unexpectedly became async')
          if (!result.ok) throw new Error(result.error)
          return result.value as DesktopAuthorizationAttempt | null
        },
        now: () => 2_000,
      })
      const attempt = await pendingAttempt()

      expect(await receive(receiver, callbackFor(attempt))).toEqual({
        reason: 'no-pending-attempt',
        status: 'rejected',
      })
      expect(existsSync(join(dataDir, 'desktop-state', 'auth-callback.json'))).toBe(false)
      const loadResult = invoke('desktop_auth_attempt_load')
      expect(loadResult).toEqual({ ok: false, error: 'credential store denied' })
    } finally {
      rmSync(dataDir, { force: true, recursive: true })
    }
  })

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

  test('releases the reservation when no attempt is pending, so a later delivery succeeds', async () => {
    const attempt = await pendingAttempt()
    let current: DesktopAuthorizationAttempt | null = null
    const deliveries: string[] = []
    const receiver = createDesktopAuthCallbackReceiver({
      instanceId: INSTANCE,
      loadAttempt: () => current,
      deliver: (callback) => {
        deliveries.push(callback)
      },
      now: () => 2_000,
    })
    const url = callbackFor(attempt)
    // The OS callback outruns the renderer's attempt save.
    expect(await receive(receiver, url)).toEqual({
      reason: 'no-pending-attempt',
      status: 'rejected',
    })
    current = attempt
    expect(await receive(receiver, url)).toEqual({ callback: url, status: 'delivered' })
    expect(deliveries).toEqual([url])
  })

  test('serializes two deliveries of one URL to a single handoff write', async () => {
    const attempt = await pendingAttempt()
    const load = deferred<DesktopAuthorizationAttempt | null>()
    const deliveries: string[] = []
    const receiver = createDesktopAuthCallbackReceiver({
      instanceId: INSTANCE,
      loadAttempt: () => load.promise,
      deliver: (callback) => {
        deliveries.push(callback)
      },
      now: () => 2_000,
    })
    const url = callbackFor(attempt)

    const first = receive(receiver, url)
    const second = receive(receiver, url)
    // The reservation lands before the first call's attempt load yields, so the
    // second call is refused as replay instead of racing to the handoff.
    expect(await second).toEqual({ reason: 'replay', status: 'rejected' })
    load.resolve(attempt)
    expect(await first).toEqual({ callback: url, status: 'delivered' })
    expect(deliveries).toEqual([url])
  })

  test('refuses a second code for one attempt while the first delivery is in flight', async () => {
    const attempt = await pendingAttempt()
    const gate = deferred<void>()
    const deliveries: string[] = []
    const receiver = createDesktopAuthCallbackReceiver({
      instanceId: INSTANCE,
      loadAttempt: () => attempt,
      deliver: async (callback) => {
        deliveries.push(callback)
        await gate.promise
      },
      now: () => 2_000,
    })
    const firstUrl = callbackFor(attempt, 'code-1111111111')
    const secondUrl = callbackFor(attempt, 'code-2222222222')

    const first = receive(receiver, firstUrl)
    const second = receive(receiver, secondUrl)
    expect(await second).toEqual({ reason: 'replay', status: 'rejected' })
    gate.resolve()
    expect(await first).toEqual({ callback: firstUrl, status: 'delivered' })
    expect(deliveries).toEqual([firstUrl])
  })

  test('retries a delivery only when the handoff write provably did not occur', async () => {
    const attempt = await pendingAttempt()
    const url = callbackFor(attempt)
    let attempts = 0
    const receiver = createDesktopAuthCallbackReceiver({
      instanceId: INSTANCE,
      loadAttempt: () => attempt,
      deliver: () => {
        attempts += 1
        return attempts === 1 ? 'failed' : 'delivered'
      },
      now: () => 2_000,
    })
    expect(await receive(receiver, url)).toMatchObject({
      reason: 'delivery-failed',
      status: 'rejected',
    })
    expect(await receive(receiver, url)).toEqual({ callback: url, status: 'delivered' })
    expect(attempts).toBe(2)
  })

  test('never retries a delivery whose outcome is unknown', async () => {
    const attempt = await pendingAttempt()
    const url = callbackFor(attempt)
    let attempts = 0
    const receiver = createDesktopAuthCallbackReceiver({
      instanceId: INSTANCE,
      loadAttempt: () => attempt,
      deliver: () => {
        attempts += 1
        return 'unknown'
      },
      now: () => 2_000,
    })
    expect(await receive(receiver, url)).toMatchObject({
      reason: 'delivery-failed',
      status: 'rejected',
    })
    // A possibly-delivered write is never attempted again.
    expect(await receive(receiver, url)).toEqual({ reason: 'replay', status: 'rejected' })
    expect(attempts).toBe(1)
  })

  test('never retries a delivery that threw, since the write may have landed', async () => {
    const attempt = await pendingAttempt()
    const url = callbackFor(attempt)
    let attempts = 0
    const receiver = createDesktopAuthCallbackReceiver({
      instanceId: INSTANCE,
      loadAttempt: () => attempt,
      deliver: () => {
        attempts += 1
        throw new Error('handoff publish failed')
      },
      now: () => 2_000,
    })
    expect(await receive(receiver, url)).toMatchObject({
      reason: 'delivery-failed',
      status: 'rejected',
    })
    expect(await receive(receiver, url)).toEqual({ reason: 'replay', status: 'rejected' })
    expect(attempts).toBe(1)
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
    // The handoff write distinguishes a proven miss from an ambiguous one.
    expect(entry).toContain("return 'failed'")
    expect(entry).toContain("return 'unknown'")
  })

  test('declares the open-url seam instead of guessing the Electrobun runtime', () => {
    const ambient = readFileSync(join(shellDir, 'src/electrobun.d.ts'), 'utf8')
    expect(ambient).toContain("on(name: 'open-url'")
  })
})
