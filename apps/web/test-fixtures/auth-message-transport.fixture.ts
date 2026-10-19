// FIXTURE ONLY. Substituted for src/server/auth-message-transport.ts by the fixture
// build (vite.auth-fixture.config.ts, via start/build-auth-fixture.mjs). It is never part of the
// production output. It hands each verification or reset message to a loopback
// outbox owned by the local acceptance harness. No mail is sent anywhere.
import 'server-only'

import type { AuthMessageKind, AuthMessageTransport } from '@adea-ai/auth/server'

const REFUSED_PREFIX = 'fail+'

export const authMessageTransport: AuthMessageTransport = {
  async send(kind: AuthMessageKind, message) {
    const outbox = process.env.ADEA_AUTH_FIXTURE_OUTBOX_URL
    if (!outbox) throw new Error('fixture outbox is not configured')
    // Failure injection: the transport refuses the message, so nothing is recorded.
    if (message.email.startsWith(REFUSED_PREFIX)) throw new Error('fixture transport refusal')
    const response = await fetch(new URL('/record', outbox), {
      body: JSON.stringify({
        email: message.email,
        kind,
        token: message.token,
        url: message.url,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    if (!response.ok) throw new Error('fixture outbox refused the message')
  },
}
