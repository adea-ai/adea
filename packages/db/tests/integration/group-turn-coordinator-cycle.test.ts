import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { UserPrincipalRef } from '@adea-ai/types'
import { and, eq, sql } from 'drizzle-orm'

import { createDatabase, type DatabaseConnection } from '../../src/connection'
import {
  cancelAddressedTurn,
  claimAddressedTurn,
  dispatchAddressedTurn,
  type AddressedTurnClaimInput,
} from '../../src/group-turn-coordinator'
import {
  createGroupChannelWithGrants,
  groupCreationCandidatesFromGrants,
  postGroupChannelMessage,
} from '../../src/group-channels'
import { ensureWorkspaceLead } from '../../src/agents'
import { createTemporaryUserSession } from '../../src/identity'
import * as schema from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL
const ISSUED = '2026-10-01T00:00:00.000Z'
const NOW = '2026-10-08T12:00:00.000Z'

/**
 * APPLICATION-LEVEL CYCLE REPRODUCTION (root-directed, adea-ai/adea#1247).
 * TESTS ONLY — no production file is touched.
 *
 * Corrected model: cancelAddressedTurn awaits requestLeadTurnCancellation
 * INSIDE its database.transaction callback, so the outer transaction keeps
 * holding the claim row lock while the nested transaction (separate
 * backend) waits on the channel row. The outer→nested edge is pure
 * JavaScript — idle-in-transaction, invisible to PostgreSQL — so the
 * deadlock detector can NEVER fire here and its absence proves nothing:
 * without outside intervention both sides park forever, with no 40P01.
 *
 * Cleanup contract (root-directed): every owned gate, task and backend id
 * is hoisted out of try so finally always sees it; finally releases JS
 * gates, cuts ONLY the owned backend's blocked statement when it is still
 * unsettled (pg_cancel_backend on the exact owned pid — never any other),
 * drains every owned task within bounds, then closes every owned pool. A
 * parked holder can therefore never hang pool close, even when an
 * observation or assertion fails first.
 */
function T(name: string, fn: () => Promise<void>) {
  test(name, fn, 30_000)
}

function claimInput(
  channelId: string,
  triggerMessageId: string,
  agentId: string,
  owner: UserPrincipalRef,
  extra: Partial<AddressedTurnClaimInput> = {}
): AddressedTurnClaimInput {
  return {
    addressedBy: owner,
    agentId,
    channelId,
    dispatchRevision: 1,
    triggerMessageId,
    ...extra,
  }
}

type LockWait = Readonly<{
  blockedBy: readonly number[]
  pid: number
  query: string
  state: string
}>

type BackendState = Readonly<{
  pid: number
  state: string
  waitEvent: string | null
}>

/** Lock-waiting backends with blocker pid chains (SQL evidence, not sleeps). */
async function lockWaits(observer: DatabaseConnection): Promise<readonly LockWait[]> {
  // Wide full-row selects push the FROM clause far right: keep 2000 chars
  // so table markers (`"app"."channels"`) are always visible.
  const rows = await observer.db.execute(sql`
    SELECT pid, state,
           left(query, 2000) AS query,
           (SELECT coalesce(array_agg(x), '{}')
              FROM unnest(pg_blocking_pids(pg_stat_activity.pid)) x) AS blocked_by
      FROM pg_stat_activity
     WHERE datname = current_database()
       AND pid <> pg_backend_pid()
       AND wait_event_type = 'Lock'
  `)
  return rows.map((row) => ({
    blockedBy: (row.blocked_by ?? []) as readonly number[],
    pid: row.pid as number,
    query: String(row.query ?? ''),
    state: String(row.state ?? ''),
  }))
}

async function backendState(
  observer: DatabaseConnection,
  pid: number
): Promise<BackendState | null> {
  const rows = await observer.db.execute(sql`
    SELECT pid, state, wait_event
      FROM pg_stat_activity
     WHERE pid = ${pid}
  `)
  const row = rows[0]
  if (!row) return null
  return {
    pid: row.pid as number,
    state: String(row.state ?? ''),
    waitEvent: row.wait_event == null ? null : String(row.wait_event),
  }
}

async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await check()) return
    if (Date.now() - start > 8000) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** SQLSTATE from a drizzle-wrapped driver error (code lives on cause). */
function abortCode(error: unknown): string {
  const cause =
    error && typeof error === 'object' && 'cause' in error
      ? (error as { cause?: unknown }).cause
      : null
  return (
    (error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : null) ??
    (cause && typeof cause === 'object' && 'code' in cause
      ? String((cause as { code?: unknown }).code)
      : 'unknown')
  )
}

/** Drain an owned task within bounds; never throws, never hangs the test. */
async function drainWithin(promise: Promise<unknown> | null, ms: number): Promise<void> {
  if (!promise) return
  promise.catch(() => {})
  await Promise.race([
    promise.then(
      () => undefined,
      () => undefined
    ),
    new Promise((resolve) => setTimeout(resolve, ms)),
  ])
}

/**
 * Bounded await for startup gates (parked promises): observes a startup
 * failure with a labeled error instead of waiting forever.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Bounded pool close: never hangs the test even with an open backend. */
async function closeBounded(pool: DatabaseConnection): Promise<void> {
  await Promise.race([
    pool.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ])
}

describe.skipIf(!connectionUrl)('coordinator application-cycle reproduction', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => connection.close())

  async function user(label: string): Promise<UserPrincipalRef> {
    return (
      await createTemporaryUserSession(connection.db, {
        credentialDigest: `cycle-repro-${label}-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000),
      })
    ).principal
  }

  async function leadGroup() {
    const owner = await user('owner')
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Cycle repro',
      owner,
    })
    const lead = await ensureWorkspaceLead(connection.db, workspace.id, owner)
    const channelId = crypto.randomUUID()
    await createGroupChannelWithGrants(connection.db, workspace.id, owner, {
      candidates: groupCreationCandidatesFromGrants(workspace.id, {
        audienceGrants: [
          {
            expiresAt: null,
            grantId: 'gra_owner',
            groupId: channelId,
            issuedAt: ISSUED,
            participant: owner,
            revision: 1,
            revokedAt: null,
          },
        ],
        enlistmentGrants: [
          {
            agent: { agentId: lead.id, workspaceId: workspace.id },
            expiresAt: null,
            grantId: 'gra_lead',
            groupId: channelId,
            issuedAt: ISSUED,
            revision: 1,
            revokedAt: null,
          },
        ],
      }),
      channelId,
      idempotencyKey: crypto.randomUUID(),
      now: NOW,
      title: 'Group',
    })
    const trigger = await postGroupChannelMessage(
      connection.db,
      workspace.id,
      channelId,
      owner,
      owner,
      {
        message: { bodyText: 'please answer', idempotencyKey: crypto.randomUUID() },
        mode: 'direct',
      },
      { now: NOW }
    )
    return { channelId, lead, owner, triggerMessageId: trigger.id, workspace }
  }

  T('cancel nests channel-wait inside a claim-holding transaction: cycle proven', async () => {
    // A dispatched claim (bound intent, no runtime row) so the nested
    // cancellation reaches the channel lock before failing fast.
    const f = await leadGroup()
    const input = claimInput(f.channelId, f.triggerMessageId, f.lead.id, f.owner)
    const pre = await claimAddressedTurn(connection.db, f.workspace.id, f.owner, input, {
      now: NOW,
    })
    expect(pre.status).toBe('claimed')
    const dispatched = await dispatchAddressedTurn(connection.db, f.workspace.id, f.owner, input, {
      now: NOW,
    })
    expect(dispatched.claim.status).toBe('duplicate')

    const holder = createDatabase(connectionUrl!)
    const canceller = createDatabase(connectionUrl!)
    const observer = createDatabase(connectionUrl!)
    let releaseHolder: (() => void) | null = null
    let holderPid = 0
    let holderCode: string | null = null
    let holderDone = false
    let holding: Promise<unknown> | null = null
    let cancelling: Promise<unknown> | null = null
    try {
      let holderParked!: () => void
      const holderGate = new Promise<void>((resolve) => {
        releaseHolder = resolve
      })
      const holderParkedPromise = new Promise<void>((resolve) => {
        holderParked = resolve
      })
      holding = (async () => {
        try {
          await holder.db.transaction(async (tx) => {
            // Owned backstop: any stuck SQL wait in this transaction
            // self-aborts with 57014 well inside the test ceiling.
            await tx.execute(sql`SET LOCAL statement_timeout = '10s'`)
            const [self] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`)
            holderPid = (self as { pid: number }).pid
            await tx
              .select({ id: schema.channels.id })
              .from(schema.channels)
              .where(
                and(
                  eq(schema.channels.id, f.channelId),
                  eq(schema.channels.workspaceId, f.workspace.id)
                )
              )
              .limit(1)
              .for('update')
            holderParked()
            await holderGate
            // After release: request the claim row. It is held by the
            // canceller's outer transaction, so this SELECT blocks —
            // closing the application-level cycle (proven, then cut).
            await tx
              .select({ id: schema.addressedAgentTurns.id })
              .from(schema.addressedAgentTurns)
              .where(eq(schema.addressedAgentTurns.id, dispatched.claim.turn.id))
              .limit(1)
              .for('update')
          })
          holderCode = 'committed'
        } catch (error) {
          holderCode = `aborted:${abortCode(error)}`
        }
        holderDone = true
      })()
      await withTimeout(holderParkedPromise, 8000, 'holderParked')

      // CANCELLER: real production cancel. Outer flips the claim
      // (uncommitted) and stays open across the nested intent-cancel,
      // which must then wait on the held channel row.
      cancelling = cancelAddressedTurn(
        canceller.db,
        f.workspace.id,
        f.owner,
        dispatched.claim.turn.id
      )
      // PROOF 1: a backend waits on the channel row, blocked by the
      // holder — the nested transaction inside the open outer one.
      let nestedPid = 0
      await waitFor(async () => {
        const waits = await lockWaits(observer)
        const nested = waits.find(
          (wait) => wait.query.includes('"channels"') && wait.blockedBy.includes(holderPid)
        )
        if (nested) nestedPid = nested.pid
        return nested !== undefined
      }, 'nested channel wait')
      // PROOF 2: the uncommitted flip is invisible to a separate
      // connection — the outer transaction is still open, holding the
      // claim lock while awaiting JavaScript.
      const [visible] = await observer.db
        .select({ state: schema.addressedAgentTurns.state })
        .from(schema.addressedAgentTurns)
        .where(eq(schema.addressedAgentTurns.id, dispatched.claim.turn.id))
        .limit(1)
      expect(visible?.state).toBe('dispatching')
      // PROOF 3: release the holder into the claim request and observe the
      // mutual wait — holder blocked by the canceller's outer backend
      // (idle-in-transaction: the JavaScript edge the detector cannot see),
      // nested still blocked by the holder. No 40P01 can fire on this
      // shape; both would park forever without intervention.
      releaseHolder()
      let holderBlockedBy: readonly number[] = []
      await waitFor(async () => {
        const waits = await lockWaits(observer)
        const holderWait = waits.find((wait) => wait.pid === holderPid)
        if (holderWait) holderBlockedBy = holderWait.blockedBy
        return holderWait !== undefined && holderWait.query.includes('"addressed_agent_turns"')
      }, 'holder claim wait')
      expect(holderBlockedBy.length).toBeGreaterThan(0)
      const outerPid = holderBlockedBy[0]!
      const outer = await backendState(observer, outerPid)
      expect(outer?.state).toBe('idle in transaction')
      const rechecked = await lockWaits(observer)
      expect(
        rechecked.some((wait) => wait.pid === nestedPid && wait.blockedBy.includes(holderPid))
      ).toBe(true)
      // Drain by cutting ONLY the owned holder backend's blocked statement
      // (test-local, bounded): it rolls back, the nested call fails fast
      // typed, and the outer cancel commits. The cut is deliberate, so the
      // observed code must be exactly 57014 — anything else (commit,
      // 40P01) would contradict the proven parked state.
      await observer.db.execute(sql`SELECT pg_cancel_backend(${holderPid})`)
      await drainWithin(holding, 5000)
      await drainWithin(cancelling, 5000)
      expect(holderCode).toBe('aborted:57014')
      await expect(cancelling).resolves.toEqual({
        runtimeCancelRequested: false,
        state: 'cancelled',
      })
      const [final] = await connection.db
        .select({ state: schema.addressedAgentTurns.state })
        .from(schema.addressedAgentTurns)
        .where(eq(schema.addressedAgentTurns.id, dispatched.claim.turn.id))
        .limit(1)
      expect(final?.state).toBe('cancelled')
    } finally {
      // Bounded reliable cleanup in strict order: release the JS gate
      // (lets a merely-parked holder commit), cut ONLY the owned backend
      // when it is still unsettled, drain owned tasks within bounds, then
      // close every owned pool. A parked holder can never hang close.
      releaseHolder?.()
      if (!holderDone && holderPid !== 0) {
        await observer.db.execute(sql`SELECT pg_cancel_backend(${holderPid})`).catch(() => {})
      }
      await drainWithin(holding, 5000)
      await drainWithin(cancelling, 5000)
      await closeBounded(holder)
      await closeBounded(canceller)
      await closeBounded(observer)
    }
  })

  T('admission waits on a held claim lock, then proceeds typed', async () => {
    // Mirror image with SQL-proven waits: the admission takes
    // channel-then-claim; a held claim makes it wait at the claim lock
    // (matched by its OWN holder pid, never any stray backend) and proceed
    // on rollback with exactly one bound intent.
    const f = await leadGroup()
    await connection.db
      .update(schema.agents)
      .set({ isWorkspaceLead: true })
      .where(eq(schema.agents.id, f.lead.id))
    const input = claimInput(f.channelId, f.triggerMessageId, f.lead.id, f.owner)
    const pre = await claimAddressedTurn(connection.db, f.workspace.id, f.owner, input, {
      now: NOW,
    })
    expect(pre.status).toBe('claimed')
    const holder = createDatabase(connectionUrl!)
    const runner = createDatabase(connectionUrl!)
    const observer = createDatabase(connectionUrl!)
    let releaseHolder: (() => void) | null = null
    let holderPid = 0
    let holderDone = false
    let holding: Promise<unknown> | null = null
    let dispatching: Promise<unknown> | null = null
    try {
      let holderParked!: () => void
      const holderGate = new Promise<void>((resolve) => {
        releaseHolder = resolve
      })
      const holderParkedPromise = new Promise<void>((resolve) => {
        holderParked = resolve
      })
      holding = (async () => {
        try {
          await holder.db.transaction(async (tx) => {
            // Owned backstop: any stuck SQL wait in this transaction
            // self-aborts with 57014 well inside the test ceiling.
            await tx.execute(sql`SET LOCAL statement_timeout = '10s'`)
            const [self] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`)
            holderPid = (self as { pid: number }).pid
            await tx
              .select({ id: schema.addressedAgentTurns.id })
              .from(schema.addressedAgentTurns)
              .where(eq(schema.addressedAgentTurns.id, pre.turn.id))
              .limit(1)
              .for('update')
            holderParked()
            await holderGate
          })
        } catch {
          // Rollback on release is the expected drain path here.
        }
        holderDone = true
      })()
      await withTimeout(holderParkedPromise, 8000, 'holderParked')
      dispatching = dispatchAddressedTurn(runner.db, f.workspace.id, f.owner, input, {
        now: NOW,
      })
      // Anchored on OUR holder pid (blocked_by), never any stray backend
      // waiting on the same table elsewhere in the database.
      await waitFor(async () => {
        const waits = await lockWaits(observer)
        return waits.some(
          (wait) =>
            wait.query.includes('"addressed_agent_turns"') && wait.blockedBy.includes(holderPid)
        )
      }, 'own-holder claim wait')
      releaseHolder()
      await drainWithin(holding, 5000)
      const done = (await dispatching) as { claim: { status: string } }
      expect(done.claim.status).toBe('duplicate')
      const [row] = await connection.db
        .select()
        .from(schema.addressedAgentTurns)
        .where(eq(schema.addressedAgentTurns.id, pre.turn.id))
        .limit(1)
      expect(row?.state).toBe('dispatching')
      expect(row?.intentId).not.toBeNull()
      const intents = await connection.db
        .select({ id: schema.leadTurnIntents.id })
        .from(schema.leadTurnIntents)
        .where(eq(schema.leadTurnIntents.channelId, f.channelId))
      expect(intents).toHaveLength(1)
    } finally {
      releaseHolder?.()
      if (!holderDone && holderPid !== 0) {
        await observer.db.execute(sql`SELECT pg_cancel_backend(${holderPid})`).catch(() => {})
      }
      await drainWithin(holding, 5000)
      await drainWithin(dispatching, 5000)
      await closeBounded(holder)
      await closeBounded(runner)
      await closeBounded(observer)
    }
  })

  T('terminal flip committed mid-wait denies admission with a typed reason', async () => {
    const f = await leadGroup()
    await connection.db
      .update(schema.agents)
      .set({ isWorkspaceLead: true })
      .where(eq(schema.agents.id, f.lead.id))
    const input = claimInput(f.channelId, f.triggerMessageId, f.lead.id, f.owner)
    const pre = await claimAddressedTurn(connection.db, f.workspace.id, f.owner, input, {
      now: NOW,
    })
    expect(pre.status).toBe('claimed')
    const holder = createDatabase(connectionUrl!)
    const runner = createDatabase(connectionUrl!)
    const observer = createDatabase(connectionUrl!)
    let releaseHolder: (() => void) | null = null
    let holderPid = 0
    let holderDone = false
    let holding: Promise<unknown> | null = null
    let dispatching: Promise<unknown> | null = null
    try {
      let holderParked!: () => void
      const holderGate = new Promise<void>((resolve) => {
        releaseHolder = resolve
      })
      const holderParkedPromise = new Promise<void>((resolve) => {
        holderParked = resolve
      })
      holding = (async () => {
        try {
          await holder.db.transaction(async (tx) => {
            // Owned backstop: any stuck SQL wait in this transaction
            // self-aborts with 57014 well inside the test ceiling.
            await tx.execute(sql`SET LOCAL statement_timeout = '10s'`)
            const [self] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`)
            holderPid = (self as { pid: number }).pid
            await tx
              .select({ id: schema.addressedAgentTurns.id })
              .from(schema.addressedAgentTurns)
              .where(eq(schema.addressedAgentTurns.id, pre.turn.id))
              .limit(1)
              .for('update')
            holderParked()
            await holderGate
            await tx
              .update(schema.addressedAgentTurns)
              .set({ state: 'cancelled' })
              .where(eq(schema.addressedAgentTurns.id, pre.turn.id))
          })
        } catch {
          // Release paths that cut the holder land here; the committed
          // path below is the expected one for this test.
        }
        holderDone = true
      })()
      await withTimeout(holderParkedPromise, 8000, 'holderParked')
      dispatching = dispatchAddressedTurn(runner.db, f.workspace.id, f.owner, input, {
        now: NOW,
      })
      // Own-holder match only: a stray backend waiting on the same table
      // must never satisfy this test.
      // Anchored on OUR holder pid (blocked_by), never any stray backend
      // waiting on the same table elsewhere in the database.
      await waitFor(async () => {
        const waits = await lockWaits(observer)
        return waits.some(
          (wait) =>
            wait.query.includes('"addressed_agent_turns"') && wait.blockedBy.includes(holderPid)
        )
      }, 'own-holder claim wait')
      releaseHolder()
      await drainWithin(holding, 5000)
      await expect(dispatching).rejects.toMatchObject({
        name: 'AddressedTurnError',
        reason: 'turn_cancelled',
      })
      const intents = await connection.db
        .select({ id: schema.leadTurnIntents.id })
        .from(schema.leadTurnIntents)
        .where(eq(schema.leadTurnIntents.channelId, f.channelId))
        .limit(10)
      expect(intents).toHaveLength(0)
    } finally {
      releaseHolder?.()
      if (!holderDone && holderPid !== 0) {
        await observer.db.execute(sql`SELECT pg_cancel_backend(${holderPid})`).catch(() => {})
      }
      await drainWithin(holding, 5000)
      await drainWithin(dispatching, 5000)
      await closeBounded(holder)
      await closeBounded(runner)
      await closeBounded(observer)
    }
  })

  T('mixed dispatch/post/cancel load settles with exact typed outcomes', async () => {
    // Workspace/member share-locks stay contention-free: every racy call
    // asserts its exact typed outcome — dispatch succeeds or loses to a
    // committed supersede, posts always succeed, cancels land typed. Any
    // 40P01, timeout code or unexpected reason fails loudly.
    const f = await leadGroup()
    await connection.db
      .update(schema.agents)
      .set({ isWorkspaceLead: true })
      .where(eq(schema.agents.id, f.lead.id))
    const runner = createDatabase(connectionUrl!)
    try {
      for (let round = 0; round < 3; round += 1) {
        const revision = 80 + round
        const claimed = await claimAddressedTurn(
          connection.db,
          f.workspace.id,
          f.owner,
          claimInput(f.channelId, f.triggerMessageId, f.lead.id, f.owner, {
            dispatchRevision: revision,
          }),
          { now: NOW }
        )
        expect(claimed.status).toBe('claimed')
        const results = await Promise.allSettled([
          dispatchAddressedTurn(
            connection.db,
            f.workspace.id,
            f.owner,
            claimInput(f.channelId, f.triggerMessageId, f.lead.id, f.owner, {
              dispatchRevision: revision,
            }),
            { now: NOW }
          ),
          postGroupChannelMessage(
            runner.db,
            f.workspace.id,
            f.channelId,
            f.owner,
            f.owner,
            {
              message: { bodyText: `race ${round}`, idempotencyKey: crypto.randomUUID() },
              mode: 'direct',
            },
            { now: NOW }
          ),
        ])
        const [dispatched, posted] = results
        expect(posted.status).toBe('fulfilled')
        if (dispatched.status === 'fulfilled') {
          expect(dispatched.value.claim.status).toBe('duplicate')
        } else {
          // The only legal loss: the concurrent post's supersede committed
          // first (the lead never changes here, budgets never fill).
          expect(dispatched.reason).toMatchObject({
            name: 'AddressedTurnError',
            reason: 'turn_superseded',
          })
        }
        // Cancellation lands on whatever state the race left: a live turn
        // cancels typed, a superseded one refuses with its exact code.
        const cancelOutcome = await cancelAddressedTurn(
          connection.db,
          f.workspace.id,
          f.owner,
          claimed.turn.id
        ).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ error, ok: false as const })
        )
        if (cancelOutcome.ok) {
          expect(cancelOutcome.value).toEqual({
            runtimeCancelRequested: false,
            state: 'cancelled',
          })
        } else {
          expect(cancelOutcome.error).toMatchObject({
            name: 'AddressedTurnError',
            reason: 'turn_superseded',
          })
        }
      }
    } finally {
      await closeBounded(runner)
    }
  })

  T('observer failure still releases parks and closes pools boundedly', async () => {
    // Injected-failure cleanup regression: the observer breaks mid-test,
    // yet the parked holder is released, every owned task drains within
    // bounds, every owned pool closes, and the suite can keep working.
    // Flags prove each stage ran; a hang would fail the 30s ceiling.
    const f = await leadGroup()
    const holder = createDatabase(connectionUrl!)
    const observer = createDatabase(connectionUrl!)
    let releaseHolder: (() => void) | null = null
    let holderDone = false
    let holding: Promise<unknown> | null = null
    let releasedFlag = false
    let drainedFlag = false
    try {
      let holderParked!: () => void
      const holderGate = new Promise<void>((resolve) => {
        releaseHolder = resolve
      })
      const holderParkedPromise = new Promise<void>((resolve) => {
        holderParked = resolve
      })
      holding = (async () => {
        try {
          await holder.db.transaction(async (tx) => {
            // Owned backstop: any stuck SQL wait in this transaction
            // self-aborts with 57014 well inside the test ceiling.
            await tx.execute(sql`SET LOCAL statement_timeout = '10s'`)
            await tx
              .select({ id: schema.channels.id })
              .from(schema.channels)
              .where(
                and(
                  eq(schema.channels.id, f.channelId),
                  eq(schema.channels.workspaceId, f.workspace.id)
                )
              )
              .limit(1)
              .for('update')
            holderParked()
            await holderGate
          })
        } catch {
          // Cuts land here; the parked path below is the expected one.
        }
        holderDone = true
      })()
      await withTimeout(holderParkedPromise, 8000, 'holderParked')
      // INJECTED FAILURE: the observer pool dies before any observation.
      await observer.close()
      let observedErr: unknown = null
      try {
        await lockWaits(observer)
      } catch (error) {
        observedErr = error
      }
      expect(observedErr).not.toBeNull()
    } finally {
      releaseHolder?.()
      releasedFlag = true
      // The observer is dead here by design; the holder was merely parked
      // on a JS gate (no SQL wait), so release alone drains it — bounded.
      await drainWithin(holding, 5000)
      drainedFlag = true
      await closeBounded(holder)
      await closeBounded(observer)
    }
    expect(releasedFlag).toBe(true)
    expect(drainedFlag).toBe(true)
    expect(holderDone).toBe(true)
    // The suite stays usable: a fresh pool connects and works.
    const fresh = createDatabase(connectionUrl!)
    try {
      const [one] = await fresh.db.execute(sql`SELECT 1 AS one`)
      expect((one as { one: number }).one).toBe(1)
    } finally {
      await closeBounded(fresh)
    }
  })

  T('injected mid-cycle failure still cuts, drains and closes boundedly', async () => {
    // Failure-cleanup regression: a REAL cycle is staged (holder waits the
    // claim held by an open cancel, nested waits the channel held by the
    // holder — both proven), then an injected failure skips the manual cut.
    // finally alone must release, cut the exact owned backend, drain and
    // close within bounds; flags prove each stage ran.
    const f = await leadGroup()
    const input = claimInput(f.channelId, f.triggerMessageId, f.lead.id, f.owner)
    const pre = await claimAddressedTurn(connection.db, f.workspace.id, f.owner, input, {
      now: NOW,
    })
    expect(pre.status).toBe('claimed')
    const dispatched = await dispatchAddressedTurn(connection.db, f.workspace.id, f.owner, input, {
      now: NOW,
    })
    expect(dispatched.claim.status).toBe('duplicate')
    const holder = createDatabase(connectionUrl!)
    const canceller = createDatabase(connectionUrl!)
    const observer = createDatabase(connectionUrl!)
    let releaseHolder: (() => void) | null = null
    let holderPid = 0
    let holderCode: string | null = null
    let holderDone = false
    let holding: Promise<unknown> | null = null
    let cancelling: Promise<unknown> | null = null
    let releasedFlag = false
    let cutFlag = false
    let drainedFlag = false
    try {
      let holderParked!: () => void
      const holderGate = new Promise<void>((resolve) => {
        releaseHolder = resolve
      })
      const holderParkedPromise = new Promise<void>((resolve) => {
        holderParked = resolve
      })
      holding = (async () => {
        try {
          await holder.db.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL statement_timeout = '10s'`)
            const [self] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`)
            holderPid = (self as { pid: number }).pid
            await tx
              .select({ id: schema.channels.id })
              .from(schema.channels)
              .where(
                and(
                  eq(schema.channels.id, f.channelId),
                  eq(schema.channels.workspaceId, f.workspace.id)
                )
              )
              .limit(1)
              .for('update')
            holderParked()
            await holderGate
            await tx
              .select({ id: schema.addressedAgentTurns.id })
              .from(schema.addressedAgentTurns)
              .where(eq(schema.addressedAgentTurns.id, dispatched.claim.turn.id))
              .limit(1)
              .for('update')
          })
          holderCode = 'committed'
        } catch (error) {
          holderCode = `aborted:${abortCode(error)}`
        }
        holderDone = true
      })()
      await withTimeout(holderParkedPromise, 8000, 'holderParked')
      cancelling = cancelAddressedTurn(
        canceller.db,
        f.workspace.id,
        f.owner,
        dispatched.claim.turn.id
      )
      cancelling.catch(() => {})
      await waitFor(async () => {
        const waits = await lockWaits(observer)
        return waits.some(
          (wait) => wait.query.includes('"channels"') && wait.blockedBy.includes(holderPid)
        )
      }, 'nested channel wait')
      releaseHolder()
      releasedFlag = true
      await waitFor(async () => {
        const waits = await lockWaits(observer)
        return waits.some((wait) => wait.pid === holderPid || wait.blockedBy.includes(holderPid))
      }, 'holder claim wait')
      // INJECTED FAILURE: the test dies here with the true cycle parked.
      // finally below is the only cleanup that runs.
      throw new Error('injected mid-cycle failure')
    } catch (error) {
      expect((error as Error).message).toBe('injected mid-cycle failure')
    } finally {
      releaseHolder?.()
      if (!holderDone && holderPid !== 0) {
        await observer.db.execute(sql`SELECT pg_cancel_backend(${holderPid})`).catch(() => {})
        cutFlag = true
      }
      await drainWithin(holding, 5000)
      await drainWithin(cancelling, 5000)
      drainedFlag = true
      await closeBounded(holder)
      await closeBounded(canceller)
      await closeBounded(observer)
    }
    expect(releasedFlag).toBe(true)
    expect(cutFlag).toBe(true)
    expect(drainedFlag).toBe(true)
    expect(holderDone).toBe(true)
    expect(holderCode).toBe('aborted:57014')
  })
})
