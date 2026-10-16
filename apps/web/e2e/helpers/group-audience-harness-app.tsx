import '../../src/start/globals.css'
import { ApiClientError } from '@adea-ai/api-client'
import type {
  AgentSummary,
  ChannelSummary,
  ConversationParticipantRef,
  GroupAgentEnlistmentGrant,
  GroupAudienceGrant,
  WorkspaceMemberSummary,
  WorkspaceSummary,
} from '@adea-ai/types'
import { Button } from '@adea-ai/ui/components/ui/button'
import { createMemo, createSignal, Show } from 'solid-js'
import { render } from 'solid-js/web'
import {
  CreateGroupDialog,
  GroupManageDialog,
  type GroupAudienceContext,
  type GroupCreateRequest,
  type GroupGrantIssuer,
  type GroupRosterSaveRequest,
} from '../../../../packages/workspace-ui/src/group-audience'

/**
 * The group-management dialogs over an in-page stand-in for the server and for the missing grant issuer.
 * Every identity here is synthetic. The stand-in keeps the rules the UI depends on: a repeated idempotency
 * key with the same payload answers the stored group, a different payload is refused, a roster write needs
 * the version it was drafted on, and grants must name the group they are sent for. It exposes switches the
 * browser test pulls: a lost response, a refusal, revoked access, a slow answer and a concurrent edit.
 */
export const harnessIds = {
  acme: '11111111-0000-4000-8000-0000000000a1',
  acmeTwin: 'c3d4e5f6-0000-4000-8000-0000000000e3',
  alexAdmin: '44444444-0000-4000-8000-0000000000d2',
  alexMember: '44444444-0000-4000-8000-0000000000d1',
  ariaAcme: '5a1c0e11-0000-4000-8000-0000000000e1',
  ariaGlobex: '9f20b7c4-0000-4000-8000-0000000000e2',
  existingGroup: '33333333-0000-4000-8000-0000000000c3',
  globex: '22222222-0000-4000-8000-0000000000b2',
  me: '44444444-0000-4000-8000-0000000000d9',
  otherGroup: '33333333-0000-4000-8000-0000000000c4',
  sam: '44444444-0000-4000-8000-0000000000d3',
} as const
const ids = harnessIds
const now = '2026-10-15T12:00:00.000Z'

const workspaces: WorkspaceSummary[] = [
  { id: ids.acme, name: 'Acme' } as WorkspaceSummary,
  { id: ids.globex, name: 'Globex' } as WorkspaceSummary,
]
const agent = (id: string, workspaceId: string): AgentSummary => ({
  createdAt: now,
  id,
  lifecycleState: 'active',
  name: 'Aria',
  presentationMetadata: {},
  profile: { id: 'aria', state: 'available', version: '1' },
  updatedAt: now,
  workspaceId,
})
const members = (role: WorkspaceMemberSummary['role'] = 'owner'): WorkspaceMemberSummary[] => [
  { displayName: 'Alex', role: 'member', userId: ids.alexMember },
  { displayName: 'Alex', role: 'admin', userId: ids.alexAdmin },
  { displayName: 'Sam', role: 'member', userId: ids.sam },
  { displayName: 'Morgan', role, userId: ids.me },
]

type CreateMode = 'hold' | 'lost' | 'ok' | 'rejected' | 'unavailable'
type IssuerMode = 'fail' | 'hold' | 'ok' | 'wrong-group' | 'wrong-agent-workspace'

export type AudienceHarness = {
  calls: {
    created: { channelId: string; idempotencyKey: string; title: string }[]
    issued: {
      agents: { agentId: string; workspaceId: string }[]
      groupId: string
      humans: string[]
    }[]
    saves: { expectedVersion: number; participants: ConversationParticipantRef[] }[]
    staleReads: number
  }
  /** Someone else adds Sam to the stored group: the server version moves under an open manage dialog. */
  concurrentEdit: () => void
  /** Removes a member from the tenant's list, as a membership revocation would. */
  dropMember: (userId: string) => void
  groups: () => { channelId: string; participants: ConversationParticipantRef[]; title: string }[]
  nextCreate: (mode: CreateMode) => void
  /** The next manage save is refused as a stale version without the page having been told. */
  nextSaveIsStale: () => void
  releaseCreate: () => void
  /** Lets a held issuer answer (see setIssuer('hold')). */
  releaseIssuer: () => void
  setIssuer: (mode: IssuerMode) => void
  setRole: (role: WorkspaceMemberSummary['role']) => void
  /** Moves the page to another workspace (`other`) or back, or to another account. */
  switchAccount: (userId: string) => void
  /** Moves the manage dialog to another group in the same workspace, or back. */
  switchGroup: (to: 'other' | 'original') => void
  switchWorkspace: (workspaceId: string) => void
}
declare global {
  interface Window {
    audienceHarness: AudienceHarness
  }
}

const [workspaceId, setWorkspaceId] = createSignal<string>(ids.acme)
const [currentUserId, setCurrentUserId] = createSignal<string>(ids.me)
const [memberRole, setMemberRole] = createSignal<WorkspaceMemberSummary['role']>('owner')
const [dropped, setDropped] = createSignal<readonly string[]>([])
const [channel, setChannel] = createSignal<ChannelSummary>({
  createdAt: now,
  id: ids.existingGroup,
  isPrimaryProjectChannel: false,
  kind: 'group',
  lifecycleState: 'active',
  participants: [
    { kind: 'user', userId: ids.me },
    { kind: 'user', userId: ids.alexMember },
    { agentId: ids.ariaAcme, kind: 'agent' },
  ],
  sortOrder: 1,
  title: 'Launch review',
  updatedAt: now,
  version: 4,
  visibility: 'participants',
  workspaceId: ids.acme,
})
// Earlier history exists in this group. Nothing in the dialogs may ever show it.
const EARLIER_SECRET = 'Q3 acquisition target is Initech'

const unavailable = () => new ApiClientError('Workspace unavailable', 404, 'workspace_unavailable')

function build() {
  const calls: AudienceHarness['calls'] = { created: [], issued: [], saves: [], staleReads: 0 }
  const stored = new Map<string, { channel: ChannelSummary; fingerprint: string }>()
  let createMode: CreateMode = 'ok'
  let issuerMode: IssuerMode = 'ok'
  let staleNext = false
  let gate: { promise: Promise<void>; release: () => void } | undefined
  let issuerGate: { promise: Promise<void>; release: () => void } | undefined
  let grantCount = 0

  const issueGrants: GroupGrantIssuer = async (request) => {
    calls.issued.push({
      agents: request.agents.map(({ agentId, workspaceId: home }) => ({
        agentId,
        workspaceId: home,
      })),
      groupId: request.groupId,
      humans: [...request.humans],
    })
    if (issuerMode === 'fail') throw new TypeError('issuer unreachable')
    if (issuerMode === 'hold') await issuerGate?.promise
    const groupId = issuerMode === 'wrong-group' ? 'some-other-group' : request.groupId
    const audienceGrants: GroupAudienceGrant[] = request.humans.map((userId) => ({
      expiresAt: null,
      grantId: `synthetic-${++grantCount}`,
      groupId,
      issuedAt: now,
      participant: { kind: 'user', userId },
      revision: 1,
      revokedAt: null,
    }))
    const enlistmentGrants: GroupAgentEnlistmentGrant[] = request.agents.map((identity) => ({
      agent:
        issuerMode === 'wrong-agent-workspace'
          ? { agentId: identity.agentId, workspaceId: ids.acme }
          : identity,
      expiresAt: null,
      grantId: `synthetic-${++grantCount}`,
      groupId,
      issuedAt: now,
      revision: 1,
      revokedAt: null,
    }))
    return { audienceGrants, enlistmentGrants }
  }

  const onCreate = async (_title: string, request?: GroupCreateRequest) => {
    if (!request) throw new Error('The dialog always names its request')
    calls.created.push({
      channelId: request.channelId,
      idempotencyKey: request.idempotencyKey,
      title: request.title,
    })
    if (createMode === 'hold') await gate?.promise
    if (createMode === 'unavailable') throw unavailable()
    if (createMode === 'rejected') {
      createMode = 'ok'
      throw new ApiClientError('rejected', 400, 'group_grant_rejected', undefined, [
        {
          participant: { kind: 'user', userId: ids.alexAdmin },
          reason: 'grant_revoked',
        },
      ])
    }
    // The server's own rule: grants must name the group they were sent for.
    const wrong = [...request.audienceGrants, ...request.enlistmentGrants].some(
      (grant) => grant.groupId !== request.channelId
    )
    if (wrong) throw new ApiClientError('Invalid request', 400, 'invalid_request')
    const participants: ConversationParticipantRef[] = [
      { kind: 'user', userId: currentUserId() },
      ...request.audienceGrants.map(({ participant }) => participant),
      ...request.enlistmentGrants.map(({ agent: enlisted }) => ({
        agentId: enlisted.agentId,
        kind: 'agent' as const,
      })),
    ]
    const fingerprint = JSON.stringify([
      request.title,
      participants.map((p) => JSON.stringify(p)).toSorted(),
    ])
    const prior = stored.get(request.idempotencyKey)
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new ApiClientError('Channel idempotency conflict', 409, 'conversation_conflict')
    } else {
      stored.set(request.idempotencyKey, {
        channel: {
          ...channel(),
          id: request.channelId,
          participants,
          title: request.title,
          version: 1,
          workspaceId: workspaceId(),
        },
        fingerprint,
      })
    }
    if (createMode === 'lost') {
      createMode = 'ok'
      throw new TypeError('Failed to fetch')
    }
    return stored.get(request.idempotencyKey)!.channel
  }

  const onSave = async (request: GroupRosterSaveRequest) => {
    calls.saves.push({
      expectedVersion: request.expectedVersion,
      participants: [...request.participants],
    })
    if (memberRole() === 'member' || dropped().includes(currentUserId())) throw unavailable()
    if (staleNext) {
      staleNext = false
      // Someone else's write landed first; this page has not been told yet.
      setChannel((value) => ({
        ...value,
        participants: [...value.participants, { kind: 'user', userId: ids.sam }],
        version: value.version + 1,
      }))
      throw new ApiClientError('Channel version conflict', 409, 'conversation_conflict')
    }
    if (request.expectedVersion !== channel().version)
      throw new ApiClientError('Channel version conflict', 409, 'conversation_conflict')
    const wrong = [...request.audienceGrants, ...request.enlistmentGrants].some(
      (grant) => grant.groupId !== channel().id
    )
    if (wrong) throw new ApiClientError('Invalid request', 400, 'invalid_request')
    const next = {
      ...channel(),
      participants: [...request.participants],
      version: channel().version + 1,
    }
    setChannel(next)
    return next
  }

  const harness: AudienceHarness = {
    calls,
    concurrentEdit: () =>
      setChannel((value) => ({
        ...value,
        participants: [...value.participants, { kind: 'user', userId: ids.sam }],
        version: value.version + 1,
      })),
    dropMember: (userId) => setDropped((value) => [...value, userId]),
    groups: () =>
      [...stored.values()].map(({ channel: created }) => ({
        channelId: created.id,
        participants: [...created.participants],
        title: created.title,
      })),
    nextCreate: (mode) => {
      createMode = mode
      if (mode === 'hold') {
        const { promise, resolve } = Promise.withResolvers<void>()
        gate = { promise, release: resolve }
      }
    },
    nextSaveIsStale: () => {
      staleNext = true
    },
    releaseCreate: () => {
      createMode = 'ok'
      gate?.release()
      gate = undefined
    },
    releaseIssuer: () => {
      issuerMode = 'ok'
      issuerGate?.release()
      issuerGate = undefined
    },
    setIssuer: (mode) => {
      issuerMode = mode
      if (mode === 'hold') {
        const { promise, resolve } = Promise.withResolvers<void>()
        issuerGate = { promise, release: resolve }
      }
    },
    setRole: setMemberRole,
    switchAccount: setCurrentUserId,
    switchGroup: (to) =>
      setChannel((value) =>
        to === 'other'
          ? { ...value, id: ids.otherGroup, title: 'Offsite plan', version: 1 }
          : { ...value, id: ids.existingGroup, title: 'Launch review', version: 4 }
      ),
    switchWorkspace: (next) => {
      setWorkspaceId(next)
      setChannel((value) => value)
    },
  }
  window.audienceHarness = harness
  return { issueGrants, onCreate, onSave, calls, refresh: () => void (calls.staleReads += 1) }
}

function Harness() {
  const server = build()
  const [dialog, setDialog] = createSignal<
    'create' | 'create-bare' | 'manage' | 'manage-readonly' | ''
  >('')
  const [withIssuer, setWithIssuer] = createSignal(true)
  const [opened, setOpened] = createSignal<string>('')
  const audience = createMemo<GroupAudienceContext>(() => ({
    agentHomes: new Map(),
    agents: [
      agent(ids.ariaAcme, ids.acme),
      agent(ids.ariaGlobex, ids.globex),
      agent(ids.acmeTwin, ids.acme),
    ],
    currentUserId: currentUserId(),
    issueGrants: withIssuer() ? server.issueGrants : undefined,
    members: members(memberRole()).filter(
      ({ userId }) => !dropped().includes(userId) || userId === currentUserId()
    ),
    workspaceId: workspaceId(),
    workspaces,
  }))
  return (
    <main>
      <Button onClick={() => setDialog('create')}>Open new group</Button>
      <Button onClick={() => setDialog('create-bare')}>Open the app's group dialog</Button>
      <Button onClick={() => setDialog('manage')}>Open manage</Button>
      <Button onClick={() => setWithIssuer(false)}>Remove issuer</Button>
      <output aria-label="Opened conversation">{opened()}</output>
      <Show when={dialog() === 'create'}>
        <CreateGroupDialog
          audience={audience()}
          busy={false}
          scope={{ accountId: currentUserId(), workspaceId: workspaceId() }}
          onClose={() => setDialog('')}
          onCreate={server.onCreate}
          onOpen={(id) => {
            setOpened(id)
            setDialog('')
          }}
          open
        />
      </Show>
      <Show when={dialog() === 'create-bare'}>
        {/* The production entry: no audience and no issuer, only the scope the host always knows. */}
        <CreateGroupDialog
          busy={false}
          scope={{ accountId: currentUserId(), workspaceId: workspaceId() }}
          onClose={() => setDialog('')}
          onCreate={server.onCreate}
          open
        />
      </Show>
      <Show when={dialog() === 'manage'}>
        <GroupManageDialog
          audience={audience()}
          channel={channel()}
          onClose={() => setDialog('')}
          onSave={server.onSave}
          onStale={server.refresh}
          open
        />
      </Show>
      <p>{EARLIER_SECRET}</p>
    </main>
  )
}

render(() => <Harness />, document.getElementById('harness-root')!)
