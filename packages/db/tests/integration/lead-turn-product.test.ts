import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ensureWorkspaceLead } from '../../src/agents'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createDirectAgentTopic } from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import { createLeadTurn } from '../../src/lead-turns'
import { readCurrentLeadTurnProduct } from '../../src/lead-turn-product'
import { agents, channels, messages, workspaceMemberships, workspaces } from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const databaseUrl = process.env.DATABASE_URL
describe.skipIf(!databaseUrl)('trusted current lead product reader', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(databaseUrl!)
  })
  afterAll(() => connection.close())
  async function fixture() {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      name: 'Current product evidence',
      owner: owner.principal,
      idempotencyKey: crypto.randomUUID(),
    })
    const lead = await ensureWorkspaceLead(connection.db, workspace.id, owner.principal)
    const topic = await createDirectAgentTopic(
      connection.db,
      workspace.id,
      lead.id,
      owner.principal,
      { title: 'Product reader', idempotencyKey: crypto.randomUUID() }
    )
    const admitted = await createLeadTurn(connection.db, workspace.id, topic.id, owner.principal, {
      bodyText: 'Canonical private question',
      idempotencyKey: crypto.randomUUID(),
    })
    const [mapped] = await connection.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspace.id))
    const read = () =>
      readCurrentLeadTurnProduct(
        connection.db,
        mapped!.controlPlaneWorkspaceId,
        admitted.leadTurn.intentId
      )
    return { owner, workspace, lead, topic, admitted, mapped: mapped!, read }
  }

  test('reads original stored actor and exact mapped canonical pins without caller funding/profile authority', async () => {
    const f = await fixture()
    const current = await f.read()
    expect(current).toMatchObject({
      workspaceId: f.workspace.id,
      controlPlaneWorkspaceId: f.mapped.controlPlaneWorkspaceId,
      intentId: f.admitted.leadTurn.intentId,
      intentCreatedAt: expect.any(String),
      actorUserId: f.owner.principal.userId,
      channelId: f.topic.id,
      channelVersion: f.topic.version,
      messageId: f.admitted.message.id,
      messageVersion: 1,
      agentId: f.lead.id,
      profileId: f.lead.profile.id,
      profileVersion: f.lead.profile.version,
      profileRevision: f.lead.profile.revision,
      prompt: 'Canonical private question',
    })
    expect(current).not.toHaveProperty('selectionRef')
    expect(current).not.toHaveProperty('profileContentDigest')
    expect(current).not.toHaveProperty('expiresAt')
    expect(current).not.toHaveProperty('allowedPrincipalIds')
    expect(
      await readCurrentLeadTurnProduct(
        connection.db,
        `wsp_${'0'.repeat(26)}`,
        f.admitted.leadTurn.intentId
      )
    ).toBeUndefined()
  })

  test('revoked original actor, archived topic and changed profile pins deny current evidence', async () => {
    const revoked = await fixture()
    await connection.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, revoked.workspace.id))
    await expect(revoked.read()).rejects.toThrow('unavailable')
    const archived = await fixture()
    await connection.db
      .update(channels)
      .set({ lifecycleState: 'archived' })
      .where(eq(channels.id, archived.topic.id))
    await expect(archived.read()).rejects.toThrow('unavailable')
    const changed = await fixture()
    await connection.db
      .update(agents)
      .set({ profileRevision: changed.lead.profile.revision + 1 })
      .where(eq(agents.id, changed.lead.id))
    await expect(changed.read()).rejects.toThrow('version conflict')
  })

  test('edited canonical prompt is withheld from the original immutable intent', async () => {
    const f = await fixture()
    await connection.db
      .update(messages)
      .set({ version: 2, editedAt: new Date(), bodyText: 'Changed question' })
      .where(eq(messages.id, f.admitted.message.id))
    await expect(f.read()).rejects.toThrow('unavailable')
  })
})
