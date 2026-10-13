import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'

import type { UserPrincipalRef } from '@adea-ai/types'

import { accountConversationInbox, findAccountConversation } from '../../src/account-inbox'
import { accountWorkspaceSummaries } from '../../src/account-summary'
import { createDatabase, type AgentHqDatabase, type DatabaseConnection } from '../../src/connection'
import { classifyWorkspaceEventsForUser } from '../../src/event-visibility'
import type { WorkspaceEventView } from '../../src/event-log'
import { groupChannelIdsInForce, userChannelVisibility } from '../../src/group-participation-store'
import {
  archiveChannel,
  createMessage,
  deleteMessage,
  editMessage,
  getChannelForUser,
  getMessageForUser,
  listChannelsForUser,
  listMessagesForUser,
  updateChannel,
} from '../../src/conversations'
import {
  createGroupChannelWithGrants,
  groupCreationCandidatesFromGrants,
  postGroupChannelMessage,
  revokeGroupGrant,
} from '../../src/group-channels'
import { createTemporaryUserSession } from '../../src/identity'
import {
  listReadStateForUser,
  markAllChannelsRead,
  markChannelReadState,
  markThreadReadState,
} from '../../src/read-state'
import { searchWorkspaceForUser } from '../../src/search'
import { inReadSnapshot } from '../../src/transactions'
import {
  channels,
  channelReadStates,
  groupAdmissions,
  groupAudienceGrants,
  groupSharingGrants,
  messages,
  threadReadStates,
  workspaceMemberships,
} from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'

// #1222 participation standing at the product boundary. A legacy or retained admission row can
// outlive the grant it is bound to. The canonical window (revision, subject, revocation, expiry,
// issue time) decides standing, so a retained row with a revoked, expired, not-yet-issued or
// revision-mismatched grant admits nobody: every product read, list, mutation and event refuses it.
// Each refusal is paired with positive controls on the same group, so no denial is vacuous.
//
// Requires DATABASE_URL on a disposable database (the integration lane provisions it). Times are
// wall-clock relative, because the product's read and write paths decide on the live clock.

const connectionUrl = process.env.DATABASE_URL
const ISSUED_AT = minutes(-24 * 60)

function minutes(delta: number): string {
  return new Date(Date.now() + delta * 60_000).toISOString()
}

type Settled<T> = { value: T } | { denied: string }

async function settle<T>(run: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { value: await run() }
  } catch (error) {
    return { denied: error instanceof Error ? error.message : String(error) }
  }
}

describe.skipIf(!connectionUrl)('participation standing at the product boundary (#1222)', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => connection.close())

  const db = (): AgentHqDatabase => connection.db

  async function user(label: string): Promise<UserPrincipalRef> {
    return (
      await createTemporaryUserSession(db(), {
        credentialDigest: `standing-${label}-${crypto.randomUUID()}`,
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
      name: 'Standing boundary',
      owner,
    })
    for (const principal of [member, stranger]) {
      await db().insert(workspaceMemberships).values({
        role: 'member',
        userId: principal.userId,
        workspaceId: workspace.id,
      })
    }
    return { member, owner, stranger, workspace }
  }

  /** A participants group with the owner and member admitted under explicit audience grants. */
  async function groupWithAudience(f: Awaited<ReturnType<typeof fixture>>, title: string) {
    const channelId = crypto.randomUUID()
    const grant = (grantId: string, participant: UserPrincipalRef) => ({
      expiresAt: null,
      grantId,
      groupId: channelId,
      issuedAt: ISSUED_AT,
      participant,
      revision: 1,
      revokedAt: null,
    })
    await createGroupChannelWithGrants(db(), f.workspace.id, f.owner, {
      candidates: groupCreationCandidatesFromGrants(f.workspace.id, {
        audienceGrants: [grant('gra_owner', f.owner), grant('gra_member', f.member)],
        enlistmentGrants: [],
      }),
      channelId,
      idempotencyKey: crypto.randomUUID(),
      now: new Date().toISOString(),
      title,
    })
    const posted = await postGroupChannelMessage(
      db(),
      f.workspace.id,
      channelId,
      f.owner,
      f.owner,
      {
        message: { bodyText: `${title} owner note`, idempotencyKey: crypto.randomUUID() },
        mode: 'direct',
      }
    )
    return { channelId, messageId: posted.id, title }
  }

  async function versionOf(f: Awaited<ReturnType<typeof fixture>>, channelId: string) {
    return (await getChannelForUser(db(), f.workspace.id, channelId, f.owner)).version
  }

  test('earlier-summary access exposes aggregates without history or hidden thread roots', async () => {
    const f = await fixture()
    const group = await groupWithAudience(f, 'Summary-only history window')
    const hiddenRoot = await createMessage(db(), f.workspace.id, group.channelId, f.owner, {
      bodyText: 'hidden historical root',
      idempotencyKey: crypto.randomUUID(),
      sender: f.owner,
    })
    await createMessage(db(), f.workspace.id, group.channelId, f.owner, {
      bodyText: 'hidden historical reply',
      idempotencyKey: crypto.randomUUID(),
      replyToMessageId: hiddenRoot.id,
      sender: f.owner,
      threadRootMessageId: hiddenRoot.id,
    })
    const visible = await createMessage(db(), f.workspace.id, group.channelId, f.owner, {
      bodyText: 'visible after join',
      idempotencyKey: crypto.randomUUID(),
      sender: f.owner,
    })
    await db()
      .update(groupAdmissions)
      .set({ joinedSequence: visible.sequence })
      .where(
        and(
          eq(groupAdmissions.channelId, group.channelId),
          eq(groupAdmissions.userId, f.member.userId)
        )
      )
    await db().insert(groupSharingGrants).values({
      channelId: group.channelId,
      expiresAt: null,
      grantId: 'gra_summary_only_member',
      issuedAt: new Date().toISOString(),
      principalKind: 'user',
      revision: 1,
      revokedAt: null,
      scope: 'earlier_summary',
      userId: f.member.userId,
      workspaceId: f.workspace.id,
    })

    expect(
      await db()
        .select({ scope: groupSharingGrants.scope })
        .from(groupSharingGrants)
        .where(
          and(
            eq(groupSharingGrants.channelId, group.channelId),
            eq(groupSharingGrants.userId, f.member.userId)
          )
        )
    ).toEqual([{ scope: 'earlier_summary' }])
    const visibleMessages = await listMessagesForUser(
      db(),
      f.workspace.id,
      group.channelId,
      f.member
    )
    expect(visibleMessages.messages.map((message) => message.id)).toEqual([visible.id])

    const summary = (await listReadStateForUser(db(), f.workspace.id, f.member)).find(
      (entry) => entry.channelId === group.channelId
    )
    expect(summary).toMatchObject({
      latestTopLevelSequence: visible.sequence,
      topLevelUnreadCount: 3,
      threadUnreadCount: 0,
      threads: [],
    })
    await expect(
      markThreadReadState(db(), f.workspace.id, group.channelId, hiddenRoot.id, f.member, 'read')
    ).rejects.toThrow('Read state unavailable')

    await markChannelReadState(
      db(),
      f.workspace.id,
      group.channelId,
      f.member,
      'read',
      visible.sequence + 99
    )
    const saved = await db()
      .select({ lastReadSequence: channelReadStates.lastReadSequence })
      .from(channelReadStates)
      .where(
        and(
          eq(channelReadStates.workspaceId, f.workspace.id),
          eq(channelReadStates.channelId, group.channelId),
          eq(channelReadStates.userId, f.member.userId)
        )
      )
    expect(saved).toEqual([{ lastReadSequence: visible.sequence }])
  })

  test('earlier-summary counts survive an empty visible frontier and a read mark', async () => {
    const f = await fixture()
    const group = await groupWithAudience(f, 'Summary-only with no visible messages')
    const [historical] = await db()
      .select({ sequence: messages.sequence })
      .from(messages)
      .where(eq(messages.id, group.messageId))
    expect(historical).toBeDefined()

    await db()
      .update(groupAdmissions)
      .set({ joinedSequence: historical!.sequence + 1 })
      .where(
        and(
          eq(groupAdmissions.channelId, group.channelId),
          eq(groupAdmissions.userId, f.member.userId)
        )
      )
    await db().insert(groupSharingGrants).values({
      channelId: group.channelId,
      expiresAt: null,
      grantId: 'gra_summary_only_empty_member',
      issuedAt: new Date().toISOString(),
      principalKind: 'user',
      revision: 1,
      revokedAt: null,
      scope: 'earlier_summary',
      userId: f.member.userId,
      workspaceId: f.workspace.id,
    })

    const visible = await listMessagesForUser(db(), f.workspace.id, group.channelId, f.member)
    expect(visible.messages).toEqual([])
    const beforeRead = (await listReadStateForUser(db(), f.workspace.id, f.member)).find(
      (entry) => entry.channelId === group.channelId
    )
    expect(beforeRead).toMatchObject({ latestTopLevelSequence: 0, topLevelUnreadCount: 1 })

    await markChannelReadState(
      db(),
      f.workspace.id,
      group.channelId,
      f.member,
      'read',
      historical!.sequence + 99
    )
    const afterRead = (await listReadStateForUser(db(), f.workspace.id, f.member)).find(
      (entry) => entry.channelId === group.channelId
    )
    expect(afterRead).toMatchObject({
      lastReadSequence: 0,
      latestTopLevelSequence: 0,
      topLevelUnreadCount: 1,
    })
  })

  test('earlier-history access exposes messages without granting earlier summary counts', async () => {
    const f = await fixture()
    const group = await groupWithAudience(f, 'History-only summary boundary')
    const hiddenRoot = await createMessage(db(), f.workspace.id, group.channelId, f.owner, {
      bodyText: 'historical root',
      idempotencyKey: crypto.randomUUID(),
      sender: f.owner,
    })
    const hiddenReply = await createMessage(db(), f.workspace.id, group.channelId, f.owner, {
      bodyText: 'historical reply',
      idempotencyKey: crypto.randomUUID(),
      replyToMessageId: hiddenRoot.id,
      sender: f.owner,
      threadRootMessageId: hiddenRoot.id,
    })
    const visible = await createMessage(db(), f.workspace.id, group.channelId, f.owner, {
      bodyText: 'visible after join',
      idempotencyKey: crypto.randomUUID(),
      sender: f.owner,
    })
    await db()
      .update(groupAdmissions)
      .set({ joinedSequence: visible.sequence })
      .where(
        and(
          eq(groupAdmissions.channelId, group.channelId),
          eq(groupAdmissions.userId, f.member.userId)
        )
      )
    await db().insert(groupSharingGrants).values({
      channelId: group.channelId,
      expiresAt: null,
      grantId: 'gra_history_only_member',
      issuedAt: new Date().toISOString(),
      principalKind: 'user',
      revision: 1,
      revokedAt: null,
      scope: 'earlier_history',
      userId: f.member.userId,
      workspaceId: f.workspace.id,
    })

    expect(
      await db()
        .select({ scope: groupSharingGrants.scope })
        .from(groupSharingGrants)
        .where(
          and(
            eq(groupSharingGrants.channelId, group.channelId),
            eq(groupSharingGrants.userId, f.member.userId)
          )
        )
    ).toEqual([{ scope: 'earlier_history' }])
    const history = await listMessagesForUser(db(), f.workspace.id, group.channelId, f.member)
    expect(history.messages.map((message) => message.id)).toContain(hiddenRoot.id)
    expect(history.messages.map((message) => message.id)).toContain(hiddenReply.id)
    expect(history.messages.map((message) => message.id)).toContain(visible.id)

    const summary = (await listReadStateForUser(db(), f.workspace.id, f.member)).find(
      (entry) => entry.channelId === group.channelId
    )
    expect(summary).toMatchObject({
      latestTopLevelSequence: visible.sequence,
      topLevelUnreadCount: 1,
      threadUnreadCount: 0,
      threads: [],
    })
  })

  test('post-join rootless reply to hidden history is withheld from group conversation reads', async () => {
    const f = await fixture()
    const group = await groupWithAudience(f, 'Rootless reply visibility')
    const hiddenRoot = await createMessage(db(), f.workspace.id, group.channelId, f.owner, {
      bodyText: 'pre-join root hidden from member',
      idempotencyKey: crypto.randomUUID(),
      sender: f.owner,
    })
    const reply = await createMessage(db(), f.workspace.id, group.channelId, f.owner, {
      bodyText: 'post-join reply must not reveal the hidden root',
      idempotencyKey: crypto.randomUUID(),
      replyToMessageId: hiddenRoot.id,
      sender: f.owner,
    })
    await db()
      .update(groupAdmissions)
      .set({ joinedSequence: reply.sequence })
      .where(
        and(
          eq(groupAdmissions.channelId, group.channelId),
          eq(groupAdmissions.userId, f.member.userId)
        )
      )
    expect(reply.replyToMessageId).toBe(hiddenRoot.id)
    expect(reply.threadRootMessageId).toBeUndefined()

    const history = await listMessagesForUser(db(), f.workspace.id, group.channelId, f.member)
    expect(history.messages.map((message) => message.id)).not.toContain(reply.id)
    await expect(getMessageForUser(db(), f.workspace.id, reply.id, f.member)).rejects.toThrow(
      'Message unavailable'
    )

    await expect(getMessageForUser(db(), f.workspace.id, reply.id, f.owner)).resolves.toMatchObject(
      {
        bodyText: 'post-join reply must not reveal the hidden root',
        replyToMessageId: hiddenRoot.id,
      }
    )
  })

  test('mutations hide pre-join targets before checking their versions', async () => {
    const f = await fixture()
    const group = await groupWithAudience(f, 'Mutation history window')
    const hiddenReply = await createMessage(db(), f.workspace.id, group.channelId, f.owner, {
      bodyText: 'hidden reply before rejoin',
      idempotencyKey: crypto.randomUUID(),
      replyToMessageId: group.messageId,
      sender: f.owner,
      threadRootMessageId: group.messageId,
    })
    await db()
      .update(groupAdmissions)
      .set({ joinedSequence: hiddenReply.sequence + 1 })
      .where(
        and(
          eq(groupAdmissions.channelId, group.channelId),
          eq(groupAdmissions.userId, f.owner.userId)
        )
      )
    await db().insert(groupSharingGrants).values({
      channelId: group.channelId,
      expiresAt: null,
      grantId: 'gra_summary_only_owner',
      issuedAt: new Date().toISOString(),
      principalKind: 'user',
      revision: 1,
      revokedAt: null,
      scope: 'earlier_summary',
      userId: f.owner.userId,
      workspaceId: f.workspace.id,
    })

    await expect(
      editMessage(db(), f.workspace.id, group.messageId, f.owner, { bodyText: 'rewritten' }, 99)
    ).rejects.toThrow('Message unavailable')
    await expect(deleteMessage(db(), f.workspace.id, hiddenReply.id, f.owner, 99)).rejects.toThrow(
      'Message unavailable'
    )
    await expect(getMessageForUser(db(), f.workspace.id, group.messageId, f.owner)).rejects.toThrow(
      'Message unavailable'
    )
  })

  test('read-state frontiers clamp to visible history and hidden roots are unavailable', async () => {
    const f = await fixture()
    const group = await groupWithAudience(f, 'Read-state history window')
    const hiddenReply = await createMessage(db(), f.workspace.id, group.channelId, f.owner, {
      bodyText: 'reply behind hidden root',
      idempotencyKey: crypto.randomUUID(),
      replyToMessageId: group.messageId,
      sender: f.owner,
      threadRootMessageId: group.messageId,
    })
    await db()
      .update(groupAdmissions)
      .set({ joinedSequence: hiddenReply.sequence + 1 })
      .where(
        and(
          eq(groupAdmissions.channelId, group.channelId),
          eq(groupAdmissions.userId, f.member.userId)
        )
      )

    await markChannelReadState(db(), f.workspace.id, group.channelId, f.member, 'read', 99)
    const savedChannel = await db()
      .select({ lastReadSequence: channelReadStates.lastReadSequence })
      .from(channelReadStates)
      .where(
        and(
          eq(channelReadStates.workspaceId, f.workspace.id),
          eq(channelReadStates.channelId, group.channelId),
          eq(channelReadStates.userId, f.member.userId)
        )
      )
    expect(savedChannel).toEqual([{ lastReadSequence: 0 }])
    await markAllChannelsRead(db(), f.workspace.id, f.member)
    const savedAfterMarkAll = await db()
      .select({ lastReadSequence: channelReadStates.lastReadSequence })
      .from(channelReadStates)
      .where(
        and(
          eq(channelReadStates.workspaceId, f.workspace.id),
          eq(channelReadStates.channelId, group.channelId),
          eq(channelReadStates.userId, f.member.userId)
        )
      )
    expect(savedAfterMarkAll).toEqual([{ lastReadSequence: 0 }])

    await expect(
      markThreadReadState(db(), f.workspace.id, group.channelId, group.messageId, f.member, 'read')
    ).rejects.toThrow('Read state unavailable')
    expect(
      await db()
        .select({ id: threadReadStates.id })
        .from(threadReadStates)
        .where(
          and(
            eq(threadReadStates.workspaceId, f.workspace.id),
            eq(threadReadStates.threadRootMessageId, group.messageId),
            eq(threadReadStates.userId, f.member.userId)
          )
        )
    ).toEqual([])
  })

  /** The member's retained admission now names a grant that is no longer in force. */
  const DEFECTS: Record<
    string,
    (f: Awaited<ReturnType<typeof fixture>>, channelId: string) => Promise<unknown>
  > = {
    revoked: (f, channelId) =>
      db()
        .update(groupAudienceGrants)
        .set({ revokedAt: minutes(-5) })
        .where(
          and(
            eq(groupAudienceGrants.channelId, channelId),
            eq(groupAudienceGrants.grantId, 'gra_member')
          )
        ),
    expired: (f, channelId) =>
      db()
        .update(groupAudienceGrants)
        .set({ expiresAt: minutes(-5) })
        .where(
          and(
            eq(groupAudienceGrants.channelId, channelId),
            eq(groupAudienceGrants.grantId, 'gra_member')
          )
        ),
    'not yet issued': (f, channelId) =>
      db()
        .update(groupAudienceGrants)
        .set({ issuedAt: minutes(60) })
        .where(
          and(
            eq(groupAudienceGrants.channelId, channelId),
            eq(groupAudienceGrants.grantId, 'gra_member')
          )
        ),
    'revision mismatch': (f, channelId) =>
      db()
        .update(groupAdmissions)
        .set({ authRevision: 2 })
        .where(
          and(eq(groupAdmissions.channelId, channelId), eq(groupAdmissions.userId, f.member.userId))
        ),
  }

  describe.each(Object.keys(DEFECTS))('retained admission with a %s grant', (defect) => {
    let f: Awaited<ReturnType<typeof fixture>>
    let group: Awaited<ReturnType<typeof groupWithAudience>>
    let versionBefore: number

    beforeAll(async () => {
      f = await fixture()
      group = await groupWithAudience(f, `Standing ${defect}`)
      await DEFECTS[defect]!(f, group.channelId)
      versionBefore = await versionOf(f, group.channelId)
    })

    test('the retained admission row is still present; only its grant changed', async () => {
      const rows = await db()
        .select({ id: groupAdmissions.id })
        .from(groupAdmissions)
        .where(
          and(
            eq(groupAdmissions.channelId, group.channelId),
            eq(groupAdmissions.userId, f.member.userId)
          )
        )
      expect(rows).toHaveLength(1)
    })

    test('reads: the channel, its list, its history, its message, inbox, read state and search refuse the member', async () => {
      expect(
        await settle(() => getChannelForUser(db(), f.workspace.id, group.channelId, f.member))
      ).toEqual({
        denied: 'Channel unavailable',
      })
      const listed = await listChannelsForUser(db(), f.workspace.id, f.member)
      expect(listed.map((channel) => channel.id)).not.toContain(group.channelId)
      expect(
        await settle(() => listMessagesForUser(db(), f.workspace.id, group.channelId, f.member))
      ).toEqual({ denied: 'Channel unavailable' })
      expect(
        await settle(() => getMessageForUser(db(), f.workspace.id, group.messageId, f.member))
      ).toEqual({ denied: 'Channel unavailable' })
      const inbox = await accountConversationInbox(db(), f.member)
      expect(inbox.conversations.map((entry) => entry.id)).not.toContain(group.channelId)
      const readState = await listReadStateForUser(db(), f.workspace.id, f.member)
      expect(readState.map((entry) => entry.channelId)).not.toContain(group.channelId)
      const hits = await searchWorkspaceForUser(db(), f.workspace.id, f.member, group.title)
      expect(hits.results.map((hit) => hit.id)).not.toContain(group.channelId)
    })

    test('events about the group are not delivered to the member', async () => {
      const event: WorkspaceEventView = {
        actor: null,
        aggregateId: group.channelId,
        aggregateType: 'channel',
        correlationId: null,
        eventId: crypto.randomUUID(),
        eventType: 'channel.updated',
        occurredAt: new Date(),
        payload: { channelId: group.channelId },
        schemaVersion: 1,
        workspaceSequence: 1,
      }
      const delivery = await classifyWorkspaceEventsForUser(db(), f.workspace.id, f.member.userId, [
        event,
      ])
      expect(delivery?.[0]?.kind).not.toBe('deliver')
    })

    test('writes: a post, a message create, a rename and an archive by the member are refused and write nothing', async () => {
      expect(
        await settle(() =>
          postGroupChannelMessage(db(), f.workspace.id, group.channelId, f.member, f.member, {
            message: { bodyText: 'stale post', idempotencyKey: crypto.randomUUID() },
            mode: 'direct',
          })
        )
      ).toEqual({ denied: 'Channel unavailable' })
      expect(
        await settle(() =>
          createMessage(db(), f.workspace.id, group.channelId, f.member, {
            bodyText: 'stale create',
            idempotencyKey: crypto.randomUUID(),
            sender: { kind: 'user', userId: f.member.userId },
          })
        )
      ).toEqual({ denied: 'Channel unavailable' })
      expect(
        await settle(() =>
          updateChannel(
            db(),
            f.workspace.id,
            group.channelId,
            f.member,
            { title: 'renamed by stale member' },
            versionBefore
          )
        )
      ).toEqual({ denied: 'Channel unavailable' })
      expect(
        await settle(() =>
          archiveChannel(db(), f.workspace.id, group.channelId, f.member, versionBefore)
        )
      ).toEqual({ denied: 'Channel unavailable' })
      expect(await versionOf(f, group.channelId)).toBe(versionBefore)
    })

    test('positive control: the owner, whose grant is intact, still reads, lists, posts and renames', async () => {
      const ownerChannel = await getChannelForUser(db(), f.workspace.id, group.channelId, f.owner)
      expect(ownerChannel.id).toBe(group.channelId)
      expect(ownerChannel.participants).toEqual([{ kind: 'user', userId: f.owner.userId }])
      expect(
        (await listChannelsForUser(db(), f.workspace.id, f.owner)).map((channel) => channel.id)
      ).toContain(group.channelId)
      const page = await listMessagesForUser(db(), f.workspace.id, group.channelId, f.owner)
      expect(page.messages.map((message) => message.id)).toContain(group.messageId)
      const posted = await postGroupChannelMessage(
        db(),
        f.workspace.id,
        group.channelId,
        f.owner,
        f.owner,
        {
          message: { bodyText: 'owner after defect', idempotencyKey: crypto.randomUUID() },
          mode: 'direct',
        }
      )
      expect(posted.bodyText).toBe('owner after defect')
      const renamed = await updateChannel(
        db(),
        f.workspace.id,
        group.channelId,
        f.owner,
        { title: `Renamed ${defect}` },
        await versionOf(f, group.channelId)
      )
      expect(renamed.title).toBe(`Renamed ${defect}`)
    })
  })

  describe('workspace-visible groups do not bypass the group grant', () => {
    test('a group made workspace-visible admits a workspace member with no admission to nothing', async () => {
      const f = await fixture()
      const group = await groupWithAudience(f, 'Workspace-visible bypass')
      await db()
        .update(channels)
        .set({ visibility: 'workspace' })
        .where(eq(channels.id, group.channelId))
      expect(
        await settle(() => getChannelForUser(db(), f.workspace.id, group.channelId, f.stranger))
      ).toEqual({ denied: 'Channel unavailable' })
      expect(
        (await listChannelsForUser(db(), f.workspace.id, f.stranger)).map((channel) => channel.id)
      ).not.toContain(group.channelId)
      expect(
        (await accountConversationInbox(db(), f.stranger)).conversations.map((entry) => entry.id)
      ).not.toContain(group.channelId)
      expect(await findAccountConversation(db(), f.stranger, group.channelId)).toBeNull()
      expect(
        (await listReadStateForUser(db(), f.workspace.id, f.stranger)).map(
          (entry) => entry.channelId
        )
      ).not.toContain(group.channelId)
      expect(
        (await accountWorkspaceSummaries(db(), f.stranger)).find(
          (summary) => summary.workspaceId === f.workspace.id
        )?.unreadChannels
      ).toBe(0)
      const event: WorkspaceEventView = {
        actor: null,
        aggregateId: group.channelId,
        aggregateType: 'channel',
        correlationId: null,
        eventId: crypto.randomUUID(),
        eventType: 'channel.updated',
        occurredAt: new Date(),
        payload: { channelId: group.channelId },
        schemaVersion: 1,
        workspaceSequence: 1,
      }
      expect(
        (
          await classifyWorkspaceEventsForUser(db(), f.workspace.id, f.stranger.userId, [event])
        )?.[0]?.kind
      ).not.toBe('deliver')
      const version = await versionOf(f, group.channelId)
      expect(
        await settle(() =>
          updateChannel(
            db(),
            f.workspace.id,
            group.channelId,
            f.stranger,
            { title: 'hijack' },
            version
          )
        )
      ).toEqual({ denied: 'Channel unavailable' })
      expect(
        await settle(() =>
          archiveChannel(db(), f.workspace.id, group.channelId, f.stranger, version)
        )
      ).toEqual({ denied: 'Channel unavailable' })
    })

    test('the product refuses to make a group workspace-visible at all', async () => {
      const f = await fixture()
      const group = await groupWithAudience(f, 'Visibility change')
      const version = await versionOf(f, group.channelId)
      expect(
        await settle(() =>
          updateChannel(
            db(),
            f.workspace.id,
            group.channelId,
            f.owner,
            { visibility: 'workspace' },
            version
          )
        )
      ).toEqual({ denied: 'Channel participant policy conflict' })
    })
  })

  describe('mutation versus revocation ordering', () => {
    test('a post parked after its gate holds the grant lock: the revocation waits, then lands after the post', async () => {
      const f = await fixture()
      const group = await groupWithAudience(f, 'Post versus revoke')
      let release!: () => void
      const hold = new Promise<void>((resolve) => (release = resolve))
      let reached!: () => void
      const gateReached = new Promise<void>((resolve) => (reached = resolve))
      const post = postGroupChannelMessage(
        db(),
        f.workspace.id,
        group.channelId,
        f.member,
        f.member,
        {
          message: { bodyText: 'ordered before revoke', idempotencyKey: crypto.randomUUID() },
          mode: 'direct',
        },
        {
          barrier: {
            afterGate: async () => {
              reached()
              await hold
            },
          },
        }
      )
      await gateReached
      const revoke = revokeGroupGrant(db(), f.workspace.id, group.channelId, f.owner, {
        grantId: 'gra_member',
        kind: 'audience',
        revokedAt: new Date().toISOString(),
      })
      const early = await Promise.race([
        revoke.then(() => 'settled' as const),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 400)),
      ])
      expect(early).toBe('blocked')
      release()
      expect((await post).bodyText).toBe('ordered before revoke')
      expect((await revoke).revoked).toBe(true)
      expect(
        await settle(() =>
          postGroupChannelMessage(db(), f.workspace.id, group.channelId, f.member, f.member, {
            message: { bodyText: 'after revoke', idempotencyKey: crypto.randomUUID() },
            mode: 'direct',
          })
        )
      ).toEqual({ denied: 'Channel unavailable' })
    })

    test('a rename by the member waits behind an uncommitted revocation, then is refused', async () => {
      const f = await fixture()
      const group = await groupWithAudience(f, 'Rename versus revoke')
      const version = await versionOf(f, group.channelId)
      let release!: () => void
      const hold = new Promise<void>((resolve) => (release = resolve))
      let revoked!: () => void
      const revokedUncommitted = new Promise<void>((resolve) => (revoked = resolve))
      const holder = db().transaction(async (tx) => {
        await tx
          .update(groupAudienceGrants)
          .set({ revokedAt: new Date().toISOString() })
          .where(
            and(
              eq(groupAudienceGrants.channelId, group.channelId),
              eq(groupAudienceGrants.grantId, 'gra_member')
            )
          )
        revoked()
        await hold
      })
      await revokedUncommitted
      const rename = settle(() =>
        updateChannel(
          db(),
          f.workspace.id,
          group.channelId,
          f.member,
          { title: 'stale rename' },
          version
        )
      )
      const early = await Promise.race([
        rename.then(() => 'settled' as const),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 400)),
      ])
      expect(early).toBe('blocked')
      release()
      await holder
      expect(await rename).toEqual({ denied: 'Channel unavailable' })
      expect((await getChannelForUser(db(), f.workspace.id, group.channelId, f.owner)).title).toBe(
        'Rename versus revoke'
      )
    })
  })
  describe('committed revocation: every new read denies, and no earlier history reappears', () => {
    test('reuses a caller-owned SERIALIZABLE transaction', async () => {
      const reused = await db().transaction(
        async (transaction) =>
          inReadSnapshot(transaction, async (existing) => existing === transaction),
        { isolationLevel: 'serializable' }
      )

      expect(reused).toBe(true)
    })

    test('a member who reads before a committed revocation is refused by every read afterwards', async () => {
      const f = await fixture()
      const group = await groupWithAudience(f, 'Committed revocation')
      const unreadFor = async (principal: UserPrincipalRef) =>
        (await accountWorkspaceSummaries(db(), principal)).find(
          (row) => row.workspaceId === f.workspace.id
        )?.unreadChannels
      const channelEvent = (): WorkspaceEventView => ({
        actor: null,
        aggregateId: group.channelId,
        aggregateType: 'channel',
        correlationId: null,
        eventId: crypto.randomUUID(),
        eventType: 'channel.updated',
        occurredAt: new Date(),
        payload: { channelId: group.channelId },
        schemaVersion: 1,
        workspaceSequence: 1,
      })
      const reads = async (principal: UserPrincipalRef) => ({
        channel: await settle(() =>
          getChannelForUser(db(), f.workspace.id, group.channelId, principal)
        ),
        listed: (await listChannelsForUser(db(), f.workspace.id, principal)).map((c) => c.id),
        messages: await settle(() =>
          listMessagesForUser(db(), f.workspace.id, group.channelId, principal)
        ),
        message: await settle(() =>
          getMessageForUser(db(), f.workspace.id, group.messageId, principal)
        ),
        accountConversation: await findAccountConversation(db(), principal, group.channelId),
        inbox: (await accountConversationInbox(db(), principal)).conversations.map((e) => e.id),
        readState: (await listReadStateForUser(db(), f.workspace.id, principal)).map(
          (e) => e.channelId
        ),
        search: (
          await searchWorkspaceForUser(db(), f.workspace.id, principal, group.title)
        ).results.map((h) => h.id),
        event: (
          await classifyWorkspaceEventsForUser(db(), f.workspace.id, principal.userId, [
            channelEvent(),
          ])
        )?.[0]?.kind,
        unread: await unreadFor(principal),
      })

      // Positive control before the revocation: the member reads the group through every surface.
      const before = await reads(f.member)
      expect('value' in before.channel).toBe(true)
      expect(before.listed).toContain(group.channelId)
      expect(before.messages).toEqual({
        value: expect.objectContaining({ messages: expect.any(Array) }),
      })
      expect(before.accountConversation?.id).toBe(group.channelId)
      expect(before.inbox).toContain(group.channelId)
      expect(before.readState).toContain(group.channelId)
      expect(before.search).toContain(group.channelId)
      expect(before.event).toBe('deliver')
      expect(before.unread).toBeGreaterThan(0)

      // The revocation commits in its own transaction before any new read below.
      const revoked = await revokeGroupGrant(db(), f.workspace.id, group.channelId, f.owner, {
        grantId: 'gra_member',
        kind: 'audience',
        revokedAt: new Date().toISOString(),
      })
      expect(revoked.revoked).toBe(true)

      const after = await reads(f.member)
      expect(after.channel).toEqual({ denied: 'Channel unavailable' })
      expect(after.listed).not.toContain(group.channelId)
      expect(after.messages).toEqual({ denied: 'Channel unavailable' })
      expect(after.message).toEqual({ denied: 'Channel unavailable' })
      expect(after.accountConversation).toBeNull()
      expect(after.inbox).not.toContain(group.channelId)
      expect(after.readState).not.toContain(group.channelId)
      expect(after.search).not.toContain(group.channelId)
      expect(after.event).not.toBe('deliver')
      expect(after.unread).toBeLessThan(before.unread ?? 0)
      expect(
        await settle(() =>
          markChannelReadState(db(), f.workspace.id, group.channelId, f.member, 'read')
        )
      ).toEqual({ denied: 'Read state unavailable' })
      expect(
        await settle(() =>
          postGroupChannelMessage(db(), f.workspace.id, group.channelId, f.member, f.member, {
            message: {
              bodyText: 'after committed revocation',
              idempotencyKey: crypto.randomUUID(),
            },
            mode: 'direct',
          })
        )
      ).toEqual({ denied: 'Channel unavailable' })

      // No history reappears: the owner, whose grant is intact, still reads the earlier message.
      const owner = await reads(f.owner)
      expect(owner.channel).not.toEqual({ denied: 'Channel unavailable' })
      expect(owner.listed).toContain(group.channelId)
    })

    test('a read-state write waiting on the channel lock rechecks after grant revocation', async () => {
      const f = await fixture()
      const group = await groupWithAudience(f, 'Read-state revoke fence')
      let signalChannelLocked!: () => void
      let releaseChannelLock!: () => void
      const channelLocked = new Promise<void>((resolve) => {
        signalChannelLocked = resolve
      })
      const channelLockRelease = new Promise<void>((resolve) => {
        releaseChannelLock = resolve
      })
      const channelLockOwner = db().transaction(async (transaction) => {
        await transaction
          .select({ id: channels.id })
          .from(channels)
          .where(eq(channels.id, group.channelId))
          .for('update')
        signalChannelLocked()
        await channelLockRelease
      })
      await channelLocked

      const readState = markChannelReadState(
        db(),
        f.workspace.id,
        group.channelId,
        f.member,
        'read'
      ).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ error, ok: false as const })
      )
      let observedChannelLockWait = false
      try {
        for (let attempt = 0; attempt < 500; attempt += 1) {
          const waiting = await db().execute(sql`
            select 1
            from pg_stat_activity
            where datname = current_database()
              and pid <> pg_backend_pid()
              and wait_event_type = 'Lock'
              and query ilike '%channels%'
              and query ilike '%for update%'
          `)
          if (waiting.length) {
            observedChannelLockWait = true
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        expect(observedChannelLockWait).toBe(true)
        const revoked = await revokeGroupGrant(db(), f.workspace.id, group.channelId, f.owner, {
          grantId: 'gra_member',
          kind: 'audience',
          revokedAt: new Date().toISOString(),
        })
        expect(revoked.revoked).toBe(true)
      } finally {
        releaseChannelLock()
      }
      await channelLockOwner

      const result = await readState
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('Read state unexpectedly survived group grant revocation')
      expect((result.error as Error).message).toBe('Read state unavailable')
    }, 30_000)

    test('one read snapshot cannot mix a pre-revoke admission with a post-barrier owner message', async () => {
      const f = await fixture()
      const group = await groupWithAudience(f, 'Snapshot barrier')
      const [beforeChannel] = await db()
        .select({ latestMessageSequence: channels.latestMessageSequence })
        .from(channels)
        .where(eq(channels.id, group.channelId))
      const event: WorkspaceEventView = {
        actor: null,
        aggregateId: group.channelId,
        aggregateType: 'channel',
        correlationId: null,
        eventId: crypto.randomUUID(),
        eventType: 'channel.updated',
        occurredAt: new Date(),
        payload: { channelId: group.channelId },
        schemaVersion: 1,
        workspaceSequence: 1,
      }
      let signalSnapshotStarted!: () => void
      let continueSnapshot!: () => void
      const snapshotStarted = new Promise<void>((resolve) => {
        signalSnapshotStarted = resolve
      })
      const barrier = new Promise<void>((resolve) => {
        continueSnapshot = resolve
      })

      const inFlight = inReadSnapshot(db(), async (transaction) => {
        expect(
          await inReadSnapshot(transaction, async (existing) => existing === transaction)
        ).toBe(true)
        expect(
          await groupChannelIdsInForce(
            transaction,
            f.member.userId,
            new Date().toISOString(),
            f.workspace.id
          )
        ).toContain(group.channelId)
        signalSnapshotStarted()
        await barrier

        const [channel] = await transaction
          .select({ latestMessageSequence: channels.latestMessageSequence })
          .from(channels)
          .where(eq(channels.id, group.channelId))
        const messageRows = await transaction
          .select({ bodyText: messages.bodyText })
          .from(messages)
          .where(eq(messages.channelId, group.channelId))
          .orderBy(messages.sequence)
        const inbox = await accountConversationInbox(transaction, f.member)
        const summary = await accountWorkspaceSummaries(transaction, f.member)
        const readState = await listReadStateForUser(transaction, f.workspace.id, f.member)
        const delivery = await classifyWorkspaceEventsForUser(
          transaction,
          f.workspace.id,
          f.member.userId,
          [event]
        )
        return { channel, delivery, inbox, messageRows, readState, summary }
      })

      await Promise.race([
        snapshotStarted,
        inFlight.then(() => {
          throw new Error('Read snapshot completed before reaching its barrier')
        }),
      ])
      let mutationError: unknown
      try {
        const revoked = await revokeGroupGrant(db(), f.workspace.id, group.channelId, f.owner, {
          grantId: 'gra_member',
          kind: 'audience',
          revokedAt: new Date().toISOString(),
        })
        expect(revoked.revoked).toBe(true)
        await postGroupChannelMessage(db(), f.workspace.id, group.channelId, f.owner, f.owner, {
          message: {
            bodyText: 'owner post after the read barrier',
            idempotencyKey: crypto.randomUUID(),
          },
          mode: 'direct',
        })
      } catch (error) {
        mutationError = error
      } finally {
        continueSnapshot()
      }

      const during = await inFlight
      if (mutationError) throw mutationError
      expect(during.channel?.latestMessageSequence).toBe(beforeChannel?.latestMessageSequence)
      expect(during.messageRows.map(({ bodyText }) => bodyText)).toEqual([
        'Snapshot barrier owner note',
      ])
      expect(during.inbox.conversations.map((entry) => entry.id)).toContain(group.channelId)
      expect(
        during.summary.find(({ workspaceId }) => workspaceId === f.workspace.id)?.unreadChannels
      ).toBe(1)
      expect(during.readState.find(({ channelId }) => channelId === group.channelId)).toMatchObject(
        { latestTopLevelSequence: beforeChannel?.latestMessageSequence }
      )
      expect(during.delivery?.[0]?.kind).toBe('deliver')

      // New root reads start after the revoke commit, so the same four surfaces deny it.
      expect(
        (await accountConversationInbox(db(), f.member)).conversations.map(({ id }) => id)
      ).not.toContain(group.channelId)
      expect(
        (await accountWorkspaceSummaries(db(), f.member)).find(
          ({ workspaceId }) => workspaceId === f.workspace.id
        )?.unreadChannels
      ).toBe(0)
      expect(
        (await classifyWorkspaceEventsForUser(db(), f.workspace.id, f.member.userId, [event]))?.[0]
          ?.kind
      ).toBe('withheld')
      expect(
        (await listReadStateForUser(db(), f.workspace.id, f.member)).map(
          ({ channelId }) => channelId
        )
      ).not.toContain(group.channelId)
    })

    test('rejects a caller-owned READ COMMITTED read after a revoke and post cross its transaction', async () => {
      const f = await fixture()
      const group = await groupWithAudience(f, 'Read committed barrier')
      let signalSnapshotStarted!: () => void
      let continueSnapshot!: () => void
      const snapshotStarted = new Promise<void>((resolve) => {
        signalSnapshotStarted = resolve
      })
      const barrier = new Promise<void>((resolve) => {
        continueSnapshot = resolve
      })

      const inFlight = db().transaction(
        async (transaction) => {
          const inForce = [
            ...(await groupChannelIdsInForce(
              transaction,
              f.member.userId,
              new Date().toISOString(),
              f.workspace.id
            )),
          ]
          expect(inForce).toContain(group.channelId)
          signalSnapshotStarted()
          await barrier

          let mixedRead: { latestMessageSequence: number } | undefined
          await expect(
            inReadSnapshot(transaction, async (snapshot) => {
              // Match the authorization-derived channel predicate used by
              // multi-statement product readers, with the pre-barrier ids.
              const [channel] = await snapshot
                .select({ latestMessageSequence: channels.latestMessageSequence })
                .from(channels)
                .where(
                  and(
                    eq(channels.workspaceId, f.workspace.id),
                    eq(channels.id, group.channelId),
                    userChannelVisibility({
                      channelId: sql`${channels.id}`,
                      inForceGroupIds: inForce,
                      kind: sql`${channels.kind}`,
                      userId: f.member.userId,
                      visibility: sql`${channels.visibility}`,
                    })
                  )
                )
              mixedRead = channel
              return channel
            })
          ).rejects.toThrow('REPEATABLE READ or SERIALIZABLE')
          expect(mixedRead).toBeUndefined()
          await expect(accountConversationInbox(transaction, f.member)).rejects.toThrow(
            'REPEATABLE READ or SERIALIZABLE'
          )
        },
        { isolationLevel: 'read committed' }
      )

      await Promise.race([
        snapshotStarted,
        inFlight.then(() => {
          throw new Error('READ COMMITTED transaction completed before reaching its barrier')
        }),
      ])
      let mutationError: unknown
      try {
        const revoked = await revokeGroupGrant(db(), f.workspace.id, group.channelId, f.owner, {
          grantId: 'gra_member',
          kind: 'audience',
          revokedAt: new Date().toISOString(),
        })
        expect(revoked.revoked).toBe(true)
        const posted = await postGroupChannelMessage(
          db(),
          f.workspace.id,
          group.channelId,
          f.owner,
          f.owner,
          {
            message: {
              bodyText: 'owner post across a READ COMMITTED transaction',
              idempotencyKey: crypto.randomUUID(),
            },
            mode: 'direct',
          }
        )
        expect(posted.bodyText).toBe('owner post across a READ COMMITTED transaction')
      } catch (error) {
        mutationError = error
      } finally {
        continueSnapshot()
      }

      await inFlight
      if (mutationError) throw mutationError
      expect(
        (await accountConversationInbox(db(), f.member)).conversations.map(({ id }) => id)
      ).not.toContain(group.channelId)
    })
  })
})
