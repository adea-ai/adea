import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'
import { ensureWorkspaceLead } from '../../src/agents'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createDirectAgentTopic } from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import { createLeadTurn, getLeadTurnForUser } from '../../src/lead-turns'
import { readCurrentLeadTurnProduct, withCurrentLeadTurnProduct } from '../../src/lead-turn-product'
import type { RequestedRoleModelSelections } from '../../src/lead-model-selections'
import { agents, channels, messages, workspaceMemberships, workspaces } from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'
import {
  createGroupChannelWithGrants,
  groupCreationCandidatesFromGrants,
  revokeGroupGrant,
} from '../../src/group-channels'

const databaseUrl = process.env.DATABASE_URL
describe.skipIf(!databaseUrl)('trusted current lead product reader', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(databaseUrl!)
  })
  afterAll(() => connection.close())
  async function fixture(
    role: 'owner' | 'admin' = 'owner',
    requestedModelSelections?: RequestedRoleModelSelections
  ) {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      name: 'Current product evidence',
      owner: owner.principal,
      idempotencyKey: crypto.randomUUID(),
    })
    if (role !== 'owner')
      await connection.db
        .update(workspaceMemberships)
        .set({ role })
        .where(
          and(
            eq(workspaceMemberships.workspaceId, workspace.id),
            eq(workspaceMemberships.userId, owner.principal.userId)
          )
        )
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
      ...(requestedModelSelections ? { requestedModelSelections } : {}),
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

  test('retains requested role references under current original-actor locks', async () => {
    const requested = {
      lead: { selectionRef: `msel_${'a'.repeat(32)}`, selectionRevision: 1 },
      child: { selectionRef: `msel_${'b'.repeat(32)}`, selectionRevision: 2 },
    }
    const f = await fixture('owner', requested)
    const current = await f.read()
    expect(current?.requestedModelSelections).toEqual(requested)
    expect(Object.isFrozen(current?.requestedModelSelections)).toBe(true)
    await connection.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, f.workspace.id))
    await expect(f.read()).rejects.toThrow('unavailable')
  })

  test('reads original stored actor and exact mapped canonical pins without caller funding/profile authority', async () => {
    const f = await fixture()
    const current = await f.read()
    expect(current).toMatchObject({
      workspaceId: f.workspace.id,
      agentWorkspaceId: f.workspace.id,
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

  test('foreign lead evidence retains its locked source identity across distinct host groups and revocation', async () => {
    const f = await fixture()
    const { workspace: source } = await createWorkspaceWithOwner(connection.db, {
      name: 'Foreign lead source',
      owner: f.owner.principal,
      idempotencyKey: crypto.randomUUID(),
    })
    const lead = await ensureWorkspaceLead(connection.db, source.id, f.owner.principal)
    const [sourceAgent] = await connection.db
      .select({ controlPlaneAgentId: agents.controlPlaneAgentId })
      .from(agents)
      .where(eq(agents.id, lead.id))
    const groups = []
    const issuedAt = new Date(Date.now() - 1_000).toISOString()
    for (let index = 0; index < 2; index++) {
      const channelId = crypto.randomUUID()
      const grantId = `gra_source_product_${index}`
      await createGroupChannelWithGrants(connection.db, f.workspace.id, f.owner.principal, {
        channelId,
        title: 'Foreign source context',
        idempotencyKey: crypto.randomUUID(),
        now: issuedAt,
        candidates: groupCreationCandidatesFromGrants(f.workspace.id, {
          audienceGrants: [
            {
              participant: f.owner.principal,
              groupId: channelId,
              grantId: `gra_actor_product_${index}`,
              revision: 1,
              issuedAt,
              expiresAt: null,
              revokedAt: null,
            },
          ],
          enlistmentGrants: [
            {
              agent: { agentId: lead.id, workspaceId: source.id },
              groupId: channelId,
              grantId,
              revision: 1,
              issuedAt,
              expiresAt: null,
              revokedAt: null,
            },
          ],
        }),
      })
      const admitted = await createLeadTurn(
        connection.db,
        f.workspace.id,
        channelId,
        f.owner.principal,
        {
          bodyText: 'Foreign lead context',
          idempotencyKey: crypto.randomUUID(),
        }
      )
      const read = () =>
        readCurrentLeadTurnProduct(
          connection.db,
          f.mapped.controlPlaneWorkspaceId,
          admitted.leadTurn.intentId
        )
      const product = await read()
      expect(product).toMatchObject({
        workspaceId: f.workspace.id,
        agentWorkspaceId: source.id,
        controlPlaneWorkspaceId: f.mapped.controlPlaneWorkspaceId,
        agentId: lead.id,
        controlPlaneAgentId: sourceAgent!.controlPlaneAgentId,
        profileId: lead.profile.id,
        channelId,
      })
      groups.push({ channelId, grantId, read, product })
    }
    expect(groups[0]!.product!.channelId).not.toBe(groups[1]!.product!.channelId)
    await revokeGroupGrant(connection.db, f.workspace.id, groups[0]!.channelId, f.owner.principal, {
      grantId: groups[0]!.grantId,
      kind: 'enlistment',
      revokedAt: new Date().toISOString(),
    })
    await expect(groups[0]!.read()).rejects.toThrow('unavailable')
    expect(await groups[1]!.read()).toMatchObject({ agentWorkspaceId: source.id, agentId: lead.id })
  })

  test('edited canonical prompt is withheld from the original immutable intent', async () => {
    const f = await fixture()
    await connection.db
      .update(messages)
      .set({ version: 2, editedAt: new Date(), bodyText: 'Changed question' })
      .where(eq(messages.id, f.admitted.message.id))
    await expect(f.read()).rejects.toThrow('unavailable')
  })

  test('admin admission downgraded to member denies runtime evidence and retains authorized history', async () => {
    const f = await fixture('admin')
    expect(await f.read()).toMatchObject({ actorUserId: f.owner.principal.userId })
    await connection.db
      .update(workspaceMemberships)
      .set({ role: 'member' })
      .where(
        and(
          eq(workspaceMemberships.workspaceId, f.workspace.id),
          eq(workspaceMemberships.userId, f.owner.principal.userId)
        )
      )
    await expect(f.read()).rejects.toThrow('unavailable')
    let disclosed = false
    await expect(
      withCurrentLeadTurnProduct(
        connection.db,
        f.mapped.controlPlaneWorkspaceId,
        f.admitted.leadTurn.intentId,
        async () => {
          disclosed = true
        }
      )
    ).rejects.toThrow('unavailable')
    expect(disclosed).toBe(false)
    expect(
      await getLeadTurnForUser(
        connection.db,
        f.workspace.id,
        f.admitted.message.id,
        f.owner.principal
      )
    ).toMatchObject({ intentId: f.admitted.leadTurn.intentId })
  })

  test('async disclosure retains actor-role and pinned-profile locks until verification settles', async () => {
    const f = await fixture('admin')
    let entered!: () => void
    let release!: () => void
    const callbackEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    const verification = new Promise<void>((resolve) => {
      release = resolve
    })
    const disclosure = withCurrentLeadTurnProduct(
      connection.db,
      f.mapped.controlPlaneWorkspaceId,
      f.admitted.leadTurn.intentId,
      async (product) => {
        entered()
        await verification
        return product
      }
    )
    await callbackEntered
    try {
      await expect(
        connection.db.transaction(async (tx) => {
          await tx.execute(sql`set local lock_timeout = '100ms'`)
          await tx
            .update(workspaceMemberships)
            .set({ role: 'member' })
            .where(
              and(
                eq(workspaceMemberships.workspaceId, f.workspace.id),
                eq(workspaceMemberships.userId, f.owner.principal.userId)
              )
            )
        })
      ).rejects.toMatchObject({ cause: { code: '55P03' } })
      await expect(
        connection.db.transaction(async (tx) => {
          await tx.execute(sql`set local lock_timeout = '100ms'`)
          await tx
            .update(agents)
            .set({ profileRevision: f.lead.profile.revision + 1 })
            .where(eq(agents.id, f.lead.id))
        })
      ).rejects.toMatchObject({ cause: { code: '55P03' } })
    } finally {
      release()
      await disclosure
    }
    await connection.db
      .update(workspaceMemberships)
      .set({ role: 'member' })
      .where(
        and(
          eq(workspaceMemberships.workspaceId, f.workspace.id),
          eq(workspaceMemberships.userId, f.owner.principal.userId)
        )
      )
    await expect(f.read()).rejects.toThrow('unavailable')
  })
})
