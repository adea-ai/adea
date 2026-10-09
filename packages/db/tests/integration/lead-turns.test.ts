import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { createAgent, ensureWorkspaceLead } from '../../src/agents'
import {
  createDatabase,
  type DatabaseConnection,
  type AgentHqTransaction,
} from '../../src/connection'
import { createDirectAgentTopic, createGroupChannel, createMessage } from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import { createLeadTurn, getLeadTurnForUser } from '../../src/lead-turns'
import {
  agents,
  channelParticipants,
  channels,
  messages,
  workspaceEvents,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import { leadTurnIntents } from '../../src/schema/lead-turns'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const faultAtIntent = (transaction: AgentHqTransaction): AgentHqTransaction =>
  new Proxy(transaction, {
    get(target, property) {
      if (property === 'transaction')
        return (callback: (nested: AgentHqTransaction) => Promise<unknown>) =>
          target.transaction((nested) => callback(faultAtIntent(nested)))
      if (property === 'insert')
        return (table: unknown) =>
          table === leadTurnIntents
            ? { values: () => ({ returning: () => target.execute(sql`select 1 / 0`) }) }
            : Reflect.apply(target.insert, target, [table])
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

const connectionUrl = process.env.DATABASE_URL
describe.skipIf(!connectionUrl)('canonical lead-turn intent', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => connection.close())
  async function fixture() {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `lead-turn-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      owner: owner.principal,
      name: 'Lead turns',
      idempotencyKey: crypto.randomUUID(),
    })
    const lead = await ensureWorkspaceLead(connection.db, workspace.id, owner.principal)
    const topic = await createDirectAgentTopic(
      connection.db,
      workspace.id,
      lead.id,
      owner.principal,
      {
        title: 'First topic',
        idempotencyKey: crypto.randomUUID(),
      }
    )
    const input = { bodyText: 'Canonical user content', idempotencyKey: crypto.randomUUID() }
    const admit = () =>
      createLeadTurn(connection.db, workspace.id, topic.id, owner.principal, input)
    return { owner, workspace, lead, topic, input, admit }
  }

  test('changed requested role pins conflict without changing canonical message or intent', async () => {
    const f = await fixture()
    const lead = { selectionRef: `msel_${'a'.repeat(32)}`, selectionRevision: 1 }
    const child = { selectionRef: `msel_${'b'.repeat(32)}`, selectionRevision: 2 }
    const input = { ...f.input, requestedModelSelections: { lead, child } }
    const first = await createLeadTurn(
      connection.db,
      f.workspace.id,
      f.topic.id,
      f.owner.principal,
      input
    )
    const replay = await createLeadTurn(
      connection.db,
      f.workspace.id,
      f.topic.id,
      f.owner.principal,
      { ...input, requestedModelSelections: { child, lead } }
    )
    expect(replay.leadTurn).toEqual(first.leadTurn)
    for (const requestedModelSelections of [
      { lead: { ...lead, selectionRevision: 2 }, child },
      { lead: child, child },
      { lead },
    ])
      await expect(
        createLeadTurn(connection.db, f.workspace.id, f.topic.id, f.owner.principal, {
          ...input,
          requestedModelSelections,
        })
      ).rejects.toThrow('model selection conflict')
    await expect(f.admit()).rejects.toThrow('model selection conflict')
    const stored = await connection.db
      .select()
      .from(leadTurnIntents)
      .where(eq(leadTurnIntents.id, first.leadTurn.intentId))
    expect(stored).toHaveLength(1)
    expect(stored[0]?.requestedModelSelections).toEqual({ lead, child })
    expect(
      await connection.db.select().from(messages).where(eq(messages.channelId, f.topic.id))
    ).toHaveLength(1)
  })

  test('concurrent retry commits one canonical message, one blocked intent and one event', async () => {
    const f = await fixture()
    const results = await Promise.all(Array.from({ length: 4 }, f.admit))
    expect(new Set(results.map((r) => r.message.id)).size).toBe(1)
    expect(new Set(results.map((r) => r.leadTurn.intentId)).size).toBe(1)
    const receipt = results[0]!.leadTurn
    expect(receipt).toMatchObject({ state: 'blocked', reasonCode: 'ADMISSION_SERVICE_UNAVAILABLE' })
    expect(receipt.dispatchKey).toBe(`lead-turn:${receipt.intentId}`)
    expect(
      await getLeadTurnForUser(
        connection.db,
        f.workspace.id,
        results[0]!.message.id,
        f.owner.principal
      )
    ).toEqual(receipt)
    const rows = await connection.db
      .select()
      .from(leadTurnIntents)
      .where(eq(leadTurnIntents.workspaceId, f.workspace.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      actorUserId: f.owner.principal.userId,
      agentId: f.lead.id,
      profileId: f.lead.profile.id,
      profileVersion: f.lead.profile.version,
      profileRevision: f.lead.profile.revision,
      channelVersion: f.topic.version,
    })
    expect(JSON.stringify(rows)).not.toContain(f.input.bodyText)
    expect(
      (
        await connection.db
          .select()
          .from(workspaceEvents)
          .where(eq(workspaceEvents.workspaceId, f.workspace.id))
      ).filter((event) => event.eventType === 'message.created')
    ).toHaveLength(1)
    await expect(
      createLeadTurn(connection.db, f.workspace.id, f.topic.id, f.owner.principal, {
        ...f.input,
        bodyText: 'Changed',
      })
    ).rejects.toThrow('idempotency conflict')
    await expect(
      createMessage(connection.db, f.workspace.id, f.topic.id, f.owner.principal, {
        ...f.input,
        sender: f.owner.principal,
      })
    ).rejects.toThrow('idempotency conflict')
  })

  test('rollback removes message, event and intent; post-commit retry retains identity', async () => {
    const f = await fixture()
    await expect(
      connection.db.transaction(async (tx) => {
        // A database failure at the intent boundary must also roll back the
        // canonical message/event. Inject a real SQL error at that boundary,
        // without requiring trigger ownership or database/schema CREATE.
        await createLeadTurn(
          faultAtIntent(tx),
          f.workspace.id,
          f.topic.id,
          f.owner.principal,
          f.input
        )
      })
    ).rejects.toMatchObject({ cause: { code: '22012' } })
    await expect(
      connection.db.transaction(async (tx) => {
        await createLeadTurn(tx, f.workspace.id, f.topic.id, f.owner.principal, f.input)
        throw new Error('simulated crash')
      })
    ).rejects.toThrow('simulated crash')
    expect(
      await connection.db.select().from(messages).where(eq(messages.channelId, f.topic.id))
    ).toHaveLength(0)
    expect(
      await connection.db
        .select()
        .from(leadTurnIntents)
        .where(eq(leadTurnIntents.channelId, f.topic.id))
    ).toHaveLength(0)
    expect(
      (
        await connection.db
          .select()
          .from(workspaceEvents)
          .where(eq(workspaceEvents.workspaceId, f.workspace.id))
      ).filter((event) => event.eventType === 'message.created')
    ).toHaveLength(0)
    const committed = await f.admit()
    expect(await f.admit()).toEqual(committed)
  })

  test('topics remain isolated and plain direct-session messages do not create an intent', async () => {
    const f = await fixture()
    const other = await createDirectAgentTopic(
      connection.db,
      f.workspace.id,
      f.lead.id,
      f.owner.principal,
      { title: 'Second topic', idempotencyKey: crypto.randomUUID() }
    )
    const first = await f.admit()
    const second = await createLeadTurn(
      connection.db,
      f.workspace.id,
      other.id,
      f.owner.principal,
      f.input
    )
    expect(second.message.id).not.toBe(first.message.id)
    expect(second.leadTurn.dispatchKey).not.toBe(first.leadTurn.dispatchKey)
    const plainKey = crypto.randomUUID()
    const plain = await createMessage(connection.db, f.workspace.id, other.id, f.owner.principal, {
      ...f.input,
      idempotencyKey: plainKey,
      sender: f.owner.principal,
      externalSessionRef: 'existing-session',
    })
    expect(
      await getLeadTurnForUser(connection.db, f.workspace.id, plain.id, f.owner.principal)
    ).toBeNull()
    await expect(
      createLeadTurn(connection.db, f.workspace.id, other.id, f.owner.principal, {
        ...f.input,
        idempotencyKey: plainKey,
      })
    ).rejects.toThrow('idempotency conflict')
  })

  test('rejects caller execution authority, non-lead channels and wrong workspace before persistence', async () => {
    const f = await fixture()
    await expect(
      createLeadTurn(connection.db, f.workspace.id, f.topic.id, f.owner.principal, {
        ...f.input,
        executionRef: 'caller-authority',
      } as never)
    ).rejects.toThrow('Invalid lead turn')
    const group = await createGroupChannel(connection.db, f.workspace.id, f.owner.principal, {
      title: 'Group',
      idempotencyKey: crypto.randomUUID(),
    })
    await expect(
      createLeadTurn(connection.db, f.workspace.id, group.id, f.owner.principal, f.input)
    ).rejects.toThrow('unavailable')
    const otherAgent = await createAgent(connection.db, f.workspace.id, f.owner.principal, {
      name: 'Other agent',
      profileId: 'profile',
      profileVersion: '1',
    })
    const otherTopic = await createDirectAgentTopic(
      connection.db,
      f.workspace.id,
      otherAgent.id,
      f.owner.principal,
      { title: 'Other agent', idempotencyKey: crypto.randomUUID() }
    )
    await expect(
      createLeadTurn(connection.db, f.workspace.id, otherTopic.id, f.owner.principal, f.input)
    ).rejects.toThrow('unavailable')
    await expect(
      createLeadTurn(connection.db, crypto.randomUUID(), f.topic.id, f.owner.principal, f.input)
    ).rejects.toThrow('unavailable')
    expect(
      await connection.db.select().from(messages).where(eq(messages.channelId, f.topic.id))
    ).toHaveLength(0)
  })

  test('revalidates pinned profile, audience, live channel and workspace on inspection and retry', async () => {
    const f = await fixture()
    const result = await f.admit()
    await connection.db
      .update(agents)
      .set({ profileRevision: f.lead.profile.revision + 1 })
      .where(eq(agents.id, f.lead.id))
    await expect(f.admit()).rejects.toThrow('version conflict')
    await expect(
      getLeadTurnForUser(connection.db, f.workspace.id, result.message.id, f.owner.principal)
    ).rejects.toThrow('version conflict')
    await connection.db
      .update(agents)
      .set({ profileRevision: f.lead.profile.revision })
      .where(eq(agents.id, f.lead.id))
    await connection.db
      .update(channels)
      .set({ version: f.topic.version + 1 })
      .where(eq(channels.id, f.topic.id))
    await expect(f.admit()).rejects.toThrow('version conflict')
    await connection.db
      .update(channels)
      .set({ version: f.topic.version })
      .where(eq(channels.id, f.topic.id))
    await connection.db
      .delete(channelParticipants)
      .where(eq(channelParticipants.userId, f.owner.principal.userId))
    await expect(f.admit()).rejects.toThrow('unavailable')
    await connection.db.insert(channelParticipants).values({
      workspaceId: f.workspace.id,
      channelId: f.topic.id,
      principalKind: 'user',
      userId: f.owner.principal.userId,
    })
    await connection.db
      .update(channels)
      .set({ lifecycleState: 'archived' })
      .where(eq(channels.id, f.topic.id))
    await expect(f.admit()).rejects.toThrow('unavailable')
    await connection.db
      .update(channels)
      .set({ lifecycleState: 'active' })
      .where(eq(channels.id, f.topic.id))
    await connection.db
      .update(workspaces)
      .set({ deletedAt: new Date() })
      .where(eq(workspaces.id, f.workspace.id))
    await expect(f.admit()).rejects.toThrow('unavailable')
  })

  test('outsider and removed membership cannot inspect or retry existing intent', async () => {
    const f = await fixture()
    const result = await f.admit()
    const outsider = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    await expect(
      getLeadTurnForUser(connection.db, f.workspace.id, result.message.id, outsider.principal)
    ).rejects.toThrow('unavailable')
    await connection.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, f.workspace.id))
    await expect(f.admit()).rejects.toThrow('unavailable')
    await expect(
      getLeadTurnForUser(connection.db, f.workspace.id, result.message.id, f.owner.principal)
    ).rejects.toThrow('unavailable')
  })

  test('current authorized participant can inspect without becoming the original admission actor', async () => {
    const f = await fixture()
    const participant = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    await connection.db
      .insert(workspaceMemberships)
      .values({ workspaceId: f.workspace.id, userId: participant.principal.userId, role: 'member' })
    await connection.db.insert(channelParticipants).values({
      workspaceId: f.workspace.id,
      channelId: f.topic.id,
      principalKind: 'user',
      userId: participant.principal.userId,
    })
    const result = await f.admit()
    expect(
      await getLeadTurnForUser(
        connection.db,
        f.workspace.id,
        result.message.id,
        participant.principal
      )
    ).toEqual(result.leadTurn)
    await connection.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.userId, f.owner.principal.userId))
    expect(
      await getLeadTurnForUser(
        connection.db,
        f.workspace.id,
        result.message.id,
        participant.principal
      )
    ).toEqual(result.leadTurn)
    await expect(f.admit()).rejects.toThrow('unavailable')
    await expect(
      createLeadTurn(connection.db, f.workspace.id, f.topic.id, participant.principal, f.input)
    ).rejects.toThrow('unavailable')
    const [intent] = await connection.db
      .select()
      .from(leadTurnIntents)
      .where(eq(leadTurnIntents.messageId, result.message.id))
    expect(intent!.actorUserId).toBe(f.owner.principal.userId)
  })
})
