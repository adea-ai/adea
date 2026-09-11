'use client'

import { createAuthClient } from '@neondatabase/auth'
import { BetterAuthReactAdapter } from '@neondatabase/auth/react'

import { createAuthAdapter } from './adapter'
import { createNeonAuthDriver, type NeonSdk } from './neon-driver'

// The browser needs the failure-code mapper to explain a rejected sign-in.
export { AUTH_ERROR_CODES, AuthProviderError, authErrorCode, type AuthErrorCode } from './errors'

export function createNeonClientAdapter() {
  // The framework-neutral entry types its url parameter as string, but the
  // shipped Next adapter passes undefined for the same same-origin relative
  // resolution; keep that behavior rather than pinning a baseURL.
  return createAuthAdapter(
    createNeonAuthDriver(
      createAuthClient(undefined as unknown as string, {
        adapter: BetterAuthReactAdapter(),
      }) as unknown as NeonSdk
    )
  )
}
