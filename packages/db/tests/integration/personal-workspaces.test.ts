import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { readFileSync } from 'node:fs'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import {
  claimTemporaryUserSession,
  claimTemporaryUserSessionForUser,
  createTemporaryUserSession,
  createUserWithAuthIdentity,
} from '../../src/identity'
import {
  addWorkspaceMembership,
  archiveWorkspace,
  beginWorkspaceDeletion,
  createWorkspaceWithOwner,
  deleteWorkspace,
  ensureBootstrapWorkspaces,
  getWorkspaceForUser,
  listArchivedWorkspacesForOwner,
  listWorkspacesForUser,
  removeWorkspaceMembership,
  reorderWorkspaces,
  reopenWorkspace,
  updateWorkspace,
  workspaceDeletionState,
} from '../../src/workspaces'
import {
  agents,
  projects,
  runtimeNodes,
  tasks,
  temporaryUserSessions,
  users,
  workspaceDeletions,
  workspaceEvents,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import { lockWorkspaceEventSequence } from '../../src/transactions'
import { mintControlPlaneIdentifier } from '../../src/control-plane-identifiers'

const connectionUrl = process.env.DATABASE_URL

describe.skipIf(!process.env.DATABASE_URL)('persistent personal workspace', () => {
  let connection: DatabaseConnection
  const fixtureUsers: string[] = []
  beforeAll(() => {
    connection = createDatabase(process.env.DATABASE_URL!)
  })
  afterAll(async () => {
    // These are disposable local fixtures, not product deletion operations.
    const rows = await connection.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(inArray(workspaces.ownerUserId, fixtureUsers))
    const ids = rows.map((row) => row.id)
    if (ids.length) {
      await connection.db
        .delete(workspaceMemberships)
        .where(inArray(workspaceMemberships.workspaceId, ids))
      await connection.db.delete(workspaces).where(inArray(workspaces.id, ids))
    }
    await connection.db
      .delete(workspaceDeletions)
      .where(inArray(workspaceDeletions.ownerUserId, fixtureUsers))
    await connection.db
      .delete(temporaryUserSessions)
      .where(inArray(temporaryUserSessions.userId, fixtureUsers))
    await connection.db.delete(users).where(inArray(users.id, fixtureUsers))
    await connection.close()
  })
  async function guest() {
    const credentialDigest = crypto.randomUUID()
    const session = await createTemporaryUserSession(connection.db, {
      credentialDigest,
      expiresAt: new Date(Date.now() + 60000),
    })
    fixtureUsers.push(session.principal.userId)
    return { ...session, credentialDigest }
  }
  async function registered() {
    const identity = { provider: 'neon', subject: crypto.randomUUID() }
    const principal = await createUserWithAuthIdentity(connection.db, { identity })
    fixtureUsers.push(principal.userId)
    return { principal, identity }
  }
  async function assertBare(workspaceId: string) {
    for (const table of [projects, agents, tasks, runtimeNodes])
      expect(
        await connection.db.select().from(table).where(eq(table.workspaceId, workspaceId))
      ).toEqual([])
  }

  /**
   * The backend pid of a session that is waiting for a lock, read from
   * PostgreSQL's own wait graph. Elapsed time never decides whether a write
   * was blocked.
   */
  async function waitForLockedBackend(applicationName: string, timeoutMs = 5_000): Promise<number> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const rows = await connection.db.execute(sql`
        select a.pid from pg_stat_activity a
        where a.datname = current_database() and a.application_name = ${applicationName}
          and a.wait_event_type = 'Lock'
      `)
      const pid = rows[0]?.pid
      if (pid !== undefined && pid !== null) return Number(pid)
      await Bun.sleep(10)
    }
    throw new Error(`Expected ${applicationName} to wait for a lock`)
  }

  /** A session blocked on a membership row, and the backends that block it. */
  async function waitForBlockedMembershipQuery(applicationName: string, blockerPid: number) {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const rows = await connection.db.execute(sql`
        select a.pid, a.wait_event, a.query, pg_blocking_pids(a.pid) as blocker_pids
        from pg_stat_activity a
        where a.datname = current_database() and a.application_name = ${applicationName}
          and a.wait_event_type = 'Lock'
          and a.query ilike '%workspace_memberships%'
          and pg_blocking_pids(a.pid) @> array[${blockerPid}]::int[]
      `)
      if (rows[0])
        return {
          blockerPids: (rows[0].blocker_pids ?? []) as number[],
          pid: Number(rows[0].pid),
          query: String(rows[0].query),
          waitEvent: String(rows[0].wait_event),
        }
      await Bun.sleep(10)
    }
    throw new Error('Expected the membership revocation to wait for the rename')
  }

  test('fresh signed-in and guest onboarding create only Home, with a home icon, under concurrent retry', async () => {
    const signedIn = await registered()
    const temporary = await guest()
    for (const principal of [signedIn.principal, temporary.principal]) {
      const results = await Promise.all(
        Array.from({ length: 3 }, () => ensureBootstrapWorkspaces(connection.db, principal))
      )
      const home = results[0]![0]!
      expect(results[0]).toHaveLength(1)
      for (const result of results) expect(result).toEqual(results[0])
      expect(home).toMatchObject({
        name: 'Home',
        logo: { kind: 'home' },
        scene: 'home',
        accent: null,
        isPersonal: true,
        canDelete: false,
        sortOrder: 0,
        version: 1,
      })
      await assertBare(home.id)
      expect(await workspaceDeletionState(connection.db, home.id, principal)).toBeNull()
    }
  })

  test('additional workspaces have no seeded data, append below Home, and optional workspaces remain reorderable', async () => {
    const { principal } = await guest()
    const [home] = await ensureBootstrapWorkspaces(connection.db, principal)
    const first = (
      await createWorkspaceWithOwner(connection.db, {
        owner: principal,
        name: 'Secondary',
        idempotencyKey: crypto.randomUUID(),
      })
    ).workspace
    const second = (
      await createWorkspaceWithOwner(connection.db, {
        owner: principal,
        name: 'Team',
        idempotencyKey: crypto.randomUUID(),
      })
    ).workspace
    expect(first).toMatchObject({
      isPersonal: false,
      canDelete: true,
      logo: { kind: 'box' },
      sortOrder: 1,
      accent: null,
    })
    expect(second.sortOrder).toBe(2)
    await assertBare(first.id)
    await assertBare(second.id)
    const ordered = await reorderWorkspaces(connection.db, principal, [
      second.id,
      first.id,
      home!.id,
    ])
    expect(ordered.map(({ id, sortOrder }) => [id, sortOrder])).toEqual([
      [home!.id, 0],
      [second.id, 1],
      [first.id, 2],
    ])
    for (const ids of [
      [first.id, first.id, home!.id],
      [first.id],
      [first.id, second.id, crypto.randomUUID()],
    ])
      await expect(reorderWorkspaces(connection.db, principal, ids)).rejects.toThrow(
        'Workspace order conflict'
      )
    const reordered = await ensureBootstrapWorkspaces(connection.db, principal)
    expect(reordered.map((workspace) => workspace.id)).toEqual([home!.id, second.id, first.id])
    expect(reordered.find((workspace) => workspace.isPersonal)?.id).toBe(home!.id)
    // Dispose only this additional fixture; production deletion is gated.
    await connection.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, first.id))
    await connection.db.delete(workspaces).where(eq(workspaces.id, first.id))
    expect(
      (await ensureBootstrapWorkspaces(connection.db, principal)).map((workspace) => workspace.id)
    ).toEqual([home!.id, second.id])
  })

  test('ordering a shared workspace changes only the caller membership, never another user list', async () => {
    const owner = await guest()
    const member = await guest()
    const [ownerHome] = await ensureBootstrapWorkspaces(connection.db, owner.principal)
    const [memberHome] = await ensureBootstrapWorkspaces(connection.db, member.principal)
    const shared = (
      await createWorkspaceWithOwner(connection.db, {
        owner: owner.principal,
        idempotencyKey: crypto.randomUUID(),
        name: 'Shared',
      })
    ).workspace
    await connection.db.insert(workspaceMemberships).values({
      workspaceId: shared.id,
      userId: member.principal.userId,
      role: 'member',
      sortOrder: 1,
    })
    await reorderWorkspaces(connection.db, member.principal, [shared.id, memberHome!.id])
    expect(
      (await listWorkspacesForUser(connection.db, member.principal)).map(
        (workspace) => workspace.id
      )
    ).toEqual([memberHome!.id, shared.id])
    expect(
      (await listWorkspacesForUser(connection.db, owner.principal)).map((workspace) => workspace.id)
    ).toEqual([ownerHome!.id, shared.id])
    await expect(
      reorderWorkspaces(connection.db, member.principal, [shared.id, ownerHome!.id])
    ).rejects.toThrow('Workspace order conflict')
  })

  test('renaming and customizing Home cannot bypass server protection, prepare, retry or archive', async () => {
    const { principal } = await guest()
    const [home] = await ensureBootstrapWorkspaces(connection.db, principal)
    let updated = await updateWorkspace(connection.db, home!.id, principal, {
      expectedVersion: home!.version,
      update: {
        name: 'Studio',
        logo: { kind: 'emoji', value: '🧪' },
        scene: 'work',
        accent: 'pink',
      },
    })
    expect(updated).toMatchObject({
      isPersonal: true,
      canDelete: false,
      name: 'Studio',
      logo: { kind: 'emoji', value: '🧪' },
      scene: 'work',
      accent: 'pink',
    })
    // An explicitly chosen box is presentation only too.
    updated = await updateWorkspace(connection.db, home!.id, principal, {
      expectedVersion: updated.version,
      update: { logo: { kind: 'box' } },
    })
    const confirmation = { confirmationName: updated.name, expectedVersion: updated.version }
    for (let retry = 0; retry < 2; retry += 1) {
      await expect(
        beginWorkspaceDeletion(connection.db, updated.id, principal, confirmation)
      ).rejects.toThrow('personal workspace cannot be deleted')
      for (const device of [false, true])
        await expect(
          deleteWorkspace(connection.db, updated.id, principal, {
            ...confirmation,
            device,
          })
        ).rejects.toThrow('personal workspace cannot be deleted')
      await expect(
        deleteWorkspace(connection.db, updated.id, principal, confirmation)
      ).rejects.toThrow('personal workspace cannot be deleted')
      await expect(archiveWorkspace(connection.db, updated.id, principal)).rejects.toThrow(
        'personal workspace cannot be deleted'
      )
    }
    // A spurious retry receipt must not bypass the root guard or supply a native purge proof.
    await connection.db.insert(workspaceDeletions).values({
      workspaceId: updated.id,
      ownerUserId: principal.userId,
      idempotencyKey: 'fixture-spurious-retry',
    })
    await expect(
      deleteWorkspace(connection.db, updated.id, principal, confirmation)
    ).rejects.toThrow('personal workspace cannot be deleted')
    expect(await workspaceDeletionState(connection.db, updated.id, principal)).toBeNull()
    expect(await getWorkspaceForUser(connection.db, updated.id, principal)).toEqual(updated)
    expect(await ensureBootstrapWorkspaces(connection.db, principal)).toEqual([updated])
  })

  test('a replayed bootstrap converges on one Home and repairs a missing owner membership', async () => {
    const { principal } = await guest()
    const first = await ensureBootstrapWorkspaces(connection.db, principal)
    expect(first.filter((workspace) => workspace.isPersonal)).toHaveLength(1)

    // A replay is the same bootstrap, asked twice: it converges on the same
    // Home rather than minting a second one.
    const replay = await ensureBootstrapWorkspaces(connection.db, principal)
    expect(replay).toEqual(first)

    const personalRows = () =>
      connection.db
        .select({ idempotencyKey: workspaces.idempotencyKey })
        .from(workspaces)
        .where(and(eq(workspaces.ownerUserId, principal.userId), eq(workspaces.isPersonal, true)))
    const rows = await personalRows()
    expect(rows).toHaveLength(1)
    // The root's creation key is stable, so a replayed or retried creation
    // resolves to the same row instead of another Home.
    expect(rows[0]?.idempotencyKey).toBe('personal:home')

    // A lost owner membership is the one way the root could become invisible
    // to its own owner. The next bootstrap repairs it.
    const home = first.find((workspace) => workspace.isPersonal)!
    await connection.db
      .delete(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, home.id),
          eq(workspaceMemberships.userId, principal.userId)
        )
      )
    expect(await listWorkspacesForUser(connection.db, principal)).toEqual([])
    const repaired = await ensureBootstrapWorkspaces(connection.db, principal)
    expect(repaired.map((workspace) => workspace.id)).toEqual(
      first.map((workspace) => workspace.id)
    )
    expect(repaired.find((workspace) => workspace.isPersonal)?.id).toBe(home.id)
    expect(await personalRows()).toHaveLength(1)
  })

  test('concurrent bootstraps for one owner still leave exactly one personal root', async () => {
    const { principal } = await guest()
    const results = await Promise.all(
      Array.from({ length: 4 }, () => ensureBootstrapWorkspaces(connection.db, principal))
    )
    for (const result of results) expect(result).toEqual(results[0])
    expect(
      results[0]!.filter((workspace) => workspace.isPersonal).map((workspace) => workspace.id)
    ).toHaveLength(1)
    const roots = await connection.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.ownerUserId, principal.userId), eq(workspaces.isPersonal, true)))
    expect(roots).toHaveLength(1)
  })

  test('the personal root is never adopted from a row that merely holds its reserved key', async () => {
    const { principal } = await guest()
    // The route reserves the `personal:` prefix, so only an internal caller can
    // put an ordinary workspace on the root's creation key.
    const { workspace: reserved } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'personal:home',
      name: 'Reserved',
      owner: principal,
    })
    expect(reserved.isPersonal).toBe(false)

    // The bootstrap refuses rather than adopting a row that was never a root.
    await expect(ensureBootstrapWorkspaces(connection.db, principal)).rejects.toThrow(
      'Workspace personal root unavailable'
    )
    const roots = await connection.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.ownerUserId, principal.userId), eq(workspaces.isPersonal, true)))
    expect(roots).toEqual([])
    const [row] = await connection.db
      .select({ isPersonal: workspaces.isPersonal })
      .from(workspaces)
      .where(eq(workspaces.id, reserved.id))
    expect(row?.isPersonal).toBe(false)
  })

  test('a rename cannot commit after the caller lost the authority, and a revocation waits for a rename in flight', async () => {
    const owner = await guest()
    const member = await guest()
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Rename fence',
      owner: owner.principal,
    })
    await addWorkspaceMembership(connection.db, workspace.id, member.principal, 'admin')
    const before = await getWorkspaceForUser(connection.db, workspace.id, owner.principal)
    expect(before).toMatchObject({ name: 'Rename fence', version: workspace.version })
    const eventsBefore = await connection.db
      .select({ id: workspaceEvents.id })
      .from(workspaceEvents)
      .where(eq(workspaceEvents.workspaceId, workspace.id))

    // A revocation never changes the workspace's version, so the rename's own
    // version check still matches after it. Only the fence can refuse it.
    const revoker = createDatabase(connectionUrl!)
    try {
      expect(await removeWorkspaceMembership(revoker.db, workspace.id, member.principal)).toBe(true)
      expect(
        (await getWorkspaceForUser(connection.db, workspace.id, owner.principal))?.version
      ).toBe(workspace.version)
      await expect(
        updateWorkspace(connection.db, workspace.id, member.principal, {
          expectedVersion: workspace.version,
          update: { name: 'Renamed after the revocation' },
        })
      ).rejects.toThrow('Workspace unavailable')
      // No partial rename: the workspace, its version and its event log are
      // exactly what they were before the refused rename.
      expect(await getWorkspaceForUser(connection.db, workspace.id, owner.principal)).toEqual(
        before
      )
      expect(
        await connection.db
          .select({ id: workspaceEvents.id })
          .from(workspaceEvents)
          .where(eq(workspaceEvents.workspaceId, workspace.id))
      ).toEqual(eventsBefore)
    } finally {
      await revoker.close()
    }

    // A demotion is refused the same way: the role is read under the fence,
    // and a demoted member no longer grants `workspace.update`.
    const demoted = await guest()
    await addWorkspaceMembership(connection.db, workspace.id, demoted.principal, 'admin')
    await connection.db
      .update(workspaceMemberships)
      .set({ role: 'member' })
      .where(
        and(
          eq(workspaceMemberships.workspaceId, workspace.id),
          eq(workspaceMemberships.userId, demoted.principal.userId)
        )
      )
    await expect(
      updateWorkspace(connection.db, workspace.id, demoted.principal, {
        expectedVersion: workspace.version,
        update: { name: 'Renamed after the demotion' },
      })
    ).rejects.toThrow('Workspace unavailable')
    expect(await getWorkspaceForUser(connection.db, workspace.id, owner.principal)).toEqual(before)

    // A rename in flight holds the fence, so a concurrent revocation waits for
    // it. The revocation cannot commit between the rename's authorization read
    // and its effect: the interleaving is unconstructible, and the two writes
    // are one ordered pair.
    const label = `rename-fence-${crypto.randomUUID()}`
    const renameUrl = new URL(connectionUrl!)
    renameUrl.searchParams.set('application_name', `${label}-rename`)
    const revokeUrl = new URL(connectionUrl!)
    revokeUrl.searchParams.set('application_name', `${label}-revoke`)
    const renamer = createDatabase(renameUrl.toString())
    const revoker2 = createDatabase(revokeUrl.toString())
    const release = Promise.withResolvers<void>()
    // The parker's own barrier: it resolves only once the parker provably holds
    // the event-sequence lock, and it rejects with the parker's own failure so
    // the barrier can never hang on an acquisition that did not happen.
    const acquired = Promise.withResolvers<void>()
    let parker: Promise<unknown> | undefined
    let rename: Promise<unknown> | undefined
    let revocation: Promise<boolean> | undefined
    try {
      const concurrent = await guest()
      await addWorkspaceMembership(connection.db, workspace.id, concurrent.principal, 'admin')
      // Parking the workspace's event sequence row holds the rename after it
      // has taken both fences and applied its write, without committing it.
      parker = connection.db.transaction(async (transaction) => {
        try {
          await lockWorkspaceEventSequence(transaction, workspace.id)
        } catch (error) {
          // The acquisition failed, so the rename must not start on the
          // assumption that the lock is held.
          acquired.reject(error)
          throw error
        }
        acquired.resolve()
        await release.promise
      })
      // Any other failure of the parker must settle the barrier too, so the
      // await below can never hang on an acquisition that did not happen.
      void parker.catch((error: unknown) => {
        acquired.reject(error)
      })
      // The rename may only start once the parker provably holds the lock. The
      // two connections are independent, so starting the rename first could
      // let it take the sequence row itself and never block on the parker.
      await acquired.promise
      rename = updateWorkspace(renamer.db, workspace.id, concurrent.principal, {
        expectedVersion: workspace.version,
        update: { name: 'Renamed while in flight' },
      })
      void rename.catch(() => undefined)
      // The rename is now blocked on the parked sequence row, which it only
      // reaches after it holds the workspace and membership fences.
      const renamePid = await waitForLockedBackend(`${label}-rename`)
      revocation = removeWorkspaceMembership(revoker2.db, workspace.id, concurrent.principal)
      void revocation.catch(() => undefined)
      // Observe PostgreSQL's actual wait graph; elapsed time never decides
      // whether the revocation was blocked by the rename.
      const blocked = await waitForBlockedMembershipQuery(`${label}-revoke`, renamePid)
      expect(blocked.pid).toBeGreaterThan(0)
      expect(blocked.blockerPids.map(Number)).toContain(renamePid)
      expect(blocked.waitEvent.length).toBeGreaterThan(0)
      expect(blocked.query).toContain('workspace_memberships')
      // The revocation has not committed, and the rename has not committed.
      expect(
        (
          await connection.db
            .select({ role: workspaceMemberships.role })
            .from(workspaceMemberships)
            .where(
              and(
                eq(workspaceMemberships.workspaceId, workspace.id),
                eq(workspaceMemberships.userId, concurrent.principal.userId)
              )
            )
        )[0]?.role
      ).toBe('admin')
      expect((await getWorkspaceForUser(connection.db, workspace.id, owner.principal))?.name).toBe(
        'Rename fence'
      )
      release.resolve()
      await rename
      expect(await revocation).toBe(true)
      expect((await getWorkspaceForUser(connection.db, workspace.id, owner.principal))?.name).toBe(
        'Renamed while in flight'
      )
      expect(
        await connection.db
          .select({ id: workspaceMemberships.id })
          .from(workspaceMemberships)
          .where(
            and(
              eq(workspaceMemberships.workspaceId, workspace.id),
              eq(workspaceMemberships.userId, concurrent.principal.userId)
            )
          )
      ).toEqual([])
    } finally {
      release.resolve()
      await parker?.catch(() => undefined)
      await rename?.catch(() => undefined)
      await revocation?.catch(() => undefined)
      await renamer.close()
      await revoker2.close()
    }
  })

  test('a rename is scope-aware and presentation-only', async () => {
    const owner = await guest()
    const member = await guest()
    const admin = await guest()
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Rename scope',
      owner: owner.principal,
    })
    await addWorkspaceMembership(connection.db, workspace.id, member.principal, 'member')
    await addWorkspaceMembership(connection.db, workspace.id, admin.principal, 'admin')

    // Membership alone is not authority to rename: the same role matrix the
    // route applies decides here too.
    await expect(
      updateWorkspace(connection.db, workspace.id, member.principal, {
        expectedVersion: workspace.version,
        update: { name: 'Member rename' },
      })
    ).rejects.toThrow('Workspace unavailable')
    expect((await getWorkspaceForUser(connection.db, workspace.id, owner.principal))?.name).toBe(
      'Rename scope'
    )

    // A stale revision conflicts instead of overwriting the current name.
    await expect(
      updateWorkspace(connection.db, workspace.id, owner.principal, {
        expectedVersion: workspace.version + 5,
        update: { name: 'Stale rename' },
      })
    ).rejects.toThrow('Workspace version conflict')

    const renamed = await updateWorkspace(connection.db, workspace.id, owner.principal, {
      expectedVersion: workspace.version,
      update: { name: 'Renamed' },
    })
    expect(renamed).toMatchObject({
      id: workspace.id,
      name: 'Renamed',
      version: workspace.version + 1,
    })

    // An admin shares the update authority; a rename still changes nothing
    // but presentation. The lifecycle capabilities stay with the owner.
    const adminRenamed = await updateWorkspace(connection.db, workspace.id, admin.principal, {
      expectedVersion: renamed.version,
      update: { name: 'Admin renamed' },
    })
    expect(adminRenamed).toMatchObject({
      id: workspace.id,
      name: 'Admin renamed',
      canArchive: false,
      canDelete: false,
    })
    expect(
      (
        await connection.db
          .select()
          .from(workspaceMemberships)
          .where(eq(workspaceMemberships.workspaceId, workspace.id))
      ).length
    ).toBe(3)
  })

  test('an archived workspace offers neither archive nor deletion; reopening restores both', async () => {
    const { principal } = await guest()
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Archive capability',
      owner: principal,
    })
    expect(workspace).toMatchObject({ canArchive: true, canDelete: true })

    await archiveWorkspace(connection.db, workspace.id, principal)
    const archived = (await listArchivedWorkspacesForOwner(connection.db, principal)).find(
      (candidate) => candidate.id === workspace.id
    )
    // Archive is not erasure: the row, its history and its links stay, but
    // the workspace is no longer an archive or a deletion target.
    expect(archived).toMatchObject({ id: workspace.id, canArchive: false, canDelete: false })
    expect(
      await connection.db.select().from(workspaces).where(eq(workspaces.id, workspace.id))
    ).toHaveLength(1)
    expect(
      await connection.db
        .select()
        .from(workspaceMemberships)
        .where(eq(workspaceMemberships.workspaceId, workspace.id))
    ).toHaveLength(1)

    const reopened = await reopenWorkspace(connection.db, workspace.id, principal)
    expect(reopened).toMatchObject({ id: workspace.id, canArchive: true, canDelete: true })
    expect(await listArchivedWorkspacesForOwner(connection.db, principal)).toEqual([])
  })

  test('the personal root keeps its identity through a rename and never offers archive or deletion', async () => {
    const { principal } = await guest()
    const [home] = await ensureBootstrapWorkspaces(connection.db, principal)
    const renamed = await updateWorkspace(connection.db, home!.id, principal, {
      expectedVersion: home!.version,
      update: { name: 'Studio' },
    })
    expect(renamed).toMatchObject({
      id: home!.id,
      name: 'Studio',
      isPersonal: true,
      canArchive: false,
      canDelete: false,
    })
    const roots = await connection.db
      .select({ id: workspaces.id, isPersonal: workspaces.isPersonal })
      .from(workspaces)
      .where(and(eq(workspaces.ownerUserId, principal.userId), eq(workspaces.isPersonal, true)))
    expect(roots).toEqual([{ id: home!.id, isPersonal: true }])
  })

  test('legacy migration preserves renamed/custom Home, Work, memberships, order and project IDs', async () => {
    const { principal } = await guest()
    const home = (
      await createWorkspaceWithOwner(connection.db, {
        owner: principal,
        idempotencyKey: 'default-home',
        name: 'Custom personal',
        scene: 'work',
      })
    ).workspace
    const work = (
      await createWorkspaceWithOwner(connection.db, {
        owner: principal,
        idempotencyKey: 'default-work',
        name: 'Old team',
        scene: 'work',
      })
    ).workspace
    await updateWorkspace(connection.db, home.id, principal, {
      expectedVersion: home.version,
      update: { logo: { kind: 'emoji', value: '🌻' }, accent: 'amber' },
    })
    const [project] = await connection.db
      .insert(projects)
      .values({
        workspaceId: home.id,
        name: 'Retained project',
        iconKey: 'folder',
        controlPlaneProjectId: mintControlPlaneIdentifier('prj'),
      })
      .returning()
    await connection.db
      .update(workspaceMemberships)
      .set({ sortOrder: 7 })
      .where(eq(workspaceMemberships.workspaceId, home.id))
    const result = await ensureBootstrapWorkspaces(connection.db, principal)
    expect(result.map(({ id }) => id)).toEqual([home.id, work.id])
    const personal = result.find((workspace) => workspace.isPersonal)!
    expect(personal).toMatchObject({
      id: home.id,
      name: 'Custom personal',
      logo: { kind: 'emoji', value: '🌻' },
      accent: 'amber',
      scene: 'work',
      sortOrder: 7,
      canDelete: false,
    })
    expect(result.find((workspace) => workspace.id === work.id)).toEqual(work)
    expect(
      await connection.db.select().from(projects).where(eq(projects.id, project!.id))
    ).toHaveLength(1)
    expect(await ensureBootstrapWorkspaces(connection.db, principal)).toEqual(result)
  })

  test('the SQL backfill uses stable metadata, restores an archived legacy root, and is idempotent', async () => {
    const { principal } = await guest()
    const legacy = (
      await createWorkspaceWithOwner(connection.db, {
        owner: principal,
        idempotencyKey: 'default',
        name: 'Renamed original',
        scene: 'work',
      })
    ).workspace
    const ordinaryHome = (
      await createWorkspaceWithOwner(connection.db, {
        owner: principal,
        idempotencyKey: crypto.randomUUID(),
        name: 'Home',
      })
    ).workspace
    await connection.db
      .update(workspaces)
      .set({ logoKind: 'emoji', logoValue: '🌲', accent: 'green', deletedAt: new Date() })
      .where(eq(workspaces.id, legacy.id))
    const migration = readFileSync(
      new URL('../../drizzle/0041_personal-workspaces.sql', import.meta.url),
      'utf8'
    )
    const backfill = migration.slice(migration.indexOf('WITH personal_candidates AS'))
    await connection.db.execute(sql.raw(backfill))
    const first = await getWorkspaceForUser(connection.db, legacy.id, principal)
    expect(first).toMatchObject({
      name: 'Renamed original',
      scene: 'work',
      isPersonal: true,
      canDelete: false,
      logo: { kind: 'emoji', value: '🌲' },
      accent: 'green',
    })
    await connection.db.execute(sql.raw(backfill))
    expect(await getWorkspaceForUser(connection.db, legacy.id, principal)).toEqual(first)
    expect(await getWorkspaceForUser(connection.db, ordinaryHome.id, principal)).toEqual(
      ordinaryHome
    )
    expect(
      (await ensureBootstrapWorkspaces(connection.db, principal)).filter(
        (workspace) => workspace.isPersonal
      )
    ).toHaveLength(1)
  })

  test('ambiguous claimed Home and Work names are preserved, and receive a separate root exactly once', async () => {
    const { principal } = await guest()
    const existing = []
    for (const name of ['Home', 'Work'])
      existing.push(
        (
          await createWorkspaceWithOwner(connection.db, {
            owner: principal,
            idempotencyKey: `claimed:${crypto.randomUUID()}`,
            name,
          })
        ).workspace
      )
    const initial = await ensureBootstrapWorkspaces(connection.db, principal)
    expect(initial).toHaveLength(3)
    expect(initial.slice(1)).toEqual(existing)
    expect(initial[0]).toMatchObject({
      name: 'Home',
      isPersonal: true,
      logo: { kind: 'home' },
      canDelete: false,
    })
    expect(await ensureBootstrapWorkspaces(connection.db, principal)).toEqual(initial)
  })

  for (const claimPath of ['identity', 'principal'] as const) {
    test(`claim via ${claimPath} preserves the account root and guest content with exactly one personal identity`, async () => {
      const account = await registered()
      const temporary = await guest()
      const [accountHome] = await ensureBootstrapWorkspaces(connection.db, account.principal)
      const [guestHome] = await ensureBootstrapWorkspaces(connection.db, temporary.principal)
      const renamed = await updateWorkspace(connection.db, guestHome!.id, temporary.principal, {
        expectedVersion: guestHome!.version,
        update: { name: 'Guest studio', logo: { kind: 'emoji', value: '🎨' } },
      })
      const [project] = await connection.db
        .insert(projects)
        .values({
          workspaceId: renamed.id,
          name: 'Guest work',
          iconKey: 'folder',
          controlPlaneProjectId: mintControlPlaneIdentifier('prj'),
        })
        .returning()
      const claim = () =>
        claimPath === 'identity'
          ? claimTemporaryUserSession(connection.db, {
              credentialDigest: temporary.credentialDigest,
              identity: account.identity,
            })
          : claimTemporaryUserSessionForUser(connection.db, {
              credentialDigest: temporary.credentialDigest,
              target: account.principal,
            })
      expect(await claim()).toEqual(account.principal)
      expect(await claim()).toEqual(account.principal)
      const result = await ensureBootstrapWorkspaces(connection.db, account.principal)
      expect(result).toHaveLength(2)
      expect(
        result.filter((workspace) => workspace.isPersonal).map((workspace) => workspace.id)
      ).toEqual([accountHome!.id])
      expect(result[1]).toMatchObject({
        id: renamed.id,
        name: 'Guest studio',
        logo: renamed.logo,
        canDelete: true,
        isPersonal: false,
      })
      expect(
        await connection.db.select().from(projects).where(eq(projects.id, project!.id))
      ).toHaveLength(1)
    })
  }

  test('a first-time sign-in retains the guest personal workspace ID and custom settings', async () => {
    const temporary = await guest()
    const [home] = await ensureBootstrapWorkspaces(connection.db, temporary.principal)
    const renamed = await updateWorkspace(connection.db, home!.id, temporary.principal, {
      expectedVersion: home!.version,
      update: { name: 'Mine', accent: 'cyan' },
    })
    const principal = await claimTemporaryUserSession(connection.db, {
      credentialDigest: temporary.credentialDigest,
      identity: { provider: 'neon', subject: crypto.randomUUID() },
    })
    expect(principal).toEqual(temporary.principal)
    expect(await ensureBootstrapWorkspaces(connection.db, principal)).toEqual([renamed])
  })

  test('the database rejects a second personal root and pending/archive flags on the root', async () => {
    const { principal } = await guest()
    const [home] = await ensureBootstrapWorkspaces(connection.db, principal)
    const additional = (
      await createWorkspaceWithOwner(connection.db, {
        owner: principal,
        idempotencyKey: crypto.randomUUID(),
        name: 'Additional',
      })
    ).workspace
    await expect(
      connection.db
        .update(workspaces)
        .set({ isPersonal: true })
        .where(eq(workspaces.id, additional.id))
        .execute()
        .catch((error) => {
          throw error.cause ?? error
        })
    ).rejects.toThrow('workspaces_personal_owner_unique')
    await expect(
      connection.db
        .update(workspaces)
        .set({ deletedAt: new Date() })
        .where(eq(workspaces.id, home!.id))
        .execute()
        .catch((error) => {
          throw error.cause ?? error
        })
    ).rejects.toThrow('workspaces_personal_active')
    await expect(
      connection.db
        .update(workspaces)
        .set({ deletionRequestedAt: new Date() })
        .where(eq(workspaces.id, home!.id))
        .execute()
        .catch((error) => {
          throw error.cause ?? error
        })
    ).rejects.toThrow('workspaces_personal_active')
    expect(
      (await listWorkspacesForUser(connection.db, principal)).filter(
        (workspace) => workspace.isPersonal
      )
    ).toHaveLength(1)
  })
})
