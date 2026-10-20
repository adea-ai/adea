import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, inArray, sql } from 'drizzle-orm'

import { createDatabase, type DatabaseConnection } from '../../src/connection'
import {
  bindSimLaunchStoreToWorkspace,
  createSimLaunchStore,
  findSimSession,
  findSimSessionContext,
  revokeSimSession,
  type SimLaunchBinding,
} from '../../src/sim-launch-sessions'
import { simLaunchCodes, simSessions } from '../../src/schema'
import {
  createSimIssuerStores,
  createSimRedemptionStore,
  createSimSessionLookup,
} from '../../src/sim-launch-ports'

const connectionUrl = process.env.DATABASE_URL

const unique = () => crypto.randomUUID()

/** A one-shot signal: `open` resolves `promise`, and `fail` rejects it. */
const noop = () => undefined
const latch = () => {
  let open = noop
  let fail: (error: unknown) => void = noop
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve
    fail = reject
  })
  return { promise, open: () => open(), fail: (error: unknown) => fail(error) }
}

/** Resolves once another backend in this database is waiting on a lock, so a redemption is parked behind the holder. */
const waitForLockWaiter = async (database: DatabaseConnection['db']) => {
  for (let poll = 0; poll < 500; poll += 1) {
    const rows = await database.execute<{ waiting: number }>(
      sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`
    )
    if (rows[0]?.waiting) return
    await Bun.sleep(10)
  }
  throw new Error('the redemption never waited on the code row lock')
}

// Workspaces created by this suite, so its rows can be removed afterwards.
const createdWorkspaces = new Set<string>()

const binding = (overrides: Partial<SimLaunchBinding> = {}): SimLaunchBinding => {
  const workspaceId = `ws-${unique()}`
  createdWorkspaces.add(workspaceId)
  return {
    workspaceId,
    bridgeId: 'bridge-a',
    origin: 'https://sim.example',
    surface: 'room-designer',
    ...overrides,
  }
}

describe.skipIf(!connectionUrl)('durable Sim launch codes and sessions', () => {
  let connection: DatabaseConnection
  let store: ReturnType<typeof createSimLaunchStore>

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
    store = createSimLaunchStore(connection.db)
  })
  afterAll(async () => {
    try {
      // Sessions reference their launch codes, so they go first.
      const workspaceIds = [...createdWorkspaces]
      if (workspaceIds.length > 0) {
        await connection.db
          .delete(simSessions)
          .where(inArray(simSessions.workspaceId, workspaceIds))
        await connection.db
          .delete(simLaunchCodes)
          .where(inArray(simLaunchCodes.workspaceId, workspaceIds))
      }
    } finally {
      await connection.close()
    }
  })

  const presented = { bridgeId: 'bridge-a', origin: 'https://sim.example' }
  // Far enough ahead that a slow run cannot expire the suite's codes.
  const later = Date.now() + 10 * 60_000

  test('a redemption spends the code and saves a workspace-bound session in one step', async () => {
    const code = `code-${unique()}`
    const session = `session-${unique()}`
    const b = binding()
    await store.issue(code, b, later)

    const redeemed = await store.redeemAndSave(code, presented, Date.now(), {
      value: session,
      expiresAt: later,
    })
    expect(redeemed).toEqual({ ok: true, surface: 'room-designer' })

    expect(await findSimSession(connection.db, session, b.workspaceId, Date.now())).toEqual({
      surface: 'room-designer',
      expiresAt: later,
    })
    // The same session value is refused in every other workspace.
    expect(await findSimSession(connection.db, session, `ws-${unique()}`, Date.now())).toBeNull()
    // The raw code and session values are never stored, only their digests.
    const [stored] = await connection.db
      .select()
      .from(simLaunchCodes)
      .where(eq(simLaunchCodes.workspaceId, b.workspaceId))
    expect(stored?.codeDigest).not.toContain(code)
    expect(stored?.consumedAt).toBeInstanceOf(Date)
  })

  test('the first presentation spends the code, so a replay gets code_used', async () => {
    const code = `code-${unique()}`
    await store.issue(code, binding(), later)
    expect(await store.redeem(code, presented, Date.now())).toMatchObject({ ok: true })
    expect(await store.redeem(code, presented, Date.now())).toEqual({
      ok: false,
      reason: 'code_used',
    })
  })

  test('exactly one of many concurrent redemptions wins and saves one session', async () => {
    const code = `code-${unique()}`
    const b = binding()
    await store.issue(code, b, later)
    const attempts = Array.from({ length: 16 }, (_, index) =>
      store.redeemAndSave(code, presented, Date.now(), {
        value: `session-${unique()}-${index}`,
        expiresAt: later,
      })
    )
    const results = await Promise.all(attempts)
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok && result.reason === 'code_used')).toHaveLength(15)
    const sessions = await connection.db
      .select()
      .from(simSessions)
      .where(eq(simSessions.workspaceId, b.workspaceId))
    expect(sessions).toHaveLength(1)
  })

  test('a failed session save rolls the code spend back, so the code can still be redeemed', async () => {
    const b = binding()
    const taken = `session-${unique()}`
    const firstCode = `code-${unique()}`
    await store.issue(firstCode, b, later)
    await store.redeemAndSave(firstCode, presented, Date.now(), { value: taken, expiresAt: later })

    // The session value is already stored, so the insert fails on its unique digest.
    const retryCode = `code-${unique()}`
    await store.issue(retryCode, b, later)
    await expect(
      store.redeemAndSave(retryCode, presented, Date.now(), { value: taken, expiresAt: later })
    ).rejects.toThrow()

    const retried = await store.redeemAndSave(retryCode, presented, Date.now(), {
      value: `session-${unique()}`,
      expiresAt: later,
    })
    expect(retried).toEqual({ ok: true, surface: 'room-designer' })
  })

  test('an expired code is refused and its spend is kept', async () => {
    const code = `code-${unique()}`
    const past = Date.now() - 1_000
    await store.issue(code, binding(), past + 500)
    expect(await store.redeem(code, presented, past + 1_000)).toEqual({
      ok: false,
      reason: 'code_expired',
    })
    expect(await store.redeem(code, presented, past)).toEqual({ ok: false, reason: 'code_used' })
  })

  test('a presentation from another bridge or origin is refused and still spends the code', async () => {
    const code = `code-${unique()}`
    await store.issue(code, binding(), later)
    expect(
      await store.redeem(code, { bridgeId: 'bridge-b', origin: 'https://sim.example' }, Date.now())
    ).toEqual({ ok: false, reason: 'origin_refused' })
    expect(await store.redeem(code, presented, Date.now())).toEqual({
      ok: false,
      reason: 'code_used',
    })
  })

  test('an unknown code is refused without creating anything', async () => {
    expect(await store.redeem(`never-issued-${unique()}`, presented, Date.now())).toEqual({
      ok: false,
      reason: 'unknown',
    })
  })

  test('an unusable clock reading refuses the code without spending it', async () => {
    const code = `code-${unique()}`
    await store.issue(code, binding(), later)
    expect(await store.redeem(code, presented, Number.NaN)).toEqual({
      ok: false,
      reason: 'code_expired',
    })
    expect(await store.redeem(code, presented, Date.now())).toMatchObject({ ok: true })
  })

  test('a session stops resolving once it expires, and a revoked session stops resolving', async () => {
    const b = binding()
    const shortLived = `session-${unique()}`
    const revocable = `session-${unique()}`
    const soon = Date.now() + 5_000
    const code = `code-${unique()}`
    await store.issue(code, b, later)
    await store.redeemAndSave(code, presented, Date.now(), { value: shortLived, expiresAt: soon })
    const other = `code-${unique()}`
    await store.issue(other, b, later)
    await store.redeemAndSave(other, presented, Date.now(), { value: revocable, expiresAt: later })

    expect(await findSimSession(connection.db, shortLived, b.workspaceId, soon - 1)).not.toBeNull()
    expect(await findSimSession(connection.db, shortLived, b.workspaceId, soon)).toBeNull()

    expect(await revokeSimSession(connection.db, revocable, Date.now())).toBe(true)
    expect(await findSimSession(connection.db, revocable, b.workspaceId, Date.now())).toBeNull()
    expect(await revokeSimSession(connection.db, revocable, Date.now())).toBe(false)
  })

  test('a presentation that waits behind a lock re-reads the clock and refuses a code that expired meanwhile', async () => {
    let clockValue = Date.now()
    const timed = createSimLaunchStore(connection.db, { clock: () => clockValue })
    const b = binding()
    const code = `code-${unique()}`
    const session = `session-${unique()}`
    await timed.issue(code, b, clockValue + 1_000)

    // A holder takes the code row lock. Any failure to take it fails the test rather than hanging it.
    const acquired = latch()
    const released = latch()
    const holder = connection.db
      .transaction(async (tx) => {
        try {
          await tx
            .select()
            .from(simLaunchCodes)
            .where(eq(simLaunchCodes.workspaceId, b.workspaceId))
            .for('update')
        } catch (error) {
          acquired.fail(error)
          throw error
        }
        acquired.open()
        await released.promise
        // Rolling back releases the lock without writing anything.
        throw new Error('release the lock')
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.message === 'release the lock') return undefined
        throw error
      })

    try {
      await acquired.promise

      // The code is still live when the redemption starts, and it expires while the redemption waits.
      const attempt = timed.redeemAndSave(code, presented, clockValue, {
        value: session,
        expiresAt: clockValue + 60_000,
      })
      await waitForLockWaiter(connection.db)
      clockValue += 2_000
      released.open()

      expect(await attempt).toEqual({ ok: false, reason: 'code_expired' })
      const sessions = await connection.db
        .select()
        .from(simSessions)
        .where(eq(simSessions.workspaceId, b.workspaceId))
      expect(sessions).toHaveLength(0)
      expect(await findSimSession(connection.db, session, b.workspaceId, clockValue)).toBeNull()
      // The refusal still spends the code, as with any presentation that reaches the row.
      expect(await timed.redeem(code, presented, clockValue)).toEqual({
        ok: false,
        reason: 'code_used',
      })
    } finally {
      released.open()
      await holder
    }
  })

  test('a store bound to a verified workspace writes that workspace, whatever the presented binding says', async () => {
    const workspaceId = `ws-${unique()}`
    createdWorkspaces.add(workspaceId)
    const bound = bindSimLaunchStoreToWorkspace(store, workspaceId)
    const code = `code-${unique()}`
    const session = `session-${unique()}`
    await bound.issue(
      code,
      { bridgeId: 'bridge-a', origin: 'https://sim.example', surface: 'hq' },
      later
    )

    expect(
      await bound.redeemAndSave(code, presented, Date.now(), { value: session, expiresAt: later })
    ).toEqual({ ok: true, surface: 'hq' })
    expect(await findSimSession(connection.db, session, workspaceId, Date.now())).toEqual({
      surface: 'hq',
      expiresAt: later,
    })
    expect(await findSimSession(connection.db, session, `ws-${unique()}`, Date.now())).toBeNull()
  })

  test('the bound store ignores a workspaceId smuggled in with the binding', async () => {
    const workspaceId = `ws-${unique()}`
    createdWorkspaces.add(workspaceId)
    const bound = bindSimLaunchStoreToWorkspace(store, workspaceId)
    const code = `code-${unique()}`
    const session = `session-${unique()}`
    const conflicting = `ws-${unique()}`
    createdWorkspaces.add(conflicting)
    // The runtime object carries a conflicting workspace id. The verified one must win.
    const smuggled = {
      bridgeId: 'bridge-a',
      origin: 'https://sim.example',
      surface: 'hq',
      workspaceId: conflicting,
    } as Omit<SimLaunchBinding, 'workspaceId'>
    await bound.issue(code, smuggled, later)

    expect(
      await bound.redeemAndSave(code, presented, Date.now(), { value: session, expiresAt: later })
    ).toEqual({ ok: true, surface: 'hq' })
    expect(await findSimSession(connection.db, session, workspaceId, Date.now())).not.toBeNull()
    expect(await findSimSession(connection.db, session, conflicting, Date.now())).toBeNull()
  })

  test('the value-only resolver returns the workspace and surface stored on the row and refuses unusable lookups', async () => {
    const workspaceId = `ws-${unique()}`
    createdWorkspaces.add(workspaceId)
    const bound = bindSimLaunchStoreToWorkspace(store, workspaceId)
    const code = `code-${unique()}`
    const session = `session-${unique()}`
    await bound.issue(
      code,
      { bridgeId: 'bridge-a', origin: 'https://sim.example', surface: 'character-designer' },
      later
    )
    expect(
      await bound.redeemAndSave(code, presented, Date.now(), { value: session, expiresAt: later })
    ).toEqual({ ok: true, surface: 'character-designer' })
    expect(await findSimSessionContext(connection.db, session, Date.now())).toEqual({
      workspaceId,
      surface: 'character-designer',
      expiresAt: later,
    })

    // A session that expires resolves until its expiry instant, then stops.
    const expiring = `session-${unique()}`
    const soon = Date.now() + 5_000
    const expiringCode = `code-${unique()}`
    await bound.issue(
      expiringCode,
      { bridgeId: 'bridge-a', origin: 'https://sim.example', surface: 'hq' },
      later
    )
    await bound.redeemAndSave(expiringCode, presented, Date.now(), {
      value: expiring,
      expiresAt: soon,
    })
    expect(await findSimSessionContext(connection.db, expiring, soon - 1)).not.toBeNull()
    expect(await findSimSessionContext(connection.db, expiring, soon)).toBeNull()

    // Unknown values and a non-finite clock resolve to nothing, and so does a session at its expiry.
    expect(await findSimSessionContext(connection.db, `session-${unique()}`, Date.now())).toBeNull()
    expect(await findSimSessionContext(connection.db, session, Number.NaN)).toBeNull()
    expect(await findSimSessionContext(connection.db, session, later)).toBeNull()

    // A revoked session stops resolving.
    expect(await revokeSimSession(connection.db, session, Date.now())).toBe(true)
    expect(await findSimSessionContext(connection.db, session, Date.now())).toBeNull()
  })

  test('a bound store refuses a workspace identifier outside the database shape', () => {
    expect(() => bindSimLaunchStoreToWorkspace(store, '')).toThrow('not a valid identifier')
    expect(() => bindSimLaunchStoreToWorkspace(store, 'ws with space')).toThrow(
      'not a valid identifier'
    )
    expect(() => bindSimLaunchStoreToWorkspace(store, 'x'.repeat(129))).toThrow(
      'not a valid identifier'
    )
  })

  test('a separate session save is refused, so sessions exist only with a redemption', () => {
    expect(() => store.save()).toThrow('saved only with their launch code redemption')
  })

  test('the durable adapters compose an issuer store and a hosted session lookup', async () => {
    const workspaceId = `ws-${unique()}`
    createdWorkspaces.add(workspaceId)
    const code = `code-${unique()}`
    const session = `session-${unique()}`

    // The issuer writes the code through a store bound to the verified workspace.
    const issuerStores = createSimIssuerStores(connection.db)
    await issuerStores(workspaceId).issue(
      code,
      { bridgeId: 'bridge-a', origin: 'https://sim.example', surface: 'hq' },
      later
    )

    // The hosted service redeems with the unbound store: the stored row carries the workspace.
    const redemption = createSimRedemptionStore(connection.db)
    expect(
      await redemption.redeemAndSave(code, presented, Date.now(), {
        value: session,
        expiresAt: later,
      })
    ).toEqual({ ok: true, surface: 'hq' })
    expect(() =>
      redemption.issue(
        code,
        { bridgeId: 'bridge-a', origin: 'https://sim.example', surface: 'hq' },
        later
      )
    ).toThrow('only the Adea backend issues them')

    // The private asset gate reads the workspace and the surface from the stored row.
    const lookup = createSimSessionLookup(connection.db)
    expect(await lookup(session)).toEqual({ workspaceId, surface: 'hq', expiresAt: later })
    expect(await lookup(`session-${unique()}`)).toBeNull()
  })

  test('the durable adapters refuse an unusable workspace and never issue from the hosted service', () => {
    // The issuer store is bound to the verified workspace, so an identifier outside the database
    // shape is refused rather than written.
    const issuerStores = createSimIssuerStores(connection.db)
    expect(() => issuerStores('')).toThrow('not a valid identifier')
    expect(() => issuerStores('ws with space')).toThrow('not a valid identifier')
    expect(() => issuerStores('x'.repeat(129))).toThrow('not a valid identifier')

    // The hosted service redeems codes; issuing them is the Adea backend's job alone.
    const redemption = createSimRedemptionStore(connection.db)
    expect(() =>
      redemption.issue(
        `code-${unique()}`,
        { bridgeId: 'bridge-a', origin: 'https://sim.example', surface: 'hq' },
        later
      )
    ).toThrow('only the Adea backend issues them')
  })
})
