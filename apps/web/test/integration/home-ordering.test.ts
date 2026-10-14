import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { AgentHqApiClient } from '@adea-ai/api-client'
import { QueryClient } from '@tanstack/solid-query'
import { eq, inArray } from 'drizzle-orm'
import { createDatabase, type DatabaseConnection } from '../../../../packages/db/src/connection'
import { createTemporaryUserSession } from '../../../../packages/db/src/identity'
import {
  temporaryUserSessions,
  users,
  workspaceMemberships,
  workspaces,
} from '../../../../packages/db/src/schema'
import {
  createWorkspaceWithOwner,
  ensureBootstrapWorkspaces,
  getWorkspaceForUser,
  listWorkspacesForUser,
  reorderWorkspaces,
  updateWorkspace,
} from '../../../../packages/db/src/workspaces'
import {
  workspaceMutationOptions,
  workspaceQueryKeys,
  workspaceQueryOptions,
} from '../../../../packages/data/src'

describe.skipIf(!process.env.DATABASE_URL)('database-backed Home ordering consumers', () => {
  let connection: DatabaseConnection
  const fixtureUsers: string[] = []
  beforeAll(() => {
    connection = createDatabase(process.env.DATABASE_URL!)
  })
  afterAll(async () => {
    await connection.db
      .delete(workspaceMemberships)
      .where(inArray(workspaceMemberships.userId, fixtureUsers))
    await connection.db.delete(workspaces).where(inArray(workspaces.ownerUserId, fixtureUsers))
    await connection.db
      .delete(temporaryUserSessions)
      .where(inArray(temporaryUserSessions.userId, fixtureUsers))
    await connection.db.delete(users).where(inArray(users.id, fixtureUsers))
    await connection.close()
  })
  async function guest() {
    const session = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    fixtureUsers.push(session.principal.userId)
    return session
  }

  test('legacy list positions pin only the caller root and feed settings/bootstrap caches without changing the active workspace', async () => {
    const { principal } = await guest()
    const other = await guest()
    const [home] = await ensureBootstrapWorkspaces(connection.db, principal)
    const [foreignHome] = await ensureBootstrapWorkspaces(connection.db, other.principal)
    const optional = (
      await createWorkspaceWithOwner(connection.db, {
        owner: principal,
        name: 'Home',
        idempotencyKey: crypto.randomUUID(),
      })
    ).workspace
    const renamed = await updateWorkspace(connection.db, home!.id, principal, {
      expectedVersion: home!.version,
      update: { name: 'Studio', logo: { kind: 'emoji', value: '🎨' }, scene: 'work' },
    })
    await connection.db.insert(workspaceMemberships).values({
      workspaceId: foreignHome!.id,
      userId: principal.userId,
      role: 'member',
      sortOrder: 0,
    })
    await connection.db
      .update(workspaceMemberships)
      .set({ sortOrder: 9 })
      .where(eq(workspaceMemberships.workspaceId, home!.id))

    // A DB-backed adapter feeds the actual query/mutation consumers; no canned
    // workspace responses. Settings reads the list; reorder refreshes bootstrap.
    const client = {
      listWorkspaces: () => listWorkspacesForUser(connection.db, principal),
      bootstrapWorkspace: async () => {
        const bootstrapped = await ensureBootstrapWorkspaces(connection.db, principal)
        return {
          workspaces: bootstrapped,
          activeWorkspace: bootstrapped.find((workspace) => workspace.isPersonal) ?? null,
          principal: { temporary: true, userId: principal.userId },
          sessionRotated: false,
        }
      },
      reorderWorkspaces: (ids: readonly string[]) =>
        reorderWorkspaces(connection.db, principal, ids),
    } as unknown as AgentHqApiClient
    const queryClient = new QueryClient()
    try {
      const expectedIds = [home!.id, foreignHome!.id, optional.id]
      const listed = await queryClient.fetchQuery(workspaceQueryOptions.list(client))
      expect(listed.map(({ id }) => id)).toEqual(expectedIds)
      expect(listed.map(({ sortOrder }) => sortOrder)).toEqual([9, 0, 1])
      expect(listed.map(({ isPersonal }) => isPersonal)).toEqual([true, false, false])
      const bootstrap = await queryClient.fetchQuery(workspaceQueryOptions.bootstrap(client))
      expect(bootstrap.workspaces).toEqual(listed)
      expect(bootstrap.activeWorkspace?.id).toBe(home!.id)
      queryClient.setQueryData(workspaceQueryKeys.bootstrap, {
        ...bootstrap,
        activeWorkspace: optional,
      })
      const mutation = workspaceMutationOptions.reorder(client, queryClient)
      const reordered = await mutation.mutationFn([optional.id, home!.id, foreignHome!.id])
      await mutation.onSuccess(reordered)
      expect(reordered.map(({ id, sortOrder }) => [id, sortOrder])).toEqual([
        [home!.id, 0],
        [optional.id, 1],
        [foreignHome!.id, 2],
      ])
      expect(queryClient.getQueryData(workspaceQueryKeys.list)).toEqual(reordered)
      expect(queryClient.getQueryData(workspaceQueryKeys.bootstrap)).toMatchObject({
        workspaces: reordered,
        activeWorkspace: reordered[1],
      })
      expect(await getWorkspaceForUser(connection.db, home!.id, principal)).toMatchObject({
        version: renamed.version,
        updatedAt: renamed.updatedAt,
        name: 'Studio',
      })
      expect(await listWorkspacesForUser(connection.db, other.principal)).toEqual([foreignHome!])
      const positions = await connection.db
        .select()
        .from(workspaceMemberships)
        .where(eq(workspaceMemberships.userId, principal.userId))
      await expect(
        reorderWorkspaces(connection.db, principal, [optional.id, home!.id, crypto.randomUUID()])
      ).rejects.toThrow('Workspace order conflict')
      expect(
        await connection.db
          .select()
          .from(workspaceMemberships)
          .where(eq(workspaceMemberships.userId, principal.userId))
      ).toEqual(positions)
      expect(await ensureBootstrapWorkspaces(connection.db, principal)).toEqual(reordered)
    } finally {
      queryClient.clear()
    }
  })
})
