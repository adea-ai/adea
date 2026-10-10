import { expect, test } from 'bun:test'
import { AgentHqApiClient } from '../../src'

const target = {
  runtimeSessionId: 'target-session-a',
  taskId: '00000000-0000-4000-8000-0000000000f1',
  expectedGeneration: 3,
}

test('handoff admission sends the structured target beside the prose body', async () => {
  let request: Request | undefined
  const client = new AgentHqApiClient({
    baseUrl: '/api',
    fetchImpl: async (input, init) => {
      request = new Request(`https://test${input}`, init)
      return Response.json({ message: { id: 'message-id' }, leadTurn: { intentId: 'intent' } })
    },
  })
  await client.createMessage('workspace', 'topic', {
    bodyText: 'Requesting lead coordination for direct session target-session-a.',
    handoffTarget: target,
    idempotencyKey: 'request-key',
    leadTurn: true,
  })
  expect(await request!.json()).toEqual({
    bodyText: 'Requesting lead coordination for direct session target-session-a.',
    handoffTarget: target,
    leadTurn: true,
  })
})

test('admission receipts and status snapshots surface the retained target', async () => {
  const retained = {
    runtimeSessionId: 'target-session-a',
    taskId: '00000000-0000-4000-8000-0000000000f1',
    observedGeneration: 3,
  }
  const client = new AgentHqApiClient({
    baseUrl: '/api',
    fetchImpl: async (_input) =>
      Response.json({
        leadTurn: {
          schemaVersion: 'adea-lead-turn/v1',
          intentId: 'intent',
          messageId: 'message-id',
          state: 'blocked',
          availability: 'unavailable',
          handoffTarget: retained,
        },
      }),
  })
  const status = await client.getLeadTurnStatus('workspace', 'intent')
  expect(status.leadTurn.handoffTarget).toEqual(retained)
})

test('target-scoped reads encode the exact session', async () => {
  const seen: string[] = []
  const client = new AgentHqApiClient({
    baseUrl: '/api',
    fetchImpl: async (input) => {
      seen.push(String(input))
      return Response.json({ leadTurn: null })
    },
  })
  await client.getChannelLeadTurn('workspace', 'topic')
  await client.getChannelLeadTurn('workspace', 'topic', 'target-session-a')
  expect(seen).toEqual([
    '/api/v1/workspaces/workspace/channels/topic/lead-turn',
    '/api/v1/workspaces/workspace/channels/topic/lead-turn?targetSessionId=target-session-a',
  ])
})
