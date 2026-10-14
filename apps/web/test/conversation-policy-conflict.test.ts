import { expect, test } from 'bun:test'
import { conversationErrorResponse } from '../src/server/conversation-response'
import type { WorkspacePrincipalResolution } from '../src/server/workspace-principal'

test('a refused group visibility change is an explicit 409 conversation conflict', async () => {
  const response = conversationErrorResponse(
    new Error('Channel participant policy conflict'),
    { principal: { kind: 'user', userId: 'fixture-user' } } as WorkspacePrincipalResolution,
    new Request('https://fixture.invalid/api')
  )
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    code: 'conversation_conflict',
    message: 'Channel participant policy conflict',
  })
})
