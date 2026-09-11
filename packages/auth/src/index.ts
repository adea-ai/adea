export {
  createAuthAdapter,
  type AuthAdapter,
  type AuthCredentials,
  type AuthDriver,
} from './adapter'
export {
  AUTH_ERROR_CODES,
  AuthProviderError,
  authErrorCode,
  providerError,
  type AuthErrorCode,
} from './errors'
export { createAuthEvent, type AuthEventName } from './observability'
export { resolveAuthenticatedPrincipal, type AuthIdentityMapping } from './principal'
export { normalizeNeonSession, type AuthResult, type ProviderSessionInput } from './session'
