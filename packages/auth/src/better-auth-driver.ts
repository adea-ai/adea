import type { AuthCredentials, AuthDriver, AuthRegistration } from './adapter'
import { providerError } from './errors'
import type { ProviderSessionInput } from './session'

type AuthResponse<T> = Promise<{ data: T | null; error: unknown }>

/**
 * The subset of the self-hosted Better Auth server API this driver needs.
 *
 * It mirrors the shape the previous provider driver was written against (a
 * `{ data, error }` result per call) so the adapter, error mapping, and the
 * "map an internal session ID to a provider token only inside the driver"
 * boundary are unchanged. The server composition in `better-auth-server.ts`
 * adapts the real `auth.api.*` surface to this interface; tests supply a fake.
 */
export type BetterAuthServerApi = {
  getSession(options?: {
    disableCookieCache?: boolean
    disableRefresh?: boolean
  }): AuthResponse<ProviderSessionInput>
  listSessions(): AuthResponse<Array<{ id: string; token: string }>>
  revokeSession(input: { token: string }): AuthResponse<unknown>
  signInEmail(credentials: AuthCredentials): AuthResponse<ProviderSessionInput>
  signUpEmail(registration: AuthRegistration): AuthResponse<ProviderSessionInput>
  signOut(): AuthResponse<unknown>
}

// Preserve the provider's normalized error code so callers can show a precise
// reason (wrong password, unconfirmed email, rate limit) instead of one opaque
// failure message for every cause. Better Auth throws its own `APIError`; the
// server composition catches it and hands the cause here for sanitizing.
function requireData<T>(result: { data: T | null; error: unknown }): T {
  if (result.error || result.data === null) {
    throw providerError(result.error)
  }
  return result.data
}

export function createBetterAuthDriver(api: BetterAuthServerApi): AuthDriver {
  // Bypassing Better Auth's signed session-data cookie cache makes this lookup
  // read the durable session row, so expiry and remote revocation fail closed
  // instead of being served from a stale cookie.
  const getFreshSession = async () =>
    requireData(
      await api.getSession({
        disableCookieCache: true,
      })
    )

  return {
    async getSession() {
      const result = await api.getSession()
      if (result.error) throw providerError(result.error)
      return result.data
    },
    async refreshSession() {
      return getFreshSession()
    },
    async revokeSession(sessionId) {
      const sessions = requireData(await api.listSessions())
      const session = sessions.find((candidate) => candidate.id === sessionId)
      if (!session) throw new Error('Authentication session is unavailable')
      requireData(await api.revokeSession({ token: session.token }))
    },
    async signIn(credentials) {
      // The credential call already returned the session it issued (read back
      // through the cookies it set). Re-reading through the incoming request
      // headers would resolve the pre-login account, or none at all.
      return requireData(await api.signInEmail(credentials))
    },
    async signUp(registration) {
      return requireData(await api.signUpEmail(registration))
    },
    async signOut() {
      requireData(await api.signOut())
    },
  }
}
