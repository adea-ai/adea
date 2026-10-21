import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import type { ConversationParticipantRef, UserPrincipalRef } from '@adea-ai/types'

import { createDatabase, type AgentHqDatabase, type DatabaseConnection } from '../../src/connection'
import {
  createGroupChannelWithGrants,
  groupCreationCandidatesFromGrants,
  postGroupChannelMessage,
  revokeGroupGrant,
} from '../../src/group-channels'
import {
  readGroupStanding,
  type GroupStandingMember,
  type GroupStandingReadModel,
} from '../../src/group-standing-read-model'
import { createTemporaryUserSession } from '../../src/identity'
import { groupAdmissions, workspaceMemberships } from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'

// #1178 effective group standing: a read-only projection of one group's roster.
//
// The projection answers what the group-audience guide still lists as a backend gap — "joined at"
// and "access ends" cannot be shown today — and it answers it from the canonical roster and the
// canonical standing decision, so it cannot drift from what the product already enforces.
//
// Each denial is paired with a positive control on the same group, so no refusal is vacuous, and
// the projection's own shape is asserted field by field: it publishes standing, never the grant
// identity that authorizes it, and never any conversation content.
//
// Requires DATABASE_URL on a disposable database (the integration lane provisions it).

const connectionUrl = process.env.DATABASE_URL
const ISSUED_AT = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

type Settled<T> = { value: T } | { denied: string }

/** The projected standing of one member; a missing member is a failure, not a silent skip. */
function standingOf(model: GroupStandingReadModel, userId: string): GroupStandingMember {
  const entry = model.members.find(
    (member) => member.participant.kind === 'user' && member.participant.userId === userId
  )
  if (!entry) throw new Error(`the projection holds no standing for ${userId}`)
  return entry
}

async function settle<T>(run: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { value: await run() }
  } catch (error) {
    return { denied: error instanceof Error ? error.message : String(error) }
  }
}

describe.skipIf(!connectionUrl)('effective group standing read model (#1178)', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => connection.close())

  const db = (): AgentHqDatabase => connection.db

  async function user(label: string): Promise<UserPrincipalRef> {
    return (
      await createTemporaryUserSession(db(), {
        credentialDigest: `standing-model-${label}-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 600_000),
      })
    ).principal
  }

  async function fixture() {
    const owner = await user('owner')
    const member = await user('member')
    const stranger = await user('stranger')
    const { workspace } = await createWorkspaceWithOwner(db(), {
      idempotencyKey: crypto.randomUUID(),
      name: 'Standing read model',
      owner,
    })
    // Both the member and the stranger are workspace members. Membership alone is not group
    // standing: the stranger is never admitted to the group, and the member is.
    await db()
      .insert(workspaceMemberships)
      .values([
        { role: 'member', userId: member.userId, workspaceId: workspace.id },
        { role: 'member', userId: stranger.userId, workspaceId: workspace.id },
      ])
    return { member, owner, stranger, workspace }
  }

  /** A participants group with the owner and the member admitted under explicit audience grants. */
  async function groupWithAudience(
    f: Awaited<ReturnType<typeof fixture>>,
    title: string,
    options: Readonly<{ memberExpiresAt?: string | null }> = {}
  ) {
    const channelId = crypto.randomUUID()
    const grant = (
      grantId: string,
      participant: UserPrincipalRef,
      expiresAt: string | null = null
    ) => ({
      expiresAt,
      grantId,
      groupId: channelId,
      issuedAt: ISSUED_AT,
      participant,
      revision: 1,
      revokedAt: null,
    })
    const ownerGrant = grant('gra_owner', f.owner)
    const memberGrant = grant('gra_member', f.member, options.memberExpiresAt ?? null)
    await createGroupChannelWithGrants(db(), f.workspace.id, f.owner, {
      candidates: groupCreationCandidatesFromGrants(f.workspace.id, {
        audienceGrants: [ownerGrant, memberGrant],
        enlistmentGrants: [],
      }),
      channelId,
      idempotencyKey: crypto.randomUUID(),
      now: new Date().toISOString(),
      title,
    })
    return { channelId, memberGrantId: memberGrant.grantId, ownerGrantId: ownerGrant.grantId }
  }

  test("a member in force reads every member's standing, with the join point preserved", async () => {
    const f = await fixture()
    const group = await groupWithAudience(f, 'Standing projection')
    const read = await settle(() =>
      readGroupStanding(db(), {
        channelId: group.channelId,
        now: new Date().toISOString(),
        requester: f.owner,
        workspaceId: f.workspace.id,
      })
    )
    expect('value' in read).toBe(true)
    if (!('value' in read)) return
    const model = read.value
    expect(model.channelId).toBe(group.channelId)
    expect(model.workspaceId).toBe(f.workspace.id)
    // Every member of the canonical roster is projected, and nobody else is. The roster's own
    // order is the store's, so the members are compared as a set.
    const expected: ConversationParticipantRef[] = [
      { kind: 'user', userId: f.member.userId },
      { kind: 'user', userId: f.owner.userId },
    ]
    expect(
      model.members
        .map((member) => member.participant)
        .toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    ).toEqual(
      expected.toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    )
    for (const member of model.members) {
      expect(member.state).toBe('effective')
      expect(member.inForce).toBe(true)
      expect(member.expiresAt).toBeNull()
      expect(member.joinPoint.joinedSequence).toBe(0)
      expect(member.joinPoint.joinedAt).toEqual(expect.any(String))
    }
    // The requester's own join point is preserved exactly as the canonical admission holds it.
    const owner = standingOf(model, f.owner.userId)
    expect(model.requesterJoinPoint.joinedAt).toBe(owner.joinPoint.joinedAt)
    expect(model.requesterJoinPoint.joinedSequence).toBe(owner.joinPoint.joinedSequence)
  })

  test('an expiry is published as the access end, and the standing ends with it', async () => {
    const f = await fixture()
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const group = await groupWithAudience(f, 'Standing expiry', { memberExpiresAt: expiresAt })
    const before = await settle(() =>
      readGroupStanding(db(), {
        channelId: group.channelId,
        now: new Date().toISOString(),
        requester: f.owner,
        workspaceId: f.workspace.id,
      })
    )
    if (!('value' in before)) throw new Error('the standing read was refused')
    const member = standingOf(before.value, f.member.userId)
    // The expiry is published exactly as the grant holds it.
    expect(member.expiresAt).toBe(expiresAt)
    expect(member.state).toBe('effective')
    expect(member.inForce).toBe(true)

    // After the expiry the same grant stands nobody, and the state says so.
    const after = await settle(() =>
      readGroupStanding(db(), {
        channelId: group.channelId,
        now: new Date(Date.parse(expiresAt) + 1000).toISOString(),
        requester: f.owner,
        workspaceId: f.workspace.id,
      })
    )
    if (!('value' in after)) throw new Error('the standing read was refused')
    const expired = standingOf(after.value, f.member.userId)
    expect(expired.state).toBe('expired')
    expect(expired.inForce).toBe(false)
    // The expiry is still published: it is the access end the projection exists for.
    expect(expired.expiresAt).toBe(expiresAt)
    // The owner is unaffected: their own grant does not expire.
    const owner = standingOf(after.value, f.owner.userId)
    expect(owner.state).toBe('effective')
    expect(owner.inForce).toBe(true)
  })

  test('a revoked grant is published as revoked, and stands nobody', async () => {
    const f = await fixture()
    const group = await groupWithAudience(f, 'Standing revocation')
    await revokeGroupGrant(db(), f.workspace.id, group.channelId, f.owner, {
      grantId: group.memberGrantId,
      kind: 'audience',
      revokedAt: new Date().toISOString(),
    })
    const read = await settle(() =>
      readGroupStanding(db(), {
        channelId: group.channelId,
        now: new Date().toISOString(),
        requester: f.owner,
        workspaceId: f.workspace.id,
      })
    )
    if (!('value' in read)) throw new Error('the standing read was refused')
    const member = standingOf(read.value, f.member.userId)
    expect(member.state).toBe('revoked')
    expect(member.inForce).toBe(false)
    // The revoked member can no longer read the projection: their own standing is gone.
    const revoked = await settle(() =>
      readGroupStanding(db(), {
        channelId: group.channelId,
        now: new Date().toISOString(),
        requester: f.member,
        workspaceId: f.workspace.id,
      })
    )
    expect(revoked).toEqual({ denied: 'Channel unavailable' })
  })

  test('a requester without standing is refused and learns nothing', async () => {
    const f = await fixture()
    const group = await groupWithAudience(f, 'Standing requester')
    // A workspace member who was never admitted to the group.
    const stranger = await settle(() =>
      readGroupStanding(db(), {
        channelId: group.channelId,
        now: new Date().toISOString(),
        requester: f.stranger,
        workspaceId: f.workspace.id,
      })
    )
    expect(stranger).toEqual({ denied: 'Channel unavailable' })
    // A principal who was never a workspace member at all.
    const outsiderPrincipal = await user('outsider')
    const outsider = await settle(() =>
      readGroupStanding(db(), {
        channelId: group.channelId,
        now: new Date().toISOString(),
        requester: outsiderPrincipal,
        workspaceId: f.workspace.id,
      })
    )
    expect(outsider).toEqual({ denied: 'Channel unavailable' })
    // The positive control on the same group: an admitted member still reads it.
    const admitted = await settle(() =>
      readGroupStanding(db(), {
        channelId: group.channelId,
        now: new Date().toISOString(),
        requester: f.member,
        workspaceId: f.workspace.id,
      })
    )
    expect('value' in admitted).toBe(true)
  })

  test('a later joiner keeps its own join point, and the projection exposes no authority or content', async () => {
    const f = await fixture()
    const group = await groupWithAudience(f, 'Standing join point')
    // A message the later joiner must not learn about through the projection.
    const posted = await postGroupChannelMessage(
      db(),
      f.workspace.id,
      group.channelId,
      f.owner,
      f.owner,
      {
        message: { bodyText: 'the secret earlier body', idempotencyKey: crypto.randomUUID() },
        mode: 'direct',
      }
    )
    const joinedAt = new Date().toISOString()
    await db()
      .update(groupAdmissions)
      .set({ joinedAt, joinedSequence: posted.sequence })
      .where(eq(groupAdmissions.channelId, group.channelId))
    const read = await settle(() =>
      readGroupStanding(db(), {
        channelId: group.channelId,
        now: new Date().toISOString(),
        requester: f.member,
        workspaceId: f.workspace.id,
      })
    )
    if (!('value' in read)) throw new Error('the standing read was refused')
    const model = read.value
    const member = standingOf(model, f.member.userId)
    // The join point is preserved: the member's own reads start at their join point.
    expect(member.joinPoint.joinedSequence).toBe(posted.sequence)
    expect(member.joinPoint.joinedAt).toBe(joinedAt)
    expect(model.requesterJoinPoint.joinedSequence).toBe(posted.sequence)

    // The projection publishes standing and nothing else. The keys are asserted one by one, so a
    // field added later cannot slip into the projection unnoticed.
    for (const entry of model.members) {
      expect(Object.keys(entry).toSorted()).toEqual([
        'expiresAt',
        'inForce',
        'joinPoint',
        'participant',
        'state',
      ])
      expect(Object.keys(entry.joinPoint).toSorted()).toEqual(['joinedAt', 'joinedSequence'])
    }
    expect(Object.keys(model).toSorted()).toEqual([
      'channelId',
      'members',
      'requesterJoinPoint',
      'workspaceId',
    ])
    // No grant identity, no issue or revocation instant, and no content of any kind.
    const serialized = JSON.stringify(model)
    expect(serialized).not.toContain('gra_owner')
    expect(serialized).not.toContain('gra_member')
    expect(serialized).not.toContain('grantId')
    expect(serialized).not.toContain('revision')
    expect(serialized).not.toContain('issuedAt')
    expect(serialized).not.toContain('revokedAt')
    expect(serialized).not.toContain('the secret earlier body')
    expect(serialized).not.toContain(posted.id)
  })
})
