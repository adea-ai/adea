import { expect, test } from 'bun:test'
import { createCloudflareAuthTransport } from '../src/server/auth-email'

test('verification and reset messages use the configured sender and exact validated callback', async () => {
  const sent: EmailMessageBuilder[] = []
  const email = {
    async send(message: EmailMessageBuilder) {
      sent.push(message)
      return { messageId: 'synthetic' }
    },
  } as SendEmail
  const transport = createCloudflareAuthTransport(email)
  for (const kind of ['verification', 'password-reset'] as const) {
    await transport.send(kind, {
      email: 'account@example.invalid',
      token: 'synthetic',
      url: `https://adea.dev/api/auth/${kind}?token=synthetic`,
    })
  }
  expect(sent.map((message) => message.from)).toEqual([
    { email: 'team@adea.dev', name: 'Adea' },
    { email: 'team@adea.dev', name: 'Adea' },
  ])
  expect(sent.map((message) => message.subject)).toEqual([
    'Verify your Adea email',
    'Reset your Adea password',
  ])
  expect(sent[0]?.text).toContain('https://adea.dev/api/auth/verification?token=synthetic')
  expect(sent[1]?.text).toContain('https://adea.dev/api/auth/password-reset?token=synthetic')
})

test('provider refusal reaches the existing sanitized delivery boundary', async () => {
  const transport = createCloudflareAuthTransport({
    async send() {
      throw new Error('synthetic delivery refusal')
    },
  } as SendEmail)
  await expect(
    transport.send('verification', {
      email: 'account@example.invalid',
      token: 'synthetic',
      url: 'https://adea.dev/api/auth/verify?token=synthetic',
    })
  ).rejects.toThrow('synthetic delivery refusal')
})
