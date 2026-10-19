import { describe, expect, test } from 'bun:test'
import type { BetterAuthOptions } from 'better-auth'

import { readBetterAuthConfig } from '../../src/config'
import { createBetterAuthOptions } from '../../src/better-auth-options'
import { createRecordingAuthDelivery } from '../../src/delivery'

const origin = 'https://auth.example.test'
const base = {
  AUTH_BASE_URL: origin,
  AUTH_DATABASE_URL: 'postgresql://app:app-only@127.0.0.1:5432/adea',
  AUTH_SECRET: 'unit-options-secret-at-least-thirty-two-characters',
  AUTH_TRUSTED_ORIGINS: origin,
}
// Any Better Auth database value is accepted here: these tests inspect options only.
const database = {} as NonNullable<BetterAuthOptions['database']>

type MessageData = { token: string; url: string; user: { email: string } }
type Sender = (data: MessageData) => Promise<void>

function optionsFor(environment: Record<string, string> = {}) {
  const recorder = createRecordingAuthDelivery()
  const options = createBetterAuthOptions({
    config: readBetterAuthConfig({ ...base, ...environment }),
    database,
    delivery: recorder.delivery,
  })
  return { options, recorder }
}

describe('shared Better Auth options', () => {
  test('carry the configured origin, secret, session lifetimes and secure cookie policy', () => {
    const { options } = optionsFor({ AUTH_SESSION_EXPIRES_IN_SECONDS: '3600' })

    expect(options.baseURL).toBe(origin)
    expect(options.secret).toBe(base.AUTH_SECRET)
    expect(options.database).toBe(database)
    expect(options.session?.expiresIn).toBe(3600)
    expect(options.advanced?.useSecureCookies).toBe(true)
    expect(options.advanced?.defaultCookieAttributes).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
    })
  })

  test('keep email/password on with the fixed password policy and revoke sessions on reset', () => {
    const { options } = optionsFor()

    expect(options.emailAndPassword).toMatchObject({
      enabled: true,
      minPasswordLength: 8,
      revokeSessionsOnPasswordReset: true,
    })
  })

  test('mirror the verification requirement into sign-up behaviour', () => {
    const required = optionsFor().options
    const optional = optionsFor({ AUTH_EMAIL_VERIFICATION_REQUIRED: 'false' }).options

    expect(required.emailAndPassword?.requireEmailVerification).toBe(true)
    expect(required.emailVerification?.sendOnSignUp).toBe(true)
    expect(optional.emailAndPassword?.requireEmailVerification).toBe(false)
    expect(optional.emailVerification?.sendOnSignUp).toBe(false)
    expect(optional.emailVerification?.autoSignInAfterVerification).toBe(true)
  })

  test('enable no social provider unless Google is fully configured', () => {
    expect(optionsFor().options.socialProviders).toBeUndefined()

    const google = optionsFor({
      GOOGLE_CLIENT_ID: 'google-client-id',
      GOOGLE_CLIENT_SECRET: 'google-client-secret',
    }).options

    expect(google.socialProviders).toEqual({
      google: { clientId: 'google-client-id', clientSecret: 'google-client-secret' },
    })
  })

  test('pass only HTTP(S) origins to Better Auth; the desktop callback scheme is excluded', () => {
    const { options } = optionsFor({
      AUTH_TRUSTED_ORIGINS: `${origin},adea://callback`,
    })

    expect(options.trustedOrigins).toEqual([origin])
  })
})

describe('verification and reset delivery wiring', () => {
  test('a verification request reaches the injected delivery with the account email, token and link', async () => {
    const { options, recorder } = optionsFor()
    const send = options.emailVerification?.sendVerificationEmail as unknown as Sender

    await send({
      token: 'verify-token',
      url: `${origin}/api/auth/verify-email?token=verify-token`,
      user: { email: 'new@example.test' },
    })

    expect(recorder.sent).toEqual([
      {
        email: 'new@example.test',
        kind: 'verification',
        token: 'verify-token',
        url: `${origin}/api/auth/verify-email?token=verify-token`,
      },
    ])
  })

  test('a reset request reaches the injected delivery as a password-reset message', async () => {
    const { options, recorder } = optionsFor()
    const send = options.emailAndPassword?.sendResetPassword as unknown as Sender

    await send({
      token: 'reset-token',
      url: `${origin}/api/auth/reset-password/reset-token`,
      user: { email: 'member@example.test' },
    })

    expect(recorder.sent.map((entry) => entry.kind)).toEqual(['password-reset'])
    expect(recorder.sent[0]?.email).toBe('member@example.test')
  })

  test('an unconfigured delivery makes the message fail rather than vanish', async () => {
    const options = createBetterAuthOptions({
      config: readBetterAuthConfig(base),
      database,
      delivery: {
        async sendPasswordReset() {
          throw new Error('no transport')
        },
        async sendVerificationEmail() {
          throw new Error('no transport')
        },
      },
    })
    const send = options.emailAndPassword?.sendResetPassword as unknown as Sender

    await expect(
      send({
        token: 'reset-token',
        url: `${origin}/api/auth/reset-password/reset-token`,
        user: { email: 'member@example.test' },
      })
    ).rejects.toThrow('no transport')
  })
})
