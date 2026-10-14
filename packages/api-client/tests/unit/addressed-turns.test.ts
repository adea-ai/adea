import { expect, test } from 'bun:test'
import { AgentHqApiClient } from '../../src'

function clientRecording() {
  const seen: Request[] = []
  const client = new AgentHqApiClient({
    baseUrl: '/api',
    fetchImpl: async (input, init) => {
      seen.push(new Request(`https://test${input}`, init))
      return Response.json({ nextAfter: null, turns: [] })
    },
  })
  return { client, seen }
}

test('addressing posts only the four request fields to the channel turns route', async () => {
  const { client, seen } = clientRecording()
  await client.addressTurn('ws', 'ch', {
    agentId: 'agent',
    dispatchRevision: 2,
    triggerMessageId: 'message',
  })
  expect(seen[0]!.method).toBe('POST')
  expect(new URL(seen[0]!.url).pathname).toBe('/api/v1/workspaces/ws/channels/ch/turns')
  expect(await seen[0]!.json()).toEqual({
    agentId: 'agent',
    dispatchRevision: 2,
    triggerMessageId: 'message',
  })
})

test('replay reads carry the cursor and a bounded limit; cancel names the turn in the path', async () => {
  const { client, seen } = clientRecording()
  await client.listAddressedTurns('ws', 'ch', { after: 'turn-1', limit: 500 })
  expect(new URL(seen[0]!.url).search).toBe('?after=turn-1&limit=200')
  await client.listAddressedTurns('ws', 'ch')
  expect(new URL(seen[1]!.url).search).toBe('')
  await client.cancelAddressedTurn('ws', 'ch', 'turn 1')
  expect(seen[2]!.method).toBe('POST')
  expect(new URL(seen[2]!.url).pathname).toBe(
    '/api/v1/workspaces/ws/channels/ch/turns/turn%201/cancel'
  )
})

const respond = (body: unknown) =>
  new AgentHqApiClient({
    baseUrl: '/api',
    fetchImpl: async () => Response.json(body, { status: 409 }),
  }).addressTurn('ws', 'ch', { agentId: 'agent', dispatchRevision: 1, triggerMessageId: 'm' })

test('a turn conflict carries its reason; a body without one does not invent it', async () => {
  const refused = await respond({ code: 'turn_conflict', reason: 'turn_superseded' }).catch(
    (error: unknown) => error
  )
  expect(refused).toMatchObject({ code: 'turn_conflict', reason: 'turn_superseded', status: 409 })
  const bare = await respond({ code: 'turn_conflict', reason: 7 }).catch((error: unknown) => error)
  expect((bare as { reason?: string }).reason).toBeUndefined()
})
