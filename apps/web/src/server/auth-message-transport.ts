import 'server-only'

import type { AuthMessageTransport } from '@adea-ai/auth/server'
import { createCloudflareAuthTransport } from './auth-email'
import { workerBindings } from './worker-bindings'

/** Production sends through its Worker binding; unavailable sending fails closed. */
export const authMessageTransport: AuthMessageTransport = {
  async send(kind, message) {
    const email = workerBindings()?.AUTH_EMAIL
    if (!email) throw new Error('Authentication email binding is unavailable')
    await createCloudflareAuthTransport(email).send(kind, message)
  },
}
