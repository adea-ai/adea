'use client'

import { createAuthClient } from '@neondatabase/auth'
import { BetterAuthVanillaAdapter } from '@neondatabase/auth/vanilla'

import { createAuthAdapter } from './adapter'
import { createNeonAuthDriver, type NeonSdk } from './neon-driver'

// The browser needs the failure-code mapper to explain a rejected sign-in,
// and the input normalizer so rejected input never gets submitted.
export { AUTH_ERROR_CODES, AuthProviderError, authErrorCode, type AuthErrorCode } from './errors'
export { normalizeEmail } from './normalize'

export function createNeonClientAdapter() {
  // The framework-neutral entry types its url parameter as string, but the
  // shipped adapters pass undefined for the same same-origin relative
  // resolution; keep that behavior rather than pinning a baseURL. The vanilla
  // adapter is the framework-neutral one: this client only calls the SDK's
  // promise API from the Solid UI.
  return createAuthAdapter(
    createNeonAuthDriver(
      createAuthClient(undefined as unknown as string, {
        adapter: BetterAuthVanillaAdapter(),
      }) as unknown as NeonSdk
    )
  )
}
