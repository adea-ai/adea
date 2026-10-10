import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { UserPrincipalRef } from '@adea-ai/types'

import { createAgent } from '../../src/agents'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createMessage } from '../../src/conversations'
import {
  AddressedTurnError,
  causalIdForAddressedTurn,
  claimAddressedTurn,
  decideAddressedTurn,
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
} from '../../src/group-channels'
import { createTemporaryUserSession } from '../../src/identity'
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
    const first = await claimAddressedTurn(connection.db, f.workspace.id, input, { now: NOW })
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
    const second = await claimAddressedTurn(connection.db, f.workspace.id, input, { now: NOW })
    expect(second.status).toBe('duplicate')
    expect(second.turn.id).toBe(first.turn.id)
    const rows = await loadAddressedTurns(connection.db, f.workspace.id, f.channelId)
    expect(rows).toHaveLength(1)
  })

  T('a restart replays the same claim instead of forking a second turn', async () => {
    const f = await groupWithAgent()
    const input = claimInput(f.channelId, f.triggerMessageId, f.agent.id, f.owner)
    const first = await claimAddressedTurn(connection.db, f.workspace.id, input, { now: NOW })
    await connection.close()
    connection = createDatabase(connectionUrl!)
    const replay = await claimAddressedTurn(connection.db, f.workspace.id, input, { now: NOW })
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
        first.turn.id,
        response.id
      )
      expect(recorded).toMatchObject({ responseMessageId: response.id, state: 'responded' })
      const redelivered = await recordAddressedTurnResponse(
        connection.db,
        f.workspace.id,
        first.turn.id,
        response.id
      )
      expect(redelivered.id).toBe(first.turn.id)
      expect(redelivered.responseMessageId).toBe(response.id)
      // A dispatch revision bump addresses a genuinely new turn.
      const second = await claimAddressedTurn(
        connection.db,
        f.workspace.id,
        claimInput(f.channelId, f.triggerMessageId, f.agent.id, f.owner, { dispatchRevision: 2 }),
        { now: NOW }
      )
      expect(second.status).toBe('claimed')
      expect(second.turn.id).not.toBe(first.turn.id)
    }
  )

  T('recursive turns stay inside the recorded budget', async () => {
    const f = await groupWithAgent()
    const root = await claimAddressedTurn(
      connection.db,
      f.workspace.id,
      claimInput(f.channelId, f.triggerMessageId, f.agent.id, f.owner, {
        budget: { maxDepth: 1, maxTurns: 2 },
      }),
      { now: NOW }
    )
    expect(root.status).toBe('claimed')
    const child = await claimAddressedTurn(
      connection.db,
      f.workspace.id,
      claimInput(f.channelId, f.triggerMessageId, f.agent.id, f.owner, {
        budget: { maxDepth: 1, maxTurns: 2 },
        dispatchRevision: 2,
        parentTurnId: root.turn.id,
      }),
      { now: NOW }
    )
    expect(child.status).toBe('claimed')
    expect(child.turn.depth).toBe(1)
    await expect(
      claimAddressedTurn(
        connection.db,
        f.workspace.id,
        claimInput(f.channelId, f.triggerMessageId, f.agent.id, f.owner, {
          budget: { maxDepth: 1, maxTurns: 8 },
          dispatchRevision: 3,
          parentTurnId: child.turn.id,
        }),
        { now: NOW }
      )
    ).rejects.toThrow('turn_depth_exceeded')
    await expect(
      claimAddressedTurn(
        connection.db,
        f.workspace.id,
        claimInput(f.channelId, f.triggerMessageId, f.agent.id, f.owner, {
          budget: { maxDepth: 1, maxTurns: 2 },
          dispatchRevision: 3,
        }),
        { now: NOW }
      )
    ).rejects.toThrow('turn_budget_exhausted')
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
      NOW
    )
    expect(decision).toEqual({ action: 'deny', reason: 'turn_not_addressed' })
    // Nothing auto-claimed: addressing is always explicit.
    expect(await loadAddressedTurns(connection.db, f.workspace.id, f.channelId)).toHaveLength(0)
  })

  T('human input supersedes stale claims; reconnect replays live work in order', async () => {
    const f = await groupWithAgent()
    const live = await claimAddressedTurn(
      connection.db,
      f.workspace.id,
      claimInput(f.channelId, f.triggerMessageId, f.agent.id, f.owner),
      { now: NOW }
    )
    expect(live.status).toBe('claimed')
    const done = await claimAddressedTurn(
      connection.db,
      f.workspace.id,
      claimInput(f.channelId, f.triggerMessageId, f.agent.id, f.owner, { dispatchRevision: 2 }),
      { now: NOW }
    )
    expect(done.status).toBe('claimed')
    const response = await createMessage(connection.db, f.workspace.id, f.channelId, f.owner, {
      bodyText: 'answered',
      idempotencyKey: crypto.randomUUID(),
      sender: { agentId: f.agent.id, kind: 'agent' },
    })
    await recordAddressedTurnResponse(connection.db, f.workspace.id, done.turn.id, response.id)
    // A newer human message supersedes still-claimed turns only.
    const superseded = await supersedeAddressedTurns(connection.db, f.workspace.id, f.channelId)
    expect(superseded).toBe(1)
    const replay = await loadAddressedTurns(connection.db, f.workspace.id, f.channelId)
    expect(replay.map((turn) => turn.state)).toEqual(['superseded', 'responded'])
    expect(replay.map((turn) => turn.addressedLabel)).toEqual([
      `${f.workspace.id}:${f.agent.id}`,
      `${f.workspace.id}:${f.agent.id}`,
    ])
    // Unknown turns fail closed with the typed error, never null rows.
    await expect(
      recordAddressedTurnResponse(connection.db, f.workspace.id, crypto.randomUUID(), response.id)
    ).rejects.toBeInstanceOf(AddressedTurnError)
  })
})
