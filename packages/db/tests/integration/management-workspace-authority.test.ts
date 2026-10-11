import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'

import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import { withWorkspaceManagementAuthority } from '../../src/management-workspace-authority'
import { createProject, getProjectForUser, updateProject } from '../../src/projects'
import { workspaceEvents, workspaceMemberships, workspaces } from '../../src/schema'
import {
  addWorkspaceMembership,
  createWorkspaceWithOwner,
  findWorkspaceMembership,
  removeWorkspaceMembership,
} from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL

describe.skipIf(!connectionUrl)('management workspace transaction authority', () => {
  let connection: DatabaseConnection
  let observer: DatabaseConnection

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
    observer = createDatabase(connectionUrl!)
  })
  afterAll(async () => {
    await connection?.close()
    await observer?.close()
  })

  async function fixture() {
    const session = () =>
      createTemporaryUserSession(connection.db, {
        credentialDigest: `digest-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000),
      })
    const owner = (await session()).principal
    const actor = (await session()).principal
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `management-fence-${crypto.randomUUID()}`,
      name: 'Management fence',
      owner,
    })
    await addWorkspaceMembership(connection.db, workspace.id, actor, 'admin')
    const project = await createProject(connection.db, workspace.id, owner, {
      iconKey: 'box',
      name: 'Before fenced effect',
    })
    return { actor, owner, project, workspace }
  }

  async function eventCount(workspaceId: string) {
    return (
      await observer.db
        .select({ id: workspaceEvents.id })
        .from(workspaceEvents)
        .where(eq(workspaceEvents.workspaceId, workspaceId))
    ).length
  }

  async function changeMembership(
    database: DatabaseConnection,
    f: Awaited<ReturnType<typeof fixture>>,
    change: 'remove' | 'downgrade'
  ) {
    if (change === 'remove') return removeWorkspaceMembership(database.db, f.workspace.id, f.actor)
    await database.db
      .update(workspaceMemberships)
      .set({ role: 'member' })
      .where(
        and(
          eq(workspaceMemberships.workspaceId, f.workspace.id),
          eq(workspaceMemberships.userId, f.actor.userId)
        )
      )
    return true
  }

  for (const change of ['remove', 'downgrade'] as const) {
    for (const permission of ['workspace.update', 'membership.manage'] as const) {
      test(`${change} committed before permission acquisition denies ${permission} with no mutation/event`, async () => {
        const f = await fixture()
        const beforeEvents = await eventCount(f.workspace.id)
        expect(await changeMembership(observer, f, change)).toBe(true)
        let executed = false
        await expect(
          withWorkspaceManagementAuthority(
            connection.db,
            { permission, principal: f.actor, workspaceId: f.workspace.id },
            async (transaction) => {
              executed = true
              return updateProject(transaction, f.workspace.id, f.project.id, f.actor, {
                name: 'Forbidden effect',
              })
            }
          )
        ).rejects.toThrow('Workspace unavailable')
        expect(executed).toBe(false)
        expect(
          (await getProjectForUser(observer.db, f.workspace.id, f.project.id, f.owner))?.name
        ).toBe(f.project.name)
        expect(await eventCount(f.workspace.id)).toBe(beforeEvents)
      })
    }

    for (const completion of ['commit', 'rollback'] as const) {
      test(`mutation lock first blocks ${change} until ${completion}, including its event`, async () => {
        const label = `management-revocation-${crypto.randomUUID()}`
        const url = new URL(connectionUrl!)
        url.searchParams.set('application_name', label)
        const revoker = createDatabase(url.toString())
        const reached = Promise.withResolvers<number>()
        const release = Promise.withResolvers<void>()
        let mutation: Promise<unknown> | undefined
        let revocation: Promise<boolean> | undefined
        try {
          const f = await fixture()
          const beforeEvents = await eventCount(f.workspace.id)
          mutation = withWorkspaceManagementAuthority(
            connection.db,
            { permission: 'workspace.update', principal: f.actor, workspaceId: f.workspace.id },
            async (transaction) => {
              const changed = await updateProject(
                transaction,
                f.workspace.id,
                f.project.id,
                f.actor,
                {
                  name: 'Fenced effect',
                }
              )
              const [row] = await transaction.execute(sql`select pg_backend_pid() as pid`)
              reached.resolve(Number(row!.pid))
              await release.promise
              if (completion === 'rollback') throw new Error('Synthetic effect rollback')
              return changed
            }
          )
          void mutation.catch(() => undefined)
          const pid = await Promise.race([
            reached.promise,
            mutation.then(() => {
              throw new Error('Mutation completed before its barrier')
            }),
          ])
          revocation = changeMembership(revoker, f, change)
          void revocation.catch(() => undefined)
          // Observe PostgreSQL's actual wait graph; elapsed time never decides
          // whether revocation was blocked by the permission transaction.
          let blocked = false
          const deadline = Date.now() + 3_000
          while (Date.now() < deadline) {
            const rows = await observer.db.execute(sql`
              select a.pid from pg_stat_activity a
              where a.datname = current_database() and a.application_name = ${label}
                and a.wait_event_type = 'Lock'
                and a.query ilike '%workspace_memberships%'
                and pg_blocking_pids(a.pid) @> array[${pid}]::int[]
            `)
            if (rows.length > 0) {
              blocked = true
              break
            }
            await Bun.sleep(10)
          }
          expect(blocked).toBe(true)
          expect((await findWorkspaceMembership(observer.db, f.workspace.id, f.actor))?.role).toBe(
            'admin'
          )
          expect(
            (await getProjectForUser(observer.db, f.workspace.id, f.project.id, f.owner))?.name
          ).toBe(f.project.name)
          expect(await eventCount(f.workspace.id)).toBe(beforeEvents)
          release.resolve()
          if (completion === 'rollback')
            await expect(mutation).rejects.toThrow('Synthetic effect rollback')
          else await mutation
          expect(await revocation).toBe(true)
          expect(
            (await findWorkspaceMembership(observer.db, f.workspace.id, f.actor))?.role ?? null
          ).toBe(change === 'remove' ? null : 'member')
          expect(
            (await getProjectForUser(observer.db, f.workspace.id, f.project.id, f.owner))?.name
          ).toBe(completion === 'commit' ? 'Fenced effect' : f.project.name)
          expect(await eventCount(f.workspace.id)).toBe(
            beforeEvents + (completion === 'commit' ? 1 : 0)
          )
        } finally {
          release.resolve()
          await mutation?.catch(() => undefined)
          await revocation?.catch(() => undefined)
          await revoker.close()
        }
      })
    }
  }

  test('the existing ordinary member query policy remains separate from management permission', async () => {
    const f = await fixture()
    await changeMembership(observer, f, 'downgrade')
    expect(
      (
        await updateProject(connection.db, f.workspace.id, f.project.id, f.actor, {
          name: 'Ordinary query policy',
        })
      ).name
    ).toBe('Ordinary query policy')
    await expect(
      withWorkspaceManagementAuthority(
        connection.db,
        {
          permission: 'workspace.update',
          principal: f.actor,
          workspaceId: f.workspace.id,
        },
        (transaction) =>
          updateProject(transaction, f.workspace.id, f.project.id, f.actor, {
            name: 'Forbidden management',
          })
      )
    ).rejects.toThrow('Workspace unavailable')
  })

  test('archived and cleanup-pending workspaces refuse effects; only reopen may include archived', async () => {
    const f = await fixture()
    await connection.db
      .update(workspaces)
      .set({ deletedAt: new Date() })
      .where(eq(workspaces.id, f.workspace.id))
    const input = {
      permission: 'workspace.update' as const,
      principal: f.owner,
      workspaceId: f.workspace.id,
    }
    await expect(
      withWorkspaceManagementAuthority(connection.db, input, async () => true)
    ).rejects.toThrow('Workspace unavailable')
    expect(
      await withWorkspaceManagementAuthority(
        connection.db,
        { ...input, includeArchived: true },
        async () => true
      )
    ).toBe(true)
    await connection.db
      .update(workspaces)
      .set({ deletionRequestedAt: new Date() })
      .where(eq(workspaces.id, f.workspace.id))
    await expect(
      withWorkspaceManagementAuthority(
        connection.db,
        { ...input, includeArchived: true },
        async () => true
      )
    ).rejects.toThrow('Workspace unavailable')
  })
})
