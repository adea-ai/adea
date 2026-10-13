// Route → PostgreSQL flows for optional-workspace archive (M11.04, #1175).
//
// The archive route handler runs the production shared management composition with an isolated test
// database/authorization seam. The real `workspace.archive` role matrix, transaction-wrapped
// executor, authorization audit, archive event and explicit confirmation are exercised together.
// Reopen remains the existing `reopenWorkspace` contract.
//
// Lane: discovered by `bun run test:integration` (react-server condition, DATABASE_URL trio). Without
// DATABASE_URL the suite is skipped here, and the lane fails rather than skipping.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'

import { authorizeWorkspaceAction } from '@adea-ai/auth/authorization'
import {
  addWorkspaceMembership,
  authorizationAuditRecords,
  createDatabase,
  createTemporaryUserSession,
  createWorkspaceWithOwner,
  ensureBootstrapWorkspaces,
  findWorkspaceMembership,
  getWorkspaceForUser,
  recordWorkspaceAuthorizationDecision,
  reopenWorkspace,
  workspaceEvents,
  type DatabaseConnection,
} from '@adea-ai/db'
import type { UserPrincipalRef } from '@adea-ai/types'

import { applicationManagementOperations } from '../../src/server/management-composition'
import { workspaceArchivePost } from '../../src/server/workspace-archive-handler'
import { workspaceArchivedGet } from '../../src/server/workspace-archived-handler'
import type { WorkspacePrincipalResolution } from '../../src/server/workspace-principal'

const connectionUrl = process.env.DATABASE_URL

function listArchivedRequest(): Request {
  return new Request('https://adea.test/api/workspaces/archived', { method: 'GET' })
}

function archiveRequest(workspaceId: string, body: unknown = { confirmed: true }): Request {
  return new Request(`https://adea.test/api/workspaces/${workspaceId}/archive`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
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

  /** The caller and test DB are injected; the real application composition performs the archive. */
  function dependencies(caller: UserPrincipalRef) {
    return {
      operations: () =>
        applicationManagementOperations(
          { kind: 'human' },
          {
            database: () => connection.db,
            authorize: async ({ permission, principal: actor, workspaceId }) =>
              (
                await authorizeWorkspaceAction(
                  { permission, principal: actor, workspaceId },
                  {
                    audit: (record) => recordWorkspaceAuthorizationDecision(connection.db, record),
                    findMembership: ({ principal: member, workspaceId: id }) =>
                      findWorkspaceMembership(connection.db, id, member),
                  }
                )
              ).allowed,
          }
        ),
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
    const auditRows = await connection.db
      .select({ decision: authorizationAuditRecords.decision })
      .from(authorizationAuditRecords)
      .where(
        and(
          eq(authorizationAuditRecords.workspaceId, workspace.id),
          eq(authorizationAuditRecords.permission, 'workspace.archive')
        )
      )
    // The gateway records both the initial and late authorization checks.
    expect(auditRows).toEqual([{ decision: 'allowed' }, { decision: 'allowed' }])
    const events = await connection.db
      .select({ eventType: workspaceEvents.eventType })
      .from(workspaceEvents)
      .where(eq(workspaceEvents.workspaceId, workspace.id))
    expect(events).toContainEqual({ eventType: 'workspace.archived' })

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

  test('archive refuses without explicit confirmation and leaves the workspace active', async () => {
    const owner = await principal('unconfirmed')
    const workspace = await optionalWorkspace(owner, 'Unconfirmed archive')

    const refused = await workspaceArchivePost(
      archiveRequest(workspace.id, { confirmed: false }),
      workspace.id,
      dependencies(owner)
    )

    expect(refused.status).toBe(400)
    expect(await getWorkspaceForUser(connection.db, workspace.id, owner)).not.toBeNull()
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

  test('the archived listing shows only the owner their own archived workspace; reopen removes it from the list', async () => {
    const owner = await principal('listed-owner')
    const member = await principal('listed-member')
    const workspace = await optionalWorkspace(owner, 'Listed archive target')
    await addWorkspaceMembership(connection.db, workspace.id, member, 'member')
    await workspaceArchivePost(archiveRequest(workspace.id), workspace.id, dependencies(owner))

    const listed = async (caller: UserPrincipalRef) => {
      const response = await workspaceArchivedGet(listArchivedRequest(), {
        database: () => connection.db,
        resolvePrincipal: async () => ({
          clearTemporaryCredential: false,
          principal: caller,
          sessionRotated: false,
          temporary: true,
        }),
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      return ((await response.json()) as { workspaces: { id: string; name: string }[] }).workspaces
    }
    const ownerRows = await listed(owner)
    expect(ownerRows.map((row) => row.id)).toEqual([workspace.id])
    expect(ownerRows[0]?.name).toBe('Listed archive target')
    expect(await listed(member)).toEqual([])

    await reopenWorkspace(connection.db, workspace.id, owner)
    expect(await listed(owner)).toEqual([])
  })
})
