import { describe, expect, test } from 'bun:test'
import { ApiClientError } from '@adea-ai/api-client'
import type {
  AgentSummary,
  GroupAgentEnlistmentGrant,
  GroupAudienceGrant,
  WorkspaceMemberSummary,
  WorkspaceSummary,
} from '@adea-ai/types'

import {
  agentKey,
  applyDraft,
  audienceChoices,
  canManageGroup,
  checkIssuedGrants,
  describeAgents,
  describeHumans,
  emptyDraft,
  grantRequest,
  groupFailure,
  groupFingerprint,
  GroupGrantUnavailableError,
  humanKey,
  nextAttempt,
  participantLabel,
  rebaseDraft,
  reconcileSelection,
  rosterChange,
  runGroupSave,
  StaleSaveError,
  selectedChoices,
  toggleSelection,
} from '../../src/group-audience-model'

const acme = '11111111-0000-4000-8000-0000000000a1'
const globex = '22222222-0000-4000-8000-0000000000b2'
const group = '33333333-0000-4000-8000-0000000000c3'
const userA = '44444444-0000-4000-8000-0000000000d1'
const userB = '44444444-0000-4000-8000-0000000000d2'
const me = '44444444-0000-4000-8000-0000000000d9'
const ariaAcme = '55555555-0000-4000-8000-0000000000e1'
const ariaGlobex = '55555555-0000-4000-8000-0000000000e2'
const ariaAcmeTwin = '55555555-0000-4000-8000-0000000000e3'
const now = '2026-10-15T12:00:00.000Z'

const agent = (id: string, workspaceId: string, name = 'Aria', lifecycleState = 'active') =>
  ({
    createdAt: now,
    id,
    lifecycleState,
    name,
    presentationMetadata: {},
    profile: { id: 'p', state: 'available', version: '1' },
    updatedAt: now,
    workspaceId,
  }) as AgentSummary
const workspaces: WorkspaceSummary[] = [
  { id: acme, name: 'Acme' } as WorkspaceSummary,
  { id: globex, name: 'Globex' } as WorkspaceSummary,
]
const members: WorkspaceMemberSummary[] = [
  { displayName: 'Alex', role: 'member', userId: userA },
  { displayName: 'Alex', role: 'admin', userId: userB },
  { displayName: 'Me', role: 'owner', userId: me },
]
const choices = audienceChoices({
  agents: [
    agent(ariaAcme, acme),
    agent(ariaGlobex, globex),
    agent(ariaAcmeTwin, acme),
    agent('55555555-0000-4000-8000-0000000000e4', acme, 'Old', 'archived'),
  ],
  excludeUserId: me,
  members,
  workspaces,
})

describe('audience choices', () => {
  test('list only the tenant’s active Agents and members other than the person asking', () => {
    expect(choices.humans.map(({ userId }) => userId)).toEqual([userA, userB])
    expect(choices.agents.map(({ agentId }) => agentId)).toEqual([
      ariaAcme,
      ariaGlobex,
      ariaAcmeTwin,
    ])
  })

  test('same-named people read differently by role and short id', () => {
    const labels = describeHumans(choices.humans).map(({ label }) => label)
    expect(new Set(labels).size).toBe(2)
    expect(labels[0]).toContain('Member')
    expect(labels[1]).toContain('Admin')
  })

  test('same-named Agents are told apart by workspace, and by short id when the workspace is the same', () => {
    const labels = describeAgents(choices.agents).map(({ label }) => label)
    expect(new Set(labels).size).toBe(3)
    expect(labels[1]).toBe('Aria · Globex')
    expect(labels[0]).toBe(`Aria · Acme · Agent ${ariaAcme}`)
    expect(labels[2]).toContain('Agent 55555555')
    expect(describeAgents(choices.agents)[0]!.label).not.toBe(
      describeAgents(choices.agents)[2]!.label
    )
  })

  test('an unnamed member keeps a short id so two never look the same', () => {
    const unnamed = audienceChoices({
      agents: [],
      members: [
        { displayName: null, role: 'member', userId: userA },
        { displayName: null, role: 'member', userId: userB },
      ],
      workspaces,
    })
    const labels = describeHumans(unnamed.humans).map(({ label }) => label)
    expect(new Set(labels).size).toBe(2)
  })

  test('a participant is named by identity: the person asking is You, strangers keep a short id', () => {
    expect(participantLabel({ kind: 'user', userId: me }, choices, me)).toBe('You')
    expect(participantLabel({ kind: 'user', userId: 'zzzz-unknown' }, choices, me)).toContain(
      'Member zzzzunkn'
    )
    expect(participantLabel({ agentId: ariaGlobex, kind: 'agent' }, choices)).toBe('Aria · Globex')
    expect(participantLabel({ agentId: 'ffff0000-unknown', kind: 'agent' }, choices)).toContain(
      'Another workspace'
    )
  })

  test('manage can read the person asking only from the workspace’s own member list', () => {
    expect(canManageGroup(members, me)).toBe(true)
    expect(canManageGroup(members, userA)).toBe(false)
    expect(canManageGroup(members, 'stranger')).toBe(false)
    expect(canManageGroup(members, undefined)).toBe(false)
  })
})

describe('selection', () => {
  test('keeps what is still offered and names what is not', () => {
    const next = audienceChoices({
      agents: [agent(ariaGlobex, globex)],
      excludeUserId: me,
      members: [members[0]!],
      workspaces,
    })
    const result = reconcileSelection(
      [humanKey(userA), humanKey(userB), agentKey(ariaAcme), agentKey(ariaGlobex)],
      choices,
      next
    )
    expect(result.kept).toEqual([humanKey(userA), agentKey(ariaGlobex)])
    expect(result.dropped).toHaveLength(2)
    expect(result.dropped[0]).toContain('Admin')
    expect(result.dropped[1]).toContain('Aria')
  })

  test('a switch to a list that does not offer the choice drops it even if the name matches', () => {
    const other = audienceChoices({
      agents: [agent('99999999-0000-4000-8000-000000000001', globex, 'Aria')],
      members: [],
      workspaces,
    })
    expect(reconcileSelection([agentKey(ariaGlobex)], choices, other).kept).toEqual([])
  })

  test('toggle adds then removes by key', () => {
    expect(toggleSelection(toggleSelection([], 'a'), 'a')).toEqual([])
  })
})

describe('grant request and issued grants', () => {
  const selection = selectedChoices([humanKey(userA), agentKey(ariaGlobex)], choices)
  const request = grantRequest({ ...selection, groupId: group, workspaceId: acme })
  const audience = (overrides: Partial<GroupAudienceGrant> = {}): GroupAudienceGrant => ({
    expiresAt: null,
    grantId: 'g-user',
    groupId: group,
    issuedAt: now,
    participant: { kind: 'user', userId: userA },
    revision: 1,
    revokedAt: null,
    ...overrides,
  })
  const enlistment = (
    overrides: Partial<GroupAgentEnlistmentGrant> = {}
  ): GroupAgentEnlistmentGrant => ({
    agent: { agentId: ariaGlobex, workspaceId: globex },
    expiresAt: null,
    grantId: 'g-agent',
    groupId: group,
    issuedAt: now,
    revision: 1,
    revokedAt: null,
    ...overrides,
  })

  test('a request carries identities only: never a grant id, revision or window', () => {
    expect(request).toEqual({
      agents: [{ agentId: ariaGlobex, workspaceId: globex }],
      groupId: group,
      humans: [userA],
      workspaceId: acme,
    })
  })

  test('accepts exactly the grants asked for', () => {
    const issued = { audienceGrants: [audience()], enlistmentGrants: [enlistment()] }
    expect(checkIssuedGrants(request, issued)).toEqual({ grants: issued, ok: true })
  })

  test.each([
    [
      'a grant for another group',
      { audienceGrants: [audience({ groupId: 'other' })], enlistmentGrants: [enlistment()] },
    ],
    [
      'a grant for someone who was not asked for',
      {
        audienceGrants: [audience({ participant: { kind: 'user', userId: userB } })],
        enlistmentGrants: [enlistment()],
      },
    ],
    [
      'an Agent grant for the same name in another workspace',
      {
        audienceGrants: [audience()],
        enlistmentGrants: [enlistment({ agent: { agentId: ariaGlobex, workspaceId: acme } })],
      },
    ],
    [
      'an already revoked grant',
      { audienceGrants: [audience({ revokedAt: now })], enlistmentGrants: [enlistment()] },
    ],
    ['a missing grant', { audienceGrants: [], enlistmentGrants: [enlistment()] }],
    [
      'an extra grant',
      {
        audienceGrants: [audience(), audience({ participant: { kind: 'user', userId: userB } })],
        enlistmentGrants: [enlistment()],
      },
    ],
    [
      'a duplicated grant',
      { audienceGrants: [audience()], enlistmentGrants: [enlistment(), enlistment()] },
    ],
  ])('refuses %s', (_name, issued) => {
    expect(checkIssuedGrants(request, issued).ok).toBe(false)
  })

  test('refuses a malformed answer', () => {
    expect(checkIssuedGrants(request, undefined as never).ok).toBe(false)
    expect(checkIssuedGrants(request, {} as never).ok).toBe(false)
  })
})

const counter = () => {
  let count = 0
  return () => `id-${++count}`
}

describe('attempts', () => {
  const ids = counter

  test('an unchanged request replays the same identity, so a retry cannot make a second group', () => {
    const newId = ids()
    const fingerprint = groupFingerprint('Launch', ['b', 'a'])
    const first = nextAttempt(null, fingerprint, newId)
    expect(nextAttempt(first, groupFingerprint(' Launch ', ['a', 'b']), newId)).toBe(first)
  })

  test('any change is a new request with a new identity', () => {
    const newId = ids()
    const first = nextAttempt(null, groupFingerprint('Launch', ['a']), newId)
    const second = nextAttempt(first, groupFingerprint('Launch', ['a', 'b']), newId)
    expect(second.channelId).not.toBe(first.channelId)
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey)
    expect(second.grants).toBeNull()
  })
})

describe('failures', () => {
  test('a stale version while managing keeps the changes and nothing was changed', () => {
    const failure = groupFailure(
      new ApiClientError('Channel version conflict', 409, 'conversation_conflict'),
      'manage'
    )
    expect(failure.kind).toBe('conflict')
    expect(failure.ambiguous).toBe(false)
    expect(failure.text).toContain('Your changes are kept')
  })

  test('a 404 is the uniform unavailable answer: revoked access or a wrong workspace, nothing else is said', () => {
    for (const operation of ['create', 'manage'] as const) {
      const failure = groupFailure(
        new ApiClientError('Workspace unavailable', 404, 'workspace_unavailable'),
        operation
      )
      expect(failure.kind).toBe('unavailable')
      expect(failure.retrySame).toBe(false)
      expect(failure.text).toContain('Nothing was changed')
    }
  })

  test('signed out is its own answer', () => {
    expect(
      groupFailure(new ApiClientError('x', 401, 'workspace_unavailable'), 'create').text
    ).toContain('signed out')
  })

  test('refused participants are named by identity, not by position', () => {
    const failure = groupFailure(
      new ApiClientError('rejected', 400, 'group_grant_rejected', undefined, [
        { participant: { kind: 'user', userId: userA }, reason: 'grant_revoked' },
        { participant: { agentId: ariaGlobex, kind: 'agent' }, reason: 'agent_inactive' },
        { reason: 'audience_requires_human' },
        { participant: { kind: 'user', userId: userB }, reason: 'a_reason_from_the_future' },
      ]),
      'create'
    )
    expect(failure.kind).toBe('rejected')
    expect(failure.perParticipant[humanKey(userA)]).toBe(
      'The grant for this participant was withdrawn.'
    )
    expect(failure.perParticipant[agentKey(ariaGlobex)]).toBe(
      'This Agent is not active, so it cannot join.'
    )
    expect(failure.perParticipant[humanKey(userB)]).toBe('The server refused this participant.')
    expect(failure.text).toContain('no group was created')
    expect(failure.text).toContain('at least one person')
    expect(failure.retrySame).toBe(false)
  })

  test('a lost response or a server error is ambiguous, and only an identical retry is safe', () => {
    for (const error of [new TypeError('Failed to fetch'), new ApiClientError('x', 503)]) {
      const failure = groupFailure(error, 'create')
      expect(failure.ambiguous).toBe(true)
      expect(failure.retrySame).toBe(true)
      expect(failure.text).toContain('not known whether')
    }
  })

  test('an issuer that cannot answer means nothing was sent', () => {
    const failure = groupFailure(new GroupGrantUnavailableError(new Error('boom')), 'create')
    expect(failure.kind).toBe('issuer')
    expect(failure.ambiguous).toBe(false)
    expect(
      groupFailure(new GroupGrantUnavailableError(new ApiClientError('x', 404)), 'create').kind
    ).toBe('unavailable')
  })

  test('an idempotency conflict while creating is not a version conflict', () => {
    expect(
      groupFailure(new ApiClientError('Channel idempotency conflict', 409), 'create').text
    ).toContain('different details')
  })
})

describe('saving', () => {
  test('an answer that arrives after the workspace or account changed is dropped', async () => {
    let context = 'acme|me'
    const saved = await runGroupSave({
      context: () => context,
      operation: 'create',
      send: async () => {
        context = 'globex|me'
        return 'created'
      },
    })
    expect(saved).toEqual({ status: 'ignored' })
    context = 'acme|me'
    const failed = await runGroupSave({
      context: () => context,
      operation: 'create',
      send: async () => {
        context = 'acme|someone-else'
        throw new ApiClientError('x', 404)
      },
    })
    expect(failed).toEqual({ status: 'ignored' })
  })

  test('a send that finds the screen gone after waiting stops before anything is changed', async () => {
    let token = 'acme|me#0'
    let sent = 0
    const outcome = await runGroupSave({
      context: () => token,
      operation: 'create',
      send: async (stillHere) => {
        token = 'acme|me#1'
        if (!stillHere()) throw new StaleSaveError()
        sent += 1
        return 'created'
      },
    })
    expect(outcome).toEqual({ status: 'ignored' })
    expect(sent).toBe(0)
  })

  test('coming back to where a save started does not make its answer current again', async () => {
    let generation = 0
    const outcome = await runGroupSave({
      context: () => `acme|me#${generation}`,
      operation: 'manage',
      send: async () => {
        generation += 1
        return 'saved'
      },
    })
    expect(outcome).toEqual({ status: 'ignored' })
  })

  test('a stale-save error is never shown as a failure', async () => {
    const outcome = await runGroupSave({
      context: () => 'same',
      operation: 'create',
      send: async () => {
        throw new StaleSaveError()
      },
    })
    expect(outcome).toEqual({ status: 'ignored' })
  })

  test('a normal answer is returned as received', async () => {
    expect(
      await runGroupSave({ context: () => 'a', operation: 'manage', send: async () => 7 })
    ).toEqual({
      status: 'saved',
      value: 7,
    })
  })
})

describe('roster drafts', () => {
  const roster = [
    { kind: 'user' as const, userId: me },
    { kind: 'user' as const, userId: userA },
    { agentId: ariaAcme, kind: 'agent' as const },
  ]
  const all = audienceChoices({
    agents: [agent(ariaAcme, acme), agent(ariaGlobex, globex)],
    members,
    workspaces,
  })

  test('applies removals and additions against the roster, once each', () => {
    const next = applyDraft(
      roster,
      {
        add: [humanKey(userB), agentKey(ariaGlobex), humanKey(userA)],
        remove: [agentKey(ariaAcme)],
      },
      all
    )
    expect(next).toEqual([
      { kind: 'user', userId: me },
      { kind: 'user', userId: userA },
      { kind: 'user', userId: userB },
      { agentId: ariaGlobex, kind: 'agent' },
    ])
  })

  test('a roster that moved re-bases the draft and drops what someone else already did', () => {
    const draft = { add: [humanKey(userB), agentKey(ariaGlobex)], remove: [humanKey(userA)] }
    const moved = [
      { kind: 'user' as const, userId: me },
      { kind: 'user' as const, userId: userB },
    ]
    const rebased = rebaseDraft(draft, moved, all)
    expect(rebased.draft).toEqual({ add: [agentKey(ariaGlobex)], remove: [] })
    expect(rebased.droppedAdds).toBe(0)
    expect(rosterChange(roster, moved, draft)).toEqual({
      joined: [humanKey(userB)],
      left: [humanKey(userA), agentKey(ariaAcme)],
      satisfied: [humanKey(userB), humanKey(userA)],
    })
  })

  test('an addition whose choice vanished is dropped and counted, never sent', () => {
    const rebased = rebaseDraft(
      { add: [agentKey(ariaGlobex)], remove: [] },
      roster,
      audienceChoices({ agents: [], members, workspaces })
    )
    expect(rebased.draft).toEqual(emptyDraft)
    expect(rebased.droppedAdds).toBe(1)
  })
})
