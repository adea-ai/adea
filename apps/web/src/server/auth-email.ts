import type { AuthMessageTransport } from '@adea-ai/auth/server'

export const AUTH_EMAIL_SENDER = 'team@adea.dev'

/** Called only after the auth delivery boundary validates the recipient and callback. */
export function createCloudflareAuthTransport(email: SendEmail): AuthMessageTransport {
  return {
    async send(kind, message) {
      const verification = kind === 'verification'
      await email.send({
        from: { email: AUTH_EMAIL_SENDER, name: 'Adea' },
        to: message.email,
        subject: verification ? 'Verify your Adea email' : 'Reset your Adea password',
        text: `${verification ? 'Verify your email address' : 'Reset your password'} by opening this link:\n\n${message.url}\n\nIf you did not request this, you can ignore this email.`,
      })
    },
  }
}
