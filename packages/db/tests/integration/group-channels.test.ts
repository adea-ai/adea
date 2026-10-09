import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { GroupAdmission, UserPrincipalRef } from '@adea-ai/types'
import { and, eq } from 'drizzle-orm'

import { createAgent } from '../../src/agents'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createMessage } from '../../src/conversations'
import {
  authorizeGroupChannelHistoryRead,
  authorizeGroupChannelPublication,
  authorizeGroupChannelTurn,
  createGroupChannelWithGrants,
  decideGroupChannelHistoryReadNow,
  groupCreationCandidatesFromGrants,
  GroupCreationError,
  listGroupChannelMessagesForUser,
  loadGroupRoster,
  loadGroupSharingGrants,
  revokeGroupGrant,
  setGroupChannelParticipantsWithGrants,
  shareGroupHistory,
} from '../../src/group-channels'
import { createTemporaryUserSession } from '../../src/identity'
import * as schema from '../../src/schema'
import { addWorkspaceMembership, createWorkspaceWithOwner } from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL

const ISSUED = '2026-10-01T00:00:00.000Z'
const NOW = '2026-10-08T12:00:00.000Z'
const LATER = '2026-10-08T13:00:00.000Z'

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
    const admin = await user('admin')
    const member = await user('member')
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Grant-gated groups',
      owner,
    })
    await addWorkspaceMembership(connection.db, workspace.id, admin, 'admin')
    await addWorkspaceMembership(connection.db, workspace.id, member, 'member')
    const agent = await createAgent(connection.db, workspace.id, owner, {
      name: 'Doc',
      profileId: 'lead',
      profileVersion: '1',
    })
    return { admin, agent, member, owner, workspace }
  }

  function grantsFor(channelId: string, f: Awaited<ReturnType<typeof fixture>>) {
    return {
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
    }
  }

  test('atomically persists a tenant-bounded group with canonical admissions', async () => {
    const f = await fixture()
    const channelId = crypto.randomUUID()
    const { channel, roster } = await createGroupChannelWithGrants(
      connection.db,
      f.workspace.id,
      f.owner,
      {
        candidates: groupCreationCandidatesFromGrants(f.workspace.id, grantsFor(channelId, f)),
        channelId,
        idempotencyKey: crypto.randomUUID(),
        now: NOW,
        title: 'Group',
      }
    )
    expect(channel.id).toBe(channelId)
    expect(channel.kind).toBe('group')
    expect(channel.visibility).toBe('participants')
    expect(channel.projectId).toBeUndefined()
    expect(channel.agentId).toBeUndefined()
    expect(roster).toHaveLength(3)
    expect(roster.every((admission) => admission.authorization.groupId === channelId)).toBe(true)
    const [grantRows, admissionRows, participantRows] = await Promise.all([
      connection.db
        .select()
        .from(schema.groupAudienceGrants)
        .where(eq(schema.groupAudienceGrants.channelId, channelId)),
      connection.db
        .select()
        .from(schema.groupAdmissions)
        .where(eq(schema.groupAdmissions.channelId, channelId)),
      connection.db
        .select()
        .from(schema.channelParticipants)
        .where(eq(schema.channelParticipants.channelId, channelId)),
    ])
    expect(grantRows).toHaveLength(2)
    expect(admissionRows).toHaveLength(3)
    expect(participantRows).toHaveLength(3)
    expect(
      admissionRows.every((row) => row.joinedSequence === 0 && row.authGroupId === channelId)
    ).toBe(true)
  })

  test('grants and admissions survive a connection restart and still gate reads', async () => {
    const f = await fixture()
    const channelId = crypto.randomUUID()
    await createGroupChannelWithGrants(connection.db, f.workspace.id, f.owner, {
      candidates: groupCreationCandidatesFromGrants(f.workspace.id, grantsFor(channelId, f)),
      channelId,
      idempotencyKey: crypto.randomUUID(),
      now: NOW,
      title: 'Durable group',
    })
    await connection.close()
    connection = createDatabase(connectionUrl!)
    const roster = await loadGroupRoster(connection.db, f.workspace.id, channelId)
    expect(roster).toHaveLength(3)
    expect(roster.every((admission) => admission.authorization.groupId === channelId)).toBe(true)
    const decision = await decideGroupChannelHistoryReadNow(
      connection.db,
      f.workspace.id,
      channelId,
      f.owner,
      { occurredAt: LATER, sequence: 0 },
      LATER
    )
    expect(decision).toMatchObject({ action: 'allow', basis: 'within_join_point' })
    const replayed = await connection.db
      .select()
      .from(schema.channels)
      .where(eq(schema.channels.id, channelId))
      .limit(1)
    expect(replayed).toHaveLength(1)
  })

  test('an invalid roster fails the whole creation with zero writes', async () => {
    const f = await fixture()
    const key = crypto.randomUUID()
    const failure = await createGroupChannelWithGrants(connection.db, f.workspace.id, f.owner, {
      candidates: groupCreationCandidatesFromGrants(f.workspace.id, {
        audienceGrants: [],
        enlistmentGrants: [],
      }),
      channelId: crypto.randomUUID(),
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
      ],
      enlistmentGrants: [],
    })
    candidates.push({
      audienceGrant: {
        expiresAt: null,
        grantId: 'gra_outsider',
        groupId: channelId,
        issuedAt: ISSUED,
        participant: outsider,
        revision: 1,
        revokedAt: null,
      },
      kind: 'human',
      participant: outsider,
      workspaceId: 'wsp_elsewhere',
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

  test('a same-workspace non-manager cannot rewrite the roster or revoke grants', async () => {
    const f = await fixture()
    const channelId = crypto.randomUUID()
    const created = await createGroupChannelWithGrants(connection.db, f.workspace.id, f.owner, {
      candidates: groupCreationCandidatesFromGrants(f.workspace.id, grantsFor(channelId, f)),
      channelId,
      idempotencyKey: crypto.randomUUID(),
      now: NOW,
      title: 'Group',
    })
    await expect(
      setGroupChannelParticipantsWithGrants(connection.db, f.workspace.id, channelId, f.member, {
        candidates: groupCreationCandidatesFromGrants(f.workspace.id, grantsFor(channelId, f)),
        expectedVersion: created.channel.version,
        now: LATER,
      })
    ).rejects.toThrow('Channel unavailable')
    await expect(
      revokeGroupGrant(connection.db, f.workspace.id, channelId, f.member, {
        grantId: 'gra_member',
        kind: 'audience',
        revokedAt: LATER,
      })
    ).rejects.toThrow('Channel unavailable')
    const roster = await loadGroupRoster(connection.db, f.workspace.id, channelId)
    expect(roster).toHaveLength(3)
  })

  test('an admin can replace the roster; retained join points come from storage', async () => {
    const f = await fixture()
    const channelId = crypto.randomUUID()
    const created = await createGroupChannelWithGrants(connection.db, f.workspace.id, f.owner, {
      candidates: groupCreationCandidatesFromGrants(f.workspace.id, grantsFor(channelId, f)),
      channelId,
      idempotencyKey: crypto.randomUUID(),
      now: NOW,
      title: 'Group',
    })
    const posted = await createMessage(connection.db, f.workspace.id, channelId, f.owner, {
      bodyText: 'founder note',
      idempotencyKey: crypto.randomUUID(),
      sender: f.owner,
    })
    const all = grantsFor(channelId, f)
    const replaced = await setGroupChannelParticipantsWithGrants(
      connection.db,
      f.workspace.id,
      channelId,
      f.admin,
      {
        candidates: groupCreationCandidatesFromGrants(f.workspace.id, all),
        expectedVersion: created.channel.version,
        now: LATER,
      }
    )
    // Founder keeps the stored join point (sequence 0), even though messages
    // were posted after creation: no caller-supplied prior is consulted.
    const founder = replaced.roster.find(
      (admission) =>
        admission.participant.kind === 'user' && admission.participant.userId === f.owner.userId
    )!
    expect(founder.joinPoint.joinedSequence).toBe(0)
    const stored = await loadGroupRoster(connection.db, f.workspace.id, channelId)
    expect(
      stored.find(
        (admission) =>
          admission.participant.kind === 'user' && admission.participant.userId === f.owner.userId
      )?.joinPoint.joinedSequence
    ).toBe(0)
    expect(posted.sequence).toBeGreaterThan(0)
  })

  test('a newcomer joins at the message frontier and sees no earlier history by default', async () => {
    const f = await fixture()
    const channelId = crypto.randomUUID()
    const founderOnly = grantsFor(channelId, f)
    founderOnly.audienceGrants = founderOnly.audienceGrants.slice(0, 1)
    founderOnly.enlistmentGrants = []
    const created = await createGroupChannelWithGrants(connection.db, f.workspace.id, f.owner, {
      candidates: groupCreationCandidatesFromGrants(f.workspace.id, founderOnly),
      channelId,
      idempotencyKey: crypto.randomUUID(),
      now: NOW,
      title: 'Group',
    })
    const posted = await createMessage(connection.db, f.workspace.id, channelId, f.owner, {
      bodyText: 'founder note',
      idempotencyKey: crypto.randomUUID(),
      sender: f.owner,
    })
    const replaced = await setGroupChannelParticipantsWithGrants(
      connection.db,
      f.workspace.id,
      channelId,
      f.owner,
      {
        candidates: groupCreationCandidatesFromGrants(f.workspace.id, grantsFor(channelId, f)),
        expectedVersion: created.channel.version,
        now: LATER,
      }
    )
    const newcomer = replaced.roster.find(
      (admission) =>
        admission.participant.kind === 'user' && admission.participant.userId === f.member.userId
    )!
    expect(newcomer.joinPoint.joinedSequence).toBe(posted.sequence + 1)
    const page = await listGroupChannelMessagesForUser(
      connection.db,
      f.workspace.id,
      channelId,
      f.member,
      {},
      LATER
    )
    expect(page.messages).toHaveLength(0)
    const founderPage = await listGroupChannelMessagesForUser(
      connection.db,
      f.workspace.id,
      channelId,
      f.owner,
      {},
      LATER
    )
    expect(founderPage.messages.map((message) => message.sequence)).toContain(posted.sequence)
  })

  test('a sharing grant unlocks earlier history until it is revoked', async () => {
    const f = await fixture()
    const channelId = crypto.randomUUID()
    const founderOnly = grantsFor(channelId, f)
    founderOnly.audienceGrants = founderOnly.audienceGrants.slice(0, 1)
    founderOnly.enlistmentGrants = []
    const created = await createGroupChannelWithGrants(connection.db, f.workspace.id, f.owner, {
      candidates: groupCreationCandidatesFromGrants(f.workspace.id, founderOnly),
      channelId,
      idempotencyKey: crypto.randomUUID(),
      now: NOW,
      title: 'Group',
    })
    await createMessage(connection.db, f.workspace.id, channelId, f.owner, {
      bodyText: 'before you joined',
      idempotencyKey: crypto.randomUUID(),
      sender: f.owner,
    })
    await setGroupChannelParticipantsWithGrants(connection.db, f.workspace.id, channelId, f.owner, {
      candidates: groupCreationCandidatesFromGrants(f.workspace.id, grantsFor(channelId, f)),
      expectedVersion: created.channel.version,
      now: LATER,
    })
    const before = await listGroupChannelMessagesForUser(
      connection.db,
      f.workspace.id,
      channelId,
      f.member,
      {},
      LATER
    )
    expect(before.messages).toHaveLength(0)
    await shareGroupHistory(connection.db, f.workspace.id, channelId, f.owner, {
      expiresAt: null,
      grantId: 'gra_share_member',
      groupId: channelId,
      issuedAt: ISSUED,
      participant: f.member,
      revision: 1,
      revokedAt: null,
      scope: 'earlier_history',
    })
    const shared = await loadGroupSharingGrants(connection.db, f.workspace.id, channelId)
    expect(shared).toHaveLength(1)
    const unlocked = await listGroupChannelMessagesForUser(
      connection.db,
      f.workspace.id,
      channelId,
      f.member,
      {},
      LATER
    )
    expect(unlocked.messages).toHaveLength(1)
    const revoked = await revokeGroupGrant(connection.db, f.workspace.id, channelId, f.owner, {
      grantId: 'gra_share_member',
      kind: 'sharing',
      revokedAt: LATER,
    })
    expect(revoked).toEqual({ revoked: true })
    const relocked = await listGroupChannelMessagesForUser(
      connection.db,
      f.workspace.id,
      channelId,
      f.member,
      {},
      LATER
    )
    expect(relocked.messages).toHaveLength(0)
  })

  test('revocation denies future reads and turns immediately while the job stays owned', async () => {
    const f = await fixture()
    const channelId = crypto.randomUUID()
    const { channel, roster } = await createGroupChannelWithGrants(
      connection.db,
      f.workspace.id,
      f.owner,
      {
        candidates: groupCreationCandidatesFromGrants(f.workspace.id, grantsFor(channelId, f)),
        channelId,
        idempotencyKey: crypto.randomUUID(),
        now: NOW,
        title: 'Group',
      }
    )
    const gate = { channel, workspaceId: f.workspace.id }
    const admitted = roster.find(
      (entry) => entry.participant.kind === 'user' && entry.participant.userId === f.member.userId
    )!
    const revoked = await revokeGroupGrant(connection.db, f.workspace.id, channelId, f.owner, {
      grantId: 'gra_member',
      kind: 'audience',
      revokedAt: LATER,
    })
    expect(revoked).toEqual({ revoked: true })
    const fresh = await loadGroupRoster(connection.db, f.workspace.id, channelId)
    const current = fresh.find(
      (entry) => entry.participant.kind === 'user' && entry.participant.userId === f.member.userId
    )!
    expect(
      authorizeGroupChannelHistoryRead(gate, {
        admission: current,
        entry: { occurredAt: LATER, sequence: 0 },
        now: LATER,
        sharingGrants: [],
      })
    ).toMatchObject({ action: 'deny', reason: 'history_participation_revoked' })
    expect(authorizeGroupChannelTurn(gate, { admission: current, now: LATER })).toMatchObject({
      action: 'deny',
      reason: 'turn_participation_revoked',
    })
    const job = {
      authorization: admitted.authorization,
      completedAt: NOW,
      jobId: 'job_1',
      participant: f.member,
    }
    const held = authorizeGroupChannelPublication(gate, {
      admission: current,
      job,
      now: LATER,
      publisher: f.member,
    })
    expect(held).toEqual({
      action: 'hold',
      jobId: 'job_1',
      reason: 'publication_participation_revoked',
    })
    expect(Object.keys(held)).toEqual(['action', 'jobId', 'reason'])
    // The pre-revocation admission object is untouched history, not live state.
    expect(admitted.grant.revokedAt).toBeNull()
  })

  test('a forged participant row without a canonical admission reads nothing', async () => {
    const f = await fixture()
    const channelId = crypto.randomUUID()
    await createGroupChannelWithGrants(connection.db, f.workspace.id, f.owner, {
      candidates: groupCreationCandidatesFromGrants(f.workspace.id, grantsFor(channelId, f)),
      channelId,
      idempotencyKey: crypto.randomUUID(),
      now: NOW,
      title: 'Group',
    })
    const stranger = await user('stranger')
    await addWorkspaceMembership(connection.db, f.workspace.id, stranger, 'member')
    await createMessage(connection.db, f.workspace.id, channelId, f.owner, {
      bodyText: 'private',
      idempotencyKey: crypto.randomUUID(),
      sender: f.owner,
    })
    // Bypass the grant gate the way a bug or a forged write would: a bare
    // participant row with no grant and no canonical admission.
    await connection.db.insert(schema.channelParticipants).values({
      channelId,
      principalKind: 'user',
      userId: stranger.userId,
      workspaceId: f.workspace.id,
    })
    const roster = await loadGroupRoster(connection.db, f.workspace.id, channelId)
    expect(
      roster.some(
        (entry) => entry.participant.kind === 'user' && entry.participant.userId === stranger.userId
      )
    ).toBe(false)
    const page = await listGroupChannelMessagesForUser(
      connection.db,
      f.workspace.id,
      channelId,
      stranger,
      {},
      LATER
    )
    expect(page.messages).toHaveLength(0)
  })

  test('concurrent creation under one idempotency key yields one channel and one roster', async () => {
    const f = await fixture()
    const channelId = crypto.randomUUID()
    const key = crypto.randomUUID()
    // Every attempt carries the same explicit id and key, so losers collide
    // on the primary key itself — not just the idempotency arbiter — and
    // must fall through to the hash-verified replay path.
    const attempt = () =>
      createGroupChannelWithGrants(connection.db, f.workspace.id, f.owner, {
        candidates: groupCreationCandidatesFromGrants(f.workspace.id, grantsFor(channelId, f)),
        channelId,
        idempotencyKey: key,
        now: NOW,
        title: 'Group',
      })
    const results = await Promise.all(Array.from({ length: 6 }, () => attempt()))
    expect(results.map((result) => result.channel.id)).toEqual(Array(6).fill(channelId))
    const participants = await connection.db
      .select()
      .from(schema.channelParticipants)
      .where(eq(schema.channelParticipants.channelId, channelId))
    expect(participants).toHaveLength(3)
    const admissions = await connection.db
      .select()
      .from(schema.groupAdmissions)
      .where(eq(schema.groupAdmissions.channelId, channelId))
    expect(admissions).toHaveLength(3)
  })

  test('concurrent revocation and reads never open stale access', async () => {
    const f = await fixture()
    const channelId = crypto.randomUUID()
    const { channel, roster } = await createGroupChannelWithGrants(
      connection.db,
      f.workspace.id,
      f.owner,
      {
        candidates: groupCreationCandidatesFromGrants(f.workspace.id, grantsFor(channelId, f)),
        channelId,
        idempotencyKey: crypto.randomUUID(),
        now: NOW,
        title: 'Group',
      }
    )
    const gate = { channel, workspaceId: f.workspace.id }
    const admitted = roster.find(
      (entry) => entry.participant.kind === 'user' && entry.participant.userId === f.member.userId
    )!
    const entry = { occurredAt: NOW, sequence: 0 }
    const reads = Array.from({ length: 8 }, () =>
      loadGroupRoster(connection.db, f.workspace.id, channelId).then((fresh) =>
        authorizeGroupChannelHistoryRead(gate, {
          admission:
            fresh.find(
              (candidate) =>
                candidate.participant.kind === 'user' &&
                candidate.participant.userId === f.member.userId
            ) ?? null,
          entry,
          now: LATER,
          sharingGrants: [],
        })
      )
    )
    const revoking = revokeGroupGrant(connection.db, f.workspace.id, channelId, f.owner, {
      grantId: 'gra_member',
      kind: 'audience',
      revokedAt: LATER,
    })
    const outcomes = await Promise.all([...reads, revoking])
    for (const outcome of outcomes.slice(0, 8)) {
      expect(['allow', 'deny']).toContain((outcome as { action: string }).action)
    }
    expect(admitted.grant.revokedAt).toBeNull()
    // After revocation completes, every fresh read denies: no stale-open window.
    const fresh = await loadGroupRoster(connection.db, f.workspace.id, channelId)
    const current = fresh.find(
      (candidate) =>
        candidate.participant.kind === 'user' && candidate.participant.userId === f.member.userId
    )!
    expect(
      authorizeGroupChannelHistoryRead(gate, {
        admission: current,
        entry,
        now: LATER,
        sharingGrants: [],
      })
    ).toMatchObject({ action: 'deny', reason: 'history_participation_revoked' })
  })

  test('a regrant with a higher revision restores reads but never revives the old binding', async () => {
    const f = await fixture()
    const channelId = crypto.randomUUID()
    const { channel, roster } = await createGroupChannelWithGrants(
      connection.db,
      f.workspace.id,
      f.owner,
      {
        candidates: groupCreationCandidatesFromGrants(f.workspace.id, grantsFor(channelId, f)),
        channelId,
        idempotencyKey: crypto.randomUUID(),
        now: NOW,
        title: 'Group',
      }
    )
    const gate = { channel, workspaceId: f.workspace.id }
    const admitted = roster.find(
      (entry: GroupAdmission) =>
        entry.participant.kind === 'user' && entry.participant.userId === f.member.userId
    )!
    await revokeGroupGrant(connection.db, f.workspace.id, channelId, f.owner, {
      grantId: 'gra_member',
      kind: 'audience',
      revokedAt: LATER,
    })
    const regranted = grantsFor(channelId, f)
    regranted.audienceGrants = regranted.audienceGrants.map((grant) =>
      grant.grantId === 'gra_member' ? { ...grant, revision: 2, revokedAt: null } : grant
    )
    const replaced = await setGroupChannelParticipantsWithGrants(
      connection.db,
      f.workspace.id,
      channelId,
      f.owner,
      {
        candidates: groupCreationCandidatesFromGrants(f.workspace.id, regranted),
        expectedVersion: channel.version,
        now: LATER,
      }
    )
    const current = replaced.roster.find(
      (entry) => entry.participant.kind === 'user' && entry.participant.userId === f.member.userId
    )!
    expect(current.authorization.revision).toBe(2)
    expect(authorizeGroupChannelTurn(gate, { admission: current, now: LATER })).toMatchObject({
      action: 'allow',
    })
    // The job admitted under revision 1 stays held: the replacement grant is
    // never borrowed back.
    const staleJob = {
      authorization: admitted.authorization,
      completedAt: NOW,
      jobId: 'job_stale',
      participant: f.member,
    }
    expect(
      authorizeGroupChannelPublication(gate, {
        admission: current,
        job: staleJob,
        now: LATER,
        publisher: f.member,
      })
    ).toMatchObject({ action: 'hold', reason: 'publication_binding_mismatch' })
  })
})
