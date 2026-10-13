// Route → PostgreSQL flows for the project list's archived view (#1218).
//
// The list handler runs against the real database and the real workspace.read authorization. The
// default list stays active-only for the sidebar; `includeArchived=true` adds archived projects for
// the explicit restore flow without widening who can see a project.
//
// Lane: discovered by `bun run test:integration` (react-server condition, DATABASE_URL trio). Without
// DATABASE_URL the suite is skipped here, and the lane fails rather than skipping.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { authorizeWorkspaceAction } from '@adea-ai/auth/authorization'
import {
  addWorkspaceMembership,
  archiveProject,
  createDatabase,
  createProject,
  createTemporaryUserSession,
  createWorkspaceWithOwner,
  findWorkspaceMembership,
  recordWorkspaceAuthorizationDecision,
  setProjectVisibility,
  type DatabaseConnection,
} from '@adea-ai/db'
import type { ProjectSummary, UserPrincipalRef } from '@adea-ai/types'

import { projectListGet } from '../../src/server/project-list-handler'
import type { WorkspacePrincipalResolution } from '../../src/server/workspace-principal'

const connectionUrl = process.env.DATABASE_URL

function listRequest(workspaceId: string, query = ''): Request {
  return new Request(`https://adea.test/api/v1/workspaces/${workspaceId}/projects${query}`)
}

async function names(response: Response): Promise<string[]> {
  return ((await response.json()) as ProjectSummary[]).map((project) => project.name).toSorted()
}

describe.skipIf(!connectionUrl)('project list route flow (#1218)', () => {
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
        credentialDigest: `project-list-${label}-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 600_000),
      })
    ).principal
  }

  function dependencies(caller: UserPrincipalRef) {
    return {
      authorize: async (
        actor: UserPrincipalRef,
        permission: 'workspace.read',
        workspaceId: string
      ) =>
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
      database: () => connection.db,
      resolvePrincipal: async (): Promise<WorkspacePrincipalResolution> => ({
        clearTemporaryCredential: false,
        principal: caller,
        sessionRotated: false,
        temporary: true,
      }),
    }
  }

  async function workspaceWithProjects() {
    const owner = await principal('owner')
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `project-list-${crypto.randomUUID()}`,
      name: 'Project list',
      owner,
    })
    const active = await createProject(connection.db, workspace.id, owner, {
      iconKey: 'box',
      name: 'Active one',
    })
    const archived = await createProject(connection.db, workspace.id, owner, {
      iconKey: 'box',
      name: 'Archived one',
    })
    await archiveProject(connection.db, workspace.id, archived.id, owner)
    return { active, archived, owner, workspace }
  }

  test('the default list is active-only and includeArchived adds the archived project', async () => {
    const { owner, workspace } = await workspaceWithProjects()

    const plain = await projectListGet(listRequest(workspace.id), workspace.id, dependencies(owner))
    expect(plain.status).toBe(200)
    expect(await names(plain)).toEqual(['Active one'])

    const explicitOff = await projectListGet(
      listRequest(workspace.id, '?includeArchived=false'),
      workspace.id,
      dependencies(owner)
    )
    expect(await names(explicitOff)).toEqual(['Active one'])

    const withArchived = await projectListGet(
      listRequest(workspace.id, '?includeArchived=true'),
      workspace.id,
      dependencies(owner)
    )
    expect(withArchived.status).toBe(200)
    const rows = (await withArchived.json()) as ProjectSummary[]
    expect(rows.map((row) => [row.name, row.lifecycleState]).toSorted()).toEqual([
      ['Active one', 'active'],
      ['Archived one', 'archived'],
    ])
  })

  test('unknown parameters and values are refused before any read', async () => {
    const { owner, workspace } = await workspaceWithProjects()
    for (const query of ['?includeArchived=yes', '?includeArchived=', '?state=archived']) {
      const refused = await projectListGet(
        listRequest(workspace.id, query),
        workspace.id,
        dependencies(owner)
      )
      expect(refused.status).toBe(400)
    }
  })

  test('an outsider gets the same unavailable answer with or without includeArchived', async () => {
    const { workspace } = await workspaceWithProjects()
    const outsider = await principal('outsider')
    for (const query of ['', '?includeArchived=true']) {
      const refused = await projectListGet(
        listRequest(workspace.id, query),
        workspace.id,
        dependencies(outsider)
      )
      expect(refused.status).toBe(404)
    }
  })

  test('a members-only archived project stays hidden from a workspace member who is not on it', async () => {
    const { archived, owner, workspace } = await workspaceWithProjects()
    await setProjectVisibility(connection.db, workspace.id, archived.id, owner, 'members')
    const member = await principal('member')
    await addWorkspaceMembership(connection.db, workspace.id, member, 'member')

    const asMember = await projectListGet(
      listRequest(workspace.id, '?includeArchived=true'),
      workspace.id,
      dependencies(member)
    )
    expect(await names(asMember)).toEqual(['Active one'])

    const asOwner = await projectListGet(
      listRequest(workspace.id, '?includeArchived=true'),
      workspace.id,
      dependencies(owner)
    )
    expect(await names(asOwner)).toEqual(['Active one', 'Archived one'])
  })
})
