import { createAuthClient } from 'better-auth/client'

import { createAuthAdapter } from './adapter'
import { createBetterAuthDriver } from './better-auth-driver'

// The browser needs the failure-code mapper to explain a rejected sign-in,
// and the input normalizer so rejected input never gets submitted.
export { AUTH_ERROR_CODES, AuthProviderError, authErrorCode, type AuthErrorCode } from './errors'
export { normalizeEmail } from './normalize'

/**
 * The client talks to the app's same-origin `/api/auth/*` proxy, which serves
 * the self-hosted Better Auth handler. The factory name is retained for the
 * existing Solid call sites; the implementation no longer uses a hosted Neon
 * Auth client.
 */
export function createNeonClientAdapter() {
  const client = createAuthClient()

  return createAuthAdapter(
    createBetterAuthDriver({
      getSession: (options) => client.getSession(options ? { query: options } : undefined),
      listSessions: () => client.listSessions(),
      revokeSession: ({ token }) => client.revokeSession({ token }),
      signInEmail: (credentials) => client.signIn.email(credentials),
      signUpEmail: (registration) => client.signUp.email(registration),
      signOut: () => client.signOut(),
    }),
    { provider: 'better-auth' }
  )
}

/** Provider-neutral alias for {@link createNeonClientAdapter}. */
export const createAuthClientAdapter = createNeonClientAdapter
