import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { UserPrincipalRef } from '@adea-ai/types'
import { and, eq, sql } from 'drizzle-orm'

import { createAgent } from '../../src/agents'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import {
  createGroupChannelWithGrants,
  groupCreationCandidatesFromGrants,
  postGroupChannelMessage,
  revokeGroupGrant,
  setGroupChannelParticipantsWithGrants,
} from '../../src/group-channels'
import { loadAddressedTurns } from '../../src/group-turn-coordinator'
import {
  addressGroupTurn,
  cancelGroupTurn,
  listAddressedTurnsForUser,
} from '../../src/group-turn-product'
import { createTemporaryUserSession } from '../../src/identity'
import {
  markLeadTurnDispatchPending,
  observeLeadTurnRuntime,
  prepareLeadTurnRuntime,
  publishLeadTurnResult,
} from '../../src/lead-turn-runtime'
import * as schema from '../../src/schema'
import { addWorkspaceMembership, createWorkspaceWithOwner } from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL
const ISSUED = '2026-10-01T00:00:00.000Z'
const NOW = '2026-10-08T12:00:00.000Z'

function T(name: string, fn: () => Promise<void>) {
  test(name, fn, 60_000)
}

const audience = (channelId: string, participant: UserPrincipalRef, grantId: string) => ({
  expiresAt: null,
  grantId,
  groupId: channelId,
  issuedAt: ISSUED,
  participant,
  revision: 1,
  revokedAt: null,
})

const enlistment = (channelId: string, agentId: string, workspaceId: string, grantId: string) => ({
  agent: { agentId, workspaceId },
  expiresAt: null,
  grantId,
  groupId: channelId,
  issuedAt: ISSUED,
  revision: 1,
  revokedAt: null,
})

/**
 * The product surface over the durable coordinator: persisted-before-dispatch claims, duplicate and
 * reconnect convergence, current-authority rechecks, human priority, replay in committed order and the
 * single recorded response. Runs only with an isolated DATABASE_URL and the react-server condition.
 */
describe.skipIf(!connectionUrl)('addressed group turns through the product surface', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => connection.close())

  async function user(label: string): Promise<UserPrincipalRef> {
    return (
      await createTemporaryUserSession(connection.db, {
        credentialDigest: `turn-product-${label}-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 120_000),
      })
    ).principal
  }

  /** A group of the owner, a second human, a lead Agent and a non-lead Agent, with one human trigger. */
  async function fixture() {
    const owner = await user('owner')
    const member = await user('member')
    const outsider = await user('outsider')
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Turn product',
      owner,
    })
    await addWorkspaceMembership(connection.db, workspace.id, member, 'member')
    await addWorkspaceMembership(connection.db, workspace.id, outsider, 'member')
    const lead = await createAgent(connection.db, workspace.id, owner, {
      name: 'Lead',
      profileId: 'lead',
      profileVersion: '1',
    })
    await connection.db
      .update(schema.agents)
      .set({ isWorkspaceLead: true })
      .where(eq(schema.agents.id, lead.id))
    const helper = await createAgent(connection.db, workspace.id, owner, {
      name: 'Helper',
      profileId: 'lead',
      profileVersion: '1',
    })
    const channelId = crypto.randomUUID()
    await createGroupChannelWithGrants(connection.db, workspace.id, owner, {
      candidates: groupCreationCandidatesFromGrants(workspace.id, {
        audienceGrants: [
          audience(channelId, owner, 'gra_owner'),
          audience(channelId, member, 'gra_member'),
        ],
        enlistmentGrants: [
          enlistment(channelId, lead.id, workspace.id, 'gra_lead'),
          enlistment(channelId, helper.id, workspace.id, 'gra_helper'),
        ],
      }),
      channelId,
      idempotencyKey: crypto.randomUUID(),
      now: NOW,
      title: 'Group',
    })
    const post = (sender: UserPrincipalRef, bodyText: string) =>
      postGroupChannelMessage(
        connection.db,
        workspace.id,
        channelId,
        sender,
        sender,
        { message: { bodyText, idempotencyKey: crypto.randomUUID() }, mode: 'direct' },
        { now: NOW }
      )
    const trigger = await post(owner, 'please answer')
    return { channelId, helper, lead, member, outsider, owner, post, trigger, workspace }
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>
  const input = (f: Fixture, agentId: string, dispatchRevision = 1) => ({
    agentId,
    dispatchRevision,
    triggerMessageId: f.trigger.id,
  })
  const address = (f: Fixture, agentId: string, dispatchRevision = 1, principal = f.owner) =>
    addressGroupTurn(
      connection.db,
      f.workspace.id,
      f.channelId,
      principal,
      input(f, agentId, dispatchRevision)
    )
  const intentCount = async (f: Fixture) =>
    (
      await connection.db
        .select({ id: schema.leadTurnIntents.id })
        .from(schema.leadTurnIntents)
        .where(eq(schema.leadTurnIntents.workspaceId, f.workspace.id))
    ).length
  const claimCount = async (f: Fixture) =>
    (await loadAddressedTurns(connection.db, f.workspace.id, f.channelId)).length

  async function addOutsiderAfterTrigger(f: Fixture) {
    const [channel] = await connection.db
      .select({ version: schema.channels.version })
      .from(schema.channels)
      .where(eq(schema.channels.id, f.channelId))
      .limit(1)
    if (!channel) throw new Error('Test channel missing')
    await setGroupChannelParticipantsWithGrants(
      connection.db,
      f.workspace.id,
      f.channelId,
      f.owner,
      {
        candidates: groupCreationCandidatesFromGrants(f.workspace.id, {
          audienceGrants: [
            audience(f.channelId, f.owner, 'gra_owner'),
            audience(f.channelId, f.member, 'gra_member'),
            audience(f.channelId, f.outsider, 'gra_outsider'),
          ],
          enlistmentGrants: [
            enlistment(f.channelId, f.lead.id, f.workspace.id, 'gra_lead'),
            enlistment(f.channelId, f.helper.id, f.workspace.id, 'gra_helper'),
          ],
        }),
        expectedVersion: channel.version,
        now: new Date().toISOString(),
      }
    )
  }

  async function insertReplayTurns(
    f: Fixture,
    count: number,
    triggerMessageIdAt: (index: number) => string,
    { idPrefix = crypto.randomUUID().slice(0, 24), startIndex = 0 } = {}
  ) {
    const createdAt = new Date(NOW)
    const rows = Array.from({ length: count }, (_, index) => {
      const sequence = startIndex + index
      const revision = sequence + 1
      const triggerMessageId = triggerMessageIdAt(sequence)
      return {
        addresserUserId: f.owner.userId,
        addressedLabel: `${f.workspace.id}:${f.helper.id}`,
        agentId: f.helper.id,
        causalId: `turn:${triggerMessageId}:${f.helper.id}:${revision}`,
        channelId: f.channelId,
        createdAt,
        depth: 0,
        dispatchRevision: revision,
        id: `${idPrefix}${sequence.toString(16).padStart(12, '0')}`,
        intentId: null,
        maxDepth: 2,
        maxTurns: 8,
        parentTurnId: null,
        responseMessageId: null,
        state: 'claimed',
        triggerMessageId,
        updatedAt: createdAt,
        workspaceId: f.workspace.id,
      }
    })
    await connection.db.insert(schema.addressedAgentTurns).values(rows)
    return rows
  }

  /** Drives a dispatched lead intent through the existing runtime path to a publishable result. */
  async function complete(f: Fixture, intentId: string) {
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
      intentId,
      preparationRef: `prep_${crypto.randomUUID().replaceAll('-', '')}`,
      selectionRef: `msel_${crypto.randomUUID().replaceAll('-', '')}`,
      selectionRevision: 1,
      workspaceId: canonicalWorkspace!.controlPlaneWorkspaceId,
    }
    const binding = {
      attemptId: pin.attemptId,
      dispatchId: `dispatch_${crypto.randomUUID().replaceAll('-', '')}`,
      executionId: pin.executionId,
      intentId,
      runtimeSessionId: `ses_${execution}`,
    }
    await prepareLeadTurnRuntime(connection.db, f.workspace.id, intentId, f.owner, pin)
    await markLeadTurnDispatchPending(connection.db, f.workspace.id, intentId, f.owner, pin)
    await observeLeadTurnRuntime(connection.db, f.workspace.id, intentId, f.owner, {
      ...binding,
      observedAt: new Date().toISOString(),
      state: 'completed',
    })
    return () =>
      publishLeadTurnResult(
        connection.db,
        f.workspace.id,
        intentId,
        f.owner,
        binding,
        'The answer',
        async () => {}
      )
  }

  T(
    'persists causal ID, recipient, revision and budget, admits the lead, and converges on replay',
    async () => {
      const f = await fixture()
      const first = await address(f, f.lead.id)
      expect(first.created).toBe(true)
      expect(first.dispatch).toBe('admitted')
      expect(first.turn).toMatchObject({
        addressedLabel: `${f.workspace.id}:${f.lead.id}`,
        addresserUserId: f.owner.userId,
        agentId: f.lead.id,
        budget: { maxDepth: 2, maxTurns: 8 },
        causalId: `turn:${f.trigger.id}:${f.lead.id}:1`,
        channelId: f.channelId,
        depth: 0,
        dispatchRevision: 1,
        dispatched: true,
        parentTurnId: null,
        responseMessageId: null,
        state: 'dispatching',
        triggerMessageId: f.trigger.id,
      })
      expect(first.turn.leadTurnIntentId).not.toBeNull()
      // A reconnect re-submitting the same request converges on the same turn and the same intent.
      const second = await address(f, f.lead.id)
      expect(second.created).toBe(false)
      expect(second.turn.id).toBe(first.turn.id)
      expect(second.turn.leadTurnIntentId).toBe(first.turn.leadTurnIntentId)
      expect(await claimCount(f)).toBe(1)
      expect(await intentCount(f)).toBe(1)
      // A new revision is a new slot; it never reuses or forks the first.
      const revised = await address(f, f.lead.id, 2)
      expect(revised.created).toBe(true)
      expect(revised.turn.id).not.toBe(first.turn.id)
      expect(await claimCount(f)).toBe(2)
    }
  )

  T('concurrent duplicate submissions create one claim and one intent', async () => {
    const f = await fixture()
    const results = await Promise.all(Array.from({ length: 6 }, () => address(f, f.lead.id)))
    expect(results.filter((result) => result.created)).toHaveLength(1)
    expect(new Set(results.map((result) => result.turn.id)).size).toBe(1)
    expect(await claimCount(f)).toBe(1)
    expect(await intentCount(f)).toBe(1)
  })

  T('a non-lead Agent keeps its claim but nothing is dispatched', async () => {
    const f = await fixture()
    const result = await address(f, f.helper.id)
    expect(result).toMatchObject({
      created: true,
      dispatch: 'not_lead',
      turn: { dispatched: false, leadTurnIntentId: null, state: 'claimed' },
    })
    expect((await address(f, f.helper.id)).created).toBe(false)
    expect(await claimCount(f)).toBe(1)
    expect(await intentCount(f)).toBe(0)
  })

  T('revoked or stale authority produces no claim and no dispatch', async () => {
    const f = await fixture()
    // The Agent's enlistment is revoked: the request is refused before any write.
    await revokeGroupGrant(connection.db, f.workspace.id, f.channelId, f.owner, {
      grantId: 'gra_lead',
      kind: 'enlistment',
      revokedAt: new Date().toISOString(),
    })
    await expect(address(f, f.lead.id)).rejects.toMatchObject({
      name: 'AddressedTurnError',
      reason: 'turn_agent_revoked',
    })
    expect(await claimCount(f)).toBe(0)
    expect(await intentCount(f)).toBe(0)
    // The addresser's own audience grant is revoked: the group reads as unavailable to them.
    await revokeGroupGrant(connection.db, f.workspace.id, f.channelId, f.owner, {
      grantId: 'gra_member',
      kind: 'audience',
      revokedAt: new Date().toISOString(),
    })
    await expect(address(f, f.helper.id, 1, f.member)).rejects.toThrow('Channel unavailable')
    // A workspace member who was never admitted gets the same answer.
    await expect(address(f, f.helper.id, 1, f.outsider)).rejects.toThrow('Channel unavailable')
    expect(await claimCount(f)).toBe(0)
    expect(await intentCount(f)).toBe(0)
    // Replay is gated the same way.
    await expect(
      listAddressedTurnsForUser(connection.db, f.workspace.id, f.channelId, f.member)
    ).rejects.toThrow('Channel unavailable')
  })

  T('a duplicate after the addresser lost authority returns nothing retained', async () => {
    const f = await fixture()
    const first = await address(f, f.lead.id, 1, f.owner)
    expect(first.created).toBe(true)
    await revokeGroupGrant(connection.db, f.workspace.id, f.channelId, f.owner, {
      grantId: 'gra_owner',
      kind: 'audience',
      revokedAt: new Date().toISOString(),
    })
    await expect(address(f, f.lead.id, 1, f.owner)).rejects.toThrow('Channel unavailable')
    expect(await claimCount(f)).toBe(1)
    expect(await intentCount(f)).toBe(1)
  })

  T('a participant who is not the trigger author cannot address from it', async () => {
    const f = await fixture()
    await expect(address(f, f.helper.id, 1, f.member)).rejects.toMatchObject({
      name: 'AddressedTurnError',
      reason: 'turn_trigger_forged',
    })
    expect(await claimCount(f)).toBe(0)
  })

  T(
    'newer human input supersedes live work, and the stale request dispatches nothing',
    async () => {
      const f = await fixture()
      const live = await address(f, f.lead.id)
      expect(live.turn.state).toBe('dispatching')
      await f.post(f.member, 'actually, a different question')
      const listed = await listAddressedTurnsForUser(
        connection.db,
        f.workspace.id,
        f.channelId,
        f.owner
      )
      expect(listed.turns.map((turn) => [turn.id, turn.state])).toEqual([
        [live.turn.id, 'superseded'],
      ])
      const intents = await intentCount(f)
      await expect(address(f, f.lead.id)).rejects.toMatchObject({
        name: 'AddressedTurnError',
        reason: 'turn_superseded',
      })
      expect(await intentCount(f)).toBe(intents)
    }
  )

  T(
    'Agent messages never address: no automatic follow-up turns, and an Agent-authored trigger is refused',
    async () => {
      const f = await fixture()
      const chatter = await postGroupChannelMessage(
        connection.db,
        f.workspace.id,
        f.channelId,
        f.owner,
        { agentId: f.helper.id, kind: 'agent' },
        {
          message: { bodyText: 'helper muses', idempotencyKey: crypto.randomUUID() },
          mode: 'direct',
        },
        { now: NOW }
      )
      expect(await claimCount(f)).toBe(0)
      await expect(
        addressGroupTurn(connection.db, f.workspace.id, f.channelId, f.owner, {
          agentId: f.lead.id,
          dispatchRevision: 1,
          triggerMessageId: chatter.id,
        })
      ).rejects.toMatchObject({ name: 'AddressedTurnError', reason: 'turn_trigger_forged' })
      expect(await claimCount(f)).toBe(0)
    }
  )

  T(
    'the turn budget bounds a trigger tree, and a retained claim still converges when full',
    async () => {
      const f = await fixture()
      for (let revision = 1; revision <= 8; revision += 1)
        expect((await address(f, f.helper.id, revision)).created).toBe(true)
      await expect(address(f, f.helper.id, 9)).rejects.toMatchObject({
        name: 'AddressedTurnError',
        reason: 'turn_budget_exhausted',
      })
      expect((await address(f, f.helper.id, 1)).created).toBe(false)
      expect(await claimCount(f)).toBe(8)
    }
  )

  T(
    'replay reads turns in committed order with attribution, pages by cursor, and rejects a bad cursor',
    async () => {
      const f = await fixture()
      const turns = []
      for (const revision of [1, 2, 3]) turns.push((await address(f, f.helper.id, revision)).turn)
      const everyone = await listAddressedTurnsForUser(
        connection.db,
        f.workspace.id,
        f.channelId,
        f.member
      )
      expect(everyone.turns.map((turn) => turn.id)).toEqual(turns.map((turn) => turn.id))
      expect(everyone.turns.every((turn) => turn.addresserUserId === f.owner.userId)).toBe(true)
      expect(everyone.nextAfter).toBeNull()
      const firstPage = await listAddressedTurnsForUser(
        connection.db,
        f.workspace.id,
        f.channelId,
        f.owner,
        { limit: 2 }
      )
      expect(firstPage.turns.map((turn) => turn.id)).toEqual([turns[0]!.id, turns[1]!.id])
      expect(firstPage.nextAfter).toBe(turns[1]!.id)
      const secondPage = await listAddressedTurnsForUser(
        connection.db,
        f.workspace.id,
        f.channelId,
        f.owner,
        { after: firstPage.nextAfter!, limit: 2 }
      )
      expect(secondPage.turns.map((turn) => turn.id)).toEqual([turns[2]!.id])
      expect(secondPage.nextAfter).toBeNull()
      await expect(
        listAddressedTurnsForUser(connection.db, f.workspace.id, f.channelId, f.owner, {
          after: crypto.randomUUID(),
        })
      ).rejects.toMatchObject({ name: 'AddressedTurnError', reason: 'turn_cursor_invalid' })
    }
  )

  T(
    'replay cursors preserve PostgreSQL microseconds and exact timestamp/id tie order',
    async () => {
      const f = await fixture()
      const first = await address(f, f.helper.id, 1)
      const second = await address(f, f.helper.id, 2)
      const third = await address(f, f.helper.id, 3)
      // The three rewritten primary keys are run-unique, so the case is
      // repeatable in a database that still holds the rows an earlier
      // execution left behind. Their relative order is unchanged: the first row
      // sorts after the tied pair by id, and the tied pair sorts by id.
      const unique = crypto.randomUUID().replaceAll('-', '').slice(0, 11)
      const tiedFirstId = `ffffffff-ffff-4fff-8fff-${unique}3`
      const tiedSecondId = `00000000-0000-4000-8000-${unique}1`
      const tiedThirdId = `00000000-0000-4000-8000-${unique}2`

      // All three JS Dates round to the same millisecond. PostgreSQL still orders the first row before
      // the tied pair by its microseconds, then orders the tied pair by UUID.
      await connection.db.execute(sql`
      UPDATE app.addressed_agent_turns
      SET id = ${tiedFirstId}::uuid, created_at = '2026-10-08 12:00:00.000100+00'::timestamptz
      WHERE id = ${first.turn.id}::uuid
    `)
      await connection.db.execute(sql`
      UPDATE app.addressed_agent_turns
      SET id = ${tiedSecondId}::uuid, created_at = '2026-10-08 12:00:00.000900+00'::timestamptz
      WHERE id = ${second.turn.id}::uuid
    `)
      await connection.db.execute(sql`
      UPDATE app.addressed_agent_turns
      SET id = ${tiedThirdId}::uuid, created_at = '2026-10-08 12:00:00.000900+00'::timestamptz
      WHERE id = ${third.turn.id}::uuid
    `)

      const page1 = await listAddressedTurnsForUser(
        connection.db,
        f.workspace.id,
        f.channelId,
        f.owner,
        { limit: 1 }
      )
      expect(page1.turns.map((turn) => turn.id)).toEqual([tiedFirstId])
      expect(page1.nextAfter).toBe(tiedFirstId)

      const page2 = await listAddressedTurnsForUser(
        connection.db,
        f.workspace.id,
        f.channelId,
        f.owner,
        { after: page1.nextAfter!, limit: 1 }
      )
      expect(page2.turns.map((turn) => turn.id)).toEqual([tiedSecondId])
      expect(page2.nextAfter).toBe(tiedSecondId)

      const page3 = await listAddressedTurnsForUser(
        connection.db,
        f.workspace.id,
        f.channelId,
        f.owner,
        { after: page2.nextAfter!, limit: 1 }
      )
      expect(page3.turns.map((turn) => turn.id)).toEqual([tiedThirdId])
      expect(page3.nextAfter).toBeNull()
    }
  )

  T('replay omits turns whose trigger the reader joined too late to see', async () => {
    const f = await fixture()
    await address(f, f.helper.id)
    const latecomer = f.outsider
    const channel = await connection.db
      .select({ version: schema.channels.version })
      .from(schema.channels)
      .where(eq(schema.channels.id, f.channelId))
      .limit(1)
    await setGroupChannelParticipantsWithGrants(
      connection.db,
      f.workspace.id,
      f.channelId,
      f.owner,
      {
        candidates: groupCreationCandidatesFromGrants(f.workspace.id, {
          audienceGrants: [
            audience(f.channelId, f.owner, 'gra_owner'),
            audience(f.channelId, f.member, 'gra_member'),
            audience(f.channelId, latecomer, 'gra_late'),
          ],
          enlistmentGrants: [
            enlistment(f.channelId, f.lead.id, f.workspace.id, 'gra_lead'),
            enlistment(f.channelId, f.helper.id, f.workspace.id, 'gra_helper'),
          ],
        }),
        expectedVersion: channel[0]!.version,
        now: new Date().toISOString(),
      }
    )
    const late = await listAddressedTurnsForUser(
      connection.db,
      f.workspace.id,
      f.channelId,
      latecomer
    )
    expect(late.turns).toEqual([])
    const original = await listAddressedTurnsForUser(
      connection.db,
      f.workspace.id,
      f.channelId,
      f.owner
    )
    expect(original.turns).toHaveLength(1)
    // The held turn id is not usable as a cursor either: it reads like any unknown id.
    await expect(
      listAddressedTurnsForUser(connection.db, f.workspace.id, f.channelId, latecomer, {
        after: original.turns[0]!.id,
      })
    ).rejects.toMatchObject({ reason: 'turn_cursor_invalid' })
  })

  T(
    'replay pages interleaved hidden turns across scan windows without skips or duplicate visible turns',
    async () => {
      const f = await fixture()
      await addOutsiderAfterTrigger(f)
      const visibleTrigger = await f.post(f.owner, 'visible after join')
      const rows = await insertReplayTurns(f, 500, (index) =>
        index % 2 === 0 ? visibleTrigger.id : f.trigger.id
      )
      const expected = rows.filter((_, index) => index % 2 === 0).map((turn) => turn.id)

      const page1 = await listAddressedTurnsForUser(
        connection.db,
        f.workspace.id,
        f.channelId,
        f.outsider,
        { limit: 90 }
      )
      expect(page1.turns.map((turn) => turn.id)).toEqual(expected.slice(0, 90))
      expect(page1.nextAfter).toBe(expected[89])

      const page2 = await listAddressedTurnsForUser(
        connection.db,
        f.workspace.id,
        f.channelId,
        f.outsider,
        { after: page1.nextAfter!, limit: 90 }
      )
      expect(page2.turns.map((turn) => turn.id)).toEqual(expected.slice(90, 180))
      expect(page2.nextAfter).toBe(expected[179])

      const page3 = await listAddressedTurnsForUser(
        connection.db,
        f.workspace.id,
        f.channelId,
        f.outsider,
        { after: page2.nextAfter!, limit: 90 }
      )
      expect(page3.turns.map((turn) => turn.id)).toEqual(expected.slice(180))
      expect(page3.nextAfter).toBeNull()

      const allReturned = [...page1.turns, ...page2.turns, ...page3.turns].map((turn) => turn.id)
      expect(allReturned).toEqual(expected)
      expect(new Set(allReturned).size).toBe(expected.length)
    }
  )

  T(
    'an exactly exhausted 1,000-row hidden scan ends cleanly, while one more hidden row fails closed',
    async () => {
      const f = await fixture()
      await addOutsiderAfterTrigger(f)
      const idPrefix = crypto.randomUUID().slice(0, 24)
      await insertReplayTurns(f, 1_000, () => f.trigger.id, { idPrefix })

      const exhausted = await listAddressedTurnsForUser(
        connection.db,
        f.workspace.id,
        f.channelId,
        f.outsider,
        { limit: 1 }
      )
      expect(exhausted.turns).toEqual([])
      expect(exhausted.nextAfter).toBeNull()

      await insertReplayTurns(f, 1, () => f.trigger.id, { idPrefix, startIndex: 1_000 })
      await expect(
        listAddressedTurnsForUser(connection.db, f.workspace.id, f.channelId, f.outsider, {
          limit: 1,
        })
      ).rejects.toThrow('Addressed turn history scan exhausted')
    }
  )

  T('cancellation belongs to the addresser or a manager and is scoped to the channel', async () => {
    const f = await fixture()
    const { turn } = await address(f, f.helper.id)
    await expect(
      cancelGroupTurn(connection.db, f.workspace.id, f.channelId, f.member, turn.id)
    ).rejects.toMatchObject({ reason: 'turn_cancel_unauthorized' })
    await expect(
      cancelGroupTurn(connection.db, f.workspace.id, f.channelId, f.owner, crypto.randomUUID())
    ).rejects.toMatchObject({ reason: 'turn_claim_unresolved' })
    const cancelled = await cancelGroupTurn(
      connection.db,
      f.workspace.id,
      f.channelId,
      f.owner,
      turn.id
    )
    expect(cancelled.turn.state).toBe('cancelled')
    // Re-cancelling converges, and a cancelled turn never dispatches again.
    expect(
      (await cancelGroupTurn(connection.db, f.workspace.id, f.channelId, f.owner, turn.id)).turn
        .state
    ).toBe('cancelled')
    const lead = await address(f, f.lead.id, 5)
    await cancelGroupTurn(connection.db, f.workspace.id, f.channelId, f.owner, lead.turn.id)
    await expect(address(f, f.lead.id, 5)).rejects.toMatchObject({ reason: 'turn_cancelled' })
    // A turn of another channel is not cancellable through this channel.
    const otherChannel = crypto.randomUUID()
    await createGroupChannelWithGrants(connection.db, f.workspace.id, f.owner, {
      candidates: groupCreationCandidatesFromGrants(f.workspace.id, {
        audienceGrants: [audience(otherChannel, f.owner, 'gra_owner_2')],
        enlistmentGrants: [],
      }),
      channelId: otherChannel,
      idempotencyKey: crypto.randomUUID(),
      now: NOW,
      title: 'Other',
    })
    await expect(
      cancelGroupTurn(connection.db, f.workspace.id, otherChannel, f.owner, lead.turn.id)
    ).rejects.toMatchObject({ reason: 'turn_claim_unresolved' })
  })

  T(
    'the published answer binds as the single response, replays converge, and a new revision is a new slot',
    async () => {
      const f = await fixture()
      const { turn } = await address(f, f.lead.id)
      const intentId = turn.leadTurnIntentId!
      const publish = await complete(f, intentId)
      const messageId = await publish()
      expect(await publish()).toBe(messageId)
      const listed = await listAddressedTurnsForUser(
        connection.db,
        f.workspace.id,
        f.channelId,
        f.member
      )
      expect(listed.turns).toHaveLength(1)
      expect(listed.turns[0]).toMatchObject({
        id: turn.id,
        responseMessageId: messageId,
        state: 'responded',
      })
      // A responded turn is terminal for dispatch, cancellation and supersede alike.
      await expect(address(f, f.lead.id)).rejects.toMatchObject({
        reason: 'turn_already_responded',
      })
      await expect(
        cancelGroupTurn(connection.db, f.workspace.id, f.channelId, f.owner, turn.id)
      ).rejects.toMatchObject({ reason: 'turn_already_responded' })
      // One response per (message, Agent, revision): revision 2 is a separate, unanswered slot.
      const revised = await address(f, f.helper.id, 2)
      expect(revised.turn.responseMessageId).toBeNull()
      const rows = await connection.db
        .select()
        .from(schema.addressedAgentTurns)
        .where(
          and(
            eq(schema.addressedAgentTurns.workspaceId, f.workspace.id),
            eq(schema.addressedAgentTurns.responseMessageId, messageId)
          )
        )
      expect(rows).toHaveLength(1)
    }
  )

  T(
    'a superseded or cancelled turn keeps that state when its answer is published later',
    async () => {
      const f = await fixture()
      const cancelled = await address(f, f.lead.id)
      const publishCancelled = await complete(f, cancelled.turn.leadTurnIntentId!)
      await cancelGroupTurn(connection.db, f.workspace.id, f.channelId, f.owner, cancelled.turn.id)
      const messageId = await publishCancelled()
      const [row] = await connection.db
        .select()
        .from(schema.addressedAgentTurns)
        .where(eq(schema.addressedAgentTurns.id, cancelled.turn.id))
      // The answer is ordinary channel history; the dead turn neither revives nor records it.
      expect(row).toMatchObject({ responseMessageId: null, state: 'cancelled' })
      expect(messageId).toBeString()
    }
  )

  T(
    'a database error during replay surfaces as an error and never drops a turn from a page',
    async () => {
      const f = await fixture()
      const first = await address(f, f.lead.id)
      const second = await address(f, f.helper.id)
      // Let the group read-proof (transaction 1) pass, then fail every later read snapshot.
      const flaky = (healthyReads: number) => {
        let reads = 0
        return new Proxy(connection.db, {
          get(target, property) {
            if (property === 'transaction')
              return (...args: Parameters<typeof target.transaction>) => {
                reads += 1
                return reads > healthyReads
                  ? Promise.reject(new Error('connection terminated unexpectedly'))
                  : target.transaction(...args)
              }
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
          },
        }) as typeof connection.db
      }
      await expect(
        listAddressedTurnsForUser(flaky(1), f.workspace.id, f.channelId, f.owner, { limit: 1 })
      ).rejects.toThrow('connection terminated unexpectedly')
      // Deliberate unavailability is still the only thing that omits a turn.
      const healthy = await listAddressedTurnsForUser(
        connection.db,
        f.workspace.id,
        f.channelId,
        f.owner,
        { limit: 1 }
      )
      expect(healthy.turns.map((turn) => turn.id)).toEqual([first.turn.id])
      const rest = await listAddressedTurnsForUser(
        connection.db,
        f.workspace.id,
        f.channelId,
        f.owner,
        { after: healthy.nextAfter! }
      )
      expect(rest.turns.map((turn) => turn.id)).toEqual([second.turn.id])
    }
  )
})
