import 'server-only'

import { createNeonServerAdapter } from '@adea-ai/auth/server'
import { evaluateEntryAccess } from '../lib/entry-access-policy.mjs'
import { emailAllowlistConfigured, isAllowedEmail } from './allowed-emails'

export function readWorkspaceEntryAccess() {
  return evaluateEntryAccess({
    configured: emailAllowlistConfigured(),
    resolveEmail: async () => (await createNeonServerAdapter().getSession())?.profile.email,
    isAllowed: isAllowedEmail,
  })
}
