import { expect, test } from 'bun:test'

import { workspaceArchivePost } from '../src/server/workspace-archive-handler'
import type { ManagementOperations } from '../src/server/management-operations'
import type { WorkspacePrincipalResolution } from '../src/server/workspace-principal'

function resolution(): WorkspacePrincipalResolution {
  const principal = { kind: 'user' as const, userId: 'archive-owner' }
  return {
    clearTemporaryCredential: false,
    principal,
    sessionRotated: false,
    temporary: false,
  }
}

function archiveRequest(body: unknown): Request {
  return new Request(
    'https://adea.test/api/workspaces/00000000-0000-4000-8000-000000000001/archive',
    {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }
  )
}

test('workspace archive requires explicit confirmation before entering the shared gateway', async () => {
  let operationCalls = 0
  const operations = {
    workspaceArchive: async () => {
      operationCalls += 1
      return { ok: true as const, operation: 'config.workspace.archive' as const, value: null }
    },
  } as unknown as ManagementOperations

  const response = await workspaceArchivePost(
    archiveRequest({ confirmed: false }),
    '00000000-0000-4000-8000-000000000001',
    {
      operations: () => operations,
      resolvePrincipal: async () => resolution(),
    }
  )

  expect(response.status).toBe(400)
  expect(operationCalls).toBe(0)
})

test('workspace archive forwards confirmed requests into the shared operation', async () => {
  const principal = resolution().principal
  const calls: unknown[] = []
  const operations = {
    workspaceArchive: async (input: unknown) => {
      calls.push(input)
      return { ok: true as const, operation: 'config.workspace.archive' as const, value: null }
    },
  } as unknown as ManagementOperations

  const response = await workspaceArchivePost(
    archiveRequest({ confirmed: true }),
    '00000000-0000-4000-8000-000000000001',
    {
      operations: () => operations,
      resolvePrincipal: async () => resolution(),
    }
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    archived: true,
    workspaceId: '00000000-0000-4000-8000-000000000001',
  })
  expect(calls).toEqual([
    {
      confirmed: true,
      principal,
      workspaceId: '00000000-0000-4000-8000-000000000001',
    },
  ])
})

test('workspace archive rejects unrecognized confirmation fields', async () => {
  let operationCalls = 0
  const operations = {
    workspaceArchive: async () => {
      operationCalls += 1
      return { ok: true as const, operation: 'config.workspace.archive' as const, value: null }
    },
  } as unknown as ManagementOperations

  const response = await workspaceArchivePost(
    archiveRequest({ confirmed: true, unexpected: true }),
    '00000000-0000-4000-8000-000000000001',
    {
      operations: () => operations,
      resolvePrincipal: async () => resolution(),
    }
  )

  expect(response.status).toBe(400)
  expect(operationCalls).toBe(0)
})
