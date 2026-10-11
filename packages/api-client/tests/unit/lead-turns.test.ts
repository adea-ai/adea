import { expect, test } from 'bun:test'
import { AgentHqApiClient } from '../../src'

test('explicit lead-turn message retains its blocked receipt and retry key', async () => {
  let request: Request | undefined
  const leadTurn = {
    schemaVersion: 'pi-lead-intent/v1',
    intentId: 'intent-id',
    messageId: 'message-id',
    dispatchKey: 'lead-turn:intent-id',
    state: 'blocked',
    reasonCode: 'ADMISSION_SERVICE_UNAVAILABLE',
  }
  const client = new AgentHqApiClient({
    baseUrl: '/api',
    fetchImpl: async (input, init) => {
      request = new Request(`https://test${input}`, init)
      return Response.json({ message: { id: 'message-id' }, leadTurn })
    },
  })
  const response = await client.createMessage('workspace', 'topic', {
    bodyText: 'Canonical body',
    idempotencyKey: 'stable-request',
    leadTurn: true,
    requestedModelSelections: {
      lead: { selectionRef: `msel_${'a'.repeat(32)}`, selectionRevision: 1 },
      child: { selectionRef: `msel_${'b'.repeat(32)}`, selectionRevision: 2 },
    },
  })
  expect(request!.headers.get('idempotency-key')).toBe('stable-request')
  expect(await request!.json()).toEqual({
    bodyText: 'Canonical body',
    leadTurn: true,
    requestedModelSelections: {
      lead: { selectionRef: `msel_${'a'.repeat(32)}`, selectionRevision: 1 },
      child: { selectionRef: `msel_${'b'.repeat(32)}`, selectionRevision: 2 },
    },
  })
  expect(response.leadTurn).toEqual(leadTurn)
  expect(response.leadTurn).not.toHaveProperty('executionRef')
})
