import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { eq, sql } from 'drizzle-orm'

import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { controlPlaneScopeIds } from '../../src/control-plane-identifiers'
import { createTemporaryUserSession } from '../../src/identity'
import { createProject, softDeleteProject } from '../../src/projects'
import { projects, users, workspaces } from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL
const WORKSPACE_ID = /^wsp_[0-9A-HJKMNP-TV-Z]{26}$/u
const PROJECT_ID = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/u

describe.skipIf(!connectionUrl)('Control Plane scope identifiers (ADR 0013)', () => {
  let connection: DatabaseConnection

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })

  afterAll(async () => {
    await connection.close()
  })

  async function owner() {
    return createTemporaryUserSession(connection.db, {
      credentialDigest: `cp-scope-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
  }

  test('mints distinct workspace and project scopes on create', async () => {
    const session = await owner()
    const first = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'cp-scope-a',
      name: 'Scope A',
      owner: session.principal,
    })
    const second = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'cp-scope-b',
      name: 'Scope B',
      owner: session.principal,
    })
    const project = await createProject(connection.db, first.workspace.id, session.principal, {
      iconKey: 'engineering',
      name: 'Engineering',
    })

    const firstScope = await controlPlaneScopeIds(connection.db, {
      workspaceId: first.workspace.id,
    })
    const secondScope = await controlPlaneScopeIds(connection.db, {
      workspaceId: second.workspace.id,
    })
    const projectScope = await controlPlaneScopeIds(connection.db, {
      projectId: project.id,
      workspaceId: first.workspace.id,
    })

    expect(firstScope?.workspaceId).toMatch(WORKSPACE_ID)
    expect(secondScope?.workspaceId).toMatch(WORKSPACE_ID)
    expect(firstScope?.workspaceId).not.toBe(secondScope?.workspaceId)
    expect(projectScope).toEqual({
      projectId: expect.stringMatching(PROJECT_ID),
      workspaceId: firstScope!.workspaceId,
    })
    // Never derived from the Adea UUID.
    expect(firstScope?.workspaceId.toLowerCase()).not.toContain(first.workspace.id.slice(0, 8))

    // An idempotent replay returns the same workspace and keeps its scope.
    const replay = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'cp-scope-a',
      name: 'Scope A',
      owner: session.principal,
    })
    expect(replay.created).toBe(false)
    expect(
      (await controlPlaneScopeIds(connection.db, { workspaceId: replay.workspace.id }))?.workspaceId
    ).toBe(firstScope!.workspaceId)
  })

  test('refuses a project from another workspace and deleted records', async () => {
    const session = await owner()
    const home = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'cp-scope-home',
      name: 'Home',
      owner: session.principal,
    })
    const work = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'cp-scope-work',
      name: 'Work',
      owner: session.principal,
    })
    const project = await createProject(connection.db, home.workspace.id, session.principal, {
      iconKey: 'design',
      name: 'Design',
    })

    expect(
      await controlPlaneScopeIds(connection.db, {
        projectId: project.id,
        workspaceId: work.workspace.id,
      })
    ).toBeNull()
    await softDeleteProject(connection.db, home.workspace.id, project.id, session.principal)
    expect(
      await controlPlaneScopeIds(connection.db, {
        projectId: project.id,
        workspaceId: home.workspace.id,
      })
    ).toBeNull()
    expect(
      await controlPlaneScopeIds(connection.db, { workspaceId: crypto.randomUUID() })
    ).toBeNull()
  })

  test('the database default mints a valid scope for any other insert path', async () => {
    const userId = crypto.randomUUID()
    await connection.db.insert(users).values({ id: userId })
    const [row] = await connection.db
      .insert(workspaces)
      .values({ idempotencyKey: 'direct', name: 'Direct', ownerUserId: userId })
      .returning()
    expect(row?.controlPlaneWorkspaceId).toMatch(WORKSPACE_ID)
    const [project] = await connection.db
      .insert(projects)
      .values({ iconKey: 'ops', name: 'Ops', workspaceId: row!.id })
      .returning()
    expect(project?.controlPlaneProjectId).toMatch(PROJECT_ID)
  })

  test('rejects malformed and duplicate scopes', async () => {
    const userId = crypto.randomUUID()
    await connection.db.insert(users).values({ id: userId })
    const [row] = await connection.db
      .insert(workspaces)
      .values({ idempotencyKey: 'constraints', name: 'Constraints', ownerUserId: userId })
      .returning()
    for (const value of [
      'wsp_01JABCDEF0123456789ABCDEFI', // I is not Crockford
      'prj_01JABCDEF0123456789ABCDEFG', // wrong prefix for a workspace
      'wsp_01jabcdef0123456789abcdefg', // lower case
      'wsp_01JABCDEF0123456789ABCDEF', // 25 characters
    ]) {
      const rejected = await connection.db
        .update(workspaces)
        .set({ controlPlaneWorkspaceId: value })
        .where(eq(workspaces.id, row!.id))
        .then(
          () => null,
          (error: unknown) => error
        )
      expect(rejected).toBeInstanceOf(Error)
    }
    const userId2 = crypto.randomUUID()
    await connection.db.insert(users).values({ id: userId2 })
    const duplicate = await connection.db
      .insert(workspaces)
      .values({
        controlPlaneWorkspaceId: row!.controlPlaneWorkspaceId,
        idempotencyKey: 'duplicate',
        name: 'Duplicate',
        ownerUserId: userId2,
      })
      .then(
        () => null,
        (error: unknown) => error
      )
    expect(duplicate).toBeInstanceOf(Error)
  })

  test('the migration backfill gives every existing row its own valid scope', async () => {
    // Migration 0033 adds the column with the volatile identifier default, so
    // PostgreSQL evaluates it per existing row. Replay that exact mechanism on
    // a scratch table holding pre-existing rows.
    const rows = await connection.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`create temporary table cp_backfill (id int primary key) on commit drop`
      )
      await transaction.execute(sql`insert into cp_backfill select generate_series(1, 500)`)
      await transaction.execute(
        sql`alter table cp_backfill add column control_plane_workspace_id text default app.control_plane_identifier('wsp') not null`
      )
      return transaction.execute<{ control_plane_workspace_id: string }>(
        sql`select control_plane_workspace_id from cp_backfill`
      )
    })
    const values = [...rows].map((row) => row.control_plane_workspace_id)
    expect(values).toHaveLength(500)
    expect(new Set(values).size).toBe(500)
    for (const value of values) expect(value).toMatch(WORKSPACE_ID)
  })

  test('the SQL generator refuses unknown prefixes', async () => {
    const failure = await connection.db
      .execute(sql`select app.control_plane_identifier('usr')`)
      .then(
        () => null,
        (error: unknown) => error
      )
    expect(failure).toBeInstanceOf(Error)
  })
})
