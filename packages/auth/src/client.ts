import { createAuthClient } from 'better-auth/client'

import {
  createAuthAdapter,
  type AuthAdapter,
  type AuthCredentials,
  type AuthRegistration,
} from './adapter'
import { createBetterAuthDriver } from './better-auth-driver'
import { AUTH_ERROR_CODES, AuthProviderError } from './errors'
import type { ProviderSessionInput } from './session'

// The browser needs the failure-code mapper to explain a rejected sign-in,
// and the input normalizer so rejected input never gets submitted.
export { AUTH_ERROR_CODES, AuthProviderError, authErrorCode, type AuthErrorCode } from './errors'
export { normalizeEmail } from './normalize'

type AuthResponse<T> = Promise<{ data: T | null; error: unknown }>
type CredentialCallResult = Promise<{ data: unknown; error: unknown }>

/**
 * The subset of Better Auth's browser client this adapter uses.
 *
 * Pinned Better Auth 1.6.23's credential endpoints do not return a session:
 * `signIn.email` resolves to `{ data: { redirect, token, url, user }, error }`
 * and a verification-required `signUp.email` to `{ data: { token: null, user },
 * error }`. Only `getSession` resolves to `{ data: { session, user } }`. The
 * interface mirrors that split so the credential flows read the session the
 * call established instead of the credential payload. It is exported so tests
 * can supply the real response shapes without a network.
 */
export type BetterAuthBrowserClient = {
  getSession(options?: {
    query?: { disableCookieCache?: boolean; disableRefresh?: boolean }
  }): Promise<{ data: ProviderSessionInput | null; error: unknown }>
  listSessions(): AuthResponse<Array<{ id: string; token: string }>>
  revokeSession(input: { token: string }): AuthResponse<unknown>
  signIn: { email(credentials: AuthCredentials): CredentialCallResult }
  signUp: { email(registration: AuthRegistration): CredentialCallResult }
  signOut(): AuthResponse<unknown>
}

/**
 * The client talks to the app's same-origin `/api/auth/*` proxy, which serves
 * the self-hosted Better Auth handler. The factory name is retained for the
 * existing Solid call sites; the implementation no longer uses a hosted Neon
 * Auth client.
 *
 * Pass a client to exercise the credential flows against Better Auth's real
 * response shapes; production callers use the default same-origin client.
 */
export function createNeonClientAdapter(
  client: BetterAuthBrowserClient = createAuthClient()
): AuthAdapter {
  // `signIn.email` / `signUp.email` return `{ redirect, token, url, user }` (or
  // `{ token: null, user }` when verification is required) — never a session —
  // so returning the credential payload would reach the shared normalizer
  // without `session.id`/`expiresAt` and throw "malformed session" on every
  // successful sign-in. Read the session the call just established through
  // `getSession`, which reflects the cookie the response set, and normalize
  // that instead.
  const credentialSession = async (
    call: () => CredentialCallResult
  ): Promise<{ data: ProviderSessionInput | null; error: unknown }> => {
    const result = await call()
    if (result.error) return { data: null, error: result.error }
    const session = await client.getSession()
    if (session.error) return { data: null, error: session.error }
    if (!session.data) {
      // The credential call succeeded but established no session: Better Auth's
      // verification-required signup. Surface the mailbox step with the shared
      // code the form maps to "confirm your email" instead of a misleading
      // malformed-session failure.
      return { data: null, error: new AuthProviderError(AUTH_ERROR_CODES.emailNotVerified) }
    }
    return { data: session.data, error: null }
  }

  return createAuthAdapter(
    createBetterAuthDriver({
      getSession: (options) => client.getSession(options ? { query: options } : undefined),
      listSessions: () => client.listSessions(),
      revokeSession: ({ token }) => client.revokeSession({ token }),
      signInEmail: (credentials) => credentialSession(() => client.signIn.email(credentials)),
      signUpEmail: (registration) => credentialSession(() => client.signUp.email(registration)),
      signOut: () => client.signOut(),
    }),
    { provider: 'better-auth' }
  )
}

/** Provider-neutral alias for {@link createNeonClientAdapter}. */
export const createAuthClientAdapter = createNeonClientAdapter
