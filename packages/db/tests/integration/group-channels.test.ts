import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { GroupAdmission, UserPrincipalRef } from '@adea-ai/types'
import { and, eq } from 'drizzle-orm'

import { createAgent } from '../../src/agents'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import {
  authorizeGroupChannelHistoryRead,
  authorizeGroupChannelPublication,
  authorizeGroupChannelTurn,
  createGroupChannelWithGrants,
  groupCreationCandidatesFromGrants,
  GroupCreationError,
  setGroupChannelParticipantsWithGrants,
} from '../../src/group-channels'
import { createMessage } from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import * as schema from '../../src/schema'
import { addWorkspaceMembership, createWorkspaceWithOwner } from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL

const ISSUED = '2026-10-01T00:00:00.000Z'
const NOW = '2026-10-08T12:00:00.000Z'

describe.skipIf(!connectionUrl)('grant-gated group channels', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => connection.close())

  async function user(label: string): Promise<UserPrincipalRef> {
    return (
      await createTemporaryUserSession(connection.db, {
        credentialDigest: `group-channels-${label}-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000),
      })
    ).principal
  }

  async function fixture() {
    const owner = await user('owner')
    const member = await user('member')
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Grant-gated groups',
      owner,
    })
    await addWorkspaceMembership(connection.db, workspace.id, member, 'member')
    const agent = await createAgent(connection.db, workspace.id, owner, {
      name: 'Doc',
      profileId: 'lead',
      profileVersion: '1',
    })
    return { agent, member, owner, workspace }
  }

  test('atomically creates a tenant-bounded group with a grant-validated roster', async () => {
    const f = await fixture()
    const channelId = crypto.randomUUID()
    const candidates = groupCreationCandidatesFromGrants(f.workspace.id, {
      audienceGrants: [
        {
          expiresAt: null,
          grantId: 'gra_owner',
          groupId: channelId,
          issuedAt: ISSUED,
          participant: f.owner,
          revision: 1,
          revokedAt: null,
        },
        {
          expiresAt: null,
          grantId: 'gra_member',
          groupId: channelId,
          issuedAt: ISSUED,
          participant: f.member,
          revision: 1,
          revokedAt: null,
        },
      ],
      enlistmentGrants: [
        {
          agent: { agentId: f.agent.id, workspaceId: f.workspace.id },
          expiresAt: null,
          grantId: 'gra_doc',
          groupId: channelId,
          issuedAt: ISSUED,
          revision: 1,
          revokedAt: null,
        },
      ],
    })
    const { channel, roster } = await createGroupChannelWithGrants(
      connection.db,
      f.workspace.id,
      f.owner,
      { candidates, channelId, idempotencyKey: crypto.randomUUID(), now: NOW, title: 'Group' }
    )
    expect(channel.id).toBe(channelId)
    expect(channel.kind).toBe('group')
    expect(channel.visibility).toBe('participants')
    expect(channel.projectId).toBeUndefined()
    expect(channel.agentId).toBeUndefined()
    expect(roster).toHaveLength(3)
    expect(roster.every((admission) => admission.authorization.groupId === channelId)).toBe(true)
    expect(
      roster.every(
        (admission) =>
          admission.joinPoint.joinedSequence === 0 && admission.joinPoint.joinedAt === NOW
      )
    ).toBe(true)
    const rows = await connection.db
      .select()
      .from(schema.channelParticipants)
      .where(
        and(
          eq(schema.channelParticipants.workspaceId, f.workspace.id),
          eq(schema.channelParticipants.channelId, channelId)
        )
      )
    expect(rows).toHaveLength(3)
  })

  test('an invalid roster fails the whole creation with zero writes', async () => {
    const f = await fixture()
    const channelId = crypto.randomUUID()
    const key = crypto.randomUUID()
    const candidates = groupCreationCandidatesFromGrants(f.workspace.id, {
      audienceGrants: [],
      enlistmentGrants: [],
    })
    const failure = await createGroupChannelWithGrants(connection.db, f.workspace.id, f.owner, {
      candidates,
      channelId,
      idempotencyKey: key,
      now: NOW,
      title: 'Group',
    }).then(
      () => {
        throw new Error('creation must reject')
      },
      (error: unknown) => error
    )
    expect(failure).toBeInstanceOf(GroupCreationError)
    const rows = await connection.db
      .select()
      .from(schema.channels)
      .where(
        and(
          eq(schema.channels.workspaceId, f.workspace.id),
          eq(schema.channels.idempotencyKey, key)
        )
      )
    expect(rows).toHaveLength(0)
  })

  test('a cross-tenant grant fails creation without writing the channel', async () => {
    const f = await fixture()
    const outsider = await user('outsider')
    const channelId = crypto.randomUUID()
    const key = crypto.randomUUID()
    const candidates = groupCreationCandidatesFromGrants(f.workspace.id, {
      audienceGrants: [
        {
          expiresAt: null,
          grantId: 'gra_owner',
          groupId: channelId,
          issuedAt: ISSUED,
          participant: f.owner,
          revision: 1,
          revokedAt: null,
        },
        {
          expiresAt: null,
          grantId: 'gra_outsider',
          groupId: channelId,
          issuedAt: ISSUED,
          participant: outsider,
          revision: 1,
          revokedAt: null,
        },
      ],
      enlistmentGrants: [],
    })
    // The outsider resolves outside the owning workspace: the policy rejects
    // them as cross-tenant with the workspace they were resolved in.
    const crossTenant = candidates.map((candidate) =>
      candidate.kind === 'human' && candidate.participant.userId === outsider.userId
        ? { ...candidate, workspaceId: 'wsp_elsewhere' }
        : candidate
    )
    const failure = await createGroupChannelWithGrants(connection.db, f.workspace.id, f.owner, {
      candidates: crossTenant,
      channelId,
      idempotencyKey: key,
      now: NOW,
      title: 'Group',
    }).then(
      () => {
        throw new Error('creation must reject')
      },
      (error: unknown) => error
    )
    expect(failure).toBeInstanceOf(GroupCreationError)
    expect(
      (failure as GroupCreationError).rejections.some(
        (rejection) =>
          rejection.scope === 'candidate' && rejection.reason === 'participant_cross_tenant'
      )
    ).toBe(true)
    const rows = await connection.db
      .select()
      .from(schema.channels)
      .where(
        and(
          eq(schema.channels.workspaceId, f.workspace.id),
          eq(schema.channels.idempotencyKey, key)
        )
      )
    expect(rows).toHaveLength(0)
  })

  test('a revoked grant denies future reads and turns while the job stays independently owned', async () => {
    const f = await fixture()
    const channelId = crypto.randomUUID()
    const live = {
      expiresAt: null,
      issuedAt: ISSUED,
      revokedAt: null,
    }
    const { channel, roster } = await createGroupChannelWithGrants(
      connection.db,
      f.workspace.id,
      f.owner,
      {
        candidates: groupCreationCandidatesFromGrants(f.workspace.id, {
          audienceGrants: [
            {
              ...live,
              grantId: 'gra_owner',
              groupId: channelId,
              participant: f.owner,
              revision: 1,
            },
          ],
          enlistmentGrants: [],
        }),
        channelId,
        idempotencyKey: crypto.randomUUID(),
        now: NOW,
        title: 'Group',
      }
    )
    const gate = { channel, workspaceId: f.workspace.id }
    const admitted = roster[0]!
    const revoked: GroupAdmission = {
      ...admitted,
      grant: { ...admitted.grant, revokedAt: NOW },
    }
    expect(
      authorizeGroupChannelHistoryRead(gate, {
        admission: revoked,
        entry: { occurredAt: NOW, sequence: 0 },
        now: NOW,
        sharingGrants: [],
      })
    ).toMatchObject({ action: 'deny', reason: 'history_participation_revoked' })
    expect(authorizeGroupChannelTurn(gate, { admission: revoked, now: NOW })).toMatchObject({
      action: 'deny',
      reason: 'turn_participation_revoked',
    })
    const job = {
      authorization: admitted.authorization,
      completedAt: NOW,
      jobId: 'job_1',
      participant: f.owner,
    }
    const held = authorizeGroupChannelPublication(gate, {
      admission: revoked,
      job,
      now: NOW,
      publisher: f.owner,
    })
    expect(held).toEqual({
      action: 'hold',
      jobId: 'job_1',
      reason: 'publication_participation_revoked',
    })
    expect(Object.keys(held)).toEqual(['action', 'jobId', 'reason'])
  })

  test('a newcomer joins at the message frontier and sees no earlier history by default', async () => {
    const f = await fixture()
    const channelId = crypto.randomUUID()
    const founderGrant = {
      expiresAt: null,
      grantId: 'gra_owner',
      groupId: channelId,
      issuedAt: ISSUED,
      participant: f.owner,
      revision: 1,
      revokedAt: null,
    }
    const created = await createGroupChannelWithGrants(connection.db, f.workspace.id, f.owner, {
      candidates: groupCreationCandidatesFromGrants(f.workspace.id, {
        audienceGrants: [founderGrant],
        enlistmentGrants: [],
      }),
      channelId,
      idempotencyKey: crypto.randomUUID(),
      now: NOW,
      title: 'Group',
    })
    const posted = await createMessage(connection.db, f.workspace.id, created.channel.id, f.owner, {
      bodyText: 'founder note',
      idempotencyKey: crypto.randomUUID(),
      sender: f.owner,
    })
    const memberGrant = {
      expiresAt: null,
      grantId: 'gra_member',
      groupId: channelId,
      issuedAt: ISSUED,
      participant: f.member,
      revision: 1,
      revokedAt: null,
    }
    const replaced = await setGroupChannelParticipantsWithGrants(
      connection.db,
      f.workspace.id,
      channelId,
      f.owner,
      {
        candidates: groupCreationCandidatesFromGrants(f.workspace.id, {
          audienceGrants: [founderGrant, memberGrant],
          enlistmentGrants: [],
        }),
        expectedVersion: created.channel.version,
        now: NOW,
        priorAdmissions: created.roster,
      }
    )
    const newcomer = replaced.roster.find(
      (admission) =>
        admission.participant.kind === 'user' && admission.participant.userId === f.member.userId
    )!
    expect(newcomer.joinPoint.joinedSequence).toBe(posted.sequence)
    const gate = { channel: replaced.channel, workspaceId: f.workspace.id }
    expect(
      authorizeGroupChannelHistoryRead(gate, {
        admission: newcomer,
        entry: { occurredAt: NOW, sequence: posted.sequence },
        now: NOW,
        sharingGrants: [],
      })
    ).toMatchObject({ action: 'deny', reason: 'history_before_join_point' })
  })
})
