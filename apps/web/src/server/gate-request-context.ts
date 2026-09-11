import { AsyncLocalStorage } from 'node:async_hooks'

import { serializeSessionCookie } from '@adea-ai/auth/start'
import type { RequestContext } from '@adea-ai/auth/start'

/**
 * Request-scoped context for the entry gate.
 *
 * The Worker entry decides the account-allowlist outcome before TanStack Start
 * handles the request, so Start's own request storage (`getRequest`) does not
 * exist yet. The gate therefore reads cookies, headers, and the origin from the
 * Request it was given, and collects any session cookie the auth toolkit wants
 * to set so the entry can append them to its own response.
 */
type GateScope = { request: Request; cookies: string[] }

const storage = new AsyncLocalStorage<GateScope>()

export function gateScope(): GateScope | undefined {
  return storage.getStore()
}

/**
 * Runs `work` with `request` available to the gate's auth context, returning
 * both its result and the cookies the toolkit asked to persist.
 */
export async function runWithGateRequest<T>(
  request: Request,
  work: () => Promise<T>
): Promise<Readonly<{ cookies: string[]; result: T }>> {
  const scope: GateScope = { request, cookies: [] }
  const result = await storage.run(scope, work)
  return { cookies: scope.cookies, result }
}

export function createGateRequestContext(): RequestContext {
  const scope = storage.getStore()
  if (!scope) throw new Error('No entry-gate request is in scope')
  const { request } = scope
  return {
    getCookies: () => request.headers.get('cookie') ?? '',
    setCookie: (name, value, options) => {
      scope.cookies.push(serializeSessionCookie(name, value, options))
    },
    getHeader: (name) => request.headers.get(name),
    getOrigin: () =>
      request.headers.get('origin') ||
      request.headers.get('referer')?.split('/').slice(0, 3).join('/') ||
      '',
    getFramework: () => 'tanstack-start',
  }
}
