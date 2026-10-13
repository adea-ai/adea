import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import { createWorkspaceWithOwner } from '../../src/workspaces'
import { ensureWorkspaceLead } from '../../src/agents'
import { createLeadTurn } from '../../src/lead-turns'
import {
  createGroupChannelWithGrants,
  groupCreationCandidatesFromGrants,
  revokeGroupGrant,
} from '../../src/group-channels'
import { withCurrentSourceLeadTurnProduct } from '../../src/lead-source-product'
import { agents, groupAudienceGrants, workspaceMemberships, workspaces } from '../../src/schema'

const databaseUrl = process.env.DATABASE_URL
describe.skipIf(!databaseUrl)('canonical foreign source product', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(databaseUrl!)
  })
  afterAll(() => connection.close())
  async function fixture() {
    const actor = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const makeWorkspace = (name: string) =>
      createWorkspaceWithOwner(connection.db, {
        name,
        owner: actor.principal,
        idempotencyKey: crypto.randomUUID(),
      })
    const { workspace: createdHost } = await makeWorkspace('Source host')
    const { workspace: createdSource } = await makeWorkspace('Source authority')
    const [host] = await connection.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, createdHost.id))
    const [source] = await connection.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, createdSource.id))
    if (!host || !source) throw new Error('Fixture workspace missing')
    const lead = await ensureWorkspaceLead(connection.db, source.id, actor.principal)
    const channelId = crypto.randomUUID()
    const grantId = `source_${crypto.randomUUID()}`
    const issuedAt = new Date(Date.now() - 1_000).toISOString()
    await createGroupChannelWithGrants(connection.db, host.id, actor.principal, {
      channelId,
      title: 'Foreign source',
      idempotencyKey: crypto.randomUUID(),
      now: issuedAt,
      candidates: groupCreationCandidatesFromGrants(host.id, {
        audienceGrants: [
          {
            participant: actor.principal,
            groupId: channelId,
            grantId: `human_${crypto.randomUUID()}`,
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
    const admitted = await createLeadTurn(connection.db, host.id, channelId, actor.principal, {
      bodyText: 'One explicit human source turn',
      idempotencyKey: crypto.randomUUID(),
    })
    const read = (workspaceId = source.controlPlaneWorkspaceId) =>
      withCurrentSourceLeadTurnProduct(
        connection.db,
        workspaceId,
        admitted.leadTurn.intentId,
        async (product) => product
      )
    return { actor, host, source, lead, channelId, grantId, admitted, read }
  }
  test('canonical source lookup retains the host, qualified Agent, source mapping and enlistment', async () => {
    const f = await fixture()
    expect(await f.read()).toMatchObject({
      workspaceId: f.host.id,
      agentWorkspaceId: f.source.id,
      controlPlaneWorkspaceId: f.host.controlPlaneWorkspaceId,
      sourceControlPlaneWorkspaceId: f.source.controlPlaneWorkspaceId,
      agentId: f.lead.id,
      channelId: f.channelId,
      actorUserId: f.actor.principal.userId,
      enlistmentGrantId: f.grantId,
      enlistmentRevision: 1,
      profileId: f.lead.profile.id,
      prompt: 'One explicit human source turn',
    })
    expect(await f.read(f.host.controlPlaneWorkspaceId)).toBeUndefined()
  })
  test('host participation and prior enlistment cannot replace current source runtime authority', async () => {
    const f = await fixture()
    await connection.db
      .delete(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, f.source.id),
          eq(workspaceMemberships.userId, f.actor.principal.userId)
        )
      )
    await expect(f.read()).rejects.toThrow('Lead turn unavailable')
  })
  test('source role downgrade, pending deletion and host enlistment revocation deny disclosure', async () => {
    const downgraded = await fixture()
    await connection.db
      .update(workspaceMemberships)
      .set({ role: 'member' })
      .where(
        and(
          eq(workspaceMemberships.workspaceId, downgraded.source.id),
          eq(workspaceMemberships.userId, downgraded.actor.principal.userId)
        )
      )
    await expect(downgraded.read()).rejects.toThrow('Lead turn unavailable')
    const pending = await fixture()
    await connection.db
      .update(workspaces)
      .set({ deletionRequestedAt: new Date() })
      .where(eq(workspaces.id, pending.source.id))
    await expect(pending.read()).rejects.toThrow('Lead turn unavailable')
    const revoked = await fixture()
    await revokeGroupGrant(
      connection.db,
      revoked.host.id,
      revoked.channelId,
      revoked.actor.principal,
      {
        grantId: revoked.grantId,
        kind: 'enlistment',
        revokedAt: new Date().toISOString(),
      }
    )
    await expect(revoked.read()).rejects.toThrow('unavailable')
  })
  test('source membership and mapping locks stay held through asynchronous disclosure', async () => {
    const f = await fixture()
    let entered!: () => void
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const read = withCurrentSourceLeadTurnProduct(
      connection.db,
      f.source.controlPlaneWorkspaceId,
      f.admitted.leadTurn.intentId,
      async () => {
        entered()
        await held
      }
    )
    await ready
    try {
      for (const mutate of [
        (tx: Parameters<Parameters<typeof connection.db.transaction>[0]>[0]) =>
          tx
            .update(workspaceMemberships)
            .set({ role: 'member' })
            .where(eq(workspaceMemberships.workspaceId, f.source.id)),
        (tx: Parameters<Parameters<typeof connection.db.transaction>[0]>[0]) =>
          tx
            .update(workspaces)
            .set({ controlPlaneWorkspaceId: `wsp_${'9'.repeat(26)}` })
            .where(eq(workspaces.id, f.source.id)),
      ]) {
        await expect(
          connection.db.transaction(async (tx) => {
            await tx.execute(sql`set local lock_timeout = '100ms'`)
            await mutate(tx)
          })
        ).rejects.toMatchObject({ cause: { code: '55P03' } })
      }
    } finally {
      release()
      await read
    }
  })
  test('an actor audience grant expiring while the read waits on the Agent lock denies disclosure', async () => {
    const f = await fixture()
    const expiresAt = new Date(Date.now() + 800).toISOString()
    await connection.db
      .update(groupAudienceGrants)
      .set({ expiresAt })
      .where(
        and(
          eq(groupAudienceGrants.workspaceId, f.host.id),
          eq(groupAudienceGrants.channelId, f.channelId),
          eq(groupAudienceGrants.userId, f.actor.principal.userId)
        )
      )
    let locked!: () => void
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
      locked = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const blocker = connection.db.transaction(async (tx) => {
      await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, f.lead.id)).for('update')
      locked()
      await held
    })
    await ready
    let disclosed = false
    const read = withCurrentSourceLeadTurnProduct(
      connection.db,
      f.source.controlPlaneWorkspaceId,
      f.admitted.leadTurn.intentId,
      async () => {
        disclosed = true
      }
    )
    try {
      // Verify a real lock wait before expiry, then let the unchanged absolute
      // grant deadline lapse. This is a DB barrier, not a synthetic product port.
      let waiting = false
      for (let attempt = 0; attempt < 40; attempt++) {
        const result = await connection.client<
          Array<{ waiting: boolean }>
        >`select exists(select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()) as waiting`
        if (result[0]?.waiting) {
          waiting = true
          break
        }
        await Bun.sleep(5)
      }
      expect(waiting).toBe(true)
      expect(Date.now()).toBeLessThan(Date.parse(expiresAt))
      await Bun.sleep(Math.max(0, Date.parse(expiresAt) - Date.now()) + 20)
    } finally {
      release()
      await blocker
    }
    await expect(read).rejects.toThrow('Lead turn unavailable')
    expect(disclosed).toBe(false)
  })
  test('audience expiry during delayed final service verification denies the returned product', async () => {
    const f = await fixture()
    const expiresAt = new Date(Date.now() + 800).toISOString()
    await connection.db
      .update(groupAudienceGrants)
      .set({ expiresAt })
      .where(
        and(
          eq(groupAudienceGrants.workspaceId, f.host.id),
          eq(groupAudienceGrants.channelId, f.channelId),
          eq(groupAudienceGrants.userId, f.actor.principal.userId)
        )
      )
    let verificationEntered = false
    const read = withCurrentSourceLeadTurnProduct(
      connection.db,
      f.source.controlPlaneWorkspaceId,
      f.admitted.leadTurn.intentId,
      async (product) => {
        verificationEntered = true
        expect(Date.now()).toBeLessThan(Date.parse(expiresAt))
        await Bun.sleep(Math.max(0, Date.parse(expiresAt) - Date.now()) + 20)
        return product
      }
    )
    await expect(read).rejects.toThrow('Lead turn unavailable')
    expect(verificationEntered).toBe(true)
  })
})
