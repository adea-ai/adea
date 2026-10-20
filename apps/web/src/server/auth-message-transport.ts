import 'server-only'

import type { AuthMessageTransport } from '@adea-ai/auth/server'

/**
 * The verification and password-reset transport for the auth route. This
 * repository configures none: no mail provider, credential, or production
 * transport is wired here, so every message is refused and the flow fails
 * closed. A deployment that adds a transport supplies it in this one place.
 *
 * The fixture build replaces this module at build time only (see
 * `vite.config.ts`), so the production output never contains a recorder.
 */
export const authMessageTransport: AuthMessageTransport | undefined = undefined
