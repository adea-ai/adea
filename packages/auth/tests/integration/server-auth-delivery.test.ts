import { describe, expect, test } from 'bun:test'

import {
  AuthDeliveryFailedError,
  AuthDeliveryRejectedError,
  createServerAuthDelivery,
  type AuthMessageKind,
  type AuthMessageTransport,
} from '../../src/server'
import { createUnconfiguredDelivery, type AuthDeliveryMessage } from '../../src/delivery'

// Synthetic values only. No transport here sends mail or touches a provider.
const baseUrl = 'https://app.example.test'
const token = 'synthetic-token-0123456789abcdef'
const email = 'person@example.test'

function recordingTransport(failWith?: Error) {
  const sent: Array<{ kind: AuthMessageKind; message: AuthDeliveryMessage }> = []
  const transport: AuthMessageTransport = {
    async send(kind, payload) {
      if (failWith) throw failWith
      sent.push({ kind, message: payload })
    },
  }
  return { sent, transport }
}

function message(overrides: Partial<AuthDeliveryMessage> = {}): AuthDeliveryMessage {
  return {
    email,
    token,
    url: `${baseUrl}/api/auth/verify-email?token=${token}`,
    ...overrides,
  }
}

async function rejectionOf(run: Promise<void>): Promise<AuthDeliveryRejectedError> {
  try {
    await run
  } catch (error) {
    if (error instanceof AuthDeliveryRejectedError) return error
    throw error
  }
  throw new Error('expected the message to be rejected')
}

describe('server-injected authentication delivery', () => {
  test('hands a verification message to the transport exactly once, with its kind', async () => {
    const { sent, transport } = recordingTransport()
    const delivery = createServerAuthDelivery({ baseUrl, transport })

    await delivery.sendVerificationEmail(message())

    expect(sent).toHaveLength(1)
    expect(sent[0]?.kind).toBe('verification')
    expect(sent[0]?.message.email).toBe(email)
    expect(sent[0]?.message.token).toBe(token)
  })

  test('hands a password-reset message to the transport with its own kind', async () => {
    const { sent, transport } = recordingTransport()
    const delivery = createServerAuthDelivery({ baseUrl, transport })

    await delivery.sendPasswordReset(
      message({ url: `${baseUrl}/api/auth/reset-password/${token}?callbackURL=%2F` })
    )

    expect(sent.map((entry) => entry.kind)).toEqual(['password-reset'])
  })

  test('accepts loopback HTTP for local development only', async () => {
    const { sent, transport } = recordingTransport()
    const delivery = createServerAuthDelivery({ baseUrl: 'http://127.0.0.1:8787', transport })

    await delivery.sendVerificationEmail(
      message({ url: `http://127.0.0.1:8787/api/auth/verify-email?token=${token}` })
    )
    expect(sent).toHaveLength(1)
  })

  test('refuses a non-HTTPS base URL outside loopback before any message is sent', () => {
    const { transport } = recordingTransport()
    expect(() =>
      createServerAuthDelivery({ baseUrl: 'http://app.example.test', transport })
    ).toThrow('must be HTTPS outside loopback development')
  })

  test.each([
    [
      'a callback on another origin',
      message({ url: `https://evil.example.test/api/auth/verify-email?token=${token}` }),
      'not on the configured app origin',
    ],
    [
      'a callback that downgrades to HTTP',
      message({ url: `http://app.example.test/api/auth/verify-email?token=${token}` }),
      'not on the configured app origin',
    ],
    [
      'a callback with embedded credentials',
      message({ url: `https://user:secret@app.example.test/api/auth/verify-email?token=${token}` }),
      'carries credentials',
    ],
    [
      'a callback outside the auth endpoints',
      message({ url: `${baseUrl}/settings?token=${token}` }),
      'not an auth endpoint',
    ],
    ['a relative callback', message({ url: '/api/auth/verify-email' }), 'not absolute'],
    [
      'a malformed recipient',
      message({ email: 'not-an-address' }),
      'not a well-formed email address',
    ],
    ['an empty token', message({ token: '' }), 'token is empty'],
    ['a token containing whitespace', message({ token: 'two words here' }), 'token is empty'],
    [
      'an invalid expiry',
      message({ expiresAt: new Date('not a date') }),
      'expiry is not a valid date',
    ],
    [
      'an already expired message',
      message({ expiresAt: new Date(Date.now() - 1_000) }),
      'already expired',
    ],
  ])('refuses %s without calling the transport', async (_label, bad, reason) => {
    const { sent, transport } = recordingTransport()
    const delivery = createServerAuthDelivery({ baseUrl, transport })

    const rejection = await rejectionOf(delivery.sendVerificationEmail(bad))

    expect(rejection.reason).toContain(reason)
    expect(sent).toEqual([])
  })

  test('rejection errors name the kind and check, never the token, URL or address', async () => {
    const { transport } = recordingTransport()
    const delivery = createServerAuthDelivery({ baseUrl, transport })
    const hostile = message({
      email: `leak-${token}@example.test extra`,
      url: `https://evil.example.test/api/auth/reset-password/${token}`,
    })

    const rejection = await rejectionOf(delivery.sendPasswordReset(hostile))

    expect(rejection.kind).toBe('password-reset')
    expect(rejection.message).not.toContain(token)
    expect(rejection.message).not.toContain('evil.example.test')
    expect(rejection.message).not.toContain('leak-')
  })

  test('a transport failure surfaces as a redacted failure, not the transport error', async () => {
    const leaky = new Error(`provider echoed ${token} to ${email}`)
    const { transport } = recordingTransport(leaky)
    const delivery = createServerAuthDelivery({ baseUrl, transport })

    let caught: unknown
    try {
      await delivery.sendVerificationEmail(message())
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(AuthDeliveryFailedError)
    const failure = caught as AuthDeliveryFailedError
    expect(failure.kind).toBe('verification')
    expect(failure.message).not.toContain(token)
    expect(failure.message).not.toContain(email)
    expect((failure as { cause?: unknown }).cause).toBeUndefined()
  })

  test('the unconfigured default still fails closed', async () => {
    await expect(createUnconfiguredDelivery().sendVerificationEmail(message())).rejects.toThrow(
      'No authentication delivery transport is configured for verification'
    )
  })
})
