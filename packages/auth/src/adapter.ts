import { normalizeNeonSession, type AuthResult, type ProviderSessionInput } from './session'

export type AuthCredentials = Readonly<{
  email: string
  password: string
}>

export type AuthRegistration = AuthCredentials &
  Readonly<{
    name: string
  }>

export interface AuthDriver {
  getSession(): Promise<ProviderSessionInput | null>
  refreshSession(): Promise<ProviderSessionInput | null>
  revokeSession(sessionId: string): Promise<void>
  signIn(credentials: AuthCredentials): Promise<ProviderSessionInput>
  signUp(registration: AuthRegistration): Promise<ProviderSessionInput>
  signOut(): Promise<void>
}

export interface AuthAdapter {
  getSession(): Promise<AuthResult | null>
  refreshSession(): Promise<AuthResult | null>
  revokeSession(sessionId: string): Promise<void>
  signIn(credentials: AuthCredentials): Promise<AuthResult>
  signUp(registration: AuthRegistration): Promise<AuthResult>
  signOut(): Promise<void>
}

export function createAuthAdapter(driver: AuthDriver): AuthAdapter {
  return {
    async getSession() {
      try {
        return normalizeNeonSession(await driver.getSession())
      } catch {
        return null
      }
    },
    async refreshSession() {
      try {
        return normalizeNeonSession(await driver.refreshSession())
      } catch {
        return null
      }
    },
    async revokeSession(sessionId) {
      if (!sessionId) throw new Error('Session ID is required for revocation')
      await driver.revokeSession(sessionId)
    },
    async signIn(credentials) {
      const session = normalizeNeonSession(await driver.signIn(credentials))
      if (!session) throw new Error('Authentication failed')
      return session
    },
    async signUp(registration) {
      const session = normalizeNeonSession(await driver.signUp(registration))
      if (!session) throw new Error('Authentication failed')
      return session
    },
    async signOut() {
      await driver.signOut()
    },
  }
}
