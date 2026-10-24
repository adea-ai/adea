import 'server-only'

import {
  createServerAuthDelivery,
  createUnconfiguredDelivery,
  type AuthDelivery,
  type AuthMessageTransport,
} from '@adea-ai/auth/server'

import { authMessageTransport } from './auth-message-transport'

/** The transport this build uses; production uses its Cloudflare email binding. */
export function configuredAuthMessageTransport(): AuthMessageTransport | undefined {
  return authMessageTransport
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
