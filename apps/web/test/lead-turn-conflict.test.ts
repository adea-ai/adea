import { expect, mock, test } from 'bun:test'
// The server boundary marker (`server-only`) throws outside react-server
// conditions; the unit runner uses browser conditions, so this suite stubs
// the marker itself before dynamically importing the server module.
// Production bundling still enforces the boundary, and no production
// module changes for test convenience.
import type { WorkspacePrincipalResolution } from '../src/server/workspace-principal'

mock.module('server-only', () => ({}))
const { conversationErrorResponse } = await import('../src/server/conversation-request')

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

test('group creation grant failures map by error name without importing the db error', async () => {
  const failure = new Error('Group creation rejected: every participant requires a valid grant')
  failure.name = 'GroupCreationError'
  const rejection = { reason: 'grant_absent', scope: 'candidate' }
  ;(failure as Error & { rejections: unknown }).rejections = [rejection]
  const response = conversationErrorResponse(
    failure,
    { principal: { kind: 'user', userId: 'fixture-user' } } as WorkspacePrincipalResolution,
    new Request('https://fixture.invalid/api')
  )
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    code: 'group_grant_rejected',
    message: 'Group creation rejected: every participant requires a valid grant',
    rejections: [rejection],
  })
})
