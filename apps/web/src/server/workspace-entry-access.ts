import 'server-only'

import { createNeonServerAdapter } from '@adea-ai/auth/server'
import { evaluateEntryAccess } from '../lib/entry-access-policy.mjs'
import { createStartRequestContext } from './auth-request-context'
import { createGateRequestContext, gateScope } from './gate-request-context'
import { emailAllowlistConfigured, isAllowedEmail } from './allowed-emails'

/**
 * Reads the account-allowlist decision for the current request.
 *
 * Called both from the Worker entry (before Start's request storage exists) and
 * from route handlers (inside it), so the Neon Auth request context is chosen
 * from whichever scope is active. Reading the session through the wrong context
 * would see no cookie and fail every signed-in visitor closed.
 */
export function readWorkspaceEntryAccess() {
  return evaluateEntryAccess({
    configured: emailAllowlistConfigured(),
    resolveEmail: async () =>
      (
        await createNeonServerAdapter(
          gateScope() ? createGateRequestContext : createStartRequestContext
        ).getSession()
      )?.profile.email,
    isAllowed: isAllowedEmail,
  })
}
