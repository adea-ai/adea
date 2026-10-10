import { expect, test } from 'bun:test'
// NOTE (lane #1215 provenance): this file imports the server-only
// conversation boundary, so it cannot load under bun's browser export
// condition with the top-level unit glob. It runs with the
// route-flow integration lane instead:
//   bun test --conditions=react-server apps/web/test/integration/lead-turn-conflict.test.ts
import { conversationErrorResponse } from '../../src/server/conversation-request'
import type { WorkspacePrincipalResolution } from '../../src/server/workspace-principal'

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
