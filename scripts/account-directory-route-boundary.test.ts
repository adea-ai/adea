// The account-wide directory and inbox routes delegate to injected handlers
// instead of authorizing a workspace: there is no workspace id in their URL
// space, and a per-workspace check would be a second, weaker source of truth
// next to the query's own membership/project/participation predicates. This
// boundary pins that wiring per route file: the guard runs first, the
// principal gate answers 401, and exactly one account*Response call receives
// the application database and the matching @adea-ai/db query.

import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

const ROUTES = [
  {
    file: 'apps/web/src/start/routes/api/v1/account/agents.ts',
    path: '/api/v1/account/agents',
    handler: 'accountAgentDirectoryResponse',
    query: 'accountAgentDirectory',
  },
  {
    file: 'apps/web/src/start/routes/api/v1/account/agents/$agentId.ts',
    path: '/api/v1/account/agents/$agentId',
    handler: 'accountAgentLookupResponse',
    query: 'findAccountAgent',
  },
  {
    file: 'apps/web/src/start/routes/api/v1/account/conversations.ts',
    path: '/api/v1/account/conversations',
    handler: 'accountConversationInboxResponse',
    query: 'accountConversationInbox',
  },
  {
    file: 'apps/web/src/start/routes/api/v1/account/conversations/$conversationId.ts',
    path: '/api/v1/account/conversations/$conversationId',
    handler: 'accountConversationLookupResponse',
    query: 'findAccountConversation',
  },
] as const

describe('account directory route boundary', () => {
  for (const route of ROUTES)
    test(`${route.path} wires guard, principal and one handler call`, async () => {
      const source = await readFile(join(root, route.file), 'utf8')

      // The registered path is the account-scoped one; no workspace segment.
      expect(source).toContain(`createFileRoute('${route.path}')`)
      expect(source).toContain('guardDesktopWorkspaceRequest')
      expect(source).not.toContain('$workspaceId')
      // No per-workspace authorization: the queries carry their own.
      expect(source).not.toContain('authorizeWorkspace')

      // Guard first, then the principal gate, then one handler call.
      const guardAt = source.indexOf('guardDesktopWorkspaceRequest(request)')
      const principalAt = source.indexOf('await resolveWorkspacePrincipal(request)')
      const handlerAt = source.indexOf(`${route.handler}(`)
      expect(guardAt).toBeGreaterThanOrEqual(0)
      expect(principalAt).toBeGreaterThan(guardAt)
      expect(handlerAt).toBeGreaterThan(principalAt)
      expect(source.match(new RegExp(`${route.handler}\\(`, 'gu'))).toHaveLength(1)
      expect(source).toContain('workspaceUnavailableResponse(request, 401)')

      // The handler receives the application database and the matching query.
      expect(source).toContain('applicationDatabase()')
      expect(source).toContain(`'@adea-ai/db'`)
      expect(source).toContain(route.query)

      // Both verbs of every desktop-facing route: scoped handler + preflight.
      expect(source).toContain('withRequestScope(')
      expect(source).toContain('handleDesktopWorkspacePreflight(request)')
    })

  test('the request boundary keeps denied lookups indistinguishable', async () => {
    const source = await readFile(
      join(root, 'apps/web/src/server/account-directory-request.ts'),
      'utf8'
    )
    // Unreadable cursor or id: 400; a denied lookup: the same missing answer
    // as a nonexistent one; anything unexpected stays unmapped for the 500
    // handler instead of masquerading as "unavailable".
    expect(source).toContain("'invalid_request'")
    expect(source.match(/workspaceUnavailableResponse\(request\)/gu)?.length).toBe(2)
    expect(source).toContain("'account_directory_unavailable'")
  })
})
