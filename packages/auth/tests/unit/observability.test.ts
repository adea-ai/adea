import { describe, expect, test } from 'bun:test'

import { createAuthEvent } from '../../src/observability'

describe('auth observability', () => {
  test('emits allowlisted metadata without tokens, cookies, provider payloads, or PII', () => {
    const event = createAuthEvent('session.lookup', {
      outcome: 'rejected',
      reason: 'expired',
      requestId: 'request-1',
      token: 'secret-token',
      cookie: 'secret-cookie',
      email: 'operator@example.com',
      providerPayload: { raw: 'secret' },
    })

    expect(event).toEqual({
      event: 'auth.session.lookup',
      outcome: 'rejected',
      reason: 'expired',
      requestId: 'request-1',
    })
    expect(JSON.stringify(event)).not.toContain('secret')
    expect(JSON.stringify(event)).not.toContain('operator@example.com')
  })
})
