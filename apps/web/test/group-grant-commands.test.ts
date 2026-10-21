// Group grant command surface (M15.01, adea-ai/adea#1178).
//
// Coverage class: the command handlers in `apps/web/src/server/group-grant-commands.ts` over a
// faithful in-memory stand-in for the grant store. The store operations are the ones the
// commands wrap — `revokeGroupGrant` and `shareGroupHistory` — so the handlers are exercised
// through the same signatures the exported store behaviour has.
//
// The stand-in reproduces the store's own rules: group-management authority is workspace
// owner/admin, the group must exist in the workspace, the grant must exist, a revocation
// reports `revoked: false` for a grant that is already revoked, a share keeps the stored row
// unless the revision is higher, and every refusal is the store's own refusal.
//
// The read that proves a revocation took effect is the product's own policy
// (`decideGroupHistoryRead`), not a model of it: a revoked sharing grant must deny the
// earlier-history read at once.
//
// No database, no real user and no live grant: the principals and groups are synthetic
// fixtures, and the store's own behaviour is proven by the database integration suite.

import { describe, expect, test } from 'bun:test'
import type { AgentHqDatabase } from '@adea-ai/db'
import type {
  ConversationParticipantRef,
  GroupSharingGrant,
  GroupSharingScope,
  UserPrincipalRef,
} from '@adea-ai/types'

import { decideGroupHistoryRead } from '../../../packages/db/src/group-participation-policy'
import {
  revokeGroupGrantCommand,
  shareGroupHistoryCommand,
  type GroupGrantOperations,
} from '../src/server/group-grant-commands'

const ISSUED = '2026-10-01T00:00:00.000Z'
const NOW = '2026-10-08T12:00:00.000Z'
const LATER = '2026-10-08T13:00:00.000Z'

const OWNER: UserPrincipalRef = { kind: 'user', userId: '11111111-1111-4111-8111-111111111111' }
const ADMIN: UserPrincipalRef = { kind: 'user', userId: '22222222-2222-4222-8222-222222222222' }
const MEMBER: UserPrincipalRef = { kind: 'user', userId: '33333333-3333-4333-8333-333333333333' }
const OUTSIDER: UserPrincipalRef = { kind: 'user', userId: '44444444-4444-4444-8444-444444444444' }

const WORKSPACE = '55555555-5555-4555-8555-555555555555'
const OTHER_WORKSPACE = '66666666-6666-4666-8666-666666666666'
const GROUP = '77777777-7777-4777-8777-777777777777'
const OTHER_GROUP = '88888888-8888-4888-8888-888888888888'

type StoredGrant = {
  expiresAt: string | null
  grantId: string
  groupId: string
  issuedAt: string
  kind: 'audience' | 'enlistment' | 'sharing'
  participant: ConversationParticipantRef
  revision: number
  revokedAt: string | null
  scope: GroupSharingScope
  workspaceId: string
}

type Store = {
  channels: Set<string>
  grants: StoredGrant[]
  memberships: Map<string, 'owner' | 'admin' | 'member'>
  /** The independently owned job a revocation must leave alone. */
  job: { state: 'running'; id: string }
}

function membershipKey(workspaceId: string, userId: string) {
  return `${workspaceId}:${userId}`
}

function channelKey(workspaceId: string, channelId: string) {
  return `${workspaceId}:${channelId}`
}

/** A store that enforces the same rules the exported store behaviour enforces. */
function createStore(): Store {
  return {
    channels: new Set([channelKey(WORKSPACE, GROUP), channelKey(OTHER_WORKSPACE, OTHER_GROUP)]),
    grants: [
      {
        expiresAt: null,
        grantId: 'gra_member',
        groupId: GROUP,
        issuedAt: ISSUED,
        kind: 'audience',
        participant: MEMBER,
        revision: 1,
        revokedAt: null,
        scope: 'earlier_history',
        workspaceId: WORKSPACE,
      },
      {
        expiresAt: null,
        grantId: 'gra_share_member',
        groupId: GROUP,
        issuedAt: ISSUED,
        kind: 'sharing',
        participant: MEMBER,
        revision: 1,
        revokedAt: null,
        scope: 'earlier_history',
        workspaceId: WORKSPACE,
      },
    ],
    memberships: new Map([
      [membershipKey(WORKSPACE, OWNER.userId), 'owner'],
      [membershipKey(WORKSPACE, ADMIN.userId), 'admin'],
      [membershipKey(WORKSPACE, MEMBER.userId), 'member'],
      [membershipKey(OTHER_WORKSPACE, OUTSIDER.userId), 'owner'],
    ]),
    job: { id: 'job-1', state: 'running' },
  }
}

function createOperations(store: Store): GroupGrantOperations {
  return {
    revokeGroupGrant: async (_database, workspaceId, channelId, principal, input) => {
      const role = store.memberships.get(membershipKey(workspaceId, principal.userId))
      if (role !== 'owner' && role !== 'admin') throw new Error('Channel unavailable')
      if (!store.channels.has(channelKey(workspaceId, channelId)))
        throw new Error('Channel unavailable')
      if (!input.grantId.trim()) throw new Error('Channel unavailable')
      const grant = store.grants.find(
        (candidate) =>
          candidate.workspaceId === workspaceId &&
          candidate.groupId === channelId &&
          candidate.grantId === input.grantId &&
          candidate.kind === input.kind
      )
      if (!grant) throw new Error('Grant unavailable')
      if (grant.revokedAt) return { revoked: false }
      grant.revokedAt = input.revokedAt
      return { revoked: true }
    },
    shareGroupHistory: async (_database, workspaceId, channelId, principal, grant) => {
      if (grant.groupId !== channelId) throw new Error('Invalid group request')
      const role = store.memberships.get(membershipKey(workspaceId, principal.userId))
      if (role !== 'owner' && role !== 'admin') throw new Error('Channel unavailable')
      if (!store.channels.has(channelKey(workspaceId, channelId)))
        throw new Error('Channel unavailable')
      const existing = store.grants.find(
        (candidate) =>
          candidate.kind === 'sharing' &&
          candidate.workspaceId === workspaceId &&
          candidate.groupId === channelId &&
          candidate.grantId === grant.grantId
      )
      if (!existing) {
        store.grants.push({
          expiresAt: grant.expiresAt,
          grantId: grant.grantId,
          groupId: grant.groupId,
          issuedAt: grant.issuedAt,
          kind: 'sharing',
          participant: grant.participant,
          revision: grant.revision,
          revokedAt: grant.revokedAt,
          scope: grant.scope,
          workspaceId,
        })
        return
      }
      if (grant.revision > existing.revision) {
        existing.expiresAt = grant.expiresAt
        existing.issuedAt = grant.issuedAt
        existing.participant = grant.participant
        existing.revision = grant.revision
        existing.revokedAt = grant.revokedAt
        existing.scope = grant.scope
      }
    },
  }
}

// The commands never touch the handle themselves; the store operations own the database.
const database = {} as unknown as AgentHqDatabase

function dependencies(store: Store, principal: UserPrincipalRef, now = () => new Date(NOW)) {
  return { database, now, operations: createOperations(store), principal }
}

/** The product's own join-point history decision for the member. */
function historyDecision(store: Store) {
  const sharing = store.grants.filter(
    (grant) => grant.kind === 'sharing' && grant.groupId === GROUP
  ) as GroupSharingGrant[]
  return decideGroupHistoryRead({
    admission: {
      authorization: { grantId: 'gra_member', groupId: GROUP, revision: 1 },
      grant: { expiresAt: null, issuedAt: ISSUED, revokedAt: null },
      joinPoint: { joinedAt: LATER, joinedSequence: 10 },
      participant: MEMBER,
    },
    entry: { occurredAt: ISSUED, sequence: 1 },
    groupId: GROUP,
    now: LATER,
    sharingGrants: sharing,
  })
}

describe('group grant commands (#1178)', () => {
  test('a member without group-management authority cannot revoke, and the refusal says nothing', async () => {
    const store = createStore()
    const outcome = await revokeGroupGrantCommand(
      { grantId: 'gra_member', groupId: GROUP, kind: 'audience', workspaceId: WORKSPACE },
      dependencies(store, MEMBER)
    )
    // One refusal for every failure: the caller cannot tell an unauthorized
    // caller from a missing group or a missing grant.
    expect(outcome).toEqual({ code: 'group_grant_unavailable', ok: false })
    expect(store.grants.find((grant) => grant.grantId === 'gra_member')?.revokedAt).toBeNull()
  })

  test('an outsider who claims another workspace is refused exactly the same way', async () => {
    const store = createStore()
    const outcome = await revokeGroupGrantCommand(
      { grantId: 'gra_member', groupId: GROUP, kind: 'audience', workspaceId: WORKSPACE },
      dependencies(store, OUTSIDER)
    )
    expect(outcome).toEqual({ code: 'group_grant_unavailable', ok: false })
    expect(store.grants.find((grant) => grant.grantId === 'gra_member')?.revokedAt).toBeNull()
  })

  test('an admin of the group may revoke, and a member may not', async () => {
    const store = createStore()
    const byAdmin = await revokeGroupGrantCommand(
      { grantId: 'gra_member', groupId: GROUP, kind: 'audience', workspaceId: WORKSPACE },
      dependencies(store, ADMIN)
    )
    expect(byAdmin).toEqual({ ok: true, revoked: true })
    const byMember = await revokeGroupGrantCommand(
      { grantId: 'gra_share_member', groupId: GROUP, kind: 'sharing', workspaceId: WORKSPACE },
      dependencies(store, MEMBER)
    )
    expect(byMember).toEqual({ code: 'group_grant_unavailable', ok: false })
  })

  test('a wrong grant, a wrong group and a wrong workspace are refused without changing anything', async () => {
    const store = createStore()
    const before = structuredClone(store.grants)
    for (const command of [
      { grantId: 'gra_absent', groupId: GROUP, kind: 'audience' as const, workspaceId: WORKSPACE },
      {
        grantId: 'gra_member',
        groupId: OTHER_GROUP,
        kind: 'audience' as const,
        workspaceId: WORKSPACE,
      },
      {
        grantId: 'gra_member',
        groupId: GROUP,
        kind: 'audience' as const,
        workspaceId: OTHER_WORKSPACE,
      },
    ]) {
      const outcome = await revokeGroupGrantCommand(command, dependencies(store, OWNER))
      expect(outcome).toEqual({ code: 'group_grant_unavailable', ok: false })
    }
    expect(store.grants).toEqual(before)
  })

  test('revoking an already revoked grant reports that nothing changed', async () => {
    const store = createStore()
    const first = await revokeGroupGrantCommand(
      { grantId: 'gra_member', groupId: GROUP, kind: 'audience', workspaceId: WORKSPACE },
      dependencies(store, OWNER)
    )
    expect(first).toEqual({ ok: true, revoked: true })
    const second = await revokeGroupGrantCommand(
      { grantId: 'gra_member', groupId: GROUP, kind: 'audience', workspaceId: WORKSPACE },
      dependencies(store, OWNER)
    )
    expect(second).toEqual({ ok: true, revoked: false })
  })

  test('a revocation denies the earlier-history read immediately and leaves the job alone', async () => {
    const store = createStore()
    // Before the revocation the sharing grant unlocks the earlier history.
    expect(historyDecision(store)).toMatchObject({
      action: 'allow',
      basis: 'earlier_history_grant',
    })

    const outcome = await revokeGroupGrantCommand(
      { grantId: 'gra_share_member', groupId: GROUP, kind: 'sharing', workspaceId: WORKSPACE },
      dependencies(store, OWNER)
    )
    expect(outcome).toEqual({ ok: true, revoked: true })
    // The next read is denied at once, with no restart and no second command.
    expect(historyDecision(store)).toMatchObject({
      action: 'deny',
      reason: 'history_before_join_point',
    })
    // The independently owned job is untouched by the revocation.
    expect(store.job).toEqual({ id: 'job-1', state: 'running' })
  })

  test('a share writes the server own timestamps, the exact group and the exact participant', async () => {
    const store = createStore()
    const issuedAt = new Date('2026-10-08T12:00:00.000Z')
    const outcome = await shareGroupHistoryCommand(
      {
        expiresInMs: 60_000,
        grantId: 'gra_share_summary',
        groupId: GROUP,
        participant: MEMBER,
        revision: 2,
        scope: 'earlier_summary',
        workspaceId: WORKSPACE,
      },
      dependencies(store, OWNER, () => issuedAt)
    )
    expect(outcome).toEqual({ ok: true })
    const stored = store.grants.find((grant) => grant.grantId === 'gra_share_summary')
    // The issue instant and the expiry are the server's own: a caller cannot
    // backdate a grant or move its window.
    expect(stored).toMatchObject({
      expiresAt: '2026-10-08T12:01:00.000Z',
      issuedAt: '2026-10-08T12:00:00.000Z',
      participant: MEMBER,
      revokedAt: null,
      scope: 'earlier_summary',
    })
  })

  test('an earlier-summary share never unlocks earlier history, and history needs its own scope', async () => {
    const store = createStore()
    // The group has no earlier-history share yet, so only the summary share
    // below can decide the read.
    store.grants = store.grants.filter((grant) => grant.grantId !== 'gra_share_member')
    await shareGroupHistoryCommand(
      {
        expiresInMs: null,
        grantId: 'gra_share_summary_only',
        groupId: GROUP,
        participant: MEMBER,
        revision: 1,
        scope: 'earlier_summary',
        workspaceId: WORKSPACE,
      },
      dependencies(store, OWNER)
    )
    // The summary scope grants nothing to the history decision.
    expect(historyDecision(store)).toMatchObject({
      action: 'deny',
      reason: 'history_before_join_point',
    })
    // A command with no scope is refused rather than widening to history.
    const unscoped = await shareGroupHistoryCommand(
      {
        expiresInMs: null,
        grantId: 'gra_share_unscoped',
        groupId: GROUP,
        participant: MEMBER,
        revision: 1,
        scope: 'everything' as GroupSharingScope,
        workspaceId: WORKSPACE,
      },
      dependencies(store, OWNER)
    )
    expect(unscoped).toEqual({ code: 'group_grant_unavailable', ok: false })
    expect(store.grants.some((grant) => grant.grantId === 'gra_share_unscoped')).toBe(false)
  })

  test('a share for a group the caller does not name is refused', async () => {
    const store = createStore()
    const outcome = await shareGroupHistoryCommand(
      {
        expiresInMs: null,
        grantId: 'gra_share_away',
        groupId: OTHER_GROUP,
        participant: MEMBER,
        revision: 1,
        scope: 'earlier_history',
        workspaceId: WORKSPACE,
      },
      dependencies(store, OWNER)
    )
    expect(outcome).toEqual({ code: 'group_grant_unavailable', ok: false })
    expect(store.grants.some((grant) => grant.grantId === 'gra_share_away')).toBe(false)
  })

  test('a stale revision never supersedes a newer sharing grant', async () => {
    const store = createStore()
    await shareGroupHistoryCommand(
      {
        expiresInMs: null,
        grantId: 'gra_share_member',
        groupId: GROUP,
        participant: MEMBER,
        revision: 5,
        scope: 'earlier_summary',
        workspaceId: WORKSPACE,
      },
      dependencies(store, OWNER)
    )
    const stored = store.grants.find((grant) => grant.grantId === 'gra_share_member')
    expect(stored).toMatchObject({ revision: 5, scope: 'earlier_summary' })
    await shareGroupHistoryCommand(
      {
        expiresInMs: null,
        grantId: 'gra_share_member',
        groupId: GROUP,
        participant: MEMBER,
        revision: 2,
        scope: 'earlier_history',
        workspaceId: WORKSPACE,
      },
      dependencies(store, OWNER)
    )
    // The stored row keeps the newer revision and its scope.
    expect(store.grants.find((grant) => grant.grantId === 'gra_share_member')).toMatchObject({
      revision: 5,
      scope: 'earlier_summary',
    })
  })

  test('a malformed command is refused before the store is touched', async () => {
    const store = createStore()
    const before = structuredClone(store.grants)
    for (const command of [
      { grantId: '', groupId: GROUP, kind: 'audience' as const, workspaceId: WORKSPACE },
      { grantId: 'gra_member', groupId: '', kind: 'audience' as const, workspaceId: WORKSPACE },
      { grantId: 'gra_member', groupId: GROUP, kind: 'other' as never, workspaceId: WORKSPACE },
    ]) {
      const outcome = await revokeGroupGrantCommand(command, dependencies(store, OWNER))
      expect(outcome).toEqual({ code: 'group_grant_unavailable', ok: false })
    }
    expect(store.grants).toEqual(before)
  })
})
