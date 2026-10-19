import { describe, expect, test } from 'bun:test'

import {
  AuthDeliveryUnavailableError,
  createRecordingAuthDelivery,
  createUnconfiguredDelivery,
} from '../../src/delivery'

describe('provider-independent delivery', () => {
  test('a recording transport captures verification and reset messages without sending', async () => {
    const { delivery, sent } = createRecordingAuthDelivery()

    await delivery.sendVerificationEmail({
      email: 'new@example.test',
      token: 'verify-token',
      url: 'https://auth.test/api/auth/verify-email?token=verify-token',
    })
    const expiresAt = new Date('2030-01-01T00:00:00.000Z')
    await delivery.sendPasswordReset({
      email: 'new@example.test',
      expiresAt,
      token: 'reset-token',
      url: 'https://auth.test/api/auth/reset-password/reset-token',
    })

    expect(sent).toEqual([
      {
        email: 'new@example.test',
        kind: 'verification',
        token: 'verify-token',
        url: 'https://auth.test/api/auth/verify-email?token=verify-token',
      },
      {
        email: 'new@example.test',
        expiresAt,
        kind: 'password-reset',
        token: 'reset-token',
        url: 'https://auth.test/api/auth/reset-password/reset-token',
      },
    ])
  })

  test('the unconfigured transport fails closed for both message kinds', async () => {
    const delivery = createUnconfiguredDelivery()
    await expect(
      delivery.sendVerificationEmail({ email: 'x@example.test', token: 't', url: 'https://x.test' })
    ).rejects.toBeInstanceOf(AuthDeliveryUnavailableError)
    await expect(
      delivery.sendPasswordReset({ email: 'x@example.test', token: 't', url: 'https://x.test' })
    ).rejects.toThrow('password-reset')
  })
})
