import { describe, expect, test } from 'bun:test'

import { simLaunchCodes, simSessions, simWorkspaceAllowlist, workspaces } from '../../src/schema'
import {
  createSimAllowlistLookup,
  grantSimAllowlist,
  revokeSimAllowlist,
  SimAllowlistWorkspaceUnavailableError,
  withdrawSimAccess,
} from '../../src/sim-allowlist'
import {
  recordingDatabase,
  renderSql,
  stepOf,
  trace,
  type Statement,
} from '../fixtures/recording-database'

// The allowlist store against a recording double. The double proves what the store asks for and in
// what order: which workspace row it locks, when it takes the authority lock, what it ends and in
// which sequence. It cannot prove how PostgreSQL honours any of that; the integration suite does,
// against a real database, including the in-flight races.
const WORKSPACE = '8f0c6a52-45f1-4e0b-a8d2-7c1d6f4a9b10'
const LOCK = 'select pg_advisory_xact_lock(hashtext($1), hashtext($2))'

/** Answers per table; anything not listed answers no rows. */
const answers =
  (byTable: Map<unknown, unknown[] | Error>) =>
  (statement: Statement): unknown[] | Error =>
    byTable.get(statement.table) ?? []

const lookupScope = { workspaceId: WORKSPACE, surface: 'hq' }

describe('the allowlist lookup', () => {
  test('a row for the workspace and surface answers true, and no row answers false', async () => {
    const present = recordingDatabase(answers(new Map([[simWorkspaceAllowlist, [{ id: 'row' }]]])))
    expect(await createSimAllowlistLookup(present.database)(lookupScope)).toBe(true)
    expect(trace(present.log)).toEqual(['select sim_workspace_allowlist'])

    const absent = recordingDatabase()
    expect(await createSimAllowlistLookup(absent.database)(lookupScope)).toBe(false)
  })

  test('the query is scoped to exactly this workspace and surface', async () => {
    const { database, log } = recordingDatabase()
    await createSimAllowlistLookup(database)({
      workspaceId: WORKSPACE.toUpperCase(),
      surface: 'hq',
    })
    const [select] = log as Statement[]
    const { sql, params } = renderSql(stepOf(select!, 'where')!.args[0])
    expect(sql).toContain('"workspace_id" = $1')
    expect(sql).toContain('"surface" = $2')
    expect(params).toEqual([WORKSPACE.toUpperCase(), 'hq'])
    expect(stepOf(select!, 'limit')!.args).toEqual([1])
  })

  test('a database failure is thrown, never answered as false', async () => {
    const { database } = recordingDatabase(
      answers(new Map([[simWorkspaceAllowlist, new Error('database down')]]))
    )
    await expect(createSimAllowlistLookup(database)(lookupScope)).rejects.toThrow('database down')
  })
})

describe('granting', () => {
  const found = new Map<unknown, unknown[] | Error>([
    [workspaces, [{ id: WORKSPACE }]],
    [simWorkspaceAllowlist, [{ id: 'row' }]],
  ])

  test('a grant that adds a row locks the workspace, inserts, then ends the earlier authority', async () => {
    const { database, log } = recordingDatabase(answers(found))
    expect(await grantSimAllowlist(database, { workspaceId: WORKSPACE, surface: 'hq' })).toBe(true)
    expect(trace(log)).toEqual([
      'transaction',
      'select workspaces +for',
      'insert sim_workspace_allowlist',
      `execute ${LOCK}`,
      'update sim_launch_codes',
      'update sim_sessions',
      'commit',
    ])
    const [, select, insert] = log as Statement[]
    expect(stepOf(select!, 'for')!.args).toEqual(['share'])
    const { sql } = renderSql(stepOf(select!, 'where')!.args[0])
    expect(sql).toContain('"deleted_at" is null')
    expect(sql).toContain('"deletion_requested_at" is null')
    expect(stepOf(insert!, 'values')!.args).toEqual([{ workspaceId: WORKSPACE, surface: 'hq' }])
    expect(stepOf(insert!, 'onConflictDoNothing')).toBeDefined()
  })

  test('the clean slate is limited to the granted surface', async () => {
    const { database, log } = recordingDatabase(answers(found))
    await grantSimAllowlist(database, { workspaceId: WORKSPACE, surface: 'room-designer' })
    const updates = (log as Statement[]).filter((entry) => entry.op === 'update')
    expect(updates).toHaveLength(2)
    for (const update of updates) {
      const { sql, params } = renderSql(stepOf(update, 'where')!.args[0])
      expect(sql).toContain('"surface" = ')
      expect(params).toContain('room-designer')
    }
  })

  test('a grant that was already present ends nothing', async () => {
    const present = new Map(found)
    present.set(simWorkspaceAllowlist, [])
    const { database, log } = recordingDatabase(answers(present))
    expect(await grantSimAllowlist(database, { workspaceId: WORKSPACE, surface: 'hq' })).toBe(false)
    expect(trace(log)).toEqual([
      'transaction',
      'select workspaces +for',
      'insert sim_workspace_allowlist',
      'commit',
    ])
  })

  test('a missing, archived or deletion-pending workspace is refused before anything is written', async () => {
    const { database, log } = recordingDatabase()
    await expect(
      grantSimAllowlist(database, { workspaceId: WORKSPACE, surface: 'hq' })
    ).rejects.toThrow(SimAllowlistWorkspaceUnavailableError)
    expect(trace(log)).toEqual(['transaction', 'select workspaces +for', 'rollback'])
  })

  test('a failure while ending the authority rolls the grant back', async () => {
    const failing = new Map(found)
    failing.set(simSessions, new Error('sessions unavailable'))
    const { database, log } = recordingDatabase(answers(failing))
    await expect(
      grantSimAllowlist(database, { workspaceId: WORKSPACE, surface: 'hq' })
    ).rejects.toThrow('sessions unavailable')
    expect(trace(log).at(-1)).toBe('rollback')
    expect(trace(log)).not.toContain('commit')
  })
})

describe('revoking one grant', () => {
  test('reports whether a row was removed, and ends nothing by itself', async () => {
    const removed = recordingDatabase(answers(new Map([[simWorkspaceAllowlist, [{ id: 'row' }]]])))
    expect(
      await revokeSimAllowlist(removed.database, { workspaceId: WORKSPACE, surface: 'hq' })
    ).toBe(true)
    expect(trace(removed.log)).toEqual(['delete sim_workspace_allowlist'])
    const [deletion] = removed.log as Statement[]
    const { sql, params } = renderSql(stepOf(deletion!, 'where')!.args[0])
    expect(sql).toContain('"workspace_id" = $1')
    expect(sql).toContain('"surface" = $2')
    expect(params).toEqual([WORKSPACE, 'hq'])

    const none = recordingDatabase()
    expect(await revokeSimAllowlist(none.database, { workspaceId: WORKSPACE, surface: 'hq' })).toBe(
      false
    )
  })
})

describe('withdrawing all access for a workspace', () => {
  const rows = new Map<unknown, unknown[] | Error>([
    [simWorkspaceAllowlist, [{ id: 'grant' }]],
    [simLaunchCodes, [{ id: 'code-1' }, { id: 'code-2' }]],
    [simSessions, [{ id: 'session-1' }]],
  ])

  test('it takes the authority lock first, then deletes grants, spends codes, and revokes sessions last', async () => {
    const { database, log } = recordingDatabase(answers(rows))
    const ended = await withdrawSimAccess(database, WORKSPACE)
    expect(ended).toEqual({ grants: 1, codes: 2, sessions: 1 })
    expect(trace(log)).toEqual([
      'transaction',
      'delete sim_workspace_allowlist',
      `execute ${LOCK}`,
      'update sim_launch_codes',
      'update sim_sessions',
      'commit',
    ])
  })

  test('only unspent codes and unrevoked sessions are touched, across every surface', async () => {
    const { database, log } = recordingDatabase(answers(rows))
    await withdrawSimAccess(database, WORKSPACE.toUpperCase())
    const [codes, sessions] = (log as Statement[]).filter((entry) => entry.op === 'update')
    const spent = renderSql(stepOf(codes!, 'where')!.args[0])
    expect(spent.sql).toContain('lower("app"."sim_launch_codes"."workspace_id") = $1')
    expect(spent.sql).toContain('"consumed_at" is null')
    expect(spent.sql).not.toContain('"surface"')
    expect(spent.params).toEqual([WORKSPACE])
    const revoked = renderSql(stepOf(sessions!, 'where')!.args[0])
    expect(revoked.sql).toContain('"revoked_at" is null')
    expect(Object.keys(stepOf(codes!, 'set')!.args[0] as object)).toEqual(['consumedAt'])
    expect(Object.keys(stepOf(sessions!, 'set')!.args[0] as object)).toEqual(['revokedAt'])
  })

  test('nothing to end answers zero for each', async () => {
    const { database } = recordingDatabase()
    expect(await withdrawSimAccess(database, WORKSPACE)).toEqual({
      grants: 0,
      codes: 0,
      sessions: 0,
    })
  })

  test('a failure part-way rolls the whole withdrawal back and is thrown', async () => {
    const failing = new Map(rows)
    failing.set(simSessions, new Error('sessions unavailable'))
    const { database, log } = recordingDatabase(answers(failing))
    await expect(withdrawSimAccess(database, WORKSPACE)).rejects.toThrow('sessions unavailable')
    expect(trace(log)).toEqual([
      'transaction',
      'delete sim_workspace_allowlist',
      `execute ${LOCK}`,
      'update sim_launch_codes',
      'update sim_sessions',
      'rollback',
    ])
  })

  test('inside a caller transaction it runs as a nested transaction of that one', async () => {
    const { database, log } = recordingDatabase(answers(rows))
    await database.transaction(async (outer) => {
      await withdrawSimAccess(outer, WORKSPACE)
    })
    expect(trace(log).filter((entry) => entry === 'transaction')).toHaveLength(2)
    expect(trace(log).at(-1)).toBe('commit')
  })
})
