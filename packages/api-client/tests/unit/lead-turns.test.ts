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

test('child observation reads encode one opaque page cursor without mutation payloads', async () => {
  const requests: Request[] = []
  const payload = {
    childObservations: { availability: 'unavailable', reasonCode: 'RUNTIME_UNAVAILABLE' },
  }
  const client = new AgentHqApiClient({
    baseUrl: '/api',
    fetchImpl: async (input, init) => {
      requests.push(new Request(`https://test${input}`, init))
      return Response.json(payload)
    },
  })
  expect(await client.getLeadTurnChildren('work/space', 'turn/id')).toEqual(payload)
  expect(new URL(requests[0]!.url).pathname).toBe(
    '/api/v1/workspaces/work%2Fspace/lead-turns/turn%2Fid/children'
  )
  expect(new URL(requests[0]!.url).search).toBe('')
  await client.getLeadTurnChildren('workspace', 'intent', {
    limit: 1,
    after: { acceptedAt: '2026-10-17T00:00:00Z', delegationId: `dlg_${'0'.repeat(26)}` },
  })
  expect(Object.fromEntries(new URL(requests[1]!.url).searchParams)).toEqual({
    limit: '1',
    afterAcceptedAt: '2026-10-17T00:00:00Z',
    afterDelegationId: `dlg_${'0'.repeat(26)}`,
  })
  expect(requests.every((request) => request.method === 'GET' && request.body === null)).toBe(true)
})
