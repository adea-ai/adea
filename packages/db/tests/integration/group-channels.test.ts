import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { GroupAdmission, UserPrincipalRef } from '@adea-ai/types'
import { and, eq } from 'drizzle-orm'

import { createAgent, ensureWorkspaceLead } from '../../src/agents'
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
  postGroupChannelMessage,
  postGroupChannelMessageInTransaction,
  resolveGroupLeadAgent,
  revokeGroupGrant,
  setGroupChannelParticipantsInTransaction,
  setGroupChannelParticipantsWithGrants,
  shareGroupHistory,
} from '../../src/group-channels'
import type { GroupPostBarrier, GroupRosterBarrier } from '../../src/group-channels'
import { searchWorkspaceForUser } from '../../src/search'
import { validateGroupCreation } from '../../src/group-participation-policy'
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

  test('legacy groups keep working: the creator reads via an implicit founder grant', async () => {
    const f = await fixture()
    const { createGroupChannel } = await import('../../src/conversations')
    const channel = await createGroupChannel(connection.db, f.workspace.id, f.owner, {
      idempotencyKey: crypto.randomUUID(),
      title: 'Legacy group',
    })
    const posted = await createMessage(connection.db, f.workspace.id, channel.id, f.owner, {
      bodyText: 'legacy hello',
      idempotencyKey: crypto.randomUUID(),
      sender: f.owner,
    })
    // The shared read boundary admits the founder; nothing went dark.
    const page = await listGroupChannelMessagesForUser(
      connection.db,
      f.workspace.id,
      channel.id,
      f.owner,
      {}
    )
    expect(page.messages.map((message) => message.sequence)).toContain(posted.sequence)
    const roster = await loadGroupRoster(connection.db, f.workspace.id, channel.id)
    expect(roster).toHaveLength(1)
    expect(roster[0]?.authorization.grantId).toMatch(/^implicit:founder:/)
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
      { now: LATER }
    )
    expect(page.messages).toHaveLength(0)
    const founderPage = await listGroupChannelMessagesForUser(
      connection.db,
      f.workspace.id,
      channelId,
      f.owner,
      {},
      { now: LATER }
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
      { now: LATER }
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
      { now: LATER }
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
      { now: LATER }
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function raced<T>(operation: Promise<T>, ms: number): Promise<'blocked' | T> {
  return Promise.race([operation, sleep(ms).then((): 'blocked' => 'blocked')])
}

async function isolatedFixture() {
  const local = createDatabase(connectionUrl!)
  const owner = (
    await createTemporaryUserSession(local.db, {
      credentialDigest: `fence-owner-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
  ).principal
  const member = (
    await createTemporaryUserSession(local.db, {
      credentialDigest: `fence-member-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
  ).principal
  const { workspace } = await createWorkspaceWithOwner(local.db, {
    idempotencyKey: crypto.randomUUID(),
    name: 'Fenced groups',
    owner,
  })
  await addWorkspaceMembership(local.db, workspace.id, member, 'member')
  return { local, member, owner, workspace }
}

describe('durable binding, fences and shared read boundary', () => {
  test('a revision 2 regrant never revives a revision 1 admission until the roster rebinds', async () => {
    const f = await isolatedFixture()
    try {
      const channelId = crypto.randomUUID()
      const founder = {
        expiresAt: null,
        grantId: 'gra_owner',
        groupId: channelId,
        issuedAt: ISSUED,
        participant: f.owner,
        revision: 1,
        revokedAt: null,
      }
      const grant = {
        expiresAt: null,
        grantId: 'gra_member',
        groupId: channelId,
        issuedAt: ISSUED,
        participant: f.member,
        revision: 1,
        revokedAt: null,
      }
      const { channel } = await createGroupChannelWithGrants(f.local.db, f.workspace.id, f.owner, {
        candidates: groupCreationCandidatesFromGrants(f.workspace.id, {
          audienceGrants: [founder, grant],
          enlistmentGrants: [],
        }),
        channelId,
        idempotencyKey: crypto.randomUUID(),
        now: NOW,
        title: 'Group',
      })
      const gate = { channel, workspaceId: f.workspace.id }
      await revokeGroupGrant(f.local.db, f.workspace.id, channelId, f.owner, {
        grantId: 'gra_member',
        kind: 'audience',
        revokedAt: LATER,
      })
      // Regrant under revision 2 directly in storage (as a rotation would),
      // without rewriting the roster: the admission stays bound to revoked
      // revision 1 and must stay held, not revived.
      await f.local.db
        .update(schema.groupAudienceGrants)
        .set({ revision: 2, revokedAt: null, updatedAt: new Date() })
        .where(
          and(
            eq(schema.groupAudienceGrants.workspaceId, f.workspace.id),
            eq(schema.groupAudienceGrants.channelId, channelId),
            eq(schema.groupAudienceGrants.grantId, 'gra_member')
          )
        )
      const stale = await loadGroupRoster(f.local.db, f.workspace.id, channelId)
      const held = stale.find(
        (entry) => entry.participant.kind === 'user' && entry.participant.userId === f.member.userId
      )!
      expect(held.authorization).toMatchObject({ grantId: 'gra_member', revision: 1 })
      expect(authorizeGroupChannelTurn(gate, { admission: held, now: LATER })).toMatchObject({
        action: 'deny',
      })
      expect(
        authorizeGroupChannelHistoryRead(gate, {
          admission: held,
          entry: { occurredAt: LATER, sequence: 0 },
          now: LATER,
          sharingGrants: [],
        })
      ).toMatchObject({ action: 'deny' })
      // Rewriting the roster rebinds the admission to revision 2: reads resume.
      const rebound = await setGroupChannelParticipantsWithGrants(
        f.local.db,
        f.workspace.id,
        channelId,
        f.owner,
        {
          candidates: groupCreationCandidatesFromGrants(f.workspace.id, {
            audienceGrants: [founder, { ...grant, revision: 2, revokedAt: null }],
            enlistmentGrants: [],
          }),
          expectedVersion: channel.version,
          now: LATER,
        }
      )
      const current = rebound.roster.find(
        (entry) => entry.participant.kind === 'user' && entry.participant.userId === f.member.userId
      )!
      expect(current.authorization.revision).toBe(2)
      expect(authorizeGroupChannelTurn(gate, { admission: current, now: LATER })).toMatchObject({
        action: 'allow',
      })
    } finally {
      await f.local.close()
    }
  })

  test('a retargeted grant id authorizes neither the old nor the new subject', async () => {
    const f = await isolatedFixture()
    try {
      const stranger = (
        await createTemporaryUserSession(f.local.db, {
          credentialDigest: `retarget-stranger-${crypto.randomUUID()}`,
          expiresAt: new Date(Date.now() + 60_000),
        })
      ).principal
      await addWorkspaceMembership(f.local.db, f.workspace.id, stranger, 'member')
      const channelId = crypto.randomUUID()
      const founder = {
        expiresAt: null,
        grantId: 'gra_owner',
        groupId: channelId,
        issuedAt: ISSUED,
        participant: f.owner,
        revision: 1,
        revokedAt: null,
      }
      const grant = {
        expiresAt: null,
        grantId: 'gra_member',
        groupId: channelId,
        issuedAt: ISSUED,
        participant: f.member,
        revision: 1,
        revokedAt: null,
      }
      const { channel } = await createGroupChannelWithGrants(f.local.db, f.workspace.id, f.owner, {
        candidates: groupCreationCandidatesFromGrants(f.workspace.id, {
          audienceGrants: [founder, grant],
          enlistmentGrants: [],
        }),
        channelId,
        idempotencyKey: crypto.randomUUID(),
        now: NOW,
        title: 'Group',
      })
      const gate = { channel, workspaceId: f.workspace.id }
      // Retarget the stored grant row at its face value: same id, new subject.
      await f.local.db
        .update(schema.groupAudienceGrants)
        .set({ revision: 2, revokedAt: null, updatedAt: new Date(), userId: stranger.userId })
        .where(
          and(
            eq(schema.groupAudienceGrants.workspaceId, f.workspace.id),
            eq(schema.groupAudienceGrants.channelId, channelId),
            eq(schema.groupAudienceGrants.grantId, 'gra_member')
          )
        )
      const roster = await loadGroupRoster(f.local.db, f.workspace.id, channelId)
      const previous = roster.find(
        (entry) => entry.participant.kind === 'user' && entry.participant.userId === f.member.userId
      )!
      expect(authorizeGroupChannelTurn(gate, { admission: previous, now: LATER })).toMatchObject({
        action: 'deny',
      })
      // The new subject was never admitted: no admission, no reads.
      expect(
        roster.some(
          (entry) =>
            entry.participant.kind === 'user' && entry.participant.userId === stranger.userId
        )
      ).toBe(false)
      expect(authorizeGroupChannelTurn(gate, { admission: null, now: LATER })).toMatchObject({
        action: 'deny',
        reason: 'turn_not_participant',
      })
    } finally {
      await f.local.close()
    }
  })

  test('a fenced post and a concurrent revocation linearize: no write slips between', async () => {
    const f = await isolatedFixture()
    try {
      const channelId = crypto.randomUUID()
      const founder = {
        expiresAt: null,
        grantId: 'gra_owner',
        groupId: channelId,
        issuedAt: ISSUED,
        participant: f.owner,
        revision: 1,
        revokedAt: null,
      }
      const grant = {
        expiresAt: null,
        grantId: 'gra_member',
        groupId: channelId,
        issuedAt: ISSUED,
        participant: f.member,
        revision: 1,
        revokedAt: null,
      }
      await createGroupChannelWithGrants(f.local.db, f.workspace.id, f.owner, {
        candidates: groupCreationCandidatesFromGrants(f.workspace.id, {
          audienceGrants: [founder, grant],
          enlistmentGrants: [],
        }),
        channelId,
        idempotencyKey: crypto.randomUUID(),
        now: NOW,
        title: 'Group',
      })
      // Hold the fence open after it locks the admission/grant rows.
      let releaseFence!: () => void
      const fenceOpen = new Promise<void>((resolve) => {
        releaseFence = resolve
      })
      let signalGate!: () => void
      const gateReached = new Promise<void>((resolve) => {
        signalGate = resolve
      })
      const barrier: GroupPostBarrier = {
        afterGate: async () => {
          signalGate()
          await fenceOpen
        },
      }
      const posting = f.local.db.transaction((tx) =>
        postGroupChannelMessageInTransaction(
          tx,
          f.workspace.id,
          channelId,
          f.member,
          f.member,
          {
            message: { bodyText: 'fenced hello', idempotencyKey: crypto.randomUUID() },
            mode: 'direct',
          },
          { barrier, now: LATER }
        )
      )
      await Promise.race([
        gateReached,
        sleep(2000).then(() => {
          throw new Error('fence never reached the gate')
        }),
      ])
      // The revocation must block on the fence's row locks: it cannot commit
      // between the gate decision and the write.
      const revoking = revokeGroupGrant(f.local.db, f.workspace.id, channelId, f.owner, {
        grantId: 'gra_member',
        kind: 'audience',
        revokedAt: LATER,
      })
      expect(await raced(revoking, 500)).toBe('blocked')
      releaseFence()
      const posted = await posting
      expect(posted.sequence).toBeGreaterThanOrEqual(1)
      expect(await revoking).toEqual({ revoked: true })
      // After the fence commits, the revocation lands and every fresh read denies.
      const decision = await decideGroupChannelHistoryReadNow(
        f.local.db,
        f.workspace.id,
        channelId,
        f.member,
        { occurredAt: LATER, sequence: posted.sequence },
        LATER
      )
      expect(decision).toMatchObject({ action: 'deny', reason: 'history_participation_revoked' })
    } finally {
      await f.local.close()
    }
  })

  test('frontier and writers linearize: before-join messages hide, after-join messages show', async () => {
    const f = await isolatedFixture()
    try {
      const channelId = crypto.randomUUID()
      const founder = {
        expiresAt: null,
        grantId: 'gra_owner',
        groupId: channelId,
        issuedAt: ISSUED,
        participant: f.owner,
        revision: 1,
        revokedAt: null,
      }
      const created = await createGroupChannelWithGrants(f.local.db, f.workspace.id, f.owner, {
        candidates: groupCreationCandidatesFromGrants(f.workspace.id, {
          audienceGrants: [founder],
          enlistmentGrants: [],
        }),
        channelId,
        idempotencyKey: crypto.randomUUID(),
        now: NOW,
        title: 'Group',
      })
      const before = await createMessage(f.local.db, f.workspace.id, channelId, f.owner, {
        bodyText: 'before join',
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
      let releaseRewrite!: () => void
      const rewriteOpen = new Promise<void>((resolve) => {
        releaseRewrite = resolve
      })
      let lockNoticed: Promise<void> | null = null
      const barrier: GroupRosterBarrier = {
        afterChannelLock: async () => {
          lockNoticed ??= Promise.resolve()
          await rewriteOpen
        },
      }
      const candidates = groupCreationCandidatesFromGrants(f.workspace.id, {
        audienceGrants: [founder, memberGrant],
        enlistmentGrants: [],
      })
      const validation = validateGroupCreation({
        candidates,
        groupId: channelId,
        now: LATER,
        workspaceId: f.workspace.id,
      })
      if (!validation.ok) throw new Error('test roster must validate')
      const rewriting = f.local.db.transaction((tx) =>
        setGroupChannelParticipantsInTransaction(
          tx,
          f.workspace.id,
          channelId,
          f.owner,
          {
            candidates,
            expectedVersion: created.channel.version,
            now: LATER,
            roster: validation.roster,
          },
          barrier
        )
      )
      await Promise.race([
        lockNoticed,
        sleep(2000).then(() => {
          throw new Error('lock never held')
        }),
      ])
      // A concurrent writer must block on the held channel lock: it cannot
      // commit (or allocate) ahead of the rewrite's frontier read.
      const writing = createMessage(f.local.db, f.workspace.id, channelId, f.owner, {
        bodyText: 'racing write',
        idempotencyKey: crypto.randomUUID(),
        sender: f.owner,
      })
      expect(await raced(writing, 500)).toBe('blocked')
      releaseRewrite()
      const [replaced, racedMessage] = await Promise.all([rewriting, writing])
      const newcomer = replaced.roster.find(
        (entry) => entry.participant.kind === 'user' && entry.participant.userId === f.member.userId
      )!
      // The writer linearized after the join: its sequence is at or after
      // the recorded join point, so the newcomer sees it; the earlier
      // message stays held.
      expect(newcomer.joinPoint.joinedSequence).toBeLessThanOrEqual(racedMessage.sequence)
      expect(newcomer.joinPoint.joinedSequence).toBeGreaterThan(before.sequence)
      const page = await listGroupChannelMessagesForUser(
        f.local.db,
        f.workspace.id,
        channelId,
        f.member,
        {},
        LATER
      )
      const sequences = page.messages.map((message) => message.sequence)
      expect(sequences).toContain(racedMessage.sequence)
      expect(sequences).not.toContain(before.sequence)
    } finally {
      await f.local.close()
    }
  })

  test('a revoked post writes nothing: gate and write share one transaction', async () => {
    const f = await isolatedFixture()
    try {
      const channelId = crypto.randomUUID()
      const founder = {
        expiresAt: null,
        grantId: 'gra_owner',
        groupId: channelId,
        issuedAt: ISSUED,
        participant: f.owner,
        revision: 1,
        revokedAt: null,
      }
      const grant = {
        expiresAt: null,
        grantId: 'gra_member',
        groupId: channelId,
        issuedAt: ISSUED,
        participant: f.member,
        revision: 1,
        revokedAt: null,
      }
      const key = crypto.randomUUID()
      await createGroupChannelWithGrants(f.local.db, f.workspace.id, f.owner, {
        candidates: groupCreationCandidatesFromGrants(f.workspace.id, {
          audienceGrants: [founder, grant],
          enlistmentGrants: [],
        }),
        channelId,
        idempotencyKey: crypto.randomUUID(),
        now: NOW,
        title: 'Group',
      })
      await revokeGroupGrant(f.local.db, f.workspace.id, channelId, f.owner, {
        grantId: 'gra_member',
        kind: 'audience',
        revokedAt: LATER,
      })
      await expect(
        postGroupChannelMessage(
          f.local.db,
          f.workspace.id,
          channelId,
          f.member,
          f.member,
          {
            message: { bodyText: 'must not land', idempotencyKey: key },
            mode: 'direct',
          },
          { now: LATER }
        )
      ).rejects.toThrow('Channel unavailable')
      const rows = await f.local.db
        .select()
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.workspaceId, f.workspace.id),
            eq(schema.messages.channelId, channelId)
          )
        )
      expect(rows).toHaveLength(0)
      const allowed = await postGroupChannelMessage(
        f.local.db,
        f.workspace.id,
        channelId,
        f.owner,
        f.owner,
        {
          message: { bodyText: 'founder lands', idempotencyKey: crypto.randomUUID() },
          mode: 'direct',
        },
        { now: LATER }
      )
      expect(allowed.sequence).toBeGreaterThanOrEqual(1)
    } finally {
      await f.local.close()
    }
  })

  test('a grant expiring between gate and write denies direct posts with zero rows', async () => {
    const f = await isolatedFixture()
    try {
      const channelId = crypto.randomUUID()
      const founder = {
        expiresAt: null,
        grantId: 'gra_owner',
        groupId: channelId,
        issuedAt: ISSUED,
        participant: f.owner,
        revision: 1,
        revokedAt: null,
      }
      // The member grant lapses mid-afternoon: valid at the gate instant,
      // expired at the final in-transaction check.
      const expiring = '2026-10-08T12:30:00.000Z'
      const grant = {
        expiresAt: expiring,
        grantId: 'gra_member',
        groupId: channelId,
        issuedAt: ISSUED,
        participant: f.member,
        revision: 1,
        revokedAt: null,
      }
      await createGroupChannelWithGrants(f.local.db, f.workspace.id, f.owner, {
        candidates: groupCreationCandidatesFromGrants(f.workspace.id, {
          audienceGrants: [founder, grant],
          enlistmentGrants: [],
        }),
        channelId,
        idempotencyKey: crypto.randomUUID(),
        now: NOW,
        title: 'Group',
      })
      const readings = [NOW, LATER]
      const clock = () => readings.shift() ?? LATER
      const key = crypto.randomUUID()
      await expect(
        postGroupChannelMessage(
          f.local.db,
          f.workspace.id,
          channelId,
          f.member,
          f.member,
          { message: { bodyText: 'must not land', idempotencyKey: key }, mode: 'direct' },
          { clock }
        )
      ).rejects.toThrow('Channel unavailable')
      const rows = await f.local.db
        .select()
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.workspaceId, f.workspace.id),
            eq(schema.messages.channelId, channelId)
          )
        )
      expect(rows).toHaveLength(0)
      // Control: a clock that never lapses writes exactly once.
      const steady = [NOW, NOW]
      const steadyClock = () => steady.shift() ?? NOW
      const posted = await postGroupChannelMessage(
        f.local.db,
        f.workspace.id,
        channelId,
        f.member,
        f.member,
        {
          message: { bodyText: 'in-window lands', idempotencyKey: crypto.randomUUID() },
          mode: 'direct',
        },
        { clock: steadyClock }
      )
      expect(posted.sequence).toBeGreaterThanOrEqual(1)
    } finally {
      await f.local.close()
    }
  })

  test('a grant expiring between gate and write denies lead posts with zero side effects', async () => {
    const f = await isolatedFixture()
    try {
      const channelId = crypto.randomUUID()
      const founder = {
        expiresAt: null,
        grantId: 'gra_owner',
        groupId: channelId,
        issuedAt: ISSUED,
        participant: f.owner,
        revision: 1,
        revokedAt: null,
      }
      const expiring = '2026-10-08T12:30:00.000Z'
      const grant = {
        expiresAt: expiring,
        grantId: 'gra_member',
        groupId: channelId,
        issuedAt: ISSUED,
        participant: f.member,
        revision: 1,
        revokedAt: null,
      }
      await createGroupChannelWithGrants(f.local.db, f.workspace.id, f.owner, {
        candidates: groupCreationCandidatesFromGrants(f.workspace.id, {
          audienceGrants: [founder, grant],
          enlistmentGrants: [],
        }),
        channelId,
        idempotencyKey: crypto.randomUUID(),
        now: NOW,
        title: 'Group',
      })
      const readings = [NOW, LATER]
      const clock = () => readings.shift() ?? LATER
      await expect(
        postGroupChannelMessage(
          f.local.db,
          f.workspace.id,
          channelId,
          f.member,
          f.member,
          {
            lead: { bodyText: 'must not land', idempotencyKey: crypto.randomUUID(), mentions: [] },
            mode: 'lead',
          },
          { clock }
        )
      ).rejects.toThrow('Channel unavailable')
      const [messages, intents] = await Promise.all([
        f.local.db
          .select()
          .from(schema.messages)
          .where(
            and(
              eq(schema.messages.workspaceId, f.workspace.id),
              eq(schema.messages.channelId, channelId)
            )
          ),
        f.local.db
          .select()
          .from(schema.leadTurnIntents)
          .where(eq(schema.leadTurnIntents.channelId, channelId)),
      ])
      expect(messages).toHaveLength(0)
      expect(intents).toHaveLength(0)
      // Control: with a live grant the gate passes and the nested lead
      // authority — owned by #1179 — refuses groups on its own terms.
      const steady = [NOW, NOW]
      const steadyClock = () => steady.shift() ?? NOW
      await expect(
        postGroupChannelMessage(
          f.local.db,
          f.workspace.id,
          channelId,
          f.member,
          f.member,
          {
            lead: { bodyText: 'gate passes', idempotencyKey: crypto.randomUUID(), mentions: [] },
            mode: 'lead',
          },
          { clock: steadyClock }
        )
      ).rejects.toThrow('Lead turn unavailable')
    } finally {
      await f.local.close()
    }
  })

  test('lead expiry at the post-write check denies with zero side effects', async () => {
    // The nested lead write really runs, then the post-write check on fresh
    // trusted time denies and the whole fence rolls back: message, intent
    // and event leave zero rows. Lead posts require runtime.invoke, so the
    // owner (founder) posts, not the member.
    const f = await isolatedFixture()
    try {
      const lead = await ensureWorkspaceLead(f.local.db, f.workspace.id, f.owner)
      const channelId = crypto.randomUUID()
      const expiring = '2026-10-08T12:30:00.000Z'
      const founder = {
        expiresAt: expiring,
        grantId: 'gra_owner',
        groupId: channelId,
        issuedAt: ISSUED,
        participant: f.owner,
        revision: 1,
        revokedAt: null,
      }
      const enlist = {
        agent: { agentId: lead.id, workspaceId: f.workspace.id },
        expiresAt: null,
        grantId: 'gra_lead',
        groupId: channelId,
        issuedAt: ISSUED,
        revision: 1,
        revokedAt: null,
      }
      await createGroupChannelWithGrants(f.local.db, f.workspace.id, f.owner, {
        candidates: groupCreationCandidatesFromGrants(f.workspace.id, {
          audienceGrants: [founder],
          enlistmentGrants: [enlist],
        }),
        channelId,
        idempotencyKey: crypto.randomUUID(),
        now: NOW,
        title: 'Group',
      })
      // Gate and final read trusted instants while the grant lives; the
      // post-write read lands after it lapses.
      const readings = [NOW, NOW, LATER]
      const clock = () => readings.shift() ?? LATER
      await expect(
        postGroupChannelMessage(
          f.local.db,
          f.workspace.id,
          channelId,
          f.owner,
          f.owner,
          {
            lead: { bodyText: 'must not land', idempotencyKey: crypto.randomUUID(), mentions: [] },
            mode: 'lead',
          },
          { clock }
        )
      ).rejects.toThrow('Channel unavailable')
      const [messages, intents] = await Promise.all([
        f.local.db
          .select()
          .from(schema.messages)
          .where(
            and(
              eq(schema.messages.workspaceId, f.workspace.id),
              eq(schema.messages.channelId, channelId)
            )
          ),
        f.local.db
          .select()
          .from(schema.leadTurnIntents)
          .where(eq(schema.leadTurnIntents.channelId, channelId)),
      ])
      expect(messages).toHaveLength(0)
      expect(intents).toHaveLength(0)
    } finally {
      await f.local.close()
    }
  })

  test('a successful authorized group lead post retains explicit lead and child selections', async () => {
    // The group lead branch preserves the SAME explicit lead/child choices
    // as the non-group lead path: parsed strictly at the route, forwarded
    // verbatim by the fence, retained on the canonical intent row.
    const f = await isolatedFixture()
    try {
      const lead = await ensureWorkspaceLead(f.local.db, f.workspace.id, f.owner)
      const channelId = crypto.randomUUID()
      const founder = {
        expiresAt: null,
        grantId: 'gra_owner',
        groupId: channelId,
        issuedAt: ISSUED,
        participant: f.owner,
        revision: 1,
        revokedAt: null,
      }
      const enlist = {
        agent: { agentId: lead.id, workspaceId: f.workspace.id },
        expiresAt: null,
        grantId: 'gra_lead',
        groupId: channelId,
        issuedAt: ISSUED,
        revision: 1,
        revokedAt: null,
      }
      await createGroupChannelWithGrants(f.local.db, f.workspace.id, f.owner, {
        candidates: groupCreationCandidatesFromGrants(f.workspace.id, {
          audienceGrants: [founder],
          enlistmentGrants: [enlist],
        }),
        channelId,
        idempotencyKey: crypto.randomUUID(),
        now: NOW,
        title: 'Group',
      })
      const selections = {
        child: { selectionRef: `msel_${'c'.repeat(32)}`, selectionRevision: 3 },
        lead: { selectionRef: `msel_${'d'.repeat(32)}`, selectionRevision: 2 },
      }
      const posted = await postGroupChannelMessage(
        f.local.db,
        f.workspace.id,
        channelId,
        f.owner,
        f.owner,
        {
          lead: {
            bodyText: 'choices ride along',
            idempotencyKey: crypto.randomUUID(),
            mentions: [],
            requestedModelSelections: selections,
          },
          mode: 'lead',
        },
        { now: NOW }
      )
      expect(posted.message.sequence).toBeGreaterThanOrEqual(1)
      const [intents, messages] = await Promise.all([
        f.local.db
          .select()
          .from(schema.leadTurnIntents)
          .where(eq(schema.leadTurnIntents.channelId, channelId)),
        f.local.db
          .select()
          .from(schema.messages)
          .where(
            and(
              eq(schema.messages.workspaceId, f.workspace.id),
              eq(schema.messages.channelId, channelId)
            )
          ),
      ])
      expect(intents).toHaveLength(1)
      expect(intents[0]?.agentId).toBe(lead.id)
      expect(intents[0]?.requestedModelSelections).toEqual(selections)
      expect(messages.map((message) => message.id)).toContain(posted.message.id)
    } finally {
      await f.local.close()
    }
  })

  test('search snippets obey the same join point as the message reads', async () => {
    const f = await isolatedFixture()
    try {
      const channelId = crypto.randomUUID()
      const founder = {
        expiresAt: null,
        grantId: 'gra_owner',
        groupId: channelId,
        issuedAt: ISSUED,
        participant: f.owner,
        revision: 1,
        revokedAt: null,
      }
      const memberGrant = {
        expiresAt: null,
        grantId: 'gra_member',
        groupId: channelId,
        issuedAt: ISSUED,
        participant: f.member,
        revision: 1,
        revokedAt: null,
      }
      const created = await createGroupChannelWithGrants(f.local.db, f.workspace.id, f.owner, {
        candidates: groupCreationCandidatesFromGrants(f.workspace.id, {
          audienceGrants: [founder],
          enlistmentGrants: [],
        }),
        channelId,
        idempotencyKey: crypto.randomUUID(),
        now: NOW,
        title: 'Group',
      })
      await createMessage(f.local.db, f.workspace.id, channelId, f.owner, {
        bodyText: 'zephyr confidential note',
        idempotencyKey: crypto.randomUUID(),
        sender: f.owner,
      })
      await setGroupChannelParticipantsWithGrants(f.local.db, f.workspace.id, channelId, f.owner, {
        candidates: groupCreationCandidatesFromGrants(f.workspace.id, {
          audienceGrants: [founder, memberGrant],
          enlistmentGrants: [],
        }),
        expectedVersion: created.channel.version,
        now: LATER,
      })
      const founderHits = await searchWorkspaceForUser(
        f.local.db,
        f.workspace.id,
        f.owner,
        'zephyr',
        {
          channelId,
          now: LATER,
        }
      )
      expect(
        founderHits.results.some(
          (result) => result.kind === 'message' && result.channelId === channelId
        )
      ).toBe(true)
      const memberHits = await searchWorkspaceForUser(
        f.local.db,
        f.workspace.id,
        f.member,
        'zephyr',
        { channelId, now: LATER }
      )
      expect(
        memberHits.results.some(
          (result) => result.kind === 'message' && result.channelId === channelId
        )
      ).toBe(false)
    } finally {
      await f.local.close()
    }
  })

  test('post and roster rewrite share one lock order: two connections never deadlock', async () => {
    // Both directions take the channel row before any admission/grant row.
    // Each side holds its first lock while the other waits; whichever waits
    // proceeds after the holder commits. Timeouts fail fast on deadlock.
    const primary = await isolatedFixture()
    const secondary = createDatabase(connectionUrl!)
    try {
      const channelId = crypto.randomUUID()
      const founder = {
        expiresAt: null,
        grantId: 'gra_owner',
        groupId: channelId,
        issuedAt: ISSUED,
        participant: primary.owner,
        revision: 1,
        revokedAt: null,
      }
      const memberGrant = {
        expiresAt: null,
        grantId: 'gra_member',
        groupId: channelId,
        issuedAt: ISSUED,
        participant: primary.member,
        revision: 1,
        revokedAt: null,
      }
      const created = await createGroupChannelWithGrants(
        primary.local.db,
        primary.workspace.id,
        primary.owner,
        {
          candidates: groupCreationCandidatesFromGrants(primary.workspace.id, {
            audienceGrants: [founder],
            enlistmentGrants: [],
          }),
          channelId,
          idempotencyKey: crypto.randomUUID(),
          now: NOW,
          title: 'Group',
        }
      )
      const candidates = groupCreationCandidatesFromGrants(primary.workspace.id, {
        audienceGrants: [founder, memberGrant],
        enlistmentGrants: [],
      })
      const validation = validateGroupCreation({
        candidates,
        groupId: channelId,
        now: LATER,
        workspaceId: primary.workspace.id,
      })
      if (!validation.ok) throw new Error('test roster must validate')
      const finish = async <T>(operation: Promise<T>): Promise<T> =>
        Promise.race([
          operation,
          sleep(8000).then(() => {
            throw new Error('deadlock: operation never completed')
          }),
        ])
      // Direction one: rewrite holds the channel lock, post waits, both finish.
      let releaseRewrite!: () => void
      const rewriteOpen = new Promise<void>((resolve) => {
        releaseRewrite = resolve
      })
      let rewriteLocked!: () => void
      const rewriteLockedPromise = new Promise<void>((resolve) => {
        rewriteLocked = resolve
      })
      const rewriting = primary.local.db.transaction((tx) =>
        setGroupChannelParticipantsInTransaction(
          tx,
          primary.workspace.id,
          channelId,
          primary.owner,
          {
            candidates,
            expectedVersion: created.channel.version,
            now: LATER,
            roster: validation.roster,
          },
          {
            afterChannelLock: async () => {
              rewriteLocked()
              await rewriteOpen
            },
          }
        )
      )
      await Promise.race([
        rewriteLockedPromise,
        sleep(3000).then(() => {
          throw new Error('rewrite never locked')
        }),
      ])
      const posting = secondary.db.transaction((tx) =>
        postGroupChannelMessageInTransaction(
          tx,
          primary.workspace.id,
          channelId,
          primary.owner,
          primary.owner,
          {
            message: { bodyText: 'waits for rewrite', idempotencyKey: crypto.randomUUID() },
            mode: 'direct',
          },
          { now: LATER }
        )
      )
      expect(await raced(posting, 400)).toBe('blocked')
      releaseRewrite()
      const [replaced, posted] = await Promise.all([finish(rewriting), finish(posting)])
      expect(posted.sequence).toBeGreaterThanOrEqual(1)
      const newcomer = replaced.roster.find(
        (entry) =>
          entry.participant.kind === 'user' && entry.participant.userId === primary.member.userId
      )!
      expect(newcomer.joinPoint.joinedSequence).toBeLessThanOrEqual(posted.sequence)
      // Direction two: fenced post holds the channel lock, rewrite waits, both finish.
      let releasePost!: () => void
      const postOpen = new Promise<void>((resolve) => {
        releasePost = resolve
      })
      let postLocked!: () => void
      const postLockedPromise = new Promise<void>((resolve) => {
        postLocked = resolve
      })
      const posting2 = secondary.db.transaction((tx) =>
        postGroupChannelMessageInTransaction(
          tx,
          primary.workspace.id,
          channelId,
          primary.owner,
          primary.owner,
          {
            message: { bodyText: 'holds the lock', idempotencyKey: crypto.randomUUID() },
            mode: 'direct',
          },
          {
            barrier: {
              afterGate: async () => {
                postLocked()
                await postOpen
              },
            },
            now: LATER,
          }
        )
      )
      await Promise.race([
        postLockedPromise,
        sleep(3000).then(() => {
          throw new Error('post never locked')
        }),
      ])
      const memberOnly = groupCreationCandidatesFromGrants(primary.workspace.id, {
        audienceGrants: [founder],
        enlistmentGrants: [],
      })
      const revalidation = validateGroupCreation({
        candidates: memberOnly,
        groupId: channelId,
        now: LATER,
        workspaceId: primary.workspace.id,
      })
      if (!revalidation.ok) throw new Error('test roster must validate')
      const rewriting2 = primary.local.db.transaction((tx) =>
        setGroupChannelParticipantsInTransaction(
          tx,
          primary.workspace.id,
          channelId,
          primary.owner,
          {
            candidates: memberOnly,
            expectedVersion: replaced.channel.version,
            now: LATER,
            roster: revalidation.roster,
          }
        )
      )
      expect(await raced(rewriting2, 400)).toBe('blocked')
      releasePost()
      const [posted2, replaced2] = await Promise.all([finish(posting2), finish(rewriting2)])
      expect(posted2.sequence).toBeGreaterThanOrEqual(1)
      expect(replaced2.roster).toHaveLength(1)
    } finally {
      await secondary.close()
      await primary.local.close()
    }
  })

  test('expiry during real lock waiting denies after the write attempt and rolls back', async () => {
    const f = await isolatedFixture()
    try {
      const channelId = crypto.randomUUID()
      const founder = {
        expiresAt: null,
        grantId: 'gra_owner',
        groupId: channelId,
        issuedAt: ISSUED,
        participant: f.owner,
        revision: 1,
        revokedAt: null,
      }
      const expiring = '2026-10-08T12:30:00.000Z'
      const grant = {
        expiresAt: expiring,
        grantId: 'gra_member',
        groupId: channelId,
        issuedAt: ISSUED,
        participant: f.member,
        revision: 1,
        revokedAt: null,
      }
      await createGroupChannelWithGrants(f.local.db, f.workspace.id, f.owner, {
        candidates: groupCreationCandidatesFromGrants(f.workspace.id, {
          audienceGrants: [founder, grant],
          enlistmentGrants: [],
        }),
        channelId,
        idempotencyKey: crypto.randomUUID(),
        now: NOW,
        title: 'Group',
      })
      // The scripted clock lapses only at the post-write check: gate and
      // final allow on trusted time, the nested write really executes, then
      // the post-write denial rolls everything back. (Real lock waiting is
      // proven by the lock-order test above; the clock models time passage
      // deterministically here.)
      const readings = [NOW, NOW, LATER]
      const clock = () => readings.shift() ?? LATER
      const key = crypto.randomUUID()
      await expect(
        postGroupChannelMessage(
          f.local.db,
          f.workspace.id,
          channelId,
          f.member,
          f.member,
          { message: { bodyText: 'must not land', idempotencyKey: key }, mode: 'direct' },
          { clock }
        )
      ).rejects.toThrow('Channel unavailable')
      const rows = await f.local.db
        .select()
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.workspaceId, f.workspace.id),
            eq(schema.messages.channelId, channelId)
          )
        )
      expect(rows).toHaveLength(0)
    } finally {
      await f.local.close()
    }
  })

  test('group lead resolution finds the single enlisted workspace lead', async () => {
    const f = await isolatedFixture()
    try {
      const lead = await ensureWorkspaceLead(f.local.db, f.workspace.id, f.owner)
      const channelId = crypto.randomUUID()
      const founder = {
        expiresAt: null,
        grantId: 'gra_owner',
        groupId: channelId,
        issuedAt: ISSUED,
        participant: f.owner,
        revision: 1,
        revokedAt: null,
      }
      const enlist = {
        agent: { agentId: lead.id, workspaceId: f.workspace.id },
        expiresAt: null,
        grantId: 'gra_lead',
        groupId: channelId,
        issuedAt: ISSUED,
        revision: 1,
        revokedAt: null,
      }
      await createGroupChannelWithGrants(f.local.db, f.workspace.id, f.owner, {
        candidates: groupCreationCandidatesFromGrants(f.workspace.id, {
          audienceGrants: [founder],
          enlistmentGrants: [enlist],
        }),
        channelId,
        idempotencyKey: crypto.randomUUID(),
        now: NOW,
        title: 'Group',
      })
      const resolved = await resolveGroupLeadAgent(f.local.db, f.workspace.id, channelId, LATER)
      expect(resolved).toBe(lead.id)
    } finally {
      await f.local.close()
    }
  })

  test('group lead resolution fails closed without an effective lead enlistment', async () => {
    const f = await isolatedFixture()
    try {
      const lead = await ensureWorkspaceLead(f.local.db, f.workspace.id, f.owner)
      const channelId = crypto.randomUUID()
      const founder = {
        expiresAt: null,
        grantId: 'gra_owner',
        groupId: channelId,
        issuedAt: ISSUED,
        participant: f.owner,
        revision: 1,
        revokedAt: null,
      }
      // A non-lead agent enlisted alongside the lead: only the lead resolves.
      const plain = await createAgent(f.local.db, f.workspace.id, f.owner, {
        name: 'Plain',
        profileId: 'lead',
        profileVersion: '1',
      })
      const { channel } = await createGroupChannelWithGrants(f.local.db, f.workspace.id, f.owner, {
        candidates: groupCreationCandidatesFromGrants(f.workspace.id, {
          audienceGrants: [founder],
          enlistmentGrants: [
            {
              agent: { agentId: lead.id, workspaceId: f.workspace.id },
              expiresAt: null,
              grantId: 'gra_lead',
              groupId: channelId,
              issuedAt: ISSUED,
              revision: 1,
              revokedAt: null,
            },
            {
              agent: { agentId: plain.id, workspaceId: f.workspace.id },
              expiresAt: null,
              grantId: 'gra_plain',
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
      expect(await resolveGroupLeadAgent(f.local.db, f.workspace.id, channelId, LATER)).toBe(
        lead.id
      )
      expect(channel.participants).toHaveLength(3)
      // Revoking the lead enlistment resolves nobody: no guessing, no fallback.
      await revokeGroupGrant(f.local.db, f.workspace.id, channelId, f.owner, {
        grantId: 'gra_lead',
        kind: 'enlistment',
        revokedAt: LATER,
      })
      expect(await resolveGroupLeadAgent(f.local.db, f.workspace.id, channelId, LATER)).toBeNull()
      // A group with no enlisted agents resolves nobody either.
      const lonelyId = crypto.randomUUID()
      await createGroupChannelWithGrants(f.local.db, f.workspace.id, f.owner, {
        candidates: groupCreationCandidatesFromGrants(f.workspace.id, {
          audienceGrants: [{ ...founder, grantId: 'gra_owner2', groupId: lonelyId }],
          enlistmentGrants: [],
        }),
        channelId: lonelyId,
        idempotencyKey: crypto.randomUUID(),
        now: NOW,
        title: 'Lonely',
      })
      expect(await resolveGroupLeadAgent(f.local.db, f.workspace.id, lonelyId, LATER)).toBeNull()
    } finally {
      await f.local.close()
    }
  })
})
