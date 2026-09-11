import type { AuthCredentials, AuthDriver, AuthRegistration } from './adapter'
import { providerError } from './errors'
import type { ProviderSessionInput } from './session'

type AuthResponse<T> = Promise<{ data: T | null; error: unknown }>

export type NeonSdk = {
  getSession(options?: unknown): AuthResponse<ProviderSessionInput>
  listSessions(): AuthResponse<Array<{ id: string; token: string }>>
  refreshToken(options?: unknown): AuthResponse<unknown>
  revokeSession(input: { token: string }): AuthResponse<unknown>
  signIn: {
    email(credentials: AuthCredentials): AuthResponse<unknown>
  }
  signUp: {
    email(registration: AuthRegistration): AuthResponse<unknown>
  }
  signOut(): AuthResponse<unknown>
}

// Preserve the provider's normalized error code so callers can show a precise
// reason (wrong password, unconfirmed email, rate limit) instead of one
// opaque failure message for every cause.
function requireData<T>(result: { data: T | null; error: unknown }): T {
  if (result.error || result.data === null) {
    throw providerError(result.error)
  }
  return result.data
}

export function createNeonAuthDriver(sdk: NeonSdk): AuthDriver {
  const getFreshSession = async () =>
    requireData(
      await sdk.getSession({
        query: { disableCookieCache: true },
      })
    )

  return {
    async getSession() {
      const result = await sdk.getSession()
      if (result.error) throw providerError(result.error)
      return result.data
    },
    async refreshSession() {
      // Neon Auth refreshes rotating tokens at the proxy. Bypassing its signed data cache
      // guarantees this lookup reflects expiry or remote revocation immediately.
      return getFreshSession()
    },
    async revokeSession(sessionId) {
      const sessions = requireData(await sdk.listSessions())
      const session = sessions.find((candidate) => candidate.id === sessionId)
      if (!session) throw new Error('Authentication session is unavailable')
      requireData(await sdk.revokeSession({ token: session.token }))
    },
    async signIn(credentials) {
      requireData(await sdk.signIn.email(credentials))
      return getFreshSession()
    },
    async signUp(registration) {
      requireData(await sdk.signUp.email(registration))
      return getFreshSession()
    },
    async signOut() {
      requireData(await sdk.signOut())
    },
  }
}
