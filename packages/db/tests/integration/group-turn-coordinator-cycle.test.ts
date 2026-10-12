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
import {
  markLeadTurnDispatchPending,
  observeLeadTurnRuntime,
  prepareLeadTurnRuntime,
} from '../../src/lead-turn-runtime'
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
 * Corrected model (a prior report wrongly claimed the flip commits before
 * the nested call): cancelAddressedTurn awaits requestLeadTurnCancellation
 * INSIDE its database.transaction callback, so the outer transaction keeps
 * holding the claim row lock while the nested transaction (separate
 * backend) waits on the channel row. The outer→nested edge is pure
 * JavaScript — idle-in-transaction, invisible to PostgreSQL — so the
 * deadlock detector can NEVER fire here and its absence proves nothing:
 * without outside intervention both sides park forever, with no 40P01.
 *
 * Every wait below is proven through pg_blocking_pids / backend state —
 * never through sleeps — and every racy call asserts an exact typed
 * outcome. Bounded releases (pg_cancel_backend on a stuck waiter, gate
 * releases, pool closes, 30s ceilings) keep every test finite.
 */
function T(name: string, fn: () => Promise<void>) {
  test(name, fn, 30_000)
}

type OwnedObservation<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; error: unknown }
  | { status: 'timeout'; label: string }

type HolderFailureDisposition =
  | { kind: 'cleanup'; error: unknown }
  | { kind: 'failure'; error: unknown }

function holderFailureDisposition(
  error: unknown,
  closeRequested: boolean
): HolderFailureDisposition {
  if (
    closeRequested &&
    error instanceof Error &&
    'code' in error &&
    error.code === 'CONNECTION_DESTROYED' &&
    'errno' in error &&
    error.errno === 'CONNECTION_DESTROYED' &&
    error.message.startsWith('write CONNECTION_DESTROYED ')
  ) {
    return { kind: 'cleanup', error }
  }
  return { kind: 'failure', error }
}

/** Observe a task within a bound while retaining rejection handlers after timeout. */
async function observeOwned<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<OwnedObservation<T>> {
  const observed = promise.then(
    (value): OwnedObservation<T> => ({ status: 'fulfilled', value }),
    (error): OwnedObservation<T> => ({ status: 'rejected', error })
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      observed,
      new Promise<OwnedObservation<T>>((resolve) => {
        timer = setTimeout(() => resolve({ status: 'timeout', label }), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const outcome = await observeOwned(promise, ms, label)
  if (outcome.status === 'timeout') throw new Error(`timed out waiting for ${label}`)
  if (outcome.status === 'rejected') throw outcome.error
  return outcome.value
}

type OwnedCloseOutcome =
  | 'closed'
  | 'close-timeout'
  | 'close-error'
  | 'probe-timeout'
  | 'close-still-usable'
  | 'absent'

/** Bound both close and the follow-up probe to one shared deadline. */
async function closeOwned(
  pool: DatabaseConnection | null,
  ms: number,
  label: string
): Promise<OwnedCloseOutcome> {
  if (!pool) return 'absent'
  const deadline = Date.now() + ms
  const close = await observeOwned(
    Promise.resolve().then(() => pool.close()),
    ms,
    `close:${label}`
  )
  if (close.status === 'timeout') return 'close-timeout'

  const remaining = deadline - Date.now()
  if (remaining <= 0) return 'probe-timeout'
  const probe = await observeOwned(
    Promise.resolve().then(() => pool.db.execute(sql`SELECT 1 AS one`)),
    remaining,
    `probe:${label}`
  )
  if (probe.status === 'timeout') return 'probe-timeout'
  if (probe.status === 'fulfilled') return 'close-still-usable'
  return close.status === 'rejected' ? 'close-error' : 'closed'
}

/** Keep the body failure primary while retaining any cleanup failure on it. */
async function preservingCleanup<T>(
  body: () => Promise<T>,
  cleanup: () => Promise<void>
): Promise<T> {
  let bodyFailed = false
  let bodyError: unknown
  let value!: T
  try {
    value = await body()
  } catch (error) {
    bodyFailed = true
    bodyError = error
  }

  let cleanupFailed = false
  let cleanupError: unknown
  try {
    await cleanup()
  } catch (error) {
    cleanupFailed = true
    cleanupError = error
  }

  if (bodyFailed) {
    if (cleanupFailed) {
      if (bodyError instanceof Error) {
        const errorWithCleanup = bodyError as Error & { cleanupFailures?: readonly unknown[] }
        try {
          Object.defineProperty(bodyError, 'cleanupFailures', {
            configurable: true,
            enumerable: true,
            value: [...(errorWithCleanup.cleanupFailures ?? []), cleanupError],
          })
        } catch {
          throw new AggregateError([bodyError, cleanupError], 'Body and cleanup both failed', {
            cause: bodyError,
          })
        }
      } else {
        throw new AggregateError([bodyError, cleanupError], 'Body and cleanup both failed', {
          cause: bodyError,
        })
      }
    }
    throw bodyError
  }
  if (cleanupFailed) throw cleanupError
  return value
}

test('bounded observation handles a late rejection after timeout', async () => {
  let rejectLate!: (error: Error) => void
  const pending = new Promise<never>((_, reject) => {
    rejectLate = reject
  })
  expect(await observeOwned(pending, 10, 'late rejection')).toEqual({
    label: 'late rejection',
    status: 'timeout',
  })
  rejectLate(new Error('late task failure'))
  await new Promise((resolve) => setTimeout(resolve, 0))
})

test('bounded close also bounds its follow-up probe', async () => {
  const pool = {
    close: async () => undefined,
    db: { execute: () => new Promise<never>(() => {}) },
  } as unknown as DatabaseConnection
  expect(await closeOwned(pool, 20, 'deterministic stuck probe')).toBe('probe-timeout')
})

test('cleanup failure does not replace the original body error', async () => {
  const bodyError = new Error('body failed')
  const cleanupError = new Error('cleanup failed')
  const thrown = await preservingCleanup(
    async () => {
      throw bodyError
    },
    async () => {
      throw cleanupError
    }
  ).then(
    () => null,
    (error: unknown) => error
  )
  expect(thrown).toBe(bodyError)
  expect((bodyError as Error & { cleanupFailures?: readonly unknown[] }).cleanupFailures).toEqual([
    cleanupError,
  ])
})

test('an unexpected holder error after close request stays a cleanup failure', async () => {
  const injectedError = new Error('injected unexpected holder transaction error')
  const disposition = holderFailureDisposition(injectedError, true)
  expect(disposition.kind).toBe('failure')
  expect(disposition.error).toBe(injectedError)
  const thrown = await preservingCleanup(
    async () => undefined,
    async () => {
      if (disposition.kind === 'failure') throw disposition.error
    }
  ).then(
    () => null,
    (error: unknown) => error
  )
  expect(thrown).toBe(injectedError)
  const poolDestroyError = Object.assign(new Error('write CONNECTION_DESTROYED localhost:5432'), {
    code: 'CONNECTION_DESTROYED',
    errno: 'CONNECTION_DESTROYED',
  })
  const closeDisposition = holderFailureDisposition(poolDestroyError, true)
  expect(closeDisposition.kind).toBe('cleanup')
  expect(closeDisposition.error).toBe(poolDestroyError)
  expect(holderFailureDisposition(poolDestroyError, false).kind).toBe('failure')
})

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

async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await check()) return
    if (Date.now() - start > 8000) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
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

  T('cancel flip commits before intent-cancel: no mutual wait can form', async () => {
    // The cleanup path mirrors the donor's owned-task discipline, adapted
    // to the fixed ordering: release the holder first, then bound every
    // owned task. If a regression leaves the holder waiting on the claim,
    // cut only the PID captured from that holder's own transaction.
    let holder: DatabaseConnection | null = null
    let canceller: DatabaseConnection | null = null
    let observer: DatabaseConnection | null = null
    let releaseHolder: (() => void) | null = null
    let holderPid = 0
    let nestedPid = 0
    let holding: Promise<void> | null = null
    let cancelling: Promise<Awaited<ReturnType<typeof cancelAddressedTurn>>> | null = null
    await preservingCleanup(
      async () => {
        // Fixed-structure proof (the nesting it replaces is gone): the flip
        // commits first and is immediately visible, while the follow-up
        // intent-cancel transaction waits on a held channel row. A holder
        // that then requests the claim row proceeds — nothing holds
        // claim-while-wanting-channel anymore, so no application cycle exists
        // to cut and no intervention is needed for settlement.
        const f = await leadGroup()
        const input = claimInput(f.channelId, f.triggerMessageId, f.lead.id, f.owner)
        const pre = await claimAddressedTurn(connection.db, f.workspace.id, f.owner, input, {
          now: NOW,
        })
        expect(pre.status).toBe('claimed')
        const dispatched = await dispatchAddressedTurn(
          connection.db,
          f.workspace.id,
          f.owner,
          input,
          { now: NOW }
        )
        expect(dispatched.claim.status).toBe('duplicate')

        holder = createDatabase(connectionUrl!)
        canceller = createDatabase(connectionUrl!)
        observer = createDatabase(connectionUrl!)
        // HOLDER: raw transaction holding the channel row, parked on a
        // JavaScript gate (idle-in-transaction, like production paths).
        let holderParked!: () => void
        const holderGate = new Promise<void>((resolve) => {
          releaseHolder = resolve
        })
        const holderParkedPromise = new Promise<void>((resolve) => {
          holderParked = resolve
        })
        holding = holder!.db.transaction(async (tx) => {
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
          // After release: request the claim row. The flip already committed
          // (proven visible below), so this SELECT must proceed at once —
          // asserting commit (not abort) below proves no inversion remains.
          await tx
            .select({ id: schema.addressedAgentTurns.id })
            .from(schema.addressedAgentTurns)
            .where(eq(schema.addressedAgentTurns.id, dispatched.claim.turn.id))
            .limit(1)
            .for('update')
        })
        // Swallow only for unhandled-rejection hygiene; the outcome is
        // asserted explicitly below.
        void holding!.catch(() => {})
        await withTimeout(holderParkedPromise, 8000, 'holderParked')

        // CANCELLER: real production cancel. The flip commits first; only
        // then does the follow-up intent-cancel transaction run — and it
        // must wait on the held channel row.
        cancelling = cancelAddressedTurn(
          canceller!.db,
          f.workspace.id,
          f.owner,
          dispatched.claim.turn.id
        )
        void cancelling!.catch(() => {})
        // PROOF 1: a backend waits on the channel row, blocked by the
        // holder — the intent-cancel transaction running after the flip
        // committed (not nested inside an open outer transaction).
        await waitFor(async () => {
          const waits = await lockWaits(observer!)
          const nested = waits.find(
            (wait) => wait.query.includes('"channels"') && wait.blockedBy.includes(holderPid)
          )
          if (nested) nestedPid = nested.pid
          return nested !== undefined
        }, 'nested channel wait')
        // PROOF 2: the flip is ALREADY visible to a separate connection
        // while the intent-cancel still waits — the structural inversion of
        // the old nesting (uncommitted `dispatching`).
        const [visible] = await observer!.db
          .select({ state: schema.addressedAgentTurns.state })
          .from(schema.addressedAgentTurns)
          .where(eq(schema.addressedAgentTurns.id, dispatched.claim.turn.id))
          .limit(1)
        expect(visible?.state).toBe('cancelled')
        // Release: the holder's claim request proceeds (nothing holds the
        // claim lock anymore), the nested call fails fast typed, and cancel
        // succeeds — with zero intervention and zero deadlock. Poll for the
        // nested backend leaving the lock wait (a single snapshot could be
        // stale), then assert the typed outcome.
        releaseHolder?.()
        await withTimeout(holding!, 5000, 'holder completion')
        await waitFor(async () => {
          const waits = await lockWaits(observer!)
          return !waits.some((wait) => wait.pid === nestedPid)
        }, 'nested drain')
        await expect(cancelling!).resolves.toEqual({
          runtimeCancelRequested: false,
          state: 'cancelled',
        })
        const [final] = await connection.db
          .select({ state: schema.addressedAgentTurns.state })
          .from(schema.addressedAgentTurns)
          .where(eq(schema.addressedAgentTurns.id, dispatched.claim.turn.id))
          .limit(1)
        expect(final?.state).toBe('cancelled')
      },
      async () => {
        releaseHolder?.()
        let holdingOutcome = holding
          ? await observeOwned(holding, 3000, 'holding before owned-backend cut')
          : null
        let cancellingOutcome = cancelling
          ? await observeOwned(cancelling, 3000, 'cancelling before owned-backend cut')
          : null
        let holderCut = false
        let nestedCut = false

        if (holdingOutcome?.status === 'timeout' && holderPid !== 0 && observer) {
          const cut = await observeOwned(
            Promise.resolve().then(() =>
              observer!.db.execute(sql`SELECT pg_cancel_backend(${holderPid}) AS cancelled`)
            ),
            3000,
            'cut owned holder backend'
          )
          holderCut =
            cut.status === 'fulfilled' &&
            Boolean((cut.value as { cancelled?: unknown }[] | undefined)?.[0]?.cancelled)
          holdingOutcome = await observeOwned(holding!, 3000, 'holding after owned-backend cut')
        }
        if (cancellingOutcome?.status === 'timeout' && nestedPid !== 0 && observer) {
          const cut = await observeOwned(
            Promise.resolve().then(() =>
              observer!.db.execute(sql`SELECT pg_cancel_backend(${nestedPid}) AS cancelled`)
            ),
            3000,
            'cut owned nested backend'
          )
          nestedCut =
            cut.status === 'fulfilled' &&
            Boolean((cut.value as { cancelled?: unknown }[] | undefined)?.[0]?.cancelled)
          cancellingOutcome = await observeOwned(
            cancelling!,
            3000,
            'cancelling after owned-backend cut'
          )
        }

        const closeHolder = holder ? await closeOwned(holder, 3000, 'holder') : 'absent'
        const closeCanceller = canceller ? await closeOwned(canceller, 3000, 'canceller') : 'absent'
        const closeObserver = observer ? await closeOwned(observer, 3000, 'observer') : 'absent'
        const cleanup = {
          cancelling: cancellingOutcome?.status ?? 'absent',
          closeCanceller,
          closeHolder,
          closeObserver,
          holderCut: String(holderCut),
          holding: holdingOutcome?.status ?? 'absent',
          nestedCut: String(nestedCut),
        }
        expect(cleanup.cancelling).not.toBe('timeout')
        expect(cleanup.closeCanceller).toBe('closed')
        expect(cleanup.closeHolder).toBe('closed')
        expect(cleanup.closeObserver).toBe('closed')
        expect(cleanup.holding).not.toBe('timeout')
        expect(cleanup.holderCut).toBe('false')
        expect(cleanup.nestedCut).toBe('false')
      }
    )
  })

  T('admission waits on a held claim lock, then proceeds typed', async () => {
    // Mirror image with SQL-proven waits (no sleep flags): the admission
    // takes channel-then-claim; a held claim makes it wait at the claim
    // lock and proceed on rollback with exactly one bound intent.
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
    let holderPid = 0
    try {
      let releaseHolder!: () => void
      let holderParked!: () => void
      const holderGate = new Promise<void>((resolve) => {
        releaseHolder = resolve
      })
      const holderParkedPromise = new Promise<void>((resolve) => {
        holderParked = resolve
      })
      const holding = holder.db.transaction(async (tx) => {
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
      holding.catch(() => {})
      await holderParkedPromise
      const dispatching = dispatchAddressedTurn(runner.db, f.workspace.id, f.owner, input, {
        now: NOW,
      })
      void dispatching.catch(() => {})
      // PROOF: the admission backend waits on the claim row, blocked by
      // the holder — then ROLLBACK releases it unchanged and admission
      // proceeds to a typed success.
      await waitFor(async () => {
        const waits = await lockWaits(observer)
        return waits.some(
          (wait) =>
            wait.query.includes('addressed_agent_turns') && wait.blockedBy.includes(holderPid)
        )
      }, 'admission claim wait')
      releaseHolder()
      await holding
      const done = await dispatching
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
      await holder.close()
      await runner.close()
      await observer.close()
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
    try {
      let releaseHolder!: () => void
      let holderParked!: () => void
      const holderGate = new Promise<void>((resolve) => {
        releaseHolder = resolve
      })
      const holderParkedPromise = new Promise<void>((resolve) => {
        holderParked = resolve
      })
      const holding = holder.db.transaction(async (tx) => {
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
      holding.catch(() => {})
      await holderParkedPromise
      const dispatching = dispatchAddressedTurn(runner.db, f.workspace.id, f.owner, input, {
        now: NOW,
      })
      void dispatching.catch(() => {})
      await waitFor(async () => {
        const waits = await lockWaits(observer)
        return waits.some((wait) => wait.query.includes('"addressed_agent_turns"'))
      }, 'admission claim wait')
      releaseHolder()
      await holding
      await expect(dispatching).rejects.toMatchObject({
        name: 'AddressedTurnError',
        reason: 'turn_cancelled',
      })
      const intents = await connection.db
        .select({ id: schema.leadTurnIntents.id })
        .from(schema.leadTurnIntents)
        .where(eq(schema.leadTurnIntents.channelId, f.channelId))
      expect(intents).toHaveLength(0)
    } finally {
      await holder.close()
      await runner.close()
      await observer.close()
    }
  })

  T('mixed dispatch/post/cancel load settles with exact typed outcomes', async () => {
    // Workspace/member share-locks stay contention-free: every racy call
    // asserts its exact typed outcome — dispatch succeeds or loses to a
    // committed supersede, posts always succeed, cancels succeed. Any
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
      await runner.close()
    }
  })

  T('cancel and admission settle in either conflict order without deadlock', async () => {
    // Both live interleavings: cancel-flip racing a fresh admission on a
    // sibling triple, repeated. Every side settles typed — cancel always
    // succeeds; dispatch either wins (duplicate + bound intent) or loses
    // to the committed flip (turn_cancelled). No 40P01, no hangs: neither
    // side holds one row while wanting another across transactions.
    const f = await leadGroup()
    await connection.db
      .update(schema.agents)
      .set({ isWorkspaceLead: true })
      .where(eq(schema.agents.id, f.lead.id))
    for (let round = 0; round < 3; round += 1) {
      const revision = 100 + round
      const input = claimInput(f.channelId, f.triggerMessageId, f.lead.id, f.owner, {
        dispatchRevision: revision,
      })
      const pre = await claimAddressedTurn(connection.db, f.workspace.id, f.owner, input, {
        now: NOW,
      })
      expect(pre.status).toBe('claimed')
      const [cancelOutcome, dispatchOutcome] = await Promise.all([
        cancelAddressedTurn(connection.db, f.workspace.id, f.owner, pre.turn.id).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ error, ok: false as const })
        ),
        dispatchAddressedTurn(connection.db, f.workspace.id, f.owner, input, { now: NOW }).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ error, ok: false as const })
        ),
      ])
      expect(cancelOutcome.ok).toBe(true)
      if (cancelOutcome.ok) {
        expect(cancelOutcome.value.state).toBe('cancelled')
      }
      if (dispatchOutcome.ok) {
        expect(dispatchOutcome.value.claim.status).toBe('duplicate')
      } else {
        // The only legal loss: the flip committed first (lead and budget
        // are stable here, nothing else denies).
        expect(dispatchOutcome.error).toMatchObject({
          name: 'AddressedTurnError',
          reason: 'turn_cancelled',
        })
      }
      const [row] = await connection.db
        .select({ state: schema.addressedAgentTurns.state })
        .from(schema.addressedAgentTurns)
        .where(eq(schema.addressedAgentTurns.id, pre.turn.id))
        .limit(1)
      expect(row?.state).toBe('cancelled')
    }
    const intents = await connection.db
      .select({ id: schema.leadTurnIntents.id })
      .from(schema.leadTurnIntents)
      .where(eq(schema.leadTurnIntents.channelId, f.channelId))
    // At most one intent per triple that dispatch won; cancelled-first
    // triples mint nothing.
    expect(intents.length).toBeLessThanOrEqual(3)
  })

  T('runtime cancellation fires end-to-end when an executor holds the intent', async () => {
    // Full boundary proof: prepare + observe a fabricated-but-valid
    // runtime binding (executor holds dispatchId), then cancel through
    // the coordinator and assert cancelRequestedAt is actually set —
    // runtimeCancelRequested true means something, not a default.
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
    const dispatched = await dispatchAddressedTurn(connection.db, f.workspace.id, f.owner, input, {
      now: NOW,
    })
    expect(dispatched.claim.status).toBe('duplicate')
    const [bound] = await connection.db
      .select()
      .from(schema.addressedAgentTurns)
      .where(eq(schema.addressedAgentTurns.id, pre.turn.id))
      .limit(1)
    expect(bound?.intentId).not.toBeNull()
    const [canonicalWorkspace] = await connection.db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, f.workspace.id))
    const execution = crypto
      .randomUUID()
      .replaceAll('-', '')
      .slice(0, 26)
      .toUpperCase()
      .replace(/[ILOU]/g, '0')
    const pin = {
      attemptId: `att_${execution}`,
      executionId: `exe_${execution}`,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      intentId: bound!.intentId!,
      preparationRef: `prep_${crypto.randomUUID().replaceAll('-', '')}`,
      selectionRef: `msel_${crypto.randomUUID().replaceAll('-', '')}`,
      selectionRevision: 1,
      workspaceId: canonicalWorkspace!.controlPlaneWorkspaceId,
    }
    await prepareLeadTurnRuntime(connection.db, f.workspace.id, bound!.intentId!, f.owner, pin)
    await markLeadTurnDispatchPending(connection.db, f.workspace.id, bound!.intentId!, f.owner, pin)
    await observeLeadTurnRuntime(connection.db, f.workspace.id, bound!.intentId!, f.owner, {
      ...pin,
      dispatchId: `dispatch_${crypto.randomUUID().replaceAll('-', '')}`,
      observedAt: new Date().toISOString(),
      runtimeSessionId: `ses_${execution}`,
      state: 'running',
    })
    const outcome = await cancelAddressedTurn(connection.db, f.workspace.id, f.owner, pre.turn.id)
    expect(outcome).toEqual({ runtimeCancelRequested: true, state: 'cancelled' })
    const [runtime] = await connection.db
      .select()
      .from(schema.leadTurnRuntime)
      .where(eq(schema.leadTurnRuntime.intentId, bound!.intentId!))
      .limit(1)
    expect(runtime?.cancelRequestedAt).not.toBeNull()
  })

  T('observer failure still releases parks and closes pools boundedly', async () => {
    let holder: DatabaseConnection | null = null
    let observer: DatabaseConnection | null = null
    let releaseHolder: (() => void) | null = null
    let holderDone = false
    let holding: Promise<void> | null = null
    let holderCloseRequested = false
    let holderFailed = false
    let holderFailure: unknown = null
    let holderCleanupFailed = false
    let holderCleanupError: unknown = null
    let observerClosed = false
    let cleanup: Record<string, string> | null = null
    await preservingCleanup(
      async () => {
        const f = await leadGroup()
        holder = createDatabase(connectionUrl!)
        observer = createDatabase(connectionUrl!)
        let holderParked!: () => void
        const holderGate = new Promise<void>((resolve) => {
          releaseHolder = resolve
        })
        const holderParkedPromise = new Promise<void>((resolve) => {
          holderParked = resolve
        })
        holding = (async () => {
          try {
            await holder!.db.transaction(async (tx) => {
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
          } catch (error) {
            const disposition = holderFailureDisposition(error, holderCloseRequested)
            if (disposition.kind === 'cleanup') {
              holderCleanupFailed = true
              holderCleanupError = disposition.error
            } else {
              holderFailed = true
              holderFailure = disposition.error
            }
          } finally {
            holderDone = true
          }
        })()
        await withTimeout(holderParkedPromise, 8000, 'holderParked')
        expect(await closeOwned(observer, 3000, 'observer-injected')).toBe('closed')
        observerClosed = true
        const observed = await observeOwned(lockWaits(observer), 3000, 'observer query after close')
        expect(observed.status).toBe('rejected')
      },
      async () => {
        releaseHolder?.()
        let holdingOutcome: OwnedObservation<void> | null = null
        if (holding) holdingOutcome = await observeOwned(holding, 3000, 'holding before close')
        if (holdingOutcome?.status === 'timeout') holderCloseRequested = true

        const closeHolder = holder ? await closeOwned(holder, 3000, 'holder') : 'absent'
        if (holdingOutcome?.status === 'timeout' && holding) {
          holdingOutcome = await observeOwned(holding, 3000, 'holding after close')
        }
        const closeObserver = observerClosed
          ? 'closed'
          : observer
            ? await closeOwned(observer, 3000, 'observer-cleanup')
            : 'absent'
        cleanup = {
          closeHolder,
          closeObserver,
          holding: holdingOutcome?.status ?? 'absent',
        }

        if (holderFailed) throw holderFailure
        if (holderCleanupFailed) {
          expect(holderCloseRequested).toBe(true)
          expect(closeHolder).toBe('closed')
          expect(holdingOutcome?.status).toBe('fulfilled')
          expect(holderCleanupError).toMatchObject({
            code: 'CONNECTION_DESTROYED',
            errno: 'CONNECTION_DESTROYED',
          })
        }
        expect(cleanup).toEqual({
          closeHolder: 'closed',
          closeObserver: 'closed',
          holding: 'fulfilled',
        })
        expect(holderDone).toBe(true)
      }
    )

    const fresh = createDatabase(connectionUrl!)
    await preservingCleanup(
      async () => {
        const [one] = await withTimeout(
          fresh.db.execute(sql`SELECT 1 AS one`),
          3000,
          'fresh-pool query'
        )
        expect((one as { one: number }).one).toBe(1)
      },
      async () => {
        expect(await closeOwned(fresh, 3000, 'fresh')).toBe('closed')
      }
    )
  })
})
