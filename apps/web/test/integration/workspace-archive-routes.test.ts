// Route → PostgreSQL flows for optional-workspace archive (M11.04, #1175).
//
// The archive route handler is driven through its injected seams: the resolved principal is staged
// per call, and authorization runs the real `workspace.archive` role matrix against real membership
// rows. The archive itself is the real `archiveWorkspace` on the migrated database. Reopen is the
// existing `reopenWorkspace` contract; its route handler is not exported, so its owner and repeat
// rules are asserted on that contract, which the route delegates to.
//
// Lane: discovered by `bun run test:integration` (react-server condition, DATABASE_URL trio). Without
// DATABASE_URL the suite is skipped here, and the lane fails rather than skipping.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { authorizeWorkspaceAction } from '@adea-ai/auth/authorization'
import {
  addWorkspaceMembership,
  createDatabase,
  createTemporaryUserSession,
  createWorkspaceWithOwner,
  ensureBootstrapWorkspaces,
  findWorkspaceMembership,
  getWorkspaceForUser,
  recordWorkspaceAuthorizationDecision,
  reopenWorkspace,
  type DatabaseConnection,
} from '@adea-ai/db'
import type { UserPrincipalRef } from '@adea-ai/types'

import { workspaceArchivePost } from '../../src/server/workspace-archive-handler'
import type { WorkspacePrincipalResolution } from '../../src/server/workspace-principal'

const connectionUrl = process.env.DATABASE_URL

function archiveRequest(workspaceId: string): Request {
  return new Request(`https://adea.test/api/workspaces/${workspaceId}/archive`, {
    method: 'POST',
  })
}

describe.skipIf(!connectionUrl)('workspace archive route flow (#1175)', () => {
  let connection: DatabaseConnection

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })

  afterAll(async () => {
    await connection.close()
  })

  async function principal(label: string): Promise<UserPrincipalRef> {
    return (
      await createTemporaryUserSession(connection.db, {
        credentialDigest: `archive-route-${label}-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 600_000),
      })
    ).principal
  }

  /** The caller is resolved per call; authorization is the production `workspace.archive` check. */
  function dependencies(caller: UserPrincipalRef) {
    return {
      authorize: async (_principal: UserPrincipalRef, workspaceId: string) =>
        (
          await authorizeWorkspaceAction(
            { permission: 'workspace.archive', principal: caller, workspaceId },
            {
              audit: (record) => recordWorkspaceAuthorizationDecision(connection.db, record),
              findMembership: ({ principal: member, workspaceId: id }) =>
                findWorkspaceMembership(connection.db, id, member),
            }
          )
        ).allowed,
      database: () => connection.db,
      resolvePrincipal: async (): Promise<WorkspacePrincipalResolution> => ({
        clearTemporaryCredential: false,
        principal: caller,
        sessionRotated: false,
        temporary: true,
      }),
    }
  }

  async function optionalWorkspace(owner: UserPrincipalRef, name: string) {
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `archive-route-${crypto.randomUUID()}`,
      name,
      owner,
    })
    return workspace
  }

  test('the owner archives an optional workspace; history stays addressable and the repeat is unavailable', async () => {
    const owner = await principal('owner')
    const workspace = await optionalWorkspace(owner, 'Optional owner archive')

    const archived = await workspaceArchivePost(
      archiveRequest(workspace.id),
      workspace.id,
      dependencies(owner)
    )
    expect(archived.status).toBe(200)
    expect(await archived.json()).toEqual({ archived: true, workspaceId: workspace.id })
    expect(await getWorkspaceForUser(connection.db, workspace.id, owner)).toBeNull()

    const repeat = await workspaceArchivePost(
      archiveRequest(workspace.id),
      workspace.id,
      dependencies(owner)
    )
    expect(repeat.status).toBe(404)
    expect((await repeat.json()) as { code: string }).toMatchObject({
      code: 'workspace_unavailable',
    })
  })

  test('admins, members and outsiders are refused by the workspace.archive matrix and leave the workspace active', async () => {
    const owner = await principal('owner-refused')
    const workspace = await optionalWorkspace(owner, 'Optional refused archive')
    const admin = await principal('admin')
    const member = await principal('member')
    const outsider = await principal('outsider')
    await addWorkspaceMembership(connection.db, workspace.id, admin, 'admin')
    await addWorkspaceMembership(connection.db, workspace.id, member, 'member')

    for (const caller of [admin, member, outsider]) {
      const refused = await workspaceArchivePost(
        archiveRequest(workspace.id),
        workspace.id,
        dependencies(caller)
      )
      expect(refused.status).toBe(404)
      expect((await refused.json()) as { code: string }).toMatchObject({
        code: 'workspace_unavailable',
      })
    }
    expect(await getWorkspaceForUser(connection.db, workspace.id, owner)).not.toBeNull()
  })

  test('Home is protected on the server: the owner gets a typed refusal and Home stays active', async () => {
    const owner = await principal('home-owner')
    const bootstrapped = await ensureBootstrapWorkspaces(connection.db, owner)
    const home = bootstrapped.find((candidate) => candidate.isPersonal)
    expect(home).toBeDefined()

    const refused = await workspaceArchivePost(
      archiveRequest(home!.id),
      home!.id,
      dependencies(owner)
    )
    expect(refused.status).toBe(409)
    expect((await refused.json()) as { code: string }).toMatchObject({
      code: 'workspace_personal_protected',
    })
    expect(await getWorkspaceForUser(connection.db, home!.id, owner)).not.toBeNull()
  })

  test('a malformed workspace id is an invalid request, not a database error', async () => {
    const owner = await principal('malformed')
    const response = await workspaceArchivePost(
      archiveRequest('not-a-workspace'),
      'not-a-workspace',
      dependencies(owner)
    )
    expect(response.status).toBe(400)
    expect((await response.json()) as { code: string }).toMatchObject({ code: 'invalid_request' })
  })

  test('reopen, the existing contract the route delegates to, restores the owner and refuses a non-owner', async () => {
    const owner = await principal('reopen-owner')
    const admin = await principal('reopen-admin')
    const workspace = await optionalWorkspace(owner, 'Optional reopen')
    await addWorkspaceMembership(connection.db, workspace.id, admin, 'admin')
    await workspaceArchivePost(archiveRequest(workspace.id), workspace.id, dependencies(owner))

    await expect(reopenWorkspace(connection.db, workspace.id, admin)).rejects.toThrow(
      'Workspace unavailable'
    )
    const reopened = await reopenWorkspace(connection.db, workspace.id, owner)
    expect(reopened.id).toBe(workspace.id)
    expect(reopened.canArchive).toBe(true)
    expect(await reopenWorkspace(connection.db, workspace.id, owner)).toEqual(reopened)
  })
})
