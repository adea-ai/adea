import type { AgentHqApiClient, ApiAddressedTurn } from '@adea-ai/api-client'
import {
  settledConversationPage,
  settledData,
  useAddressedTurnsQuery,
  useAddressTurnMutation,
  useCancelAddressedTurnMutation,
  useRefreshChannels,
  useSetGroupSelectionMutation,
  useWorkspaceListQuery,
  useWorkspaceMembersQuery,
  isLiveAddressedTurn,
  type AddressedTurnReplay,
} from '@adea-ai/data'
import type { AgentSummary, ChannelSummary, WorkspaceMemberSummary } from '@adea-ai/types'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { Button } from '@adea-ai/ui/components/ui/button'
import { StatusChip } from '@adea-ai/ui/components/ui/status-chip'
import { ToggleGroup, ToggleGroupItem } from '@adea-ai/ui/components/ui/toggle-group'
import { Text } from '@adea-ai/ui/components/ui/typography'
import {
  createComputed,
  createEffect,
  createMemo,
  createSignal,
  For,
  lazy,
  onCleanup,
  onMount,
  Show,
  Suspense,
  type Accessor,
} from 'solid-js'

import {
  addressedTurnFailure,
  addressingMode,
  audienceLabel,
  createAddressingQueue,
  FIRST_DISPATCH_REVISION,
  groupParticipants,
  qualifyAgent,
  qualifyContext,
  qualifyTurnAgent,
  turnOrigin,
  turnPresentation,
  turnsByTrigger,
  type AddressingIntent,
  type AddressingMode,
  type QualifiedAgent,
} from './addressed-turn-model'
import { ConversationAvatar } from './conversation-avatar'
import type { GroupAudienceContext, GroupRosterSaveRequest } from './group-audience'

// The manage dialog loads from the module that holds every group dialog, only once someone opens it.
const GroupManageDialog = lazy(() =>
  import('./create-workspace-dialogs').then((module) => ({ default: module.GroupManageDialog }))
)

const shortId = (id: string) => id.replaceAll('-', '').slice(0, 8)

/**
 * The group's people, named from the workspace's member list: the signed-in person reads as "You", a repeated
 * display name gains the member's role and then a short id, and a person the list does not know is "Member".
 */
function groupHumans(
  participants: ChannelSummary['participants'],
  members: readonly WorkspaceMemberSummary[],
  currentUserId: string | undefined
) {
  const known = new Map(members.map((member) => [member.userId, member]))
  const people = participants.flatMap((participant) => {
    if (participant.kind !== 'user') return []
    const member = known.get(participant.userId)
    return [{ member, userId: participant.userId }]
  })
  const named = (name: string) =>
    people.filter(({ member }) => member?.displayName?.trim() === name).length
  return people.map(({ member, userId }) => {
    if (userId === currentUserId) return { key: userId, label: 'You' }
    const name = member?.displayName?.trim()
    if (!member || !name) return { key: userId, label: `Member ${shortId(userId)}` }
    if (named(name) < 2) return { key: userId, label: name }
    const withRole = `${name} · ${member.role}`
    const same = people.filter(
      (other) => other.member?.displayName?.trim() === name && other.member.role === member.role
    ).length
    return { key: userId, label: same < 2 ? withRole : `${withRole} · ${shortId(userId)}` }
  })
}

type CancelState = Readonly<{ status: 'pending' | 'done' | 'failed'; text: string | null }>

/**
 * What the group surface needs from addressed turns. One object per mounted group conversation; the
 * controller below owns the queries, the in-session address queue and the cancel state.
 */
export type GroupAddressing = Readonly<{
  /** Trigger messages that have turns or undelivered requests to show. */
  activeMessageIds: Accessor<ReadonlySet<string>>
  address: (triggerMessageId: string, agentIds: readonly string[]) => Promise<void>
  cancel: (turnId: string) => Promise<void>
  cancelStates: Accessor<Readonly<Record<string, CancelState>>>
  /** False when the replay stopped at its page cap: newer turns exist that were not read. */
  complete: Accessor<boolean>
  currentUserId: Accessor<string | undefined>
  dismiss: (key: string) => void
  /** The read failed and nothing is held for this conversation yet. */
  failed: Accessor<boolean>
  /** The group's people as the server holds them, named from the workspace's member list. */
  humans: Accessor<readonly Readonly<{ key: string; label: string }>[]>
  intents: Accessor<readonly AddressingIntent[]>
  loaded: Accessor<boolean>
  mode: Accessor<AddressingMode>
  qualify: (turn: ApiAddressedTurn) => QualifiedAgent
  qualifyIntent: (intent: AddressingIntent) => QualifiedAgent
  recipients: Accessor<readonly string[]>
  refresh: () => void
  retry: (key: string) => Promise<void>
  /** The latest refresh failed; the turns shown are the last ones read. */
  stale: Accessor<boolean>
  /** The server says this reader can no longer read the turns; none are kept or shown. */
  unavailable: Accessor<boolean>
  roster: Accessor<readonly QualifiedAgent[]>
  /** What the manage dialog needs: the live group, the tenant's choices and how to save a roster. */
  manage: Readonly<{
    audience: Accessor<GroupAudienceContext>
    channel: Accessor<ChannelSummary>
    refresh: () => void
    save: (request: GroupRosterSaveRequest) => Promise<ChannelSummary>
  }>
  setRecipients: (agentIds: readonly string[]) => void
  turns: Accessor<readonly ApiAddressedTurn[]>
  agentAvatar: (agentId: string) => string | undefined
  audience: Accessor<string>
}>

/** Renders nothing. Runs the group's queries and hands the surface one `GroupAddressing`. */
export function GroupAddressingController(props: {
  agents: readonly AgentSummary[]
  audienceEpoch: number
  channel: ChannelSummary
  client: AgentHqApiClient
  currentUserId?: string
  /** The newest root message sequence; a new message can supersede live turns, so it triggers a read. */
  latestSequence: number
  onReady: (value: GroupAddressing | undefined) => void
  workspaceId: string
}) {
  const workspaces = useWorkspaceListQuery(props.client)
  const turnsQuery = useAddressedTurnsQuery(
    props.client,
    () => props.workspaceId,
    () => props.channel.id
  )
  const addressMutation = useAddressTurnMutation(
    () => props.client,
    () => props.workspaceId,
    () => props.channel.id
  )
  const cancelMutation = useCancelAddressedTurnMutation(
    () => props.client,
    () => props.workspaceId,
    () => props.channel.id
  )
  // A failed background refresh puts the query in its error state, which settledConversationPage hides.
  // The turns last read for this audience are still the best account there is, so they stay shown (with
  // their Cancel buttons) and an alert says the refresh failed. A replaced audience never shows them.
  const [lastRead, setLastRead] = createSignal<AddressedTurnReplay>()
  createComputed(() => {
    const fresh = settledConversationPage(turnsQuery, props.audienceEpoch)
    if (fresh) setLastRead(fresh)
  })
  const page = () => {
    const fresh = settledConversationPage(turnsQuery, props.audienceEpoch)
    if (fresh) return fresh
    const kept = lastRead()
    return kept?.conversationAudienceEpoch === props.audienceEpoch ? kept : undefined
  }
  const turns = () => page()?.turns ?? []
  const context = createMemo(() => qualifyContext(props.agents, settledData(workspaces) ?? []))
  const roster = createMemo(() =>
    groupParticipants({ channel: props.channel, context: context(), turns: turns() })
  )
  const membersQuery = useWorkspaceMembersQuery(props.client, () => props.workspaceId)
  const setParticipants = useSetGroupSelectionMutation(props.client, () => props.workspaceId)
  const refreshChannels = useRefreshChannels(() => props.workspaceId)
  const audienceContext = createMemo<GroupAudienceContext>(() => ({
    agentHomes: new Map(
      roster().flatMap(({ agentId, workspaceId }) =>
        workspaceId ? [[agentId, workspaceId] as const] : []
      )
    ),
    agents: props.agents,
    currentUserId: props.currentUserId,
    members: settledData(membersQuery)?.members,
    workspaceId: props.workspaceId,
    workspaces: settledData(workspaces) ?? [],
  }))
  const humans = createMemo(() =>
    groupHumans(
      props.channel.participants,
      settledData(membersQuery)?.members ?? [],
      props.currentUserId
    )
  )
  const [chosen, setChosen] = createSignal<readonly string[]>([])
  // A recipient who left the roster since it was chosen is not addressed.
  const recipients = createMemo(() => {
    const present = new Set(roster().map(({ agentId }) => agentId))
    return chosen().filter((agentId) => present.has(agentId))
  })
  const mode = createMemo(() =>
    addressingMode(roster().filter(({ agentId }) => recipients().includes(agentId)))
  )
  const [intents, setIntents] = createSignal<readonly AddressingIntent[]>([])
  const queue = createAddressingQueue({
    onChange: setIntents,
    send: (input) => addressMutation.mutateAsync(input),
  })
  const [cancelStates, setCancelStates] = createSignal<Readonly<Record<string, CancelState>>>({})
  const setCancelState = (turnId: string, state: CancelState) =>
    setCancelStates((current) => ({ ...current, [turnId]: state }))

  const activeMessageIds = createMemo(
    () =>
      new Set([
        ...turns().map(({ triggerMessageId }) => triggerMessageId),
        ...intents().map(({ triggerMessageId }) => triggerMessageId),
      ])
  )
  const api: GroupAddressing = {
    activeMessageIds,
    address: (triggerMessageId, agentIds) =>
      queue.enqueue(
        agentIds.map((agentId) => ({
          agentId,
          dispatchRevision: FIRST_DISPATCH_REVISION,
          triggerMessageId,
        }))
      ),
    agentAvatar: (agentId) => context().agents.get(agentId)?.avatarRef,
    audience: () => audienceLabel(props.channel.visibility),
    cancel: async (turnId) => {
      setCancelState(turnId, { status: 'pending', text: null })
      try {
        const result = await cancelMutation.mutateAsync(turnId)
        setCancelState(turnId, {
          status: 'done',
          text: result.runtimeCancelRequested
            ? 'Cancellation was requested from the runtime.'
            : 'Cancelled. The runtime was not holding this turn.',
        })
      } catch (error) {
        setCancelState(turnId, {
          status: 'failed',
          text: addressedTurnFailure(error, 'cancel').text,
        })
      }
    },
    cancelStates,
    complete: () => page()?.complete ?? true,
    currentUserId: () => props.currentUserId,
    dismiss: queue.dismiss,
    failed: () => turnsQuery.isError && !page(),
    stale: () => turnsQuery.isError && Boolean(page()),
    unavailable: () => page()?.unavailable === true,
    humans,
    intents,
    loaded: () => Boolean(page()),
    manage: {
      audience: audienceContext,
      channel: () => props.channel,
      refresh: refreshChannels,
      save: (request) =>
        setParticipants
          .mutateAsync({
            channelId: props.channel.id,
            expectedVersion: request.expectedVersion,
            selection: request.selection,
          })
          .then((result) => result.channel),
    },
    mode,
    qualify: (turn) => qualifyTurnAgent(turn, context()),
    qualifyIntent: (intent) => {
      const home = roster().find(({ agentId }) => agentId === intent.agentId)?.workspaceId ?? null
      return qualifyAgent(intent.agentId, home, context())
    },
    recipients,
    refresh: () => void turnsQuery.refetch(),
    retry: queue.retry,
    roster,
    setRecipients: setChosen,
    turns,
  }

  // A new human message supersedes live turns in the same transaction as the post: read again.
  let seenSequence = props.latestSequence
  createEffect(() => {
    const latest = props.latestSequence
    if (latest === seenSequence) return
    seenSequence = latest
    void turnsQuery.refetch()
  })
  // Reconnect: re-read the committed turns and retry what never reached the server. A retried request
  // is identical, and the server answers a repeat with the turn it already holds.
  const reconnect = () => {
    void turnsQuery.refetch()
    void queue.retryTransient()
  }
  onMount(() => {
    window.addEventListener('online', reconnect)
    onCleanup(() => window.removeEventListener('online', reconnect))
    props.onReady(api)
    onCleanup(() => props.onReady(undefined))
  })
  return null
}

/** The group header: who is in it, in which workspace, for which audience, and who the next message addresses. */
export function GroupRoster(props: { addressing: GroupAddressing }) {
  const [managing, setManaging] = createSignal(false)
  return (
    <nav class="min-w-0 pt-0.5" aria-label="People in this conversation">
      <ul class="flex flex-wrap justify-center gap-x-4 gap-y-2 pt-0.5 pb-1">
        <For each={props.addressing.humans()}>
          {(human) => (
            <li class="flex items-center gap-2" aria-label={human.label} data-group-human="">
              <ConversationAvatar kind="user" />
              <Text variant="label">{human.label}</Text>
            </li>
          )}
        </For>
        <For each={props.addressing.roster()}>
          {(agent) => (
            <li class="flex items-center gap-2" aria-label={agent.label}>
              <ConversationAvatar
                kind="agent"
                avatarRef={props.addressing.agentAvatar(agent.agentId)}
              />
              <span class="flex min-w-0 flex-col">
                <Text variant="label">{agent.name ?? `Agent ${agent.agentId.slice(0, 8)}`}</Text>
                <Text variant="micro" tone="muted">
                  {agent.workspaceLabel}
                </Text>
              </span>
            </li>
          )}
        </For>
      </ul>
      <p class="flex flex-wrap justify-center gap-x-4 pb-1">
        <Text variant="caption" tone="muted">
          Audience: {props.addressing.audience()}
        </Text>
        <Text variant="caption" tone="muted" data-addressing-mode={props.addressing.mode().kind}>
          Next message: {props.addressing.mode().label}
        </Text>
        <Button size="xs" variant="outline" onClick={() => setManaging(true)}>
          Manage group
        </Button>
      </p>
      <Show when={managing()}>
        <Suspense fallback={null}>
          <GroupManageDialog
            audience={props.addressing.manage.audience()}
            channel={props.addressing.manage.channel()}
            onClose={() => setManaging(false)}
            onSave={props.addressing.manage.save}
            onStale={props.addressing.manage.refresh}
            open
          />
        </Suspense>
      </Show>
    </nav>
  )
}

/** Chooses who the next message addresses. Nothing is addressed unless an Agent is chosen here. */
export function GroupRecipientPicker(props: { addressing: GroupAddressing }) {
  const addressing = () => props.addressing
  return (
    <section aria-label="Address Agents" class="flex flex-col gap-1.5 px-5 pt-3">
      <Show
        when={addressing().roster().length}
        fallback={
          <Text variant="caption" tone="muted" role="status">
            No Agents are enlisted in this conversation, so nothing can be addressed.
          </Text>
        }
      >
        <div class="flex flex-wrap items-center gap-2">
          <Text variant="label">Address</Text>
          <ToggleGroup
            multiple
            class="flex-wrap"
            aria-label="Agents your next message addresses"
            value={[...addressing().recipients()]}
            onChange={(value: string[]) => addressing().setRecipients(value)}
          >
            <For each={addressing().roster()}>
              {(agent) => (
                <ToggleGroupItem value={agent.agentId} variant="outline" size="sm">
                  {agent.label}
                </ToggleGroupItem>
              )}
            </For>
          </ToggleGroup>
        </div>
        <Text variant="caption" tone="muted" role="status">
          {addressing().mode().label}.{' '}
          {addressing().mode().kind === 'none'
            ? 'Agents only answer when addressed.'
            : 'Only the group’s lead runs turns today; other Agents are recorded as addressed and nothing starts for them.'}
        </Text>
      </Show>
      <Show when={addressing().failed()}>
        <Alert variant="destructive">
          <AlertDescription>
            Addressed turns could not be read, so their status is not shown.{' '}
            <Button size="xs" variant="outline" onClick={() => addressing().refresh()}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      </Show>
      <Show when={addressing().unavailable()}>
        <Alert>
          <AlertDescription>
            Addressed turns are no longer available to you, so none are shown.{' '}
            <Button size="xs" variant="outline" onClick={() => addressing().refresh()}>
              Read again
            </Button>
          </AlertDescription>
        </Alert>
      </Show>
      <Show when={addressing().stale()}>
        <Alert variant="destructive">
          <AlertDescription>
            Addressed turns could not be refreshed. What is shown is from the last read and may be
            out of date.{' '}
            <Button size="xs" variant="outline" onClick={() => addressing().refresh()}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      </Show>
      <Show when={addressing().loaded() && !addressing().complete()}>
        <Alert>
          <AlertDescription>
            Only the oldest addressed turns were read. Newer turns may exist that are not shown.{' '}
            <Button size="xs" variant="outline" onClick={() => addressing().refresh()}>
              Read again
            </Button>
          </AlertDescription>
        </Alert>
      </Show>
    </section>
  )
}

function IntentRow(props: { addressing: GroupAddressing; intent: AddressingIntent }) {
  const agent = () => props.addressing.qualifyIntent(props.intent)
  return (
    <li class="flex flex-col gap-0.5" data-addressing-intent={props.intent.status}>
      <span class="flex flex-wrap items-center gap-2">
        <Text variant="label">{agent().label}</Text>
        <StatusChip
          tone={props.intent.status === 'pending' ? 'pending' : 'warning'}
          label={props.intent.status === 'pending' ? 'Sending' : 'Not delivered'}
        />
        <Show when={props.intent.status === 'failed' && props.intent.failure?.retryable}>
          <Button
            size="xs"
            variant="outline"
            onClick={() => void props.addressing.retry(props.intent.key)}
          >
            Retry
          </Button>
        </Show>
        <Show when={props.intent.status === 'failed'}>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => props.addressing.dismiss(props.intent.key)}
          >
            Dismiss
          </Button>
        </Show>
      </span>
      <Show when={props.intent.failure}>
        {(failure) => (
          <Text variant="caption" tone="muted" role="status">
            {failure().text}
          </Text>
        )}
      </Show>
    </li>
  )
}

function TurnRow(props: {
  addressing: GroupAddressing
  index: number
  of: number
  turn: ApiAddressedTurn
}) {
  const view = () => turnPresentation(props.turn)
  const agent = () => props.addressing.qualify(props.turn)
  const cancelState = () => props.addressing.cancelStates()[props.turn.id]
  const canCancel = () =>
    isLiveAddressedTurn(props.turn) &&
    props.addressing.currentUserId() === props.turn.addresserUserId
  return (
    <li class="flex flex-col gap-0.5" data-addressed-turn={props.turn.state}>
      <span class="flex flex-wrap items-center gap-2">
        <Show when={props.of > 1}>
          <Text variant="micro" tone="muted" numeric>
            {props.index + 1} of {props.of}
          </Text>
        </Show>
        <Text variant="label">{agent().label}</Text>
        <StatusChip tone={view().tone} label={view().label} detail={view().detail} />
        <Show when={props.turn.parentTurnId !== null}>
          <Text variant="micro" tone="muted">
            {turnOrigin(props.turn)}
          </Text>
        </Show>
        <Show when={canCancel() && cancelState()?.status !== 'done'}>
          <Button
            size="xs"
            variant="outline"
            aria-label={`Cancel turn for ${agent().label}`}
            disabled={cancelState()?.status === 'pending'}
            onClick={() => void props.addressing.cancel(props.turn.id)}
          >
            {cancelState()?.status === 'pending' ? 'Cancelling…' : 'Cancel turn'}
          </Button>
        </Show>
      </span>
      <Show when={props.turn.state !== 'responded' && props.turn.state !== 'dispatching'}>
        <Text variant="caption" tone="muted">
          {view().detail}
        </Text>
      </Show>
      <Show when={cancelState()?.text}>
        {(text) => (
          <Text variant="caption" tone="muted" role="status">
            {text()}
          </Text>
        )}
      </Show>
    </li>
  )
}

/** The Agents a human message addressed, in the order the server committed them. */
export function MessageTurns(props: { addressing: GroupAddressing; messageId: string }) {
  const turns = createMemo(
    () => turnsByTrigger(props.addressing.turns()).get(props.messageId) ?? []
  )
  // An intent whose turn the server has already retained is delivered; its own row would contradict
  // the turn row beside it (a lost response leaves the intent failed while the replay has the turn).
  const intents = createMemo(() =>
    props.addressing
      .intents()
      .filter(
        ({ agentId, dispatchRevision, triggerMessageId }) =>
          triggerMessageId === props.messageId &&
          !turns().some(
            (turn) => turn.agentId === agentId && turn.dispatchRevision === dispatchRevision
          )
      )
  )
  return (
    <Show when={turns().length || intents().length}>
      <ul
        class="border-border mt-2 flex flex-col gap-2 border-s-2 ps-3"
        aria-label="Addressed Agents"
      >
        <For each={turns()}>
          {(turn, index) => (
            <TurnRow
              addressing={props.addressing}
              index={index()}
              of={turns().length}
              turn={turn}
            />
          )}
        </For>
        <For each={intents()}>
          {(intent) => <IntentRow addressing={props.addressing} intent={intent} />}
        </For>
      </ul>
    </Show>
  )
}
