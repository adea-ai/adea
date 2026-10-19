import {
  normalizeProviderSession,
  type AuthProviderName,
  type AuthResult,
  type ProviderSessionInput,
} from './session'

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

export type AuthAdapterOptions = Readonly<{ provider?: AuthProviderName }>

export function createAuthAdapter(
  driver: AuthDriver,
  options: AuthAdapterOptions = {}
): AuthAdapter {
  const provider = options.provider
  return {
    async getSession() {
      try {
        return normalizeProviderSession(await driver.getSession(), { provider })
      } catch {
        return null
      }
    },
    async refreshSession() {
      try {
        return normalizeProviderSession(await driver.refreshSession(), { provider })
      } catch {
        return null
      }
    },
    async revokeSession(sessionId) {
      if (!sessionId) throw new Error('Session ID is required for revocation')
      await driver.revokeSession(sessionId)
    },
    async signIn(credentials) {
      const session = normalizeProviderSession(await driver.signIn(credentials), { provider })
      if (!session) throw new Error('Authentication failed')
      return session
    },
    async signUp(registration) {
      const session = normalizeProviderSession(await driver.signUp(registration), { provider })
      if (!session) throw new Error('Authentication failed')
      return session
    },
    async signOut() {
      await driver.signOut()
    },
  }
}
