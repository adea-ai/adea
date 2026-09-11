import 'server-only'

import { createStartRequestContext as createContext } from '@adea-ai/auth/start'
import type { RequestContext } from '@adea-ai/auth/start'
import { getRequest, setCookie } from '@tanstack/react-start/server'

/**
 * Binds the framework-neutral Neon Auth Start adapter to this app's request
 * helpers. Resolved per call so every request reads its own context rather
 * than capturing one at module scope.
 */
export function createStartRequestContext(): RequestContext {
  return createContext({ getRequest, setCookie })
}
