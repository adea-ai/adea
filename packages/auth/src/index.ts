export {
  createAuthAdapter,
  type AuthAdapter,
  type AuthAdapterOptions,
  type AuthCredentials,
  type AuthDriver,
} from './adapter'
export { createBetterAuthDriver, type BetterAuthServerApi } from './better-auth-driver'
export {
  AuthDeliveryUnavailableError,
  createRecordingAuthDelivery,
  createUnconfiguredDelivery,
  type AuthDelivery,
  type AuthDeliveryMessage,
  type RecordedAuthDelivery,
} from './delivery'
export {
  AUTH_ERROR_CODES,
  AuthProviderError,
  authErrorCode,
  providerError,
  type AuthErrorCode,
} from './errors'
export { createAuthEvent, type AuthEventName } from './observability'
export { resolveAuthenticatedPrincipal, type AuthIdentityMapping } from './principal'
export {
  normalizeNeonSession,
  normalizeProviderSession,
  type AuthProviderName,
  type AuthResult,
  type NormalizeSessionOptions,
  type ProviderSessionInput,
} from './session'
