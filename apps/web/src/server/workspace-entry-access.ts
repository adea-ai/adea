import 'server-only'

import { createNeonServerAdapter } from '@adea-ai/auth/server'
import { evaluateEntryAccess } from '../lib/entry-access-policy.mjs'
import { createStartRequestContext } from './auth-request-context'
import { emailAllowlistConfigured, isAllowedEmail } from './allowed-emails'

export function readWorkspaceEntryAccess() {
  return evaluateEntryAccess({
    configured: emailAllowlistConfigured(),
    resolveEmail: async () =>
      (await createNeonServerAdapter(createStartRequestContext).getSession())?.profile.email,
    isAllowed: isAllowedEmail,
  })
}
