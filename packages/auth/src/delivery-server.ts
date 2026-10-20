import 'server-only'

import type { AuthDelivery, AuthDeliveryMessage } from './delivery'

/**
 * Server-only injection of verification and password-reset delivery.
 *
 * The provider-neutral {@link AuthDelivery} boundary stays in `delivery.ts`. This
 * module supplies the one place a real transport is wired in: an operator or
 * deployment hands in a transport, and every message is checked before it
 * reaches it. Nothing here sends email, reads credentials, or chooses a
 * provider. A message that fails a check is never handed to the transport.
 *
 * Errors name the message kind and the failed check only. They never carry the
 * token, the callback URL, or the email address, so they are safe to log.
 */

export type AuthMessageKind = 'password-reset' | 'verification'

export type AuthMessageTransport = Readonly<{
  send(kind: AuthMessageKind, message: AuthDeliveryMessage): Promise<void>
}>

export type ServerAuthDeliveryOptions = Readonly<{
  /** The public app origin that serves `/api/auth/*`. Callback URLs must share its origin. */
  baseUrl: string
  transport: AuthMessageTransport
}>

/** Raised before any transport call when a message fails a fixed check. */
export class AuthDeliveryRejectedError extends Error {
  readonly kind: AuthMessageKind
  readonly reason: string

  constructor(kind: AuthMessageKind, reason: string) {
    super(`Authentication ${kind} message was rejected: ${reason}`)
    this.name = 'AuthDeliveryRejectedError'
    this.kind = kind
    this.reason = reason
  }
}

/**
 * Raised when the transport itself fails. The transport's own error is not
 * attached as a cause or message, because it may echo the message it was given.
 */
export class AuthDeliveryFailedError extends Error {
  readonly kind: AuthMessageKind

  constructor(kind: AuthMessageKind) {
    super(`Authentication ${kind} message could not be handed to the transport`)
    this.name = 'AuthDeliveryFailedError'
    this.kind = kind
  }
}

const MAX_EMAIL_LENGTH = 320
const MAX_TOKEN_LENGTH = 512
const AUTH_PATH_PREFIX = '/api/auth/'

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.localhost')
  )
}

function parseBaseOrigin(baseUrl: string): string {
  const url = new URL(baseUrl)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new Error('Server auth delivery base URL must be HTTPS outside loopback development')
  }
  return url.origin
}

function checkMessage(kind: AuthMessageKind, message: AuthDeliveryMessage, baseOrigin: string) {
  const reject = (reason: string): never => {
    throw new AuthDeliveryRejectedError(kind, reason)
  }

  if (
    message.email.length === 0 ||
    message.email.length > MAX_EMAIL_LENGTH ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(message.email)
  ) {
    reject('recipient is not a well-formed email address')
  }

  if (
    message.token.length === 0 ||
    message.token.length > MAX_TOKEN_LENGTH ||
    /\s/.test(message.token)
  ) {
    reject('token is empty, too long, or contains whitespace')
  }

  if (message.expiresAt !== undefined) {
    if (!(message.expiresAt instanceof Date) || Number.isNaN(message.expiresAt.getTime())) {
      reject('expiry is not a valid date')
    } else if (message.expiresAt.getTime() <= Date.now()) {
      reject('message has already expired')
    }
  }

  let callback: URL
  try {
    callback = new URL(message.url)
  } catch {
    return reject('callback URL is not absolute')
  }
  if (callback.username || callback.password) {
    reject('callback URL carries credentials')
  }
  if (callback.origin !== baseOrigin) {
    reject('callback URL is not on the configured app origin')
  }
  if (!callback.pathname.startsWith(AUTH_PATH_PREFIX)) {
    reject('callback URL is not an auth endpoint')
  }
}

/**
 * Builds the {@link AuthDelivery} the Better Auth service uses for verification
 * and password reset. Each message is checked against the configured origin,
 * then passed to the injected transport exactly once. A failed check throws
 * before the transport is called.
 */
export function createServerAuthDelivery({
  baseUrl,
  transport,
}: ServerAuthDeliveryOptions): AuthDelivery {
  const baseOrigin = parseBaseOrigin(baseUrl)

  const deliver =
    (kind: AuthMessageKind) =>
    async (message: AuthDeliveryMessage): Promise<void> => {
      checkMessage(kind, message, baseOrigin)
      try {
        await transport.send(kind, message)
      } catch {
        throw new AuthDeliveryFailedError(kind)
      }
    }

  return Object.freeze<AuthDelivery>({
    sendPasswordReset: deliver('password-reset'),
    sendVerificationEmail: deliver('verification'),
  })
}
