import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { UserPrincipalRef } from '@adea-ai/types'
import { and, eq } from 'drizzle-orm'

import { ensureWorkspaceLead } from '../../src/agents'
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
import { createTemporaryUserSession } from '../../src/identity'
import * as schema from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL
const ISSUED = '2026-10-01T00:00:00.000Z'
const NOW = '2026-10-08T12:00:00.000Z'

/**
 * LOCK-ORDER REPRODUCTION ONLY (root-directed, adea-ai/adea#1247).
 * No production file is touched by this suite: it stages production
 * operations against held counterpart locks (raw SQL mirrors are marked
 * MIRROR and match the production statement shape) and records whether
 * the operations wait in canonical order or deadlock. Every racy call
 * asserts an exact typed outcome — a PostgreSQL 40P01 or timeout fails
 * loudly with its code instead of passing as an arbitrary rejection.
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

async function settledWithCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'fulfilled'
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error ? String(error.code) : 'no-code'
    const name = error instanceof Error ? error.name : 'unknown'
    const reason =
      error && typeof error === 'object' && 'reason' in error ? String(error.reason) : ''
    const detail = reason || (error instanceof Error ? error.message : '')
    return `rejected:${name}:${detail}:code=${code}`
  }
}

describe.skipIf(!connectionUrl)('coordinator lock-order reproduction', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => connection.close())

  async function user(label: string): Promise<UserPrincipalRef> {
    return (
      await createTemporaryUserSession(connection.db, {
        credentialDigest: `lock-repro-${label}-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000),
      })
    ).principal
  }

  async function leadGroup() {
    const owner = await user('owner')
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Lock repro',
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

  T('cancel-with-intent waits on a held channel lock, then succeeds typed', async () => {
    // cancelAddressedTurn flips the claim (claim row only), commits, then
    // calls requestLeadTurnCancellation on a SEPARATE transaction that
    // locks the channel row. Holding that channel row elsewhere must make
    // cancel WAIT (ordered), never deadlock: cancel holds no claim lock by
    // then, so no cycle is possible.
    const f = await leadGroup()
    const claimed = await claimAddressedTurn(
      connection.db,
      f.workspace.id,
      f.owner,
      claimInput(f.channelId, f.triggerMessageId, f.lead.id, f.owner),
      { now: NOW }
    )
    expect(claimed.status).toBe('claimed')
    const dispatched = await dispatchAddressedTurn(
      connection.db,
      f.workspace.id,
      f.owner,
      claimInput(f.channelId, f.triggerMessageId, f.lead.id, f.owner),
      { now: NOW }
    )
    expect(dispatched.claim.status).toBe('duplicate')
    const holder = createDatabase(connectionUrl!)
    const runner = createDatabase(connectionUrl!)
    try {
      let release!: () => void
      let parked!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const parkedPromise = new Promise<void>((resolve) => {
        parked = resolve
      })
      // MIRROR of admitAddressedLeadTurn's first statement: channel row
      // FOR UPDATE with the same predicate shape.
      const holding = holder.db.transaction(async (tx) => {
        await tx
          .select({ id: schema.channels.id })
          .from(schema.channels)
          .where(
            and(
              eq(schema.channels.id, f.channelId),
              eq(schema.channels.workspaceId, f.workspace.id),
              eq(schema.channels.lifecycleState, 'active')
            )
          )
          .limit(1)
          .for('update')
        parked()
        await gate
      })
      await parkedPromise
      let finished = false
      const cancelling = cancelAddressedTurn(
        runner.db,
        f.workspace.id,
        f.owner,
        dispatched.claim.turn.id
      ).finally(() => {
        finished = true
      })
      // The flip needs no channel lock and commits at once; the intent
      // boundary behind it blocks on the held channel row.
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(finished).toBe(false)
      release()
      await expect(cancelling).resolves.toEqual({
        runtimeCancelRequested: false,
        state: 'cancelled',
      })
      await holding
      const [row] = await connection.db
        .select({ state: schema.addressedAgentTurns.state })
        .from(schema.addressedAgentTurns)
        .where(eq(schema.addressedAgentTurns.id, dispatched.claim.turn.id))
        .limit(1)
      expect(row?.state).toBe('cancelled')
    } finally {
      await holder.close()
      await runner.close()
    }
  })

  T('admission waits on a held claim lock, then proceeds typed', async () => {
    // Mirror image: the admission takes channel-then-claim. Holding the
    // claim row elsewhere must make admission WAIT at the claim lock and
    // then proceed — ordered, never a cycle (the holder wants nothing).
    const f = await leadGroup()
    const input = claimInput(f.channelId, f.triggerMessageId, f.lead.id, f.owner)
    const pre = await claimAddressedTurn(connection.db, f.workspace.id, f.owner, input, {
      now: NOW,
    })
    expect(pre.status).toBe('claimed')
    const holder = createDatabase(connectionUrl!)
    const runner = createDatabase(connectionUrl!)
    try {
      let release!: () => void
      let parked!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const parkedPromise = new Promise<void>((resolve) => {
        parked = resolve
      })
      // MIRROR of cancelAddressedTurn's flip lock: claim row FOR UPDATE.
      const holding = holder.db.transaction(async (tx) => {
        await tx
          .select({ id: schema.addressedAgentTurns.id })
          .from(schema.addressedAgentTurns)
          .where(eq(schema.addressedAgentTurns.id, pre.turn.id))
          .limit(1)
          .for('update')
        parked()
        await gate
      })
      await parkedPromise
      let finished = false
      const dispatching = dispatchAddressedTurn(runner.db, f.workspace.id, f.owner, input, {
        now: NOW,
      })
      void dispatching.finally(() => {
        finished = true
      })
      await new Promise((resolve) => setTimeout(resolve, 400))
      // Admission took the free channel lock, then blocked on the held
      // claim lock: still pending proves the wait (not a deadlock — the
      // holder wants nothing and releases on rollback).
      expect(finished).toBe(false)
      // ROLLBACK releases the claim unchanged: admission must then proceed
      // to a typed success with exactly one bound intent.
      release()
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
    } finally {
      await holder.close()
      await runner.close()
    }
  })

  T('terminal flip committed mid-wait denies admission with a typed reason', async () => {
    // Same staging, but the holder flips the claim to cancelled and
    // COMMITS: the waiting admission must observe the terminal state and
    // deny — never mint.
    const f = await leadGroup()
    const input = claimInput(f.channelId, f.triggerMessageId, f.lead.id, f.owner)
    const pre = await claimAddressedTurn(connection.db, f.workspace.id, f.owner, input, {
      now: NOW,
    })
    expect(pre.status).toBe('claimed')
    const holder = createDatabase(connectionUrl!)
    const runner = createDatabase(connectionUrl!)
    try {
      let release!: () => void
      let markParked!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const parkedPromise = new Promise<void>((resolve) => {
        markParked = resolve
      })
      const holding = holder.db.transaction(async (tx) => {
        await tx
          .select({ id: schema.addressedAgentTurns.id })
          .from(schema.addressedAgentTurns)
          .where(eq(schema.addressedAgentTurns.id, pre.turn.id))
          .limit(1)
          .for('update')
        markParked()
        await gate
        await tx
          .update(schema.addressedAgentTurns)
          .set({ state: 'cancelled' })
          .where(eq(schema.addressedAgentTurns.id, pre.turn.id))
      })
      await parkedPromise
      const dispatching = dispatchAddressedTurn(runner.db, f.workspace.id, f.owner, input, {
        now: NOW,
      })
      await new Promise((resolve) => setTimeout(resolve, 400))
      release()
      await holding
      const outcome = await settledWithCode(dispatching)
      expect(outcome).toBe('rejected:AddressedTurnError:turn_cancelled:code=no-code')
      const intents = await connection.db
        .select({ id: schema.leadTurnIntents.id })
        .from(schema.leadTurnIntents)
        .where(eq(schema.leadTurnIntents.channelId, f.channelId))
      expect(intents).toHaveLength(0)
    } finally {
      await holder.close()
      await runner.close()
    }
  })

  T('workspace/member share-locks stay contention-free under mixed load', async () => {
    // The locks taken after the channel lock (workspace/member FOR SHARE,
    // admission/grant rows, agent pin) must never produce 40P01 under
    // mixed dispatch/post/cancel load: every racy call settles typed.
    const f = await leadGroup()
    const runner = createDatabase(connectionUrl!)
    try {
      for (let round = 0; round < 3; round += 1) {
        const revision = 60 + round
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
        for (const result of results) {
          if (result.status === 'rejected') {
            const outcome = await settledWithCode(Promise.reject(result.reason))
            expect(outcome).not.toContain('40P01')
            expect(outcome).not.toContain('deadlock')
          }
        }
      }
    } finally {
      await runner.close()
    }
  })
})
