import '../../src/start/globals.css'
import { ApiClientError, type ApiGroupSelection } from '@adea-ai/api-client'
import type {
  AgentSummary,
  ChannelSummary,
  ConversationParticipantRef,
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
  type GroupRosterSaveRequest,
} from '../../../../packages/workspace-ui/src/group-audience'

/**
 * The group-management dialogs over an in-page stand-in for the server.
 * Every identity here is synthetic. The stand-in keeps the rules the UI depends on: a repeated idempotency
 * key with the same payload answers the stored group, a different payload is refused, a roster write needs
 * the version it was drafted on, and the request carries a selection of identities, never a grant (the
 * server issues those). It exposes switches the
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
type SaveMode = 'forbidden' | 'hold' | 'lost' | 'lost-before' | 'ok' | 'unauthorized' | 'unknown'

export type AudienceHarness = {
  calls: {
    created: {
      channelId: string
      idempotencyKey: string
      selection: ApiGroupSelection
      title: string
    }[]
    saves: { expectedVersion: number; selection: ApiGroupSelection }[]
    staleReads: number
  }
  /** Someone else adds Sam to the stored group: the server version moves under an open manage dialog. */
  concurrentEdit: () => void
  /** Removes a member from the tenant's list, as a membership revocation would. */
  dropMember: (userId: string) => void
  groups: () => { channelId: string; participants: ConversationParticipantRef[]; title: string }[]
  nextCreate: (mode: CreateMode) => void
  /**
   * How the next manage save ends: refused as signed out or forbidden, or committed on the server but with the
   * answer lost (`lost`) or garbled (`unknown`), or lost before the server saw it (`lost-before`).
   */
  nextSave: (mode: SaveMode) => void
  /** The next manage save is refused as a stale version without the page having been told. */
  nextSaveIsStale: () => void
  releaseCreate: () => void
  /** Lets a held manage save answer (see nextSave('hold')). */
  releaseSave: () => void
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
  const calls: AudienceHarness['calls'] = { created: [], saves: [], staleReads: 0 }
  const stored = new Map<string, { channel: ChannelSummary; fingerprint: string }>()
  let createMode: CreateMode = 'ok'
  let staleNext = false
  let saveMode: SaveMode = 'ok'
  let gate: { promise: Promise<void>; release: () => void } | undefined
  let saveGate: { promise: Promise<void>; release: () => void } | undefined

  const onCreate = async (_title: string, request?: GroupCreateRequest) => {
    if (!request) throw new Error('The dialog always names its request')
    calls.created.push({
      channelId: request.channelId,
      idempotencyKey: request.idempotencyKey,
      selection: request.selection,
      title: request.title,
    })
    if (createMode === 'hold') await gate?.promise
    if (createMode === 'unavailable') throw unavailable()
    if (createMode === 'rejected') {
      createMode = 'ok'
      throw new ApiClientError('rejected', 400, 'group_grant_rejected', undefined, [
        {
          participant: { kind: 'user', userId: ids.alexAdmin },
          reason: 'participant_cross_tenant',
        },
      ])
    }
    // The server issues every grant from the selection; the creator is always the founding member.
    const participants: ConversationParticipantRef[] = [
      { kind: 'user', userId: currentUserId() },
      ...request.selection.humans.map((userId) => ({ kind: 'user' as const, userId })),
      ...request.selection.agents.map(({ agentId }) => ({ agentId, kind: 'agent' as const })),
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
    calls.saves.push({ expectedVersion: request.expectedVersion, selection: request.selection })
    if (saveMode === 'hold') await saveGate?.promise
    if (memberRole() === 'member' || dropped().includes(currentUserId())) throw unavailable()
    if (saveMode === 'unauthorized') {
      saveMode = 'ok'
      throw new ApiClientError('Unauthorized', 401)
    }
    if (saveMode === 'forbidden') {
      saveMode = 'ok'
      throw new ApiClientError('Forbidden', 403)
    }
    if (saveMode === 'lost-before') {
      saveMode = 'ok'
      throw new TypeError('Failed to fetch')
    }
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
    const next = {
      ...channel(),
      participants: [
        ...request.selection.humans.map((userId) => ({ kind: 'user' as const, userId })),
        ...request.selection.agents.map(({ agentId }) => ({ agentId, kind: 'agent' as const })),
      ],
      version: channel().version + 1,
    }
    setChannel(next)
    if (saveMode === 'lost') {
      saveMode = 'ok'
      throw new TypeError('Failed to fetch')
    }
    if (saveMode === 'unknown') {
      saveMode = 'ok'
      throw new ApiClientError('Bad gateway', 502)
    }
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
    nextSave: (mode) => {
      saveMode = mode
      if (mode === 'hold') {
        const { promise, resolve } = Promise.withResolvers<void>()
        saveGate = { promise, release: resolve }
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
    releaseSave: () => {
      saveMode = 'ok'
      saveGate?.release()
      saveGate = undefined
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
  return { onCreate, onSave, calls, refresh: () => void (calls.staleReads += 1) }
}

function Harness() {
  const server = build()
  const [dialog, setDialog] = createSignal<
    'create' | 'create-bare' | 'manage' | 'manage-readonly' | ''
  >('')
  const [opened, setOpened] = createSignal<string>('')
  const audience = createMemo<GroupAudienceContext>(() => ({
    agentHomes: new Map(),
    agents: [
      agent(ids.ariaAcme, ids.acme),
      agent(ids.ariaGlobex, ids.globex),
      agent(ids.acmeTwin, ids.acme),
    ],
    currentUserId: currentUserId(),
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
        {/* The production entry: no audience lists, only the scope the host always knows. */}
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
