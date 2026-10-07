import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, inArray, sql } from 'drizzle-orm'
import { readFileSync } from 'node:fs'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import {
  claimTemporaryUserSession,
  claimTemporaryUserSessionForUser,
  createTemporaryUserSession,
  createUserWithAuthIdentity,
} from '../../src/identity'
import {
  archiveWorkspace,
  beginWorkspaceDeletion,
  createWorkspaceWithOwner,
  deleteWorkspace,
  ensureBootstrapWorkspaces,
  getWorkspaceForUser,
  listWorkspacesForUser,
  reorderWorkspaces,
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
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import { mintControlPlaneIdentifier } from '../../src/control-plane-identifiers'

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

  test('additional workspaces have no seeded data, append below Home, and all remain reorderable', async () => {
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
    await reorderWorkspaces(connection.db, principal, [first.id, second.id, home!.id])
    for (const ids of [
      [first.id, first.id, home!.id],
      [first.id],
      [first.id, second.id, crypto.randomUUID()],
    ])
      await expect(reorderWorkspaces(connection.db, principal, ids)).rejects.toThrow(
        'Workspace order conflict'
      )
    const reordered = await ensureBootstrapWorkspaces(connection.db, principal)
    expect(reordered.map((workspace) => workspace.id)).toEqual([first.id, second.id, home!.id])
    expect(reordered.find((workspace) => workspace.isPersonal)?.id).toBe(home!.id)
    // Dispose only this additional fixture; production deletion is gated.
    await connection.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, first.id))
    await connection.db.delete(workspaces).where(eq(workspaces.id, first.id))
    expect(
      (await ensureBootstrapWorkspaces(connection.db, principal)).map((workspace) => workspace.id)
    ).toEqual([second.id, home!.id])
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
    ).toEqual([shared.id, memberHome!.id])
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
      new URL('../../drizzle/0040_personal-workspaces.sql', import.meta.url),
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
    expect(initial.slice(0, 2)).toEqual(existing)
    expect(initial[2]).toMatchObject({
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
