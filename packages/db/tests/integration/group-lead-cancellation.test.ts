import { describe, expect, test } from 'bun:test'
import type { UserPrincipalRef } from '@adea-ai/types'
import { and, eq } from 'drizzle-orm'

import { ensureWorkspaceLead } from '../../src/agents'
import { createDatabase } from '../../src/connection'
import { archiveChannel } from '../../src/conversations'
import { getLatestLeadTurnForChannel, getLeadTurnForUser } from '../../src/lead-turns'
import {
  markLeadTurnDispatchPending,
  observeLeadTurnRuntime,
  prepareLeadTurnRuntime,
  readLeadTurnRuntime,
  requestLeadTurnCancellation,
  resolveLeadTurnAuthority,
} from '../../src/lead-turn-runtime'
import { fenceLeadTurnForRollback, readLeadTurnRollbackState } from '../../src/lead-turn-rollback'
import {
  createGroupChannelWithGrants,
  groupCreationCandidatesFromGrants,
  postGroupChannelMessage,
  revokeGroupGrant,
} from '../../src/group-channels'
import { createTemporaryUserSession } from '../../src/identity'
import * as schema from '../../src/schema'
import { addWorkspaceMembership, createWorkspaceWithOwner } from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL

const ISSUED = '2026-10-01T00:00:00.000Z'
const NOW = '2026-10-08T12:00:00.000Z'
const LATER = '2026-10-08T13:00:00.000Z'

// Group claim-holder cancellation and binding (#1220). Active group admissions are reachable only
// through the `bind` and `cancel` historical purposes, and only for the original claim holder.

function T(name: string, fn: () => Promise<void>) {
  test(name, fn, 30_000)
}

function hexId(length: number): string {
  return [...crypto.getRandomValues(new Uint8Array(length))]
    .map((byte) => (byte % 16).toString(16))
    .join('')
}

/** Unique Crockford/hex fixture ids: runtime attempt/execution ids are unique. */
function uniqueRuntimeIds() {
  const upper = (length: number) => hexId(length).toUpperCase()
  return {
    attemptId: `att_${upper(26)}`,
    dispatchId: `dispatch_${hexId(32)}`,
    executionId: `exe_${upper(26)}`,
    runtimeSessionId: `ses_${upper(26)}`,
  }
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
/** Canonical group lead admission: owner and member audience, plus any extra audience principal who posts. */
async function groupLeadAdmission(
  f: Awaited<ReturnType<typeof isolatedFixture>>,
  poster: UserPrincipalRef,
  extraAudience: readonly UserPrincipalRef[] = []
) {
  const lead = await ensureWorkspaceLead(f.local.db, f.workspace.id, f.owner)
  const channelId = crypto.randomUUID()
  const audience = [f.owner, f.member, ...extraAudience]
  await createGroupChannelWithGrants(f.local.db, f.workspace.id, f.owner, {
    candidates: groupCreationCandidatesFromGrants(f.workspace.id, {
      audienceGrants: audience.map((participant, index) => ({
        expiresAt: null,
        grantId: `gra_person_${index}`,
        groupId: channelId,
        issuedAt: ISSUED,
        participant,
        revision: 1,
        revokedAt: null,
      })),
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
      ],
    }),
    channelId,
    idempotencyKey: crypto.randomUUID(),
    now: NOW,
    title: 'Group',
  })
  const posted = await postGroupChannelMessage(
    f.local.db,
    f.workspace.id,
    channelId,
    poster,
    poster,
    {
      lead: { bodyText: 'run it', idempotencyKey: crypto.randomUUID(), mentions: [] },
      mode: 'lead',
    },
    { now: NOW }
  )
  return { channelId, intentId: posted.leadTurn.intentId }
}

/** Prepares and marks one attempt pending as the claim holder, returning the ids the canonical dispatch records. */
async function prepareGroupAttempt(
  f: Awaited<ReturnType<typeof isolatedFixture>>,
  intentId: string,
  actor: UserPrincipalRef
) {
  const { controlPlaneWorkspaceId } = await resolveLeadTurnAuthority(
    f.local.db,
    f.workspace.id,
    intentId,
    actor,
    'effect'
  )
  const ids = uniqueRuntimeIds()
  const selection = {
    attemptId: ids.attemptId,
    executionId: ids.executionId,
    expiresAt: '2027-01-01T00:00:00.000Z',
    intentId,
    preparationRef: `prep_${'c'.repeat(32)}`,
    selectionRef: `msel_${'c'.repeat(32)}`,
    selectionRevision: 1,
    workspaceId: controlPlaneWorkspaceId,
  }
  await prepareLeadTurnRuntime(f.local.db, f.workspace.id, intentId, actor, selection)
  await markLeadTurnDispatchPending(f.local.db, f.workspace.id, intentId, actor, selection)
  return ids
}

/** Records the canonical dispatch binding as the claim holder, so cancellation has a runtime binding. */
async function bindGroupAttempt(
  f: Awaited<ReturnType<typeof isolatedFixture>>,
  intentId: string,
  actor: UserPrincipalRef
) {
  const ids = await prepareGroupAttempt(f, intentId, actor)
  await observeLeadTurnRuntime(f.local.db, f.workspace.id, intentId, actor, {
    attemptId: ids.attemptId,
    dispatchId: ids.dispatchId,
    executionId: ids.executionId,
    intentId,
    observedAt: NOW,
    runtimeSessionId: ids.runtimeSessionId,
    state: 'running',
  })
  return ids.dispatchId
}

async function dispatchIdOf(f: Awaited<ReturnType<typeof isolatedFixture>>, intentId: string) {
  const [row] = await f.local.db
    .select({ dispatchId: schema.leadTurnRuntime.dispatchId })
    .from(schema.leadTurnRuntime)
    .where(eq(schema.leadTurnRuntime.intentId, intentId))
  return row?.dispatchId ?? null
}

async function cancelRequestedAt(f: Awaited<ReturnType<typeof isolatedFixture>>, intentId: string) {
  const [row] = await f.local.db
    .select({ at: schema.leadTurnRuntime.cancelRequestedAt })
    .from(schema.leadTurnRuntime)
    .where(eq(schema.leadTurnRuntime.intentId, intentId))
  return row?.at ?? null
}

async function archiveGroup(f: Awaited<ReturnType<typeof isolatedFixture>>, channelId: string) {
  const [channel] = await f.local.db
    .select({ version: schema.channels.version })
    .from(schema.channels)
    .where(eq(schema.channels.id, channelId))
  await archiveChannel(f.local.db, f.workspace.id, channelId, f.owner, channel!.version)
}

describe.skipIf(!connectionUrl)('group lead-turn cancellation and binding', () => {
  T(
    'group cancellation: the claim holder reads and cancels through canonical group authority, and a repeat converges',
    async () => {
      const f = await isolatedFixture()
      try {
        const { intentId } = await groupLeadAdmission(f, f.owner)
        await bindGroupAttempt(f, intentId, f.owner)
        const authority = await resolveLeadTurnAuthority(
          f.local.db,
          f.workspace.id,
          intentId,
          f.owner,
          'cancel'
        )
        expect(authority.intentId).toBe(intentId)
        await requestLeadTurnCancellation(f.local.db, f.workspace.id, intentId, f.owner)
        const first = await cancelRequestedAt(f, intentId)
        expect(first).not.toBeNull()
        await requestLeadTurnCancellation(f.local.db, f.workspace.id, intentId, f.owner)
        expect(await cancelRequestedAt(f, intentId)).toEqual(first)
      } finally {
        await f.local.close()
      }
    }
  )

  T(
    'group cancellation: a group participant who is not the claim holder is denied, and nothing is recorded',
    async () => {
      const f = await isolatedFixture()
      try {
        const { intentId } = await groupLeadAdmission(f, f.owner)
        await bindGroupAttempt(f, intentId, f.owner)
        await expect(
          requestLeadTurnCancellation(f.local.db, f.workspace.id, intentId, f.member)
        ).rejects.toThrow('Lead turn unavailable')
        await expect(
          resolveLeadTurnAuthority(f.local.db, f.workspace.id, intentId, f.member, 'cancel')
        ).rejects.toThrow('Lead turn unavailable')
        expect(await cancelRequestedAt(f, intentId)).toBeNull()
      } finally {
        await f.local.close()
      }
    }
  )

  T(
    'group cancellation: a principal from another workspace is denied at the cancel authority',
    async () => {
      const f = await isolatedFixture()
      try {
        const { intentId } = await groupLeadAdmission(f, f.owner)
        await bindGroupAttempt(f, intentId, f.owner)
        const outsider = (
          await createTemporaryUserSession(f.local.db, {
            credentialDigest: `outsider-${crypto.randomUUID()}`,
            expiresAt: new Date(Date.now() + 60_000),
          })
        ).principal
        // The outsider owns a different workspace, so they hold runtime.invoke there and nowhere in this one.
        await createWorkspaceWithOwner(f.local.db, {
          idempotencyKey: crypto.randomUUID(),
          name: 'Other workspace',
          owner: outsider,
        })
        await expect(
          resolveLeadTurnAuthority(f.local.db, f.workspace.id, intentId, outsider, 'cancel')
        ).rejects.toThrow('Lead turn unavailable')
        await expect(
          requestLeadTurnCancellation(f.local.db, f.workspace.id, intentId, outsider)
        ).rejects.toThrow('Lead turn unavailable')
        expect(await cancelRequestedAt(f, intentId)).toBeNull()
      } finally {
        await f.local.close()
      }
    }
  )

  T(
    'group cancellation: an admin who loses runtime.invoke is denied, and the binding is kept',
    async () => {
      const f = await isolatedFixture()
      try {
        const admin = (
          await createTemporaryUserSession(f.local.db, {
            credentialDigest: `admin-${crypto.randomUUID()}`,
            expiresAt: new Date(Date.now() + 60_000),
          })
        ).principal
        await addWorkspaceMembership(f.local.db, f.workspace.id, admin, 'admin')
        const { intentId } = await groupLeadAdmission(f, admin, [admin])
        await bindGroupAttempt(f, intentId, admin)
        await f.local.db
          .update(schema.workspaceMemberships)
          .set({ role: 'member' })
          .where(
            and(
              eq(schema.workspaceMemberships.workspaceId, f.workspace.id),
              eq(schema.workspaceMemberships.userId, admin.userId)
            )
          )
        await expect(
          requestLeadTurnCancellation(f.local.db, f.workspace.id, intentId, admin)
        ).rejects.toThrow('Lead turn unavailable')
        expect(await cancelRequestedAt(f, intentId)).toBeNull()
        const [binding] = await f.local.db
          .select({ dispatchId: schema.leadTurnRuntime.dispatchId })
          .from(schema.leadTurnRuntime)
          .where(eq(schema.leadTurnRuntime.intentId, intentId))
        expect(binding?.dispatchId).not.toBeNull()
      } finally {
        await f.local.close()
      }
    }
  )

  T(
    'group cancellation: a fenced admission is still cancelled by its claim holder, and the fence attribution is unchanged',
    async () => {
      const f = await isolatedFixture()
      try {
        const { intentId } = await groupLeadAdmission(f, f.owner)
        await bindGroupAttempt(f, intentId, f.owner)
        const fence = await fenceLeadTurnForRollback(f.local.db, f.workspace.id, intentId, {
          actor: { kind: 'user', principal: f.owner },
          reason: 'rollback_cohort',
        })
        await requestLeadTurnCancellation(f.local.db, f.workspace.id, intentId, f.owner)
        expect(await cancelRequestedAt(f, intentId)).not.toBeNull()
        const [fenced] = await f.local.db
          .select({
            fencedAt: schema.leadTurnIntents.rollbackFencedAt,
            actorRef: schema.leadTurnIntents.rollbackFenceActorRef,
          })
          .from(schema.leadTurnIntents)
          .where(eq(schema.leadTurnIntents.id, intentId))
        expect(fenced!.fencedAt?.toISOString()).toBe(fence.attribution.fencedAt)
        expect(fenced!.actorRef).toBe(f.owner.userId)
      } finally {
        await f.local.close()
      }
    }
  )

  T(
    'group cancellation: an archived group admission is denied at the cancel authority, and nothing is recorded',
    async () => {
      const f = await isolatedFixture()
      try {
        const { channelId, intentId } = await groupLeadAdmission(f, f.owner)
        await bindGroupAttempt(f, intentId, f.owner)
        const [channel] = await f.local.db
          .select({ version: schema.channels.version })
          .from(schema.channels)
          .where(eq(schema.channels.id, channelId))
        await archiveChannel(f.local.db, f.workspace.id, channelId, f.owner, channel!.version)
        await expect(
          resolveLeadTurnAuthority(f.local.db, f.workspace.id, intentId, f.owner, 'cancel')
        ).rejects.toThrow('Lead turn unavailable')
        await expect(
          requestLeadTurnCancellation(f.local.db, f.workspace.id, intentId, f.owner)
        ).rejects.toThrow('Lead turn unavailable')
        expect(await cancelRequestedAt(f, intentId)).toBeNull()
      } finally {
        await f.local.close()
      }
    }
  )

  T(
    'group cancellation: an archived group refuses a repeat cancel and keeps the request recorded before archiving',
    async () => {
      const f = await isolatedFixture()
      try {
        const { channelId, intentId } = await groupLeadAdmission(f, f.owner)
        await bindGroupAttempt(f, intentId, f.owner)
        await requestLeadTurnCancellation(f.local.db, f.workspace.id, intentId, f.owner)
        const recorded = await cancelRequestedAt(f, intentId)
        expect(recorded).not.toBeNull()
        await archiveGroup(f, channelId)
        await expect(
          requestLeadTurnCancellation(f.local.db, f.workspace.id, intentId, f.owner)
        ).rejects.toThrow('Lead turn unavailable')
        expect(await cancelRequestedAt(f, intentId)).toEqual(recorded)
      } finally {
        await f.local.close()
      }
    }
  )

  T(
    'group cancellation: an archived group refuses a non-holder participant, and the binding is kept',
    async () => {
      const f = await isolatedFixture()
      try {
        const { channelId, intentId } = await groupLeadAdmission(f, f.owner)
        await bindGroupAttempt(f, intentId, f.owner)
        await archiveGroup(f, channelId)
        await expect(
          requestLeadTurnCancellation(f.local.db, f.workspace.id, intentId, f.member)
        ).rejects.toThrow('Lead turn unavailable')
        await expect(
          resolveLeadTurnAuthority(f.local.db, f.workspace.id, intentId, f.member, 'cancel')
        ).rejects.toThrow('Lead turn unavailable')
        expect(await cancelRequestedAt(f, intentId)).toBeNull()
        const [binding] = await f.local.db
          .select({ dispatchId: schema.leadTurnRuntime.dispatchId })
          .from(schema.leadTurnRuntime)
          .where(eq(schema.leadTurnRuntime.intentId, intentId))
        expect(binding?.dispatchId).not.toBeNull()
      } finally {
        await f.local.close()
      }
    }
  )

  T(
    'group binding: the claim holder records the canonical dispatch, and cancellation then records the request',
    async () => {
      const f = await isolatedFixture()
      try {
        const { intentId } = await groupLeadAdmission(f, f.owner)
        const dispatchId = await bindGroupAttempt(f, intentId, f.owner)
        expect(await dispatchIdOf(f, intentId)).toBe(dispatchId)
        await requestLeadTurnCancellation(f.local.db, f.workspace.id, intentId, f.owner)
        expect(await cancelRequestedAt(f, intentId)).not.toBeNull()
      } finally {
        await f.local.close()
      }
    }
  )

  T(
    'group binding: a participant who is not the claim holder cannot record the dispatch, and nothing is bound',
    async () => {
      const f = await isolatedFixture()
      try {
        const { intentId } = await groupLeadAdmission(f, f.owner)
        const ids = await prepareGroupAttempt(f, intentId, f.owner)
        await expect(
          observeLeadTurnRuntime(f.local.db, f.workspace.id, intentId, f.member, {
            attemptId: ids.attemptId,
            dispatchId: ids.dispatchId,
            executionId: ids.executionId,
            intentId,
            observedAt: NOW,
            runtimeSessionId: ids.runtimeSessionId,
            state: 'running',
          })
        ).rejects.toThrow('Lead turn unavailable')
        expect(await dispatchIdOf(f, intentId)).toBeNull()
      } finally {
        await f.local.close()
      }
    }
  )

  T(
    'group binding: a revoked audience grant stops the claim holder from cancelling, and the bound dispatch is kept',
    async () => {
      const f = await isolatedFixture()
      try {
        const { channelId, intentId } = await groupLeadAdmission(f, f.owner)
        const dispatchId = await bindGroupAttempt(f, intentId, f.owner)
        await revokeGroupGrant(f.local.db, f.workspace.id, channelId, f.owner, {
          grantId: 'gra_person_0',
          kind: 'audience',
          revokedAt: LATER,
        })
        await expect(
          requestLeadTurnCancellation(f.local.db, f.workspace.id, intentId, f.owner)
        ).rejects.toThrow('Lead turn unavailable')
        expect(await cancelRequestedAt(f, intentId)).toBeNull()
        expect(await dispatchIdOf(f, intentId)).toBe(dispatchId)
      } finally {
        await f.local.close()
      }
    }
  )

  T(
    'group binding: a claim holder who loses workspace membership cannot cancel, and the bound dispatch is kept',
    async () => {
      const f = await isolatedFixture()
      try {
        const admin = (
          await createTemporaryUserSession(f.local.db, {
            credentialDigest: `admin-${crypto.randomUUID()}`,
            expiresAt: new Date(Date.now() + 60_000),
          })
        ).principal
        await addWorkspaceMembership(f.local.db, f.workspace.id, admin, 'admin')
        const { intentId } = await groupLeadAdmission(f, admin, [admin])
        const dispatchId = await bindGroupAttempt(f, intentId, admin)
        await f.local.db
          .delete(schema.workspaceMemberships)
          .where(
            and(
              eq(schema.workspaceMemberships.workspaceId, f.workspace.id),
              eq(schema.workspaceMemberships.userId, admin.userId)
            )
          )
        await expect(
          requestLeadTurnCancellation(f.local.db, f.workspace.id, intentId, admin)
        ).rejects.toThrow('Lead turn unavailable')
        expect(await cancelRequestedAt(f, intentId)).toBeNull()
        expect(await dispatchIdOf(f, intentId)).toBe(dispatchId)
      } finally {
        await f.local.close()
      }
    }
  )

  T(
    'group binding: an archived group refuses a dispatch binding by the claim holder, and nothing is recorded',
    async () => {
      const f = await isolatedFixture()
      try {
        const { channelId, intentId } = await groupLeadAdmission(f, f.owner)
        const ids = await prepareGroupAttempt(f, intentId, f.owner)
        await archiveGroup(f, channelId)
        await expect(
          observeLeadTurnRuntime(f.local.db, f.workspace.id, intentId, f.owner, {
            attemptId: ids.attemptId,
            dispatchId: ids.dispatchId,
            executionId: ids.executionId,
            intentId,
            observedAt: NOW,
            runtimeSessionId: ids.runtimeSessionId,
            state: 'running',
          })
        ).rejects.toThrow('Lead turn unavailable')
        expect(await dispatchIdOf(f, intentId)).toBeNull()
        expect(await cancelRequestedAt(f, intentId)).toBeNull()
      } finally {
        await f.local.close()
      }
    }
  )

  T(
    'group read purposes: a mutation purpose reads a bound group only for its claim holder, and archiving denies both',
    async () => {
      const f = await isolatedFixture()
      try {
        const { channelId, intentId } = await groupLeadAdmission(f, f.owner)
        const dispatchId = await bindGroupAttempt(f, intentId, f.owner)
        for (const purpose of ['cancel', 'effect'] as const) {
          const row = await readLeadTurnRuntime(
            f.local.db,
            f.workspace.id,
            intentId,
            f.owner,
            purpose
          )
          expect(row?.dispatchId).toBe(dispatchId)
          await expect(
            readLeadTurnRuntime(f.local.db, f.workspace.id, intentId, f.member, purpose)
          ).rejects.toThrow('Lead turn unavailable')
        }
        await expect(
          readLeadTurnRuntime(f.local.db, f.workspace.id, intentId, f.member)
        ).rejects.toThrow('Lead turn unavailable')
        await archiveGroup(f, channelId)
        for (const purpose of ['cancel', 'effect'] as const) {
          await expect(
            readLeadTurnRuntime(f.local.db, f.workspace.id, intentId, f.owner, purpose)
          ).rejects.toThrow('Lead turn unavailable')
        }
      } finally {
        await f.local.close()
      }
    }
  )

  T(
    'group read regression: historical read APIs refuse an active group admission before and after binding, for its claim holder and a participant',
    async () => {
      const f = await isolatedFixture()
      try {
        const { channelId, intentId } = await groupLeadAdmission(f, f.owner)
        const [intent] = await f.local.db
          .select({ messageId: schema.leadTurnIntents.messageId })
          .from(schema.leadTurnIntents)
          .where(eq(schema.leadTurnIntents.id, intentId))
        const refuseReads = async () => {
          for (const who of [f.owner, f.member]) {
            await expect(
              getLeadTurnForUser(f.local.db, f.workspace.id, intent!.messageId, who)
            ).rejects.toThrow('Lead turn unavailable')
            await expect(
              getLatestLeadTurnForChannel(f.local.db, f.workspace.id, channelId, who)
            ).rejects.toThrow('Lead turn unavailable')
            await expect(
              resolveLeadTurnAuthority(f.local.db, f.workspace.id, intentId, who)
            ).rejects.toThrow('Lead turn unavailable')
            await expect(
              readLeadTurnRuntime(f.local.db, f.workspace.id, intentId, who)
            ).rejects.toThrow('Lead turn unavailable')
            await expect(
              readLeadTurnRollbackState(f.local.db, f.workspace.id, intentId, who)
            ).rejects.toThrow('Lead turn unavailable')
          }
        }
        await refuseReads()
        await bindGroupAttempt(f, intentId, f.owner)
        await refuseReads()
      } finally {
        await f.local.close()
      }
    }
  )
})
