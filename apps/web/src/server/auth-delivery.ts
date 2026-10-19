import 'server-only'

import {
  createServerAuthDelivery,
  createUnconfiguredDelivery,
  type AuthDelivery,
  type AuthMessageTransport,
} from '@adea-ai/auth/server'

/**
 * The verification and password-reset transport for the auth route. This
 * repository configures none: no mail provider, credential, or production
 * transport is wired here, so every message is refused and the flow fails
 * closed. A deployment that adds a transport supplies it in this one place.
 */
export function configuredAuthMessageTransport(): AuthMessageTransport | undefined {
  return undefined
}

/**
 * The delivery the auth route injects into each request's service. Without a
 * transport it is the fail-closed default; with one, every message is checked
 * against the configured app origin before the transport sees it.
 */
export function authDeliveryForRequest(
  environment: Readonly<Record<string, string | undefined>> = process.env
): AuthDelivery {
  const transport = configuredAuthMessageTransport()
  if (!transport) return createUnconfiguredDelivery()
  const baseUrl = environment.AUTH_BASE_URL
  if (!baseUrl) throw new Error('AUTH_BASE_URL is required to deliver auth messages')
  return createServerAuthDelivery({ baseUrl, transport })
}
