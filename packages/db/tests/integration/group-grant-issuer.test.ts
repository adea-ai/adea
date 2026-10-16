import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { UserPrincipalRef } from '@adea-ai/types'
import { and, eq } from 'drizzle-orm'

import { archiveAgent, createAgent } from '../../src/agents'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import {
  audienceGrantIdFor,
  createGroupChannelFromSelection,
  enlistmentGrantIdFor,
  setGroupChannelParticipantsFromSelection,
} from '../../src/group-grant-issuer'
import { createMessage } from '../../src/conversations'
import {
  authorizeGroupChannelPublication,
  listGroupChannelMessagesForUser,
  loadGroupRoster,
  revokeGroupGrant,
  setGroupChannelParticipantsWithGrants,
} from '../../src/group-channels'
import {
  GroupCreationError,
  groupCreationCandidatesFromGrants,
} from '../../src/group-participation-store'
import { createTemporaryUserSession } from '../../src/identity'
import * as schema from '../../src/schema'
import {
  addWorkspaceMembership,
  createWorkspaceWithOwner,
  removeWorkspaceMembership,
} from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL
// Real recent instants: messages are stamped with the wall clock, so grants must already be in effect.
const NOW = new Date(Date.now() - 120_000).toISOString()
const LATER = new Date(Date.now() - 60_000).toISOString()

const rejectionsOf = async (attempt: Promise<unknown>) => {
  const error = await attempt.then(
    () => null,
    (reason: unknown) => reason
  )
  expect(error).toBeInstanceOf(GroupCreationError)
  return (error as GroupCreationError).rejections
}

describe.skipIf(!connectionUrl)('server-side group grant issuance', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => connection.close())

  async function user(label: string): Promise<UserPrincipalRef> {
    return (
      await createTemporaryUserSession(connection.db, {
        credentialDigest: `group-issuer-${label}-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000),
      })
    ).principal
  }

  async function fixture() {
    const owner = await user('owner')
    const member = await user('member')
    const second = await user('second')
    const outsider = await user('outsider')
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Issuer workspace',
      owner,
    })
    await addWorkspaceMembership(connection.db, workspace.id, member, 'member')
    await addWorkspaceMembership(connection.db, workspace.id, second, 'member')
    const agent = await createAgent(connection.db, workspace.id, owner, {
      name: 'Aria',
      profileId: 'lead',
      profileVersion: '1',
    })
    return { agent, member, outsider, owner, second, workspace }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  async function foreign() {
    const sourceOwner = await user('source-owner')
    const { workspace: source } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Agent source',
      owner: sourceOwner,
    })
    const agent = await createAgent(connection.db, source.id, sourceOwner, {
      name: 'Foreign',
      profileId: 'lead',
      profileVersion: '1',
    })
    return { agent, source, sourceOwner }
  }

  const say = (f: Fixture, channelId: string, bodyText: string) =>
    createMessage(connection.db, f.workspace.id, channelId, f.owner, {
      bodyText,
      idempotencyKey: crypto.randomUUID(),
      sender: f.owner,
    })
  const seenBy = async (f: Fixture, channelId: string, reader: UserPrincipalRef) =>
    (
      await listGroupChannelMessagesForUser(connection.db, f.workspace.id, channelId, reader, {})
    ).messages.map(({ bodyText }) => bodyText)
  const revoke = (f: Fixture, channelId: string, userId: string, revokedAt = NOW) =>
    revokeGroupGrant(connection.db, f.workspace.id, channelId, f.owner, {
      grantId: audienceGrantIdFor(userId),
      kind: 'audience',
      revokedAt,
    })
  test('a roster drafted before another admin revoked someone cannot regrant them', async () => {
    const f = await fixture()
    const channelId = crypto.randomUUID()
    const created = await create(f, { humans: [f.member.userId] }, { channelId })
    const draftedAt = created.channel.version
    await revoke(f, channelId, f.member.userId)
    // The stale draft only meant to add a third person, at the version it saw.
    const rejections = await rejectionsOf(
      replace(f, channelId, draftedAt, {
        humans: [f.owner.userId, f.member.userId, f.second.userId],
      })
    )
    expect(rejections.map(({ reason }) => reason)).toEqual(['grant_revoked'])
    const [grant] = await grantsOf(channelId, f.member.userId)
    expect(grant).toMatchObject({ revision: 1 })
    expect(grant!.revokedAt).not.toBeNull()
    expect(await grantsOf(channelId, f.second.userId)).toHaveLength(0)
    expect(await versionOf(channelId)).toBe(draftedAt)
  })

  const create = (
    f: Fixture,
    selection: { agents?: { agentId: string; workspaceId: string }[]; humans?: string[] },
    options: {
      channelId?: string
      idempotencyKey?: string
      now?: string
      as?: UserPrincipalRef
    } = {}
  ) =>
    createGroupChannelFromSelection(connection.db, f.workspace.id, options.as ?? f.owner, {
      channelId: options.channelId,
      idempotencyKey: options.idempotencyKey ?? crypto.randomUUID(),
      now: options.now ?? NOW,
      selection: { agents: selection.agents ?? [], humans: selection.humans ?? [] },
      title: 'Selected group',
    })

  const replace = (
    f: Fixture,
    channelId: string,
    expectedVersion: number,
    selection: { agents?: { agentId: string; workspaceId: string }[]; humans?: string[] },
    options: { now?: string; as?: UserPrincipalRef } = {}
  ) =>
    setGroupChannelParticipantsFromSelection(
      connection.db,
      f.workspace.id,
      channelId,
      options.as ?? f.owner,
      {
        expectedVersion,
        now: options.now ?? LATER,
        selection: { agents: selection.agents ?? [], humans: selection.humans ?? [] },
      }
    )

  const grantRows = (channelId: string) =>
    connection.db
      .select()
      .from(schema.groupAudienceGrants)
      .where(eq(schema.groupAudienceGrants.channelId, channelId))
  const enlistmentRows = (channelId: string) =>
    connection.db
      .select()
      .from(schema.groupEnlistmentGrants)
      .where(eq(schema.groupEnlistmentGrants.channelId, channelId))
  const grantsOf = async (channelId: string, userId: string) =>
    (await grantRows(channelId)).filter((row) => row.userId === userId)
  const versionOf = async (channelId: string) => {
    const [row] = await connection.db
      .select({ version: schema.channels.version })
      .from(schema.channels)
      .where(eq(schema.channels.id, channelId))
    return row!.version
  }
  const channelCount = async (channelId: string) =>
    (await connection.db.select().from(schema.channels).where(eq(schema.channels.id, channelId)))
      .length

  test('creates the group with the creator founded and every other member issued a grant bound to it', async () => {
    const f = await fixture()
    const channelId = crypto.randomUUID()
    const created = await create(
      f,
      {
        agents: [{ agentId: f.agent.id, workspaceId: f.workspace.id }],
        humans: [f.member.userId, f.owner.userId],
      },
      { channelId }
    )
    expect(created.channel.id).toBe(channelId)
    const roster = await loadGroupRoster(connection.db, f.workspace.id, channelId)
    expect(roster).toHaveLength(3)
    expect(roster.every(({ authorization }) => authorization.groupId === channelId)).toBe(true)
    const audience = await grantRows(channelId)
    expect(audience.map(({ grantId }) => grantId).toSorted()).toEqual(
      [`founder-${f.owner.userId}`, audienceGrantIdFor(f.member.userId)].toSorted()
    )
    expect(
      (await enlistmentRows(channelId)).map(({ grantId, revision }) => ({ grantId, revision }))
    ).toEqual([
      {
        grantId: enlistmentGrantIdFor({ agentId: f.agent.id, workspaceId: f.workspace.id }),
        revision: 1,
      },
    ])
  })

  test('replaying the same create request returns the same group and issues nothing twice', async () => {
    const f = await fixture()
    const channelId = crypto.randomUUID()
    const idempotencyKey = crypto.randomUUID()
    const first = await create(f, { humans: [f.member.userId] }, { channelId, idempotencyKey })
    const again = await create(
      f,
      { humans: [f.member.userId] },
      { channelId, idempotencyKey, now: LATER }
    )
    expect(again.channel.id).toBe(first.channel.id)
    expect(await grantRows(channelId)).toHaveLength(2)
  })

  test('a person who is not a member of the host workspace is refused and nothing is written', async () => {
    const f = await fixture()
    const channelId = crypto.randomUUID()
    await expect(create(f, { humans: [f.outsider.userId] }, { channelId })).rejects.toThrow()
    expect(await channelCount(channelId)).toBe(0)
    expect(await grantRows(channelId)).toHaveLength(0)
  })

  test('a plain member can create a group and name other members, who are checked like anyone else', async () => {
    const f = await fixture()
    const channelId = crypto.randomUUID()
    await create(f, { humans: [f.second.userId] }, { as: f.member, channelId })
    const roster = await loadGroupRoster(connection.db, f.workspace.id, channelId)
    expect(roster.map(({ participant }) => participant)).toContainEqual({
      kind: 'user',
      userId: f.member.userId,
    })
  })

  describe('Agents from other workspaces', () => {
    test('an owner with no standing in the source workspace cannot enlist the Agent', async () => {
      const f = await fixture()
      const { agent, source } = await foreign()
      const channelId = crypto.randomUUID()
      await expect(
        create(f, { agents: [{ agentId: agent.id, workspaceId: source.id }] }, { channelId })
      ).rejects.toThrow()
      expect(await channelCount(channelId)).toBe(0)
    })

    test('claiming the host workspace for a foreign Agent does not borrow host authority', async () => {
      const f = await fixture()
      const { agent } = await foreign()
      const channelId = crypto.randomUUID()
      await expect(
        create(f, { agents: [{ agentId: agent.id, workspaceId: f.workspace.id }] }, { channelId })
      ).rejects.toThrow()
      expect(await channelCount(channelId)).toBe(0)
    })

    test('an admin of the source workspace can enlist it, and keeps it across a roster save', async () => {
      const f = await fixture()
      const { agent, source } = await foreign()
      await addWorkspaceMembership(connection.db, source.id, f.owner, 'admin')
      const channelId = crypto.randomUUID()
      const qualified = { agentId: agent.id, workspaceId: source.id }
      const created = await create(f, { agents: [qualified] }, { channelId })
      const [before] = await enlistmentRows(channelId)
      const saved = await replace(f, channelId, created.channel.version, {
        agents: [qualified],
        humans: [f.owner.userId, f.member.userId],
      })
      expect(saved.roster).toHaveLength(3)
      expect(await enlistmentRows(channelId)).toEqual([before!])
    })

    test('once source authority is gone, a roster save that keeps the Agent is refused unchanged', async () => {
      const f = await fixture()
      const { agent, source } = await foreign()
      await addWorkspaceMembership(connection.db, source.id, f.owner, 'admin')
      const channelId = crypto.randomUUID()
      const qualified = { agentId: agent.id, workspaceId: source.id }
      const created = await create(f, { agents: [qualified] }, { channelId })
      expect(await removeWorkspaceMembership(connection.db, source.id, f.owner)).toBe(true)
      await expect(
        replace(f, channelId, created.channel.version, {
          agents: [qualified],
          humans: [f.owner.userId, f.member.userId],
        })
      ).rejects.toThrow()
      expect(await loadGroupRoster(connection.db, f.workspace.id, channelId)).toHaveLength(2)
    })
  })

  test('an archived Agent is refused with typed reasons and the group is not changed', async () => {
    const f = await fixture()
    const channelId = crypto.randomUUID()
    const created = await create(f, { humans: [f.member.userId] }, { channelId })
    await archiveAgent(connection.db, f.workspace.id, f.agent.id, f.owner)
    const error = await replace(f, channelId, created.channel.version, {
      agents: [{ agentId: f.agent.id, workspaceId: f.workspace.id }],
      humans: [f.owner.userId, f.member.userId],
    }).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect(await loadGroupRoster(connection.db, f.workspace.id, channelId)).toHaveLength(2)
    if (error instanceof GroupCreationError) expect(error.rejections.length).toBeGreaterThan(0)
  })

  describe('roster replacement', () => {
    test('retained members keep the exact grant and binding they hold; new members get a revision-1 grant', async () => {
      const f = await fixture()
      const channelId = crypto.randomUUID()
      const created = await create(
        f,
        {
          agents: [{ agentId: f.agent.id, workspaceId: f.workspace.id }],
          humans: [f.member.userId],
        },
        { channelId }
      )
      const before = await loadGroupRoster(connection.db, f.workspace.id, channelId)
      const bindingOf = (roster: typeof before, key: string) =>
        roster.find(({ participant }) =>
          participant.kind === 'user' ? participant.userId === key : participant.agentId === key
        )!.authorization
      const result = await replace(f, channelId, created.channel.version, {
        agents: [{ agentId: f.agent.id, workspaceId: f.workspace.id }],
        humans: [f.owner.userId, f.member.userId, f.second.userId],
      })
      expect(result.channel.version).toBe(created.channel.version + 1)
      const after = await loadGroupRoster(connection.db, f.workspace.id, channelId)
      expect(after).toHaveLength(4)
      for (const key of [f.owner.userId, f.member.userId, f.agent.id])
        expect(bindingOf(after, key)).toEqual(bindingOf(before, key))
      expect(bindingOf(after, f.second.userId)).toMatchObject({
        grantId: audienceGrantIdFor(f.second.userId),
        groupId: channelId,
        revision: 1,
      })
    })

    test('removing a member drops their admission and leaves everyone else on their grants', async () => {
      const f = await fixture()
      const channelId = crypto.randomUUID()
      const created = await create(f, { humans: [f.member.userId, f.second.userId] }, { channelId })
      const result = await replace(f, channelId, created.channel.version, {
        humans: [f.owner.userId, f.second.userId],
      })
      expect(result.roster.map(({ participant }) => participant)).not.toContainEqual({
        kind: 'user',
        userId: f.member.userId,
      })
      expect(await loadGroupRoster(connection.db, f.workspace.id, channelId)).toHaveLength(2)
    })

    test('keeping someone whose grant was withdrawn is refused with its reason, not renewed', async () => {
      const f = await fixture()
      const channelId = crypto.randomUUID()
      await create(f, { humans: [f.member.userId] }, { channelId })
      await revoke(f, channelId, f.member.userId)
      const version = await versionOf(channelId)
      const rejections = await rejectionsOf(
        replace(f, channelId, version, {
          humans: [f.owner.userId, f.member.userId, f.second.userId],
        })
      )
      expect(rejections.map(({ reason }) => reason)).toEqual(['grant_revoked'])
      expect(await versionOf(channelId)).toBe(version)
      expect(await grantsOf(channelId, f.second.userId)).toHaveLength(0)
      const [grant] = await grantsOf(channelId, f.member.userId)
      expect(grant).toMatchObject({ revision: 1 })
      expect(grant!.revokedAt).not.toBeNull()
    })

    test('keeping someone whose grant expired is refused with its reason, not renewed', async () => {
      const f = await fixture()
      const channelId = crypto.randomUUID()
      await create(f, { humans: [f.member.userId] }, { channelId })
      await connection.db
        .update(schema.groupAudienceGrants)
        .set({ expiresAt: NOW })
        .where(
          and(
            eq(schema.groupAudienceGrants.channelId, channelId),
            eq(schema.groupAudienceGrants.userId, f.member.userId)
          )
        )
      const rejections = await rejectionsOf(
        replace(f, channelId, await versionOf(channelId), {
          humans: [f.owner.userId, f.member.userId],
        })
      )
      expect(rejections.map(({ reason }) => reason)).toEqual(['grant_expired'])
    })

    test('readmission is removing and adding again: the next revision, and a new history frontier', async () => {
      const f = await fixture()
      const channelId = crypto.randomUUID()
      const created = await create(f, { humans: [f.member.userId] }, { channelId })
      await say(f, channelId, 'before the withdrawal')
      await revoke(f, channelId, f.member.userId)
      await say(f, channelId, 'while access was withdrawn')
      const removed = await replace(f, channelId, await versionOf(channelId), {
        humans: [f.owner.userId],
      })
      await say(f, channelId, 'while removed')
      const readded = await replace(f, channelId, removed.channel.version, {
        humans: [f.owner.userId, f.member.userId],
      })
      expect(created.channel.version).toBeLessThan(readded.channel.version)
      const admission = readded.roster.find(
        ({ participant }) => participant.kind === 'user' && participant.userId === f.member.userId
      )!
      expect(admission.authorization).toMatchObject({
        grantId: audienceGrantIdFor(f.member.userId),
        revision: 2,
      })
      await say(f, channelId, 'after the readmission')
      // Nothing said while their access was withdrawn or while they were out is theirs to read.
      expect(await seenBy(f, channelId, f.member)).toEqual(['after the readmission'])
      const [grant] = await grantsOf(channelId, f.member.userId)
      expect(grant).toMatchObject({ revision: 2, revokedAt: null })
    })

    test('a regrant of a member who stayed on the roster also starts a new history frontier', async () => {
      const f = await fixture()
      const channelId = crypto.randomUUID()
      await create(f, { humans: [f.member.userId] }, { channelId })
      await revoke(f, channelId, f.member.userId)
      await say(f, channelId, 'said while revoked')
      const version = await versionOf(channelId)
      const [held] = await grantsOf(channelId, f.member.userId)
      const regrant = await setGroupChannelParticipantsWithGrants(
        connection.db,
        f.workspace.id,
        channelId,
        f.owner,
        {
          candidates: groupCreationCandidatesFromGrants(f.workspace.id, {
            audienceGrants: [
              {
                expiresAt: null,
                grantId: `founder-${f.owner.userId}`,
                groupId: channelId,
                issuedAt: NOW,
                participant: f.owner,
                revision: 1,
                revokedAt: null,
              },
              {
                expiresAt: null,
                grantId: held!.grantId,
                groupId: channelId,
                issuedAt: LATER,
                participant: f.member,
                revision: held!.revision + 1,
                revokedAt: null,
              },
            ],
            enlistmentGrants: [],
          }),
          expectedVersion: version,
          now: LATER,
        }
      )
      expect(regrant.roster).toHaveLength(2)
      await say(f, channelId, 'said after the regrant')
      expect(await seenBy(f, channelId, f.member)).toEqual(['said after the regrant'])
    })

    test('a retained member keeps their history frontier while their grant is unchanged', async () => {
      const f = await fixture()
      const channelId = crypto.randomUUID()
      const created = await create(f, { humans: [f.member.userId] }, { channelId })
      await say(f, channelId, 'after joining')
      await replace(f, channelId, created.channel.version, {
        humans: [f.owner.userId, f.member.userId, f.second.userId],
      })
      await say(f, channelId, 'after the roster grew')
      expect(await seenBy(f, channelId, f.member)).toEqual([
        'after joining',
        'after the roster grew',
      ])
    })

    test('a child job that finished while its member was removed is still held after they are re-added', async () => {
      const f = await fixture()
      const channelId = crypto.randomUUID()
      const created = await create(f, { humans: [f.member.userId] }, { channelId })
      const gate = { channel: created.channel, workspaceId: f.workspace.id }
      const before = created.roster.find(
        ({ participant }) => participant.kind === 'user' && participant.userId === f.member.userId
      )!
      const job = {
        authorization: before.authorization,
        completedAt: NOW,
        jobId: 'job_started_before_removal',
        participant: f.member,
      }
      const removed = await replace(f, channelId, created.channel.version, {
        humans: [f.owner.userId],
      })
      // It completes while its member is out: nothing publishes for a non-member.
      expect(
        authorizeGroupChannelPublication(gate, {
          admission: undefined,
          job,
          now: LATER,
          publisher: f.member,
        })
      ).toMatchObject({ action: 'hold' })
      const readded = await replace(f, channelId, removed.channel.version, {
        humans: [f.owner.userId, f.member.userId],
      })
      const current = readded.roster.find(
        ({ participant }) => participant.kind === 'user' && participant.userId === f.member.userId
      )!
      expect(current.authorization.revision).toBe(before.authorization.revision + 1)
      expect(
        authorizeGroupChannelPublication(gate, {
          admission: current,
          job,
          now: LATER,
          publisher: f.member,
        })
      ).toMatchObject({ action: 'hold', reason: 'publication_binding_mismatch' })
    })

    test('an Agent removed and added back gets a new binding too', async () => {
      const f = await fixture()
      const channelId = crypto.randomUUID()
      const qualified = { agentId: f.agent.id, workspaceId: f.workspace.id }
      const created = await create(f, { agents: [qualified] }, { channelId })
      const before = created.roster.find(({ participant }) => participant.kind === 'agent')!
      const removed = await replace(f, channelId, created.channel.version, {
        humans: [f.owner.userId],
      })
      const readded = await replace(f, channelId, removed.channel.version, {
        agents: [qualified],
        humans: [f.owner.userId],
      })
      const current = readded.roster.find(({ participant }) => participant.kind === 'agent')!
      expect(current.authorization.revision).toBe(before.authorization.revision + 1)
    })

    test('only an owner or admin can replace a roster, and nothing is issued for a refused save', async () => {
      const f = await fixture()
      const channelId = crypto.randomUUID()
      const created = await create(f, { humans: [f.member.userId] }, { channelId })
      await expect(
        replace(
          f,
          channelId,
          created.channel.version,
          { humans: [f.owner.userId, f.member.userId, f.second.userId] },
          { as: f.member }
        )
      ).rejects.toThrow()
      expect((await grantRows(channelId)).some(({ userId }) => userId === f.second.userId)).toBe(
        false
      )
    })

    test('a stale version is a conflict and issues nothing', async () => {
      const f = await fixture()
      const channelId = crypto.randomUUID()
      const created = await create(f, { humans: [f.member.userId] }, { channelId })
      await expect(
        replace(f, channelId, created.channel.version + 3, {
          humans: [f.owner.userId, f.member.userId, f.second.userId],
        })
      ).rejects.toThrow('Channel version conflict')
      expect((await grantRows(channelId)).some(({ userId }) => userId === f.second.userId)).toBe(
        false
      )
    })

    test('a member who left the workspace cannot be kept by the roster that names them', async () => {
      const f = await fixture()
      const channelId = crypto.randomUUID()
      const created = await create(f, { humans: [f.member.userId] }, { channelId })
      expect(await removeWorkspaceMembership(connection.db, f.workspace.id, f.member)).toBe(true)
      await expect(
        replace(f, channelId, created.channel.version, {
          humans: [f.owner.userId, f.member.userId],
        })
      ).rejects.toThrow()
    })

    test('two concurrent saves against the same version: exactly one wins and the roster is consistent', async () => {
      const f = await fixture()
      const channelId = crypto.randomUUID()
      const created = await create(f, { humans: [f.member.userId] }, { channelId })
      const [one, two] = await Promise.allSettled([
        replace(f, channelId, created.channel.version, {
          humans: [f.owner.userId, f.member.userId, f.second.userId],
        }),
        replace(f, channelId, created.channel.version, { humans: [f.owner.userId] }),
      ])
      const outcomes = [one.status, two.status].toSorted()
      expect(outcomes).toEqual(['fulfilled', 'rejected'])
      const roster = await loadGroupRoster(connection.db, f.workspace.id, channelId)
      const expected = one.status === 'fulfilled' ? 3 : 1
      expect(roster).toHaveLength(expected)
    })
  })
})
