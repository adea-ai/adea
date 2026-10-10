import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { UserPrincipalRef } from '@adea-ai/types'
import { and, eq } from 'drizzle-orm'

import { createAgent, ensureWorkspaceLead } from '../../src/agents'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createMessage } from '../../src/conversations'
import { admitAddressedLeadTurn } from '../../src/lead-turns'
import {
  AddressedTurnError,
  cancelAddressedTurn,
  causalIdForAddressedTurn,
  claimAddressedTurn,
  decideAddressedTurn,
  dispatchAddressedTurn,
  loadAddressedTurns,
  recordAddressedTurnResponse,
  supersedeAddressedTurns,
  type AddressedTurnClaimInput,
} from '../../src/group-turn-coordinator'
import {
  createGroupChannelWithGrants,
  groupCreationCandidatesFromGrants,
  loadGroupRoster,
  postGroupChannelMessage,
  revokeGroupGrant,
} from '../../src/group-channels'
import { createTemporaryUserSession } from '../../src/identity'
import * as schema from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL
const ISSUED = '2026-10-01T00:00:00.000Z'
const NOW = '2026-10-08T12:00:00.000Z'

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

describe.skipIf(!connectionUrl)('durable addressed agent turns', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => connection.close())

  async function user(label: string): Promise<UserPrincipalRef> {
    return (
      await createTemporaryUserSession(connection.db, {
        credentialDigest: `addressed-turn-${label}-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000),
      })
    ).principal
  }

  async function groupWithAgent() {
    const owner = await user('owner')
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Addressed turns',
      owner,
    })
    const agent = await createAgent(connection.db, workspace.id, owner, {
      name: 'Echo',
      profileId: 'lead',
      profileVersion: '1',
    })
    const channelId = crypto.randomUUID()
    const founder = {
      expiresAt: null,
      grantId: 'gra_owner',
      groupId: channelId,
      issuedAt: ISSUED,
      participant: owner,
      revision: 1,
      revokedAt: null,
    }
    const enlistment = {
      agent: { agentId: agent.id, workspaceId: workspace.id },
      expiresAt: null,
      grantId: 'gra_echo',
      groupId: channelId,
      issuedAt: ISSUED,
      revision: 1,
      revokedAt: null,
    }
    await createGroupChannelWithGrants(connection.db, workspace.id, owner, {
      candidates: groupCreationCandidatesFromGrants(workspace.id, {
        audienceGrants: [founder],
        enlistmentGrants: [enlistment],
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
    return { agent, channelId, owner, triggerMessageId: trigger.id, workspace }
  }

  T('duplicate claims converge on one durable row before any dispatch', async () => {
    const f = await groupWithAgent()
    const input = claimInput(f.channelId, f.triggerMessageId, f.agent.id, f.owner)
    const first = await claimAddressedTurn(connection.db, f.workspace.id, f.owner, input, {
      now: NOW,
    })
    expect(first.status).toBe('claimed')
    // Causal ID, workspace-qualified label, revision and budget are all
    // persisted before anything is dispatched.
    expect(first.turn).toMatchObject({
      agentId: f.agent.id,
      causalId: causalIdForAddressedTurn(f.triggerMessageId, f.agent.id, 1),
      channelId: f.channelId,
      depth: 0,
      dispatchRevision: 1,
      maxDepth: 2,
      maxTurns: 8,
      state: 'claimed',
      workspaceId: f.workspace.id,
    })
    expect(first.turn.addressedLabel).toBe(`${f.workspace.id}:${f.agent.id}`)
    expect(first.turn.responseMessageId).toBeNull()
    const second = await claimAddressedTurn(connection.db, f.workspace.id, f.owner, input, {
      now: NOW,
    })
    expect(second.status).toBe('duplicate')
    expect(second.turn.id).toBe(first.turn.id)
    const rows = await loadAddressedTurns(connection.db, f.workspace.id, f.channelId)
    expect(rows).toHaveLength(1)
  })

  T('a restart replays the same claim instead of forking a second turn', async () => {
    const f = await groupWithAgent()
    const input = claimInput(f.channelId, f.triggerMessageId, f.agent.id, f.owner)
    const first = await claimAddressedTurn(connection.db, f.workspace.id, f.owner, input, {
      now: NOW,
    })
    await connection.close()
    connection = createDatabase(connectionUrl!)
    const replay = await claimAddressedTurn(connection.db, f.workspace.id, f.owner, input, {
      now: NOW,
    })
    expect(replay.status).toBe('duplicate')
    expect(replay.turn.id).toBe(first.turn.id)
  })

  T(
    'one response per triple: redelivered responses converge, revisions open new slots',
    async () => {
      const f = await groupWithAgent()
      const first = await claimAddressedTurn(
        connection.db,
        f.workspace.id,
        f.owner,
        claimInput(f.channelId, f.triggerMessageId, f.agent.id, f.owner),
        { now: NOW }
      )
      expect(first.status).toBe('claimed')
      const response = await createMessage(connection.db, f.workspace.id, f.channelId, f.owner, {
        bodyText: 'echo answers',
        idempotencyKey: crypto.randomUUID(),
        sender: { agentId: f.agent.id, kind: 'agent' },
      })
      const recorded = await recordAddressedTurnResponse(
        connection.db,
        f.workspace.id,
        f.owner,
        first.turn.id,
        response.id,
        { now: new Date().toISOString() }
      )
      expect(recorded).toMatchObject({ responseMessageId: response.id, state: 'responded' })
      const redelivered = await recordAddressedTurnResponse(
        connection.db,
        f.workspace.id,
        f.owner,
        first.turn.id,
        response.id,
        { now: new Date().toISOString() }
      )
      expect(redelivered.id).toBe(first.turn.id)
      expect(redelivered.responseMessageId).toBe(response.id)
      // A dispatch revision bump addresses a genuinely new turn.
      const second = await claimAddressedTurn(
        connection.db,
        f.workspace.id,
        f.owner,
        claimInput(f.channelId, f.triggerMessageId, f.agent.id, f.owner, { dispatchRevision: 2 }),
        { now: NOW }
      )
      expect(second.status).toBe('claimed')
      expect(second.turn.id).not.toBe(first.turn.id)
    }
  )

  T('concurrent claims respect the budget while duplicates still converge', async () => {
    const f = await groupWithAgent()
    const budget = { maxDepth: 2, maxTurns: 2 }
    // Five distinct claims race for two budget slots; the trigger-row lock
    // linearizes count-then-insert, so exactly two win.
    const races = await Promise.allSettled(
      [1, 2, 3, 4, 5].map((revision) =>
        claimAddressedTurn(
          connection.db,
          f.workspace.id,
          f.owner,
          claimInput(f.channelId, f.triggerMessageId, f.agent.id, f.owner, {
            budget,
            dispatchRevision: revision,
          }),
          { now: NOW }
        )
      )
    )
    const claimed = races.filter(
      (result): result is PromiseFulfilledResult<{ status: 'claimed'; turn: unknown }> =>
        result.status === 'fulfilled' && result.value.status === 'claimed'
    )
    const denied = races.filter(
      (result) =>
        result.status === 'rejected' &&
        result.reason instanceof AddressedTurnError &&
        result.reason.reason === 'turn_budget_exhausted'
    )
    expect(claimed).toHaveLength(2)
    expect(denied).toHaveLength(3)
    // A duplicate retry of a winner returns the retained claim even though
    // the budget is now full — convergence beats capacity.
    const winner = claimed[0]?.value.turn as { id: string; dispatchRevision: number }
    const retry = await claimAddressedTurn(
      connection.db,
      f.workspace.id,
      f.owner,
      claimInput(f.channelId, f.triggerMessageId, f.agent.id, f.owner, {
        budget,
        dispatchRevision: winner.dispatchRevision,
      }),
      { now: NOW }
    )
    expect(retry.status).toBe('duplicate')
    expect(retry.turn.id).toBe(winner.id)
  })

  T('recursive turns inherit the retained root budget; stale parents fail', async () => {
    const f = await groupWithAgent()
    const root = await claimAddressedTurn(
      connection.db,
      f.workspace.id,
      f.owner,
      claimInput(f.channelId, f.triggerMessageId, f.agent.id, f.owner, {
        budget: { maxDepth: 1, maxTurns: 2 },
      }),
      { now: NOW }
    )
    expect(root.status).toBe('claimed')
    const child = await claimAddressedTurn(
      connection.db,
      f.workspace.id,
      f.owner,
      claimInput(f.channelId, f.triggerMessageId, f.agent.id, f.owner, {
        budget: { maxDepth: 1, maxTurns: 2 },
        dispatchRevision: 2,
        parentTurnId: root.turn.id,
      }),
      { now: NOW }
    )
    expect(child.status).toBe('claimed')
    expect(child.turn.depth).toBe(1)
    // A supplied-but-missing parent no longer resets depth to zero.
    await expect(
      claimAddressedTurn(
        connection.db,
        f.workspace.id,
        f.owner,
        claimInput(f.channelId, f.triggerMessageId, f.agent.id, f.owner, {
          dispatchRevision: 3,
          parentTurnId: crypto.randomUUID(),
        }),
        { now: NOW }
      )
    ).rejects.toMatchObject({ name: 'AddressedTurnError', reason: 'turn_parent_unknown' })
    await expect(
      claimAddressedTurn(
        connection.db,
        f.workspace.id,
        f.owner,
        claimInput(f.channelId, f.triggerMessageId, f.agent.id, f.owner, {
          budget: { maxDepth: 1, maxTurns: 8 },
          dispatchRevision: 3,
          parentTurnId: child.turn.id,
        }),
        { now: NOW }
      )
    ).rejects.toMatchObject({ name: 'AddressedTurnError', reason: 'turn_depth_exceeded' })
    // Caller-supplied escalation is ignored: the retained root budget
    // (maxTurns 2, already full) still governs.
    await expect(
      claimAddressedTurn(
        connection.db,
        f.workspace.id,
        f.owner,
        claimInput(f.channelId, f.triggerMessageId, f.agent.id, f.owner, {
          budget: { maxDepth: 9, maxTurns: 99 },
          dispatchRevision: 4,
        }),
        { now: NOW }
      )
    ).rejects.toMatchObject({ name: 'AddressedTurnError', reason: 'turn_budget_exhausted' })
  })

  T('agent chatter never addresses follow-up turns: no broadcast loops', async () => {
    const f = await groupWithAgent()
    await postGroupChannelMessage(
      connection.db,
      f.workspace.id,
      f.channelId,
      f.owner,
      { agentId: f.agent.id, kind: 'agent' },
      {
        message: { bodyText: 'echo muses', idempotencyKey: crypto.randomUUID() },
        mode: 'direct',
      },
      { now: NOW }
    )
    const roster = await loadGroupRoster(connection.db, f.workspace.id, f.channelId)
    const decision = decideAddressedTurn(
      {
        ...claimInput(f.channelId, f.triggerMessageId, f.agent.id, f.owner),
        addressedBy: { agentId: f.agent.id, kind: 'agent' } as unknown as {
          kind: 'user'
          userId: string
        },
      },
      roster,
      null,
      { maxDepth: 2, maxTurns: 8 },
      NOW,
      { addresserBound: false, addresserEffective: false }
    )
    expect(decision).toEqual({ action: 'deny', reason: 'turn_not_addressed' })
    // Nothing auto-claimed: addressing is always explicit.
    expect(await loadAddressedTurns(connection.db, f.workspace.id, f.channelId)).toHaveLength(0)
  })

  T('forged triggers fail before writes: unknown, alien, agent-authored, unbound', async () => {
    const f = await groupWithAgent()
    const input = () => claimInput(f.channelId, f.triggerMessageId, f.agent.id, f.owner)
    // Unknown message id.
    await expect(
      claimAddressedTurn(
        connection.db,
        f.workspace.id,
        f.owner,
        { ...input(), triggerMessageId: crypto.randomUUID() },
        { now: NOW }
      )
    ).rejects.toMatchObject({ name: 'AddressedTurnError', reason: 'turn_trigger_unknown' })
    // A real message from another channel of the same workspace.
    const otherChannelId = crypto.randomUUID()
    await createGroupChannelWithGrants(connection.db, f.workspace.id, f.owner, {
      candidates: groupCreationCandidatesFromGrants(f.workspace.id, {
        audienceGrants: [
          {
            expiresAt: null,
            grantId: 'gra_owner_2',
            groupId: otherChannelId,
            issuedAt: ISSUED,
            participant: f.owner,
            revision: 1,
            revokedAt: null,
          },
        ],
        enlistmentGrants: [],
      }),
      channelId: otherChannelId,
      idempotencyKey: crypto.randomUUID(),
      now: NOW,
      title: 'Other',
    })
    const alien = await postGroupChannelMessage(
      connection.db,
      f.workspace.id,
      otherChannelId,
      f.owner,
      f.owner,
      {
        message: { bodyText: 'unrelated', idempotencyKey: crypto.randomUUID() },
        mode: 'direct',
      },
      { now: NOW }
    )
    await expect(
      claimAddressedTurn(
        connection.db,
        f.workspace.id,
        f.owner,
        { ...input(), triggerMessageId: alien.id },
        { now: NOW }
      )
    ).rejects.toMatchObject({ name: 'AddressedTurnError', reason: 'turn_trigger_unknown' })
    // addressedBy must equal the authenticated principal.
    const outsider = await user('outsider')
    await expect(
      claimAddressedTurn(connection.db, f.workspace.id, outsider, input(), { now: NOW })
    ).rejects.toMatchObject({ name: 'AddressedTurnError', reason: 'turn_addresser_mismatch' })
    // An agent-authored message can never trigger addressing.
    const agentNote = await postGroupChannelMessage(
      connection.db,
      f.workspace.id,
      f.channelId,
      f.owner,
      { agentId: f.agent.id, kind: 'agent' },
      {
        message: { bodyText: 'echo muses', idempotencyKey: crypto.randomUUID() },
        mode: 'direct',
      },
      { now: NOW }
    )
    await expect(
      claimAddressedTurn(
        connection.db,
        f.workspace.id,
        f.owner,
        { ...input(), triggerMessageId: agentNote.id },
        { now: NOW }
      )
    ).rejects.toMatchObject({ name: 'AddressedTurnError', reason: 'turn_trigger_forged' })
  })

  T('a revoked principal cannot obtain even a duplicate turn', async () => {
    const f = await groupWithAgent()
    const input = claimInput(f.channelId, f.triggerMessageId, f.agent.id, f.owner)
    const first = await claimAddressedTurn(connection.db, f.workspace.id, f.owner, input, {
      now: NOW,
    })
    expect(first.status).toBe('claimed')
    await revokeGroupGrant(connection.db, f.workspace.id, f.channelId, f.owner, {
      grantId: 'gra_owner',
      kind: 'audience',
      revokedAt: new Date().toISOString(),
    })
    // The retained claim exists, but the revoked principal is revalidated
    // before any duplicate is handed back — budget state is irrelevant.
    await expect(
      claimAddressedTurn(connection.db, f.workspace.id, f.owner, input, {
        now: new Date().toISOString(),
      })
    ).rejects.toMatchObject({ name: 'AddressedTurnError', reason: 'turn_not_participant' })
  })

  T('a forged principal cannot obtain even a duplicate turn', async () => {
    const f = await groupWithAgent()
    const input = claimInput(f.channelId, f.triggerMessageId, f.agent.id, f.owner)
    const first = await claimAddressedTurn(connection.db, f.workspace.id, f.owner, input, {
      now: NOW,
    })
    expect(first.status).toBe('claimed')
    // A live outsider replays the owner's exact triple with their own
    // identity: unbound to the canonical trigger, they are rejected
    // before the duplicate short-circuit.
    const outsider = await user('outsider')
    await expect(
      claimAddressedTurn(
        connection.db,
        f.workspace.id,
        outsider,
        { ...input, addressedBy: outsider },
        { now: new Date().toISOString() }
      )
    ).rejects.toMatchObject({ name: 'AddressedTurnError', reason: 'turn_trigger_forged' })
  })

  T('superseded claims never dispatch, even after the agent becomes lead', async () => {
    const f = await groupWithAgent()
    const input = claimInput(f.channelId, f.triggerMessageId, f.agent.id, f.owner)
    const first = await claimAddressedTurn(connection.db, f.workspace.id, f.owner, input, {
      now: NOW,
    })
    expect(first.status).toBe('claimed')
    // Non-lead addressed turns stay claimed: no intent is minted.
    await expect(
      dispatchAddressedTurn(connection.db, f.workspace.id, f.owner, input, { now: NOW })
    ).rejects.toMatchObject({ name: 'AddressedTurnError', reason: 'turn_not_lead' })
    const intentsBefore = await connection.db
      .select({ id: schema.leadTurnIntents.id })
      .from(schema.leadTurnIntents)
      .where(eq(schema.leadTurnIntents.channelId, f.channelId))
    // Human input supersedes the stale claim; promoting the agent to lead
    // afterwards must not resurrect it — the retry binds to retained
    // state, not to a fresh synthetic message.
    expect(await supersedeAddressedTurns(connection.db, f.workspace.id, f.channelId, f.owner)).toBe(
      1
    )
    await connection.db
      .update(schema.agents)
      .set({ isWorkspaceLead: true })
      .where(eq(schema.agents.id, f.agent.id))
    await expect(
      dispatchAddressedTurn(connection.db, f.workspace.id, f.owner, input, { now: NOW })
    ).rejects.toMatchObject({ name: 'AddressedTurnError', reason: 'turn_superseded' })
    const intentsAfter = await connection.db
      .select({ id: schema.leadTurnIntents.id })
      .from(schema.leadTurnIntents)
      .where(eq(schema.leadTurnIntents.channelId, f.channelId))
    expect(intentsAfter).toHaveLength(intentsBefore.length)
  })

  T('human input supersedes stale claims; reconnect replays live work in order', async () => {
    const f = await groupWithAgent()
    const live = await claimAddressedTurn(
      connection.db,
      f.workspace.id,
      f.owner,
      claimInput(f.channelId, f.triggerMessageId, f.agent.id, f.owner),
      { now: NOW }
    )
    expect(live.status).toBe('claimed')
    const done = await claimAddressedTurn(
      connection.db,
      f.workspace.id,
      f.owner,
      claimInput(f.channelId, f.triggerMessageId, f.agent.id, f.owner, { dispatchRevision: 2 }),
      { now: NOW }
    )
    expect(done.status).toBe('claimed')
    const response = await createMessage(connection.db, f.workspace.id, f.channelId, f.owner, {
      bodyText: 'answered',
      idempotencyKey: crypto.randomUUID(),
      sender: { agentId: f.agent.id, kind: 'agent' },
    })
    await recordAddressedTurnResponse(
      connection.db,
      f.workspace.id,
      f.owner,
      done.turn.id,
      response.id,
      {
        now: new Date().toISOString(),
      }
    )
    // A newer human message supersedes still-claimed turns only.
    const superseded = await supersedeAddressedTurns(
      connection.db,
      f.workspace.id,
      f.channelId,
      f.owner
    )
    expect(superseded).toBe(1)
    const replay = await loadAddressedTurns(connection.db, f.workspace.id, f.channelId)
    expect(replay.map((turn) => turn.state)).toEqual(['superseded', 'responded'])
    expect(replay.map((turn) => turn.addressedLabel)).toEqual([
      `${f.workspace.id}:${f.agent.id}`,
      `${f.workspace.id}:${f.agent.id}`,
    ])
    // Unknown turns fail closed with the typed error, never null rows.
    await expect(
      recordAddressedTurnResponse(
        connection.db,
        f.workspace.id,
        f.owner,
        crypto.randomUUID(),
        response.id,
        { now: new Date().toISOString() }
      )
    ).rejects.toBeInstanceOf(AddressedTurnError)
  })

  T('response recording binds agent, channel and recorder — nothing arbitrary', async () => {
    const f = await groupWithAgent()
    const claimed = await claimAddressedTurn(
      connection.db,
      f.workspace.id,
      f.owner,
      claimInput(f.channelId, f.triggerMessageId, f.agent.id, f.owner),
      { now: NOW }
    )
    expect(claimed.status).toBe('claimed')
    // An unknown message id is not a publication here.
    await expect(
      recordAddressedTurnResponse(
        connection.db,
        f.workspace.id,
        f.owner,
        claimed.turn.id,
        crypto.randomUUID(),
        { now: new Date().toISOString() }
      )
    ).rejects.toMatchObject({ name: 'AddressedTurnError', reason: 'turn_response_unbound' })
    // A human-authored message is not the claimed Agent's response.
    const humanNote = await createMessage(connection.db, f.workspace.id, f.channelId, f.owner, {
      bodyText: 'owner note',
      idempotencyKey: crypto.randomUUID(),
      sender: f.owner,
    })
    await expect(
      recordAddressedTurnResponse(
        connection.db,
        f.workspace.id,
        f.owner,
        claimed.turn.id,
        humanNote.id,
        { now: new Date().toISOString() }
      )
    ).rejects.toMatchObject({ name: 'AddressedTurnError', reason: 'turn_response_unbound' })
    // A recorder without effective participation cannot publish.
    const stranger = await user('stranger')
    const response = await createMessage(connection.db, f.workspace.id, f.channelId, f.owner, {
      bodyText: 'echo answers',
      idempotencyKey: crypto.randomUUID(),
      sender: { agentId: f.agent.id, kind: 'agent' },
    })
    await expect(
      recordAddressedTurnResponse(
        connection.db,
        f.workspace.id,
        stranger,
        claimed.turn.id,
        response.id,
        {
          now: new Date().toISOString(),
        }
      )
    ).rejects.toMatchObject({ name: 'AddressedTurnError', reason: 'turn_response_unauthorized' })
  })

  T('dispatch reaches the resolved lead through the existing lead-turn adapter', async () => {
    const owner = await user('lead-owner')
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Lead dispatch',
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
    const messagesBefore = await connection.db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(
        and(eq(schema.messages.workspaceId, workspace.id), eq(schema.messages.channelId, channelId))
      )
    const dispatched = await dispatchAddressedTurn(
      connection.db,
      workspace.id,
      owner,
      claimInput(channelId, trigger.id, lead.id, owner),
      { now: NOW }
    )
    expect(dispatched.claim.status).toBe('claimed')
    expect(dispatched.intent.triggerMessageId).toBe(trigger.id)
    // The intent binds the ORIGINAL trigger id and content: the stored
    // intent row names the trigger message, whose body is untouched.
    const [intentRow] = await connection.db
      .select()
      .from(schema.leadTurnIntents)
      .where(eq(schema.leadTurnIntents.messageId, trigger.id))
      .limit(1)
    expect(intentRow?.agentId).toBe(lead.id)
    expect(intentRow?.id).toBe(dispatched.intent.leadTurn.intentId)
    const [triggerRow] = await connection.db
      .select({ bodyText: schema.messages.bodyText })
      .from(schema.messages)
      .where(eq(schema.messages.id, trigger.id))
      .limit(1)
    expect(triggerRow?.bodyText).toBe('please answer')
    // Dispatch mints no human message: the count is unchanged.
    const messagesAfter = await connection.db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(
        and(eq(schema.messages.workspaceId, workspace.id), eq(schema.messages.channelId, channelId))
      )
    expect(messagesAfter.map((row) => row.id).toSorted()).toEqual(
      messagesBefore.map((row) => row.id).toSorted()
    )
    // Redispatch converges: same claim row, same intent.
    const again = await dispatchAddressedTurn(
      connection.db,
      workspace.id,
      owner,
      claimInput(channelId, trigger.id, lead.id, owner),
      { now: NOW }
    )
    expect(again.claim.status).toBe('duplicate')
    expect(again.claim.turn.id).toBe(dispatched.claim.turn.id)
    expect(again.intent.leadTurn.intentId).toBe(dispatched.intent.leadTurn.intentId)
    // Revoking the human's participation denies further claims.
    await revokeGroupGrant(connection.db, workspace.id, channelId, owner, {
      grantId: 'gra_owner',
      kind: 'audience',
      revokedAt: new Date().toISOString(),
    })
    await expect(
      claimAddressedTurn(
        connection.db,
        workspace.id,
        owner,
        claimInput(channelId, trigger.id, lead.id, owner, { dispatchRevision: 9 }),
        { now: new Date().toISOString() }
      )
    ).rejects.toBeInstanceOf(AddressedTurnError)
  })

  T('parked dispatch loses to a committed supersede: no intent is minted', async () => {
    // Two-connection linearizability at the existing admission boundary:
    // the dispatch parks after claiming but before its atomic decision;
    // a supersede that commits first wins and the resumed dispatch mints
    // nothing. No second runtime, no extra lock service — the claim row's
    // own lock plus the conditional flip decide the order.
    const f = await groupWithAgent()
    const input = claimInput(f.channelId, f.triggerMessageId, f.agent.id, f.owner)
    // The agent must be the resolved lead so the dispatch would mint if
    // the supersede did not win first.
    await connection.db
      .update(schema.agents)
      .set({ isWorkspaceLead: true })
      .where(eq(schema.agents.id, f.agent.id))
    const second = createDatabase(connectionUrl!)
    try {
      let release!: () => void
      let markParked!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const parkedPromise = new Promise<void>((resolve) => {
        markParked = resolve
      })
      const dispatching = dispatchAddressedTurn(connection.db, f.workspace.id, f.owner, input, {
        barrier: {
          beforeDispatchDecision: async () => {
            markParked()
            await gate
          },
        },
        now: NOW,
      })
      await parkedPromise
      expect(await supersedeAddressedTurns(second.db, f.workspace.id, f.channelId, f.owner)).toBe(1)
      release()
      await expect(dispatching).rejects.toMatchObject({
        name: 'AddressedTurnError',
        reason: 'turn_superseded',
      })
      const intents = await connection.db
        .select({ id: schema.leadTurnIntents.id })
        .from(schema.leadTurnIntents)
        .where(eq(schema.leadTurnIntents.channelId, f.channelId))
      expect(intents).toHaveLength(0)
    } finally {
      await second.close()
    }
  })

  T('same-named agents from two sources keep distinct source labels', async () => {
    // The label binds the verified SOURCE workspace while the row keeps
    // host ownership: an authorized foreign Agent never wears the host's
    // identity, even when display names collide.
    const owner = await user('label-owner')
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Labels home',
      owner,
    })
    const otherOwner = await user('label-other')
    const other = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Labels away',
      owner: otherOwner,
    })
    const echoHome = await createAgent(connection.db, workspace.id, owner, {
      name: 'Echo',
      profileId: 'lead',
      profileVersion: '1',
    })
    const echoAway = await createAgent(connection.db, other.workspace.id, otherOwner, {
      name: 'Echo',
      profileId: 'lead',
      profileVersion: '1',
    })
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
            agent: { agentId: echoHome.id, workspaceId: workspace.id },
            expiresAt: null,
            grantId: 'gra_home',
            groupId: channelId,
            issuedAt: ISSUED,
            revision: 1,
            revokedAt: null,
          },
          {
            agent: { agentId: echoAway.id, workspaceId: other.workspace.id },
            expiresAt: null,
            grantId: 'gra_away',
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
        message: { bodyText: 'answer please', idempotencyKey: crypto.randomUUID() },
        mode: 'direct',
      },
      { now: NOW }
    )
    const home = await claimAddressedTurn(
      connection.db,
      workspace.id,
      owner,
      claimInput(channelId, trigger.id, echoHome.id, owner),
      { now: NOW }
    )
    const away = await claimAddressedTurn(
      connection.db,
      workspace.id,
      owner,
      claimInput(channelId, trigger.id, echoAway.id, owner, { dispatchRevision: 2 }),
      { now: NOW }
    )
    expect(home.status).toBe('claimed')
    expect(away.status).toBe('claimed')
    expect(home.turn.addressedLabel).toBe(`${workspace.id}:${echoHome.id}`)
    expect(away.turn.addressedLabel).toBe(`${other.workspace.id}:${echoAway.id}`)
    expect(home.turn.workspaceId).toBe(workspace.id)
    expect(away.turn.workspaceId).toBe(workspace.id)
  })

  T('parked lead swap cannot launch the other agent', async () => {
    // The addressed Agent is enforced inside the canonical admission
    // transaction: a swap that commits while dispatch is parked denies at
    // the pre-check, and the admission itself would deny all the same —
    // neither agent launches anything.
    const f = await groupWithAgent()
    const other = await createAgent(connection.db, f.workspace.id, f.owner, {
      name: 'Other',
      profileId: 'lead',
      profileVersion: '1',
    })
    await connection.db
      .update(schema.agents)
      .set({ isWorkspaceLead: true })
      .where(eq(schema.agents.id, f.agent.id))
    const input = claimInput(f.channelId, f.triggerMessageId, f.agent.id, f.owner)
    let release!: () => void
    let markParked!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const parkedPromise = new Promise<void>((resolve) => {
      markParked = resolve
    })
    const dispatching = dispatchAddressedTurn(connection.db, f.workspace.id, f.owner, input, {
      barrier: {
        beforeDispatchDecision: async () => {
          markParked()
          await gate
        },
      },
      now: NOW,
    })
    await parkedPromise
    // Swap the lead while dispatch is parked.
    await connection.db
      .update(schema.agents)
      .set({ isWorkspaceLead: false })
      .where(eq(schema.agents.id, f.agent.id))
    await connection.db
      .update(schema.agents)
      .set({ isWorkspaceLead: true })
      .where(eq(schema.agents.id, other.id))
    release()
    await expect(dispatching).rejects.toMatchObject({
      name: 'AddressedTurnError',
      reason: 'turn_not_lead',
    })
    const intents = await connection.db
      .select({ id: schema.leadTurnIntents.id })
      .from(schema.leadTurnIntents)
      .where(eq(schema.leadTurnIntents.channelId, f.channelId))
    expect(intents).toHaveLength(0)
  })

  T('admission enforces the expected agent inside its own transaction', async () => {
    // Direct proof of the in-transaction enforcement: even with a live
    // claim and an effective principal, an expected id that is not the
    // resolved lead denies inside lockAuthority — no intent, no message.
    const f = await groupWithAgent()
    await connection.db
      .update(schema.agents)
      .set({ isWorkspaceLead: true })
      .where(eq(schema.agents.id, f.agent.id))
    const messagesBefore = await connection.db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.workspaceId, f.workspace.id),
          eq(schema.messages.channelId, f.channelId)
        )
      )
    await expect(
      admitAddressedLeadTurn(connection.db, f.workspace.id, f.channelId, f.owner, {
        expectedAgentId: crypto.randomUUID(),
        triggerMessageId: f.triggerMessageId,
      })
    ).rejects.toThrow('Lead turn unavailable')
    const messagesAfter = await connection.db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.workspaceId, f.workspace.id),
          eq(schema.messages.channelId, f.channelId)
        )
      )
    expect(messagesAfter.map((row) => row.id).toSorted()).toEqual(
      messagesBefore.map((row) => row.id).toSorted()
    )
  })

  T('addresser cancels a live claim; outsiders cannot; terminals hold', async () => {
    const f = await groupWithAgent()
    const input = claimInput(f.channelId, f.triggerMessageId, f.agent.id, f.owner)
    const first = await claimAddressedTurn(connection.db, f.workspace.id, f.owner, input, {
      now: NOW,
    })
    expect(first.status).toBe('claimed')
    // The addresser cancels: no intent was ever minted, so no runtime
    // holds anything and the outcome reports it instead of failing.
    await expect(
      cancelAddressedTurn(connection.db, f.workspace.id, f.owner, first.turn.id)
    ).resolves.toEqual({ runtimeCancelRequested: false, state: 'cancelled' })
    // Re-cancelling converges on the terminal state.
    await expect(
      cancelAddressedTurn(connection.db, f.workspace.id, f.owner, first.turn.id)
    ).resolves.toEqual({ runtimeCancelRequested: false, state: 'cancelled' })
    // An outsider with no participation cannot cancel live claims.
    const second = await claimAddressedTurn(
      connection.db,
      f.workspace.id,
      f.owner,
      claimInput(f.channelId, f.triggerMessageId, f.agent.id, f.owner, { dispatchRevision: 5 }),
      { now: NOW }
    )
    expect(second.status).toBe('claimed')
    const outsider = await user('outsider')
    await expect(
      cancelAddressedTurn(connection.db, f.workspace.id, outsider, second.turn.id)
    ).rejects.toMatchObject({ name: 'AddressedTurnError', reason: 'turn_cancel_unauthorized' })
    // A responded turn already has its response: cancellation is refused.
    const response = await createMessage(connection.db, f.workspace.id, f.channelId, f.owner, {
      bodyText: 'echo answers',
      idempotencyKey: crypto.randomUUID(),
      sender: { agentId: f.agent.id, kind: 'agent' },
    })
    await recordAddressedTurnResponse(
      connection.db,
      f.workspace.id,
      f.owner,
      second.turn.id,
      response.id,
      { now: new Date().toISOString() }
    )
    await expect(
      cancelAddressedTurn(connection.db, f.workspace.id, f.owner, second.turn.id)
    ).rejects.toMatchObject({ name: 'AddressedTurnError', reason: 'turn_already_responded' })
  })

  T('cancelled claims never dispatch and never record', async () => {
    const f = await groupWithAgent()
    await connection.db
      .update(schema.agents)
      .set({ isWorkspaceLead: true })
      .where(eq(schema.agents.id, f.agent.id))
    const input = claimInput(f.channelId, f.triggerMessageId, f.agent.id, f.owner)
    const first = await claimAddressedTurn(connection.db, f.workspace.id, f.owner, input, {
      now: NOW,
    })
    expect(first.status).toBe('claimed')
    await cancelAddressedTurn(connection.db, f.workspace.id, f.owner, first.turn.id)
    await expect(
      dispatchAddressedTurn(connection.db, f.workspace.id, f.owner, input, { now: NOW })
    ).rejects.toMatchObject({ name: 'AddressedTurnError', reason: 'turn_cancelled' })
    const intents = await connection.db
      .select({ id: schema.leadTurnIntents.id })
      .from(schema.leadTurnIntents)
      .where(eq(schema.leadTurnIntents.channelId, f.channelId))
    expect(intents).toHaveLength(0)
    // A late agent answer finds no live turn: convergent, unrecorded.
    const late = await createMessage(connection.db, f.workspace.id, f.channelId, f.owner, {
      bodyText: 'too late',
      idempotencyKey: crypto.randomUUID(),
      sender: { agentId: f.agent.id, kind: 'agent' },
    })
    const current = await recordAddressedTurnResponse(
      connection.db,
      f.workspace.id,
      f.owner,
      first.turn.id,
      late.id,
      { now: new Date().toISOString() }
    )
    expect(current.state).toBe('cancelled')
    expect(current.responseMessageId).toBeNull()
  })

  T('new human messages auto-supersede stale claims inside the post', async () => {
    // Production wiring proof: no explicit supersede call — the fenced
    // human post retires live claims in the same transaction.
    const f = await groupWithAgent()
    const first = await claimAddressedTurn(
      connection.db,
      f.workspace.id,
      f.owner,
      claimInput(f.channelId, f.triggerMessageId, f.agent.id, f.owner),
      { now: NOW }
    )
    expect(first.status).toBe('claimed')
    await postGroupChannelMessage(
      connection.db,
      f.workspace.id,
      f.channelId,
      f.owner,
      f.owner,
      {
        message: { bodyText: 'actually, never mind', idempotencyKey: crypto.randomUUID() },
        mode: 'direct',
      },
      { now: NOW }
    )
    const replay = await loadAddressedTurns(connection.db, f.workspace.id, f.channelId)
    expect(replay.map((turn) => turn.state)).toEqual(['superseded'])
  })

  T('cross-workspace addressed lead cancels cleanly with labels intact', async () => {
    const owner = await user('xws-owner')
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'XWS host',
      owner,
    })
    const otherOwner = await user('xws-other')
    const other = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'XWS away',
      owner: otherOwner,
    })
    const leadAway = await ensureWorkspaceLead(connection.db, other.workspace.id, otherOwner)
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
            agent: { agentId: leadAway.id, workspaceId: other.workspace.id },
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
    const dispatched = await dispatchAddressedTurn(
      connection.db,
      workspace.id,
      owner,
      claimInput(channelId, trigger.id, leadAway.id, owner),
      { now: NOW }
    )
    expect(dispatched.claim.status).toBe('claimed')
    // The addresser (also the intent actor) cancels: the claim flips and
    // the intent cancel is attempted through the existing boundary — with
    // no executor holding it, the outcome reports back cleanly.
    await expect(
      cancelAddressedTurn(connection.db, workspace.id, owner, dispatched.claim.turn.id)
    ).resolves.toEqual({ runtimeCancelRequested: false, state: 'cancelled' })
    const replay = await loadAddressedTurns(connection.db, workspace.id, channelId)
    expect(replay.map((turn) => [turn.state, turn.addressedLabel])).toEqual([
      ['cancelled', `${other.workspace.id}:${leadAway.id}`],
    ])
  })
})
