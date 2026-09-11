/**
 * Provider error codes Adea maps to user-facing sign-in messages. The auth
 * provider normalises its upstream errors into these stable codes, so the UI
 * can tell a wrong password from a rate limit or an unconfirmed address.
 */
export const AUTH_ERROR_CODES = {
  emailAddressInvalid: 'email_address_invalid',
  emailExists: 'email_exists',
  emailNotConfirmed: 'email_not_confirmed',
  invalidCredentials: 'invalid_credentials',
  overRequestRateLimit: 'over_request_rate_limit',
  sessionExpired: 'session_expired',
  sessionNotFound: 'session_not_found',
  userAlreadyExists: 'user_already_exists',
  validationFailed: 'validation_failed',
  weakPassword: 'weak_password',
} as const

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES]

/**
 * Convert a provider code ("INVALID_EMAIL_OR_PASSWORD",
 * "invalid_credentials") into the normalised snake_case form.
 * @param value candidate code
 */
function normalizeCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.toLowerCase().replaceAll('-', '_')
}

/**
 * Reads a stable error code from whatever the provider rejected with. The SDK
 * returns normalized `AuthApiError` values, but a transport failure can arrive
 * as a plain Error or a bare object, so every shape is handled defensively.
 * @param error the value returned in a provider result's `error` field
 */
export function authErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const candidate = error as { code?: unknown; body?: unknown; cause?: unknown }
  const direct = normalizeCode(candidate.code)
  if (direct) return direct
  const body = candidate.body as { code?: unknown } | undefined
  const fromBody = normalizeCode(body?.code)
  if (fromBody) return fromBody
  return authErrorCode(candidate.cause)
}

/**
 * An authentication failure that preserves the provider's error code.
 *
 * The provider's own message is deliberately dropped: upstream payloads may
 * echo the submitted email address or session material, and the UI maps codes
 * to fixed copy instead.
 */
export class AuthProviderError extends Error {
  readonly code: string | null

  constructor(code: string | null, message = 'Authentication provider request failed') {
    super(message)
    this.name = 'AuthProviderError'
    this.code = code
  }

  /** True when the provider rejected the submitted credentials or account. */
  get isCredentialRejection(): boolean {
    return (
      this.code === AUTH_ERROR_CODES.invalidCredentials ||
      this.code === AUTH_ERROR_CODES.emailNotConfirmed ||
      this.code === AUTH_ERROR_CODES.userAlreadyExists ||
      this.code === AUTH_ERROR_CODES.emailExists
    )
  }
}

/**
 * Surfaces a provider failure as an {@link AuthProviderError} so callers can
 * distinguish causes without parsing provider prose.
 * @param error the value returned in a provider result's `error` field
 */
export function providerError(error: unknown): AuthProviderError {
  return new AuthProviderError(authErrorCode(error))
}
