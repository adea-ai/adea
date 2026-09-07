export {
  createAuthAdapter,
  type AuthAdapter,
  type AuthCredentials,
  type AuthDriver,
} from './adapter'
export { createAuthEvent, type AuthEventName } from './observability'
export { resolveAuthenticatedPrincipal, type AuthIdentityMapping } from './principal'
export { normalizeNeonSession, type AuthResult, type ProviderSessionInput } from './session'
