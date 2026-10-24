import { createHash } from 'node:crypto'

import { describe, expect, test } from 'bun:test'

import { simLaunchCodes, simSessions } from '../../src/schema'
import {
  bindSimLaunchStoreToWorkspace,
  createSimLaunchStore,
  findSimSession,
  findSimSessionContext,
  revokeSimSession,
  SIM_SURFACES,
} from '../../src/sim-launch-sessions'
import {
  recordingDatabase,
  renderSql,
  stepOf,
  trace,
  type Entry,
  type Statement,
} from '../fixtures/recording-database'

// The launch-code and session store against a recording double. The double proves what the store
// asks for and in what order: the issuance lock before the insert, the row lock before the spend,
// the spend before the binding checks, and the rollback when a session cannot be written. It cannot
// prove how PostgreSQL serializes any of that; the integration suite does, against a real database.
const WORKSPACE = '8f0c6a52-45f1-4e0b-a8d2-7c1d6f4a9b10'
const SHARED_LOCK = 'select pg_advisory_xact_lock_shared(hashtext($1), hashtext($2))'
const NOW = 1_800_000_000_000
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

const binding = {
  workspaceId: WORKSPACE,
  bridgeId: 'bridge-1',
  origin: 'https://sim.example',
  surface: 'hq',
} as const
const presented = { bridgeId: 'bridge-1', origin: 'https://sim.example' }

const codeRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'code-row',
  codeDigest: sha256('launch-code'),
  workspaceId: WORKSPACE,
  surface: 'room-designer',
  bridgeId: 'bridge-1',
  origin: 'https://sim.example',
  expiresAt: new Date(NOW + 60_000),
  consumedAt: null,
  ...overrides,
})

/** Answers the launch-code select with these rows, or the failure, and every other statement with none. */
const withCodes =
  (rows: unknown[], sessionInsert: unknown[] | Error = []) =>
  (statement: Statement): unknown[] | Error => {
    if (statement.table === simLaunchCodes && statement.op === 'select') return rows
    if (statement.table === simSessions && statement.op === 'insert') return sessionInsert
    return []
  }

/** The values and parameters the store wrote or rendered, as text, for checking a secret never appears. */
const sentText = (log: readonly unknown[]) =>
  JSON.stringify(
    (log as Entry[]).map((entry) =>
      'steps' in entry ? entry.steps.filter((step) => step.name === 'values') : entry
    )
  )

/** Answers every select with these rows and every other statement with none. */
const withSession = (rows: unknown[]) => (statement: Statement) =>
  statement.op === 'select' ? rows : []

const statementsOf = (log: readonly unknown[], op: Statement['op']) =>
  (log as Statement[]).filter((entry) => entry.op === op)

describe('issuing a launch code', () => {
  test('takes the shared issuance lock before the insert, in one transaction', async () => {
    const { database, log } = recordingDatabase()
    await createSimLaunchStore(database).issue('launch-code', binding, NOW + 1000)
    expect(trace(log)).toEqual([
      'transaction',
      `execute ${SHARED_LOCK}`,
      'insert sim_launch_codes',
      'commit',
    ])
    expect(log[1]).toMatchObject({ params: ['adea.sim-authority', WORKSPACE] })
  })

  test('stores only the digest of the code, with its binding and expiry', async () => {
    const { database, log } = recordingDatabase()
    await createSimLaunchStore(database).issue('launch-code', binding, NOW + 1000)
    const [insert] = statementsOf(log, 'insert')
    expect(stepOf(insert!, 'values')!.args).toEqual([
      {
        codeDigest: sha256('launch-code'),
        workspaceId: WORKSPACE,
        surface: 'hq',
        bridgeId: 'bridge-1',
        origin: 'https://sim.example',
        expiresAt: new Date(NOW + 1000),
      },
    ])
    expect(sentText(log)).not.toContain('launch-code')
  })

  test('a failed insert rolls the transaction back and the failure reaches the caller', async () => {
    const failure = new Error('insert failed')
    const { database, log } = recordingDatabase((statement) =>
      statement.op === 'insert' ? failure : []
    )
    await expect(createSimLaunchStore(database).issue('code', binding, NOW)).rejects.toBe(failure)
    expect(trace(log)).toEqual([
      'transaction',
      `execute ${SHARED_LOCK}`,
      'insert sim_launch_codes',
      'rollback',
    ])
  })

  test('an expiry that is not finite is refused before any statement runs', async () => {
    for (const expiresAt of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const { database, log } = recordingDatabase()
      await expect(
        createSimLaunchStore(database).issue('code', binding, expiresAt)
      ).rejects.toThrow(RangeError)
      expect(log).toEqual([])
    }
  })
})

describe('redeeming a launch code', () => {
  test('locks the code row by digest before anything else is decided', async () => {
    const { database, log } = recordingDatabase(withCodes([codeRow()]))
    await createSimLaunchStore(database, { clock: () => NOW }).redeem('launch-code', presented, NOW)
    const [select] = statementsOf(log, 'select')
    expect(stepOf(select!, 'for')!.args).toEqual(['update'])
    const { sql, params } = renderSql(stepOf(select!, 'where')!.args[0])
    expect(sql).toContain('"code_digest" = $1')
    expect(params).toEqual([sha256('launch-code')])
    expect(trace(log).slice(0, 2)).toEqual(['transaction', 'select sim_launch_codes +for'])
  })

  test('an unknown code spends nothing and answers unknown', async () => {
    const { database, log } = recordingDatabase(withCodes([]))
    const result = await createSimLaunchStore(database, { clock: () => NOW }).redeem(
      'launch-code',
      presented,
      NOW
    )
    expect(result).toEqual({ ok: false, reason: 'unknown' })
    expect(trace(log)).toEqual(['transaction', 'select sim_launch_codes +for', 'commit'])
  })

  test('a code that was already spent answers code_used and is not spent again', async () => {
    const { database, log } = recordingDatabase(
      withCodes([codeRow({ consumedAt: new Date(NOW - 1) })])
    )
    const result = await createSimLaunchStore(database, { clock: () => NOW }).redeem(
      'launch-code',
      presented,
      NOW
    )
    expect(result).toEqual({ ok: false, reason: 'code_used' })
    expect(statementsOf(log, 'update')).toEqual([])
  })

  test('a valid presentation spends the code with the clock read after the lock, and creates no session', async () => {
    const { database, log } = recordingDatabase(withCodes([codeRow()]))
    const result = await createSimLaunchStore(database, { clock: () => NOW + 5 }).redeem(
      'launch-code',
      presented,
      NOW
    )
    expect(result).toEqual({ ok: true, surface: 'room-designer' })
    expect(trace(log)).toEqual([
      'transaction',
      'select sim_launch_codes +for',
      'update sim_launch_codes',
      'commit',
    ])
    const [update] = statementsOf(log, 'update')
    expect(stepOf(update!, 'set')!.args).toEqual([{ consumedAt: new Date(NOW + 5) }])
    const { sql, params } = renderSql(stepOf(update!, 'where')!.args[0])
    expect(sql).toContain('"id" = $1')
    expect(params).toEqual(['code-row'])
  })

  test('an expiry decided by the post-lock clock answers code_expired and still spends the code', async () => {
    // The caller's `now` is still inside the window; the clock read after the lock is past it.
    const { database, log } = recordingDatabase(
      withCodes([codeRow({ expiresAt: new Date(NOW + 10) })])
    )
    const result = await createSimLaunchStore(database, { clock: () => NOW + 11 }).redeem(
      'launch-code',
      presented,
      NOW
    )
    expect(result).toEqual({ ok: false, reason: 'code_expired' })
    expect(trace(log)).toEqual([
      'transaction',
      'select sim_launch_codes +for',
      'update sim_launch_codes',
      'commit',
    ])
  })

  test('a code is expired at the instant it expires, and live a millisecond earlier', async () => {
    const expiresAt = new Date(NOW + 10)
    for (const [clock, ok] of [
      [NOW + 9, true],
      [NOW + 10, false],
    ] as const) {
      const { database } = recordingDatabase(withCodes([codeRow({ expiresAt })]))
      const result = await createSimLaunchStore(database, { clock: () => clock }).redeem(
        'launch-code',
        presented,
        NOW
      )
      expect(result.ok).toBe(ok)
    }
  })

  test('a different bridge or origin answers origin_refused, and the code is spent anyway', async () => {
    for (const other of [
      { bridgeId: 'bridge-2', origin: 'https://sim.example' },
      { bridgeId: 'bridge-1', origin: 'https://elsewhere.example' },
    ]) {
      const { database, log } = recordingDatabase(withCodes([codeRow()]))
      const result = await createSimLaunchStore(database, { clock: () => NOW }).redeemAndSave(
        'launch-code',
        other,
        NOW,
        { value: 'session-value', expiresAt: NOW + 1000 }
      )
      expect(result).toEqual({ ok: false, reason: 'origin_refused' })
      expect(trace(log)).toEqual([
        'transaction',
        'select sim_launch_codes +for',
        'update sim_launch_codes',
        'commit',
      ])
    }
  })

  test('a caller clock that is not finite spends nothing and opens no transaction', async () => {
    const { database, log } = recordingDatabase(withCodes([codeRow()]))
    const result = await createSimLaunchStore(database, { clock: () => NOW }).redeem(
      'launch-code',
      presented,
      Number.NaN
    )
    expect(result).toEqual({ ok: false, reason: 'code_expired' })
    expect(log).toEqual([])
  })

  test('a post-lock clock that is not finite spends nothing and answers code_expired', async () => {
    const { database, log } = recordingDatabase(withCodes([codeRow()]))
    const result = await createSimLaunchStore(database, { clock: () => Number.NaN }).redeem(
      'launch-code',
      presented,
      NOW
    )
    expect(result).toEqual({ ok: false, reason: 'code_expired' })
    expect(statementsOf(log, 'update')).toEqual([])
  })

  test('without a clock option the system clock decides expiry', async () => {
    const live = recordingDatabase(
      withCodes([codeRow({ expiresAt: new Date(Date.now() + 60_000) })])
    )
    expect((await createSimLaunchStore(live.database).redeem('launch-code', presented, 0)).ok).toBe(
      true
    )
    const old = recordingDatabase(withCodes([codeRow({ expiresAt: new Date(1000) })]))
    expect(await createSimLaunchStore(old.database).redeem('launch-code', presented, 0)).toEqual({
      ok: false,
      reason: 'code_expired',
    })
  })
})

describe('redeeming a launch code together with its session', () => {
  const session = { value: 'session-value', expiresAt: NOW + 3_600_000 }

  test('spends the code, then writes the session bound to the code row, in one transaction', async () => {
    const { database, log } = recordingDatabase(withCodes([codeRow()]))
    const result = await createSimLaunchStore(database, { clock: () => NOW }).redeemAndSave(
      'launch-code',
      presented,
      NOW,
      session
    )
    expect(result).toEqual({ ok: true, surface: 'room-designer' })
    expect(trace(log)).toEqual([
      'transaction',
      'select sim_launch_codes +for',
      'update sim_launch_codes',
      'insert sim_sessions',
      'commit',
    ])
    const [insert] = statementsOf(log, 'insert')
    expect(stepOf(insert!, 'values')!.args).toEqual([
      {
        sessionDigest: sha256('session-value'),
        launchCodeId: 'code-row',
        workspaceId: WORKSPACE,
        surface: 'room-designer',
        expiresAt: new Date(session.expiresAt),
      },
    ])
    expect(sentText(log)).not.toContain('session-value')
  })

  test('the session takes the workspace and surface stored on the code, never the caller', async () => {
    const other = codeRow({ workspaceId: 'cccccccc-0000-4000-8000-000000000000', surface: 'hq' })
    const { database, log } = recordingDatabase(withCodes([other]))
    await createSimLaunchStore(database, { clock: () => NOW }).redeemAndSave(
      'launch-code',
      presented,
      NOW,
      session
    )
    const [insert] = statementsOf(log, 'insert')
    expect(stepOf(insert!, 'values')!.args[0]).toMatchObject({
      workspaceId: 'cccccccc-0000-4000-8000-000000000000',
      surface: 'hq',
    })
  })

  test('refused presentations write no session', async () => {
    const cases = [
      withCodes([]),
      withCodes([codeRow({ consumedAt: new Date(NOW - 1) })]),
      withCodes([codeRow({ expiresAt: new Date(NOW - 1) })]),
    ]
    for (const answer of cases) {
      const { database, log } = recordingDatabase(answer)
      const result = await createSimLaunchStore(database, { clock: () => NOW }).redeemAndSave(
        'launch-code',
        presented,
        NOW,
        session
      )
      expect(result.ok).toBe(false)
      expect(statementsOf(log, 'insert')).toEqual([])
    }
  })

  test('a failed session insert rolls the spend back and the failure reaches the caller', async () => {
    const failure = new Error('session insert failed')
    const { database, log } = recordingDatabase(withCodes([codeRow()], failure))
    await expect(
      createSimLaunchStore(database, { clock: () => NOW }).redeemAndSave(
        'launch-code',
        presented,
        NOW,
        session
      )
    ).rejects.toBe(failure)
    expect(trace(log)).toEqual([
      'transaction',
      'select sim_launch_codes +for',
      'update sim_launch_codes',
      'insert sim_sessions',
      'rollback',
    ])
  })

  test('a session that cannot expire is refused before the transaction, so nothing is spent', async () => {
    const { database, log } = recordingDatabase(withCodes([codeRow()]))
    await expect(
      createSimLaunchStore(database, { clock: () => NOW }).redeemAndSave(
        'launch-code',
        presented,
        NOW,
        { value: 'session-value', expiresAt: Number.POSITIVE_INFINITY }
      )
    ).rejects.toThrow(RangeError)
    expect(log).toEqual([])
  })

  test('sessions are never saved apart from their code redemption', () => {
    const { database } = recordingDatabase()
    expect(() => createSimLaunchStore(database).save()).toThrow(
      'Sim sessions are saved only with their launch code redemption'
    )
  })
})

describe('binding a store to one workspace', () => {
  test('issues for the bound workspace, whatever else the caller passes', async () => {
    const { database, log } = recordingDatabase()
    const bound = bindSimLaunchStoreToWorkspace(createSimLaunchStore(database), WORKSPACE)
    await bound.issue(
      'launch-code',
      {
        bridgeId: 'bridge-1',
        origin: 'https://sim.example',
        surface: 'hq',
        workspaceId: 'other',
      } as never,
      NOW
    )
    const [insert] = statementsOf(log, 'insert')
    expect(stepOf(insert!, 'values')!.args[0]).toMatchObject({ workspaceId: WORKSPACE })
    expect(log[1]).toMatchObject({ params: ['adea.sim-authority', WORKSPACE] })
  })

  test('hands redemption and the refusing save through unchanged', () => {
    const { database } = recordingDatabase()
    const store = createSimLaunchStore(database)
    const bound = bindSimLaunchStoreToWorkspace(store, WORKSPACE)
    expect(bound.redeem).toBe(store.redeem)
    expect(bound.redeemAndSave).toBe(store.redeemAndSave)
    expect(bound.save).toBe(store.save)
  })

  test('refuses a workspace identifier outside the bridge grammar', () => {
    const { database } = recordingDatabase()
    const store = createSimLaunchStore(database)
    for (const bad of ['', 'has space', 'semi;colon', 'x'.repeat(129)])
      expect(() => bindSimLaunchStoreToWorkspace(store, bad)).toThrow(RangeError)
    expect(() => bindSimLaunchStoreToWorkspace(store, WORKSPACE)).not.toThrow()
  })

  test('the closed set of surfaces is the one the table allows', () => {
    expect([...SIM_SURFACES]).toEqual(['hq', 'room-designer', 'character-designer'])
  })
})

describe('reading and revoking sessions', () => {
  const sessionRow = {
    surface: 'character-designer',
    workspaceId: WORKSPACE,
    expiresAt: new Date(NOW + 1000),
  }

  test('a live session in this workspace is found, and the query is bounded by digest, workspace, revocation and expiry', async () => {
    const { database, log } = recordingDatabase(withSession([sessionRow]))
    expect(await findSimSession(database, 'session-value', WORKSPACE, NOW)).toEqual({
      surface: 'character-designer',
      expiresAt: NOW + 1000,
    })
    const [select] = statementsOf(log, 'select')
    const { sql, params } = renderSql(stepOf(select!, 'where')!.args[0])
    expect(sql).toContain('"session_digest" = $1')
    expect(sql).toContain('"workspace_id" = $2')
    expect(sql).toContain('"revoked_at" is null')
    expect(sql).toContain('"expires_at" > $3')
    expect(params).toEqual([sha256('session-value'), WORKSPACE, new Date(NOW).toISOString()])
    expect(stepOf(select!, 'limit')!.args).toEqual([1])
  })

  test('no row, or a clock that is not finite, finds nothing', async () => {
    const empty = recordingDatabase(withSession([]))
    expect(await findSimSession(empty.database, 'session-value', WORKSPACE, NOW)).toBeNull()
    const unusable = recordingDatabase(withSession([sessionRow]))
    expect(
      await findSimSession(unusable.database, 'session-value', WORKSPACE, Number.NaN)
    ).toBeNull()
    expect(unusable.log).toEqual([])
  })

  test('the context lookup returns the stored workspace and surface and takes none from the caller', async () => {
    const { database, log } = recordingDatabase(withSession([sessionRow]))
    expect(await findSimSessionContext(database, 'session-value', NOW)).toEqual({
      workspaceId: WORKSPACE,
      surface: 'character-designer',
      expiresAt: NOW + 1000,
    })
    const [select] = statementsOf(log, 'select')
    const { sql, params } = renderSql(stepOf(select!, 'where')!.args[0])
    expect(sql).not.toContain('"workspace_id"')
    expect(sql).toContain('"revoked_at" is null')
    expect(sql).toContain('"expires_at" > $2')
    expect(params).toEqual([sha256('session-value'), new Date(NOW).toISOString()])
  })

  test('the context lookup finds nothing for no row or an unusable clock', async () => {
    const empty = recordingDatabase(withSession([]))
    expect(await findSimSessionContext(empty.database, 'session-value', NOW)).toBeNull()
    const unusable = recordingDatabase(withSession([sessionRow]))
    expect(await findSimSessionContext(unusable.database, 'session-value', Number.NaN)).toBeNull()
    expect(unusable.log).toEqual([])
  })

  test('revoking a live session answers true and stamps the revocation time', async () => {
    const { database, log } = recordingDatabase((statement) =>
      statement.op === 'update' ? [{ id: 'session-row' }] : []
    )
    expect(await revokeSimSession(database, 'session-value', NOW)).toBe(true)
    const [update] = statementsOf(log, 'update')
    expect(stepOf(update!, 'set')!.args).toEqual([{ revokedAt: new Date(NOW) }])
    const { sql, params } = renderSql(stepOf(update!, 'where')!.args[0])
    expect(sql).toContain('"session_digest" = $1')
    expect(sql).toContain('"revoked_at" is null')
    expect(params).toEqual([sha256('session-value')])
  })

  test('revoking nothing live, or with an unusable clock, answers false', async () => {
    const none = recordingDatabase()
    expect(await revokeSimSession(none.database, 'session-value', NOW)).toBe(false)
    const unusable = recordingDatabase((statement) =>
      statement.op === 'update' ? [{ id: 'session-row' }] : []
    )
    expect(await revokeSimSession(unusable.database, 'session-value', Number.NaN)).toBe(false)
    expect(unusable.log).toEqual([])
  })
})
