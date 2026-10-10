import { expect, test } from 'bun:test'
import { conversationErrorResponse } from '../src/server/conversation-request'
import type { WorkspacePrincipalResolution } from '../src/server/workspace-principal'

test('changed requested-model replay is an explicit conflict with no runtime or credential details', async () => {
  const response = conversationErrorResponse(
    new Error('Lead turn model selection conflict'),
    { principal: { kind: 'user', userId: 'fixture-user' } } as WorkspacePrincipalResolution,
    new Request('https://fixture.invalid/api')
  )
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    code: 'conversation_conflict',
    message: 'Lead turn model selection conflict',
  })
})
