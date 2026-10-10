import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ensureWorkspaceLead } from '../../src/agents'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createDirectAgentTopic } from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import { createLeadTurn } from '../../src/lead-turns'
import { resolveLeadTurnAuthority } from '../../src/lead-turn-runtime'
import { fenceLeadTurnForRollback, readLeadTurnRollbackState } from '../../src/lead-turn-rollback'
import {
  channelParticipants,
  leadTurnIntents,
  leadTurnRuntime,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const databaseUrl = process.env.DATABASE_URL

// Negative checks against the real rollback reader and the effect and cancel authority, for fence
// envelopes that are missing, stale or mismatched. Refusals are the same unavailable answer the other
// readers give, so a caller learns nothing about the fence from a denial.
describe.skipIf(!databaseUrl)(
  'fence envelope negatives on the real rollback reader and authority',
  () => {
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
        name: 'Fence envelope negatives',
        owner: owner.principal,
        idempotencyKey: crypto.randomUUID(),
      })
      const lead = await ensureWorkspaceLead(connection.db, workspace.id, owner.principal)
      const topic = await createDirectAgentTopic(
        connection.db,
        workspace.id,
        lead.id,
        owner.principal,
        {
          title: 'Envelope negatives',
          idempotencyKey: crypto.randomUUID(),
        }
      )
      const admitted = await createLeadTurn(
        connection.db,
        workspace.id,
        topic.id,
        owner.principal,
        {
          bodyText: 'Canonical question',
          idempotencyKey: crypto.randomUUID(),
        }
      )
      const [canonical] = await connection.db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, workspace.id))
      return {
        owner,
        workspace,
        topic,
        intentId: admitted.leadTurn.intentId,
        controlPlaneWorkspaceId: canonical!.controlPlaneWorkspaceId,
      }
    }

    async function outsider() {
      return createTemporaryUserSession(connection.db, {
        credentialDigest: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
      })
    }

    test('mismatched: a fenced admission read through another workspace is refused, and the fence is not disclosed', async () => {
      const f = await fixture()
      await fenceLeadTurnForRollback(connection.db, f.workspace.id, f.intentId, {
        actor: { kind: 'user', principal: f.owner.principal },
        reason: 'rollback_cohort',
      })
      const other = await fixture()
      await expect(
        readLeadTurnRollbackState(connection.db, other.workspace.id, f.intentId, f.owner.principal)
      ).rejects.toThrow('unavailable')
      await expect(
        readLeadTurnRollbackState(
          connection.db,
          f.workspace.id,
          crypto.randomUUID(),
          f.owner.principal
        )
      ).rejects.toThrow('unavailable')
    })

    test('mismatched: a fenced admission is refused to a principal from another workspace at the cancel and effect authority', async () => {
      const f = await fixture()
      await fenceLeadTurnForRollback(connection.db, f.workspace.id, f.intentId, {
        actor: { kind: 'user', principal: f.owner.principal },
        reason: 'rollback_cohort',
      })
      const other = await fixture()
      await expect(
        resolveLeadTurnAuthority(
          connection.db,
          other.workspace.id,
          f.intentId,
          other.owner.principal,
          'cancel'
        )
      ).rejects.toThrow('unavailable')
      await expect(
        resolveLeadTurnAuthority(
          connection.db,
          other.workspace.id,
          f.intentId,
          other.owner.principal,
          'effect'
        )
      ).rejects.toThrow('unavailable')
    })

    test('mismatched: a participant who is not the original actor cannot cancel a fenced admission, and the fence stays put', async () => {
      const f = await fixture()
      const member = await createTemporaryUserSession(connection.db, {
        credentialDigest: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
      })
      await connection.db.insert(workspaceMemberships).values({
        workspaceId: f.workspace.id,
        userId: member.principal.userId,
        role: 'member',
      })
      await connection.db.insert(channelParticipants).values({
        workspaceId: f.workspace.id,
        channelId: f.topic.id,
        principalKind: 'user',
        userId: member.principal.userId,
      })
      const fence = await fenceLeadTurnForRollback(connection.db, f.workspace.id, f.intentId, {
        actor: { kind: 'user', principal: f.owner.principal },
        reason: 'rollback_cohort',
      })
      await expect(
        resolveLeadTurnAuthority(
          connection.db,
          f.workspace.id,
          f.intentId,
          member.principal,
          'cancel'
        )
      ).rejects.toThrow('unavailable')
      // The channel is still active, so a pinned reader would now see the audience change. Read the stored
      // attribution directly instead, which is what the fence wrote.
      const [row] = await connection.db
        .select({
          fencedAt: leadTurnIntents.rollbackFencedAt,
          actorRef: leadTurnIntents.rollbackFenceActorRef,
          reason: leadTurnIntents.rollbackFenceReason,
        })
        .from(leadTurnIntents)
        .where(eq(leadTurnIntents.id, f.intentId))
      expect(row).toEqual({
        fencedAt: new Date(fence.attribution!.fencedAt),
        actorRef: f.owner.principal.userId,
        reason: 'rollback_cohort',
      })
    })

    test('missing: an unfenced admission with no runtime evidence is fence_required, never a reroute', async () => {
      const f = await fixture()
      const state = await readLeadTurnRollbackState(
        connection.db,
        f.workspace.id,
        f.intentId,
        f.owner.principal
      )
      expect(state).toMatchObject({ disposition: 'fence_required', fenced: false })
      expect(state).not.toHaveProperty('runtime')
      const rows = await connection.db
        .select()
        .from(leadTurnRuntime)
        .where(eq(leadTurnRuntime.intentId, f.intentId))
      expect(rows).toHaveLength(0)
    })

    test('missing: a fenced admission with no runtime evidence is no_effect_recorded, and the envelope is complete', async () => {
      const f = await fixture()
      const fence = await fenceLeadTurnForRollback(connection.db, f.workspace.id, f.intentId, {
        actor: { kind: 'user', principal: f.owner.principal },
        reason: 'rollback_cohort',
      })
      expect(fence.attribution).toMatchObject({
        actor: { kind: 'user', userId: f.owner.principal.userId },
        reason: 'rollback_cohort',
        authority: { runtimeState: null, disposition: 'no_effect_recorded' },
      })
      const state = await readLeadTurnRollbackState(
        connection.db,
        f.workspace.id,
        f.intentId,
        f.owner.principal
      )
      expect(state).toMatchObject({ disposition: 'no_effect_recorded', fenced: true })
    })

    test('mismatched: an outsider with no grant gets the same answer as an unknown admission', async () => {
      const f = await fixture()
      const stranger = await outsider()
      await expect(
        readLeadTurnRollbackState(connection.db, f.workspace.id, f.intentId, stranger.principal)
      ).rejects.toThrow('unavailable')
      await expect(
        readLeadTurnRollbackState(
          connection.db,
          f.workspace.id,
          crypto.randomUUID(),
          stranger.principal
        )
      ).rejects.toThrow('unavailable')
    })
  }
)
