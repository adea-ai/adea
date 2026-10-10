import { afterAll, beforeAll, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import {
  createWorkspaceWithOwner,
  ensureBootstrapWorkspaces,
  workspaceDeletionState,
} from '../../src/workspaces'
import {
  authorizationAuditRecords,
  temporaryUserSessions,
  users,
  workspaceDeletions,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import { workspaceDeletionPost } from '../../../../apps/web/src/server/workspace-deletion-handler'

let connection: DatabaseConnection
beforeAll(() => {
  if (process.env.DATABASE_URL) connection = createDatabase(process.env.DATABASE_URL)
})
afterAll(async () => {
  await connection?.close()
})

for (const interrupted of [false, true]) {
  test.skipIf(!process.env.DATABASE_URL)(
    `direct API prepare/final cannot delete without server-verifiable completion; interrupted=${interrupted}`,
    async () => {
      const owner = await createTemporaryUserSession(connection.db, {
        credentialDigest: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
      })
      const [home] = await ensureBootstrapWorkspaces(connection.db, owner.principal)
      const extra = (
        await createWorkspaceWithOwner(connection.db, {
          owner: owner.principal,
          name: 'Scratch',
          idempotencyKey: crypto.randomUUID(),
        })
      ).workspace
      const token = 'disposable-owner-token'
      const dependencies = {
        database: () => connection.db,
        resolvePrincipal: async (request: Request) =>
          request.headers.get('authorization') === `Bearer ${token}`
            ? {
                principal: owner.principal,
                temporary: true,
                clearTemporaryCredential: false,
                sessionRotated: false,
              }
            : null,
      }
      const post = (workspace: typeof extra, body: Record<string, unknown>, authenticated = true) =>
        workspaceDeletionPost(
          new Request(`https://adea.dev/api/workspaces/${workspace.id}/delete`, {
            method: 'POST',
            headers: {
              origin: 'http://127.0.0.1:4789',
              'x-adea-client': 'desktop',
              'sec-fetch-site': 'cross-site',
              'content-type': 'application/json',
              ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({
              confirmationName: workspace.name,
              expectedVersion: workspace.version,
              ...body,
            }),
          }),
          workspace.id,
          dependencies
        )
      try {
        expect((await post(extra, {}, false)).status).toBe(401)
        if (interrupted)
          await connection.db
            .update(workspaces)
            .set({ deletionRequestedAt: new Date() })
            .where(eq(workspaces.id, extra.id))
        const prepare = await post(extra, { phase: 'prepare' })
        expect(prepare.status).toBe(409)
        expect(await prepare.json()).toMatchObject({ code: 'workspace_deletion_cleanup_required' })
        const [unchanged] = await connection.db
          .select()
          .from(workspaces)
          .where(eq(workspaces.id, extra.id))
        expect(Boolean(unchanged?.deletionRequestedAt)).toBe(interrupted)
        for (let retry = 0; retry < 2; retry++) {
          const response = await post(extra, {
            device: true,
            requireCleanupAuthorization: false,
            cleanupComplete: true,
            completionProof: 'caller-assertion',
          })
          expect(response.status).toBe(409)
          expect(await response.json()).toMatchObject({
            code: 'workspace_deletion_cleanup_required',
          })
          expect(
            await connection.db.select().from(workspaces).where(eq(workspaces.id, extra.id))
          ).toHaveLength(1)
          expect(
            await connection.db
              .select()
              .from(workspaceDeletions)
              .where(eq(workspaceDeletions.workspaceId, extra.id))
          ).toHaveLength(0)
        }
        // Even a contradictory historical receipt cannot prove completion while its root exists.
        await connection.db.insert(workspaceDeletions).values({
          workspaceId: extra.id,
          ownerUserId: owner.principal.userId,
          idempotencyKey: unchanged!.idempotencyKey,
        })
        expect(await workspaceDeletionState(connection.db, extra.id, owner.principal)).toBe(
          interrupted ? 'cleanup_pending' : 'active'
        )
        expect((await post(extra, {})).status).toBe(409)
        for (const phase of [{ phase: 'prepare' }, {}]) {
          const response = await post(home!, phase)
          expect(response.status).toBe(409)
          expect(await response.json()).toMatchObject({ code: 'workspace_personal_protected' })
        }
        expect(
          await connection.db.select().from(workspaces).where(eq(workspaces.id, home!.id))
        ).toHaveLength(1)
      } finally {
        // Raw SQL cleanup is restricted to these disposable fixtures, never the application path.
        const ids = (
          await connection.db
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(eq(workspaces.ownerUserId, owner.principal.userId))
        ).map((row) => row.id)
        await connection.db
          .delete(workspaceMemberships)
          .where(inArray(workspaceMemberships.workspaceId, ids))
        await connection.db
          .delete(authorizationAuditRecords)
          .where(inArray(authorizationAuditRecords.workspaceId, ids))
        await connection.db.delete(workspaces).where(inArray(workspaces.id, ids))
        await connection.db
          .delete(workspaceDeletions)
          .where(eq(workspaceDeletions.ownerUserId, owner.principal.userId))
        await connection.db
          .delete(temporaryUserSessions)
          .where(eq(temporaryUserSessions.userId, owner.principal.userId))
        await connection.db.delete(users).where(eq(users.id, owner.principal.userId))
      }
    }
  )
}
