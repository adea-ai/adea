/**
 * Provider-independent delivery of verification and password-reset messages.
 *
 * Better Auth owns token creation, storage, and single-use semantics; Adea owns
 * how the resulting link reaches the person. This boundary keeps the auth
 * service free of any specific mail transport (hosted provider, SMTP, or an
 * operator-run queue) and makes the delivery step injectable so tests can assert
 * it without ever sending real email or using live credentials.
 */

export type AuthDeliveryMessage = Readonly<{
  email: string
  /** When the single-use token stops being accepted, if the provider reports it. */
  expiresAt?: Date
  /** The single-use token, for providers that deliver a code instead of a link. */
  token: string
  /** The exact callback URL the person must open to finish the flow. */
  url: string
}>

export interface AuthDelivery {
  sendPasswordReset(message: AuthDeliveryMessage): Promise<void>
  sendVerificationEmail(message: AuthDeliveryMessage): Promise<void>
}

/**
 * Raised when verification or reset delivery is requested but no transport is
 * configured. It fails closed on purpose: silently dropping a verification or
 * reset message would strand a new signup with no way to continue.
 */
export class AuthDeliveryUnavailableError extends Error {
  constructor(kind: 'password-reset' | 'verification') {
    super(`No authentication delivery transport is configured for ${kind}`)
    this.name = 'AuthDeliveryUnavailableError'
  }
}

export type RecordedAuthDelivery = Readonly<{
  email: string
  expiresAt?: Date
  kind: 'password-reset' | 'verification'
  token: string
  url: string
}>

/**
 * A delivery transport that records every message in memory. Synthetic and
 * local tests use it to prove a verification or reset was requested exactly
 * once, for the right address, without a network call.
 */
export function createRecordingAuthDelivery(): Readonly<{
  delivery: AuthDelivery
  sent: readonly RecordedAuthDelivery[]
}> {
  const sent: RecordedAuthDelivery[] = []
  const record = (kind: RecordedAuthDelivery['kind']) => async (message: AuthDeliveryMessage) => {
    sent.push(
      Object.freeze({
        email: message.email,
        ...(message.expiresAt ? { expiresAt: message.expiresAt } : {}),
        kind,
        token: message.token,
        url: message.url,
      })
    )
  }
  return Object.freeze({
    delivery: Object.freeze<AuthDelivery>({
      sendPasswordReset: record('password-reset'),
      sendVerificationEmail: record('verification'),
    }),
    sent,
  })
}

/**
 * The fail-closed default. Every send rejects so a missing transport surfaces
 * in the signup or reset flow instead of looking like a delivered message.
 */
export function createUnconfiguredDelivery(): AuthDelivery {
  return Object.freeze<AuthDelivery>({
    async sendPasswordReset() {
      throw new AuthDeliveryUnavailableError('password-reset')
    },
    async sendVerificationEmail() {
      throw new AuthDeliveryUnavailableError('verification')
    },
  })
}
