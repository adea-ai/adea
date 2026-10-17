import type { AgentHqApiClient, ApiGroupSelection } from '@adea-ai/api-client'
import { settledData, useWorkspaceListQuery, useWorkspaceMembersQuery } from '@adea-ai/data'
import type {
  AgentSummary,
  ChannelSummary,
  QualifiedAgentIdentity,
  WorkspaceMemberSummary,
  WorkspaceSummary,
} from '@adea-ai/types'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Checkbox } from '@adea-ai/ui/components/ui/checkbox'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Label } from '@adea-ai/ui/components/ui/label'
import { ModalDialog } from '@adea-ai/ui/components/ui/modal-dialog'
import { Heading, Text } from '@adea-ai/ui/components/ui/typography'
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  on,
  onCleanup,
  Show,
  untrack,
  type JSX,
} from 'solid-js'

import {
  applyDraft,
  audienceChoices,
  canManageGroup,
  conflictAfterUnclearSave,
  describeAgents,
  describeHumans,
  draftIsEmpty,
  emptyDraft,
  groupSelection,
  groupAudienceCopy,
  groupFingerprint,
  humanKey,
  nextAttempt,
  participantKey,
  participantLabel,
  rebaseDraft,
  reconcileSelection,
  rosterChange,
  rosterKeys,
  runGroupSave,
  selectedChoices,
  toggleSelection,
  type AudienceChoices,
  type AudienceSelection,
  type GroupAttempt,
  type GroupFailure,
  type RosterDraft,
} from './group-audience-model'
import { createClientRequestId } from './request-id'

export { canManageGroup } from './group-audience-model'
export type { AudienceChoices } from './group-audience-model'

/** What the server needs to create a group: the person's choices by identity. The server issues every grant. */
export type GroupCreateRequest = Readonly<{
  channelId: string
  idempotencyKey: string
  selection: ApiGroupSelection
  title: string
}>

/** What the server needs to replace a group's roster: who should be in it, and the version seen. */
export type GroupRosterSaveRequest = Readonly<{
  expectedVersion: number
  selection: ApiGroupSelection
}>

/**
 * Everything the create and manage surfaces know about the tenant: the lists the server returned for this
 * workspace. There is no grant source here: the server issues grants from the selection it is sent.
 */
export type GroupAudienceContext = Readonly<{
  /** Home workspace of Agents the list does not include, learned from the group's own retained turns. */
  agentHomes?: ReadonlyMap<string, string>
  agents: readonly AgentSummary[]
  currentUserId: string | undefined
  members?: readonly WorkspaceMemberSummary[]
  workspaceId: string
  workspaces: readonly WorkspaceSummary[]
}>

/**
 * Whose group this is and where: the signed-in account, the workspace, and the workspace's audience epoch.
 * It is passed by every host independently of the audience lists, so a draft can never outlive the
 * account or workspace it was written for.
 */
export type GroupScope = Readonly<{
  accountId: string | undefined
  epoch?: number
  workspaceId: string | undefined
}>

const scopeKey = (scope: GroupScope) =>
  `${scope.workspaceId ?? ''}|${scope.accountId ?? ''}|${scope.epoch ?? 0}`

type RosterRowView = Readonly<{
  detail?: string
  key: string
  kind: 'agent' | 'user'
  label: string
  note?: string
  problem?: string
  tone?: 'adding' | 'removing'
}>

/** Who is (or will be) in the group, one row each, with what the server said about any of them. */
function RosterList(props: {
  label: string
  rows: readonly RosterRowView[]
  children?: (row: RosterRowView) => JSX.Element
}) {
  return (
    <ul class="flex flex-col gap-2" aria-label={props.label} data-group-roster="">
      <For each={props.rows}>
        {(row) => (
          <li
            class="flex flex-wrap items-center gap-x-3 gap-y-1"
            data-roster-key={row.key}
            data-roster-state={row.tone ?? 'current'}
          >
            <span class="flex min-w-0 flex-1 flex-col">
              <Text variant="label">{row.label}</Text>
              <Show when={row.detail}>
                <Text variant="micro" tone="muted">
                  {row.detail}
                </Text>
              </Show>
              <Show when={row.note}>
                <Text variant="caption" tone="muted">
                  {row.note}
                </Text>
              </Show>
              <Show when={row.problem}>
                <Text variant="caption" role="alert" data-roster-problem="">
                  {row.problem}
                </Text>
              </Show>
            </span>
            {props.children?.(row)}
          </li>
        )}
      </For>
    </ul>
  )
}

function Notices(props: { removal?: boolean }) {
  return (
    <div class="flex flex-col gap-1.5" data-group-notices="">
      <Text variant="caption" tone="muted">
        {groupAudienceCopy.joinPointHistory}
      </Text>
      <Text variant="caption" tone="muted">
        {groupAudienceCopy.earlierAccess}
      </Text>
      <Show when={props.removal !== false}>
        <Text variant="caption" tone="muted">
          {groupAudienceCopy.removal}
        </Text>
      </Show>
    </div>
  )
}

/** Checkboxes for the people and Agents that can be added. Identity decides the row, never the name. */
function AudiencePicker(props: {
  choices: AudienceChoices
  disabled: boolean
  onToggle: (key: string) => void
  problems: Readonly<Record<string, string>>
  selected: AudienceSelection
}) {
  const humans = createMemo(() => describeHumans(props.choices.humans))
  const agents = createMemo(() => describeAgents(props.choices.agents))
  const chosen = createMemo(() => new Set(props.selected))
  const hasSameNames = createMemo(() => {
    const labels = agents().map(({ choice }) => `${choice.name}`)
    return new Set(labels).size !== labels.length
  })
  const row = (item: { choice: { key: string }; detail: string; label: string }) => (
    <li class="flex flex-col gap-0.5" data-choice-key={item.choice.key}>
      <Checkbox
        checked={chosen().has(item.choice.key)}
        disabled={props.disabled}
        onChange={() => props.onToggle(item.choice.key)}
        label={item.label}
        description={item.detail}
        aria-invalid={props.problems[item.choice.key] ? true : undefined}
      />
      <Show when={props.problems[item.choice.key]}>
        {(problem) => (
          <div class="ps-7">
            <Text variant="caption" role="alert">
              {problem()}
            </Text>
          </div>
        )}
      </Show>
    </li>
  )
  return (
    <div class="flex flex-col gap-4">
      <fieldset class="flex flex-col gap-2" data-audience-people="">
        <legend>
          <Text variant="label">People</Text>
        </legend>
        <Show
          when={humans().length}
          fallback={
            <Text variant="caption" tone="muted" role="status">
              There is nobody else in this workspace to add.
            </Text>
          }
        >
          <ul class="flex max-h-48 flex-col gap-2 overflow-y-auto">
            <For each={humans()}>{row}</For>
          </ul>
        </Show>
      </fieldset>
      <fieldset class="flex flex-col gap-2" data-audience-agents="">
        <legend>
          <Text variant="label">Agents</Text>
        </legend>
        <Show
          when={agents().length}
          fallback={
            <Text variant="caption" tone="muted" role="status">
              There are no active Agents to enlist.
            </Text>
          }
        >
          <ul class="flex max-h-48 flex-col gap-2 overflow-y-auto">
            <For each={agents()}>{row}</For>
          </ul>
          <Show when={hasSameNames()}>
            <Text variant="caption" tone="muted">
              {groupAudienceCopy.sameNameAgents}
            </Text>
          </Show>
        </Show>
      </fieldset>
    </div>
  )
}

function FailureAlert(props: { failure: GroupFailure }) {
  return (
    <Alert variant="destructive" role="alert" data-group-failure={props.failure.kind}>
      <AlertDescription>{props.failure.text}</AlertDescription>
    </Alert>
  )
}

/**
 * The new-group dialog. It lets the person pick the audience and enlist Agents; the server issues and checks
 * every grant. Without audience lists (a legacy host) the group starts with only its creator. The group is
 * shown as created only when the server's answer arrives, and every failure keeps the title and selections
 * for another try.
 */
export function CreateGroupDialog(props: {
  audience?: GroupAudienceContext
  busy: boolean
  onClose: () => void
  /** Legacy callers resolve with nothing and the dialog closes; a returned channel is shown as confirmed. */
  onCreate: (title: string, request?: GroupCreateRequest) => Promise<ChannelSummary | void>
  onOpen?: (channelId: string) => void
  open: boolean
  scope: GroupScope
}) {
  const [title, setTitle] = createSignal('')
  const [selected, setSelected] = createSignal<AudienceSelection>([])
  const [failure, setFailure] = createSignal<GroupFailure | null>(null)
  const [pending, setPending] = createSignal(false)
  const [created, setCreated] = createSignal<ChannelSummary | null>(null)
  const [notice, setNotice] = createSignal<string | null>(null)
  let attempt: GroupAttempt | null = null
  let inFlight = false
  // Bumped whenever the account or workspace changes, so an answer to a send that began before the change is
  // dropped even if the person has since come back to where it started.
  let generation = 0
  const titleId = createUniqueId()
  // A memo, so the effects below run when the account or workspace changes, not whenever the tenant's lists reload.
  const context = createMemo(
    () =>
      `${scopeKey(props.scope)}|${props.audience?.workspaceId ?? ''}|${props.audience?.currentUserId ?? ''}`
  )
  const token = () => `${context()}#${generation}`
  // Closing or unmounting the dialog ends any send still waiting: its answer belongs to nobody on screen.
  const invalidate = () => {
    generation += 1
    inFlight = false
  }
  onCleanup(invalidate)
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (open) return
        invalidate()
        setPending(false)
      },
      { defer: true }
    )
  )
  const choices = createMemo(() =>
    props.audience
      ? audienceChoices({
          agents: props.audience.agents,
          excludeUserId: props.audience.currentUserId,
          members: props.audience.members ?? [],
          workspaces: props.audience.workspaces,
        })
      : { agents: [], humans: [] }
  )
  const canPick = () => Boolean(props.audience)
  const empty = createMemo(() => title().trim().length === 0)

  // A different account or workspace is a different group: nothing typed or selected carries over.
  createEffect(
    on(
      context,
      () => {
        generation += 1
        inFlight = false
        setPending(false)
        setTitle('')
        setSelected([])
        setFailure(null)
        setCreated(null)
        setNotice(null)
        attempt = null
      },
      { defer: true }
    )
  )
  // A list that changed under the selection (a member left, an Agent was archived) is reconciled by
  // identity and the person is told, rather than a selection silently naming someone else.
  let previousChoices = untrack(choices)
  createEffect(
    on(
      choices,
      (next) => {
        const result = reconcileSelection(untrack(selected), previousChoices, next)
        previousChoices = next
        if (result.dropped.length === 0) return
        setSelected(result.kept)
        setNotice(
          `No longer available, so removed from your selection: ${result.dropped.join(', ')}.`
        )
      },
      { defer: true }
    )
  )

  const edit =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      setFailure(null)
      set(value)
    }

  const submit = async () => {
    if (inFlight || empty()) return
    inFlight = true
    const started = generation
    setPending(true)
    setFailure(null)
    const text = title().trim()
    const chosen = selectedChoices(selected(), choices())
    const current = nextAttempt(attempt, groupFingerprint(text, selected()), createClientRequestId)
    attempt = current
    const outcome = await runGroupSave({
      context: token,
      operation: 'create',
      send: () =>
        props.onCreate(text, {
          channelId: current.channelId,
          idempotencyKey: current.idempotencyKey,
          selection: groupSelection(chosen),
          title: text,
        }),
    })
    if (started !== generation) return
    inFlight = false
    setPending(false)
    if (outcome.status === 'ignored') return
    if (outcome.status === 'failed') {
      if (outcome.failure.kind === 'conflict') attempt = null
      setFailure(outcome.failure)
      return
    }
    if (outcome.value) setCreated(outcome.value)
    else props.onClose()
  }

  const creatorRow = (): RosterRowView => ({
    detail: 'Creator',
    key: humanKey(props.audience?.currentUserId ?? 'you'),
    kind: 'user',
    label: 'You',
  })
  const addedRows = createMemo<readonly RosterRowView[]>(() => {
    const chosen = selectedChoices(selected(), choices())
    return [
      ...describeHumans(chosen.humans).map(({ choice, detail, label }) => ({
        detail,
        key: choice.key,
        kind: 'user' as const,
        label,
        problem: failure()?.perParticipant[choice.key],
        tone: 'adding' as const,
      })),
      ...describeAgents(chosen.agents).map(({ choice, detail, label }) => ({
        detail,
        key: choice.key,
        kind: 'agent' as const,
        label,
        problem: failure()?.perParticipant[choice.key],
        tone: 'adding' as const,
      })),
    ]
  })
  const confirmedRows = createMemo<readonly RosterRowView[]>(() => {
    const channel = created()
    if (!channel) return []
    return channel.participants.map((participant) => ({
      key: participantKey(participant),
      kind: participant.kind,
      label: participantLabel(participant, choices(), props.audience?.currentUserId),
    }))
  })
  const mismatch = createMemo(() => {
    const channel = created()
    if (!channel) return false
    const expected = [
      participantKey({ kind: 'user', userId: props.audience?.currentUserId ?? '' }),
      ...selected(),
    ].toSorted()
    return (
      canPick() && JSON.stringify(rosterKeys(channel.participants)) !== JSON.stringify(expected)
    )
  })

  return (
    <ModalDialog
      modal={false}
      class="max-h-full overflow-y-auto"
      open={props.open}
      onClose={props.onClose}
      title="New group conversation"
      description="A durable conversation for users and multiple Agents, without requiring a Project."
    >
      <Show
        when={!created()}
        fallback={
          <div class="grid gap-4" data-group-created="">
            <Heading
              as="h3"
              size="subsection"
              tabindex="-1"
              ref={(element: HTMLElement) => queueMicrotask(() => element.focus())}
            >
              Group created
            </Heading>
            <Show when={mismatch()}>
              <Alert role="alert">
                <AlertDescription>
                  The server created the group with a different roster than you chose. This is who
                  is in it.
                </AlertDescription>
              </Alert>
            </Show>
            <RosterList label="Who is in the group" rows={confirmedRows()} />
            <Notices removal={false} />
            <div class="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => props.onClose()}>
                Close
              </Button>
              <Show when={props.onOpen}>
                <Button onClick={() => props.onOpen?.(created()!.id)}>Open conversation</Button>
              </Show>
            </div>
          </div>
        }
      >
        <form
          class="grid gap-4"
          aria-busy={pending() || props.busy}
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <div class="flex flex-col gap-2">
            <Label for={titleId}>Conversation name</Label>
            <Input
              id={titleId}
              name="title"
              required
              maxLength={120}
              autofocus
              disabled={pending()}
              value={title()}
              onInput={(event) => edit(setTitle)(event.currentTarget.value)}
            />
          </div>
          <section
            class="flex flex-col gap-3"
            aria-label="Who is in this group"
            data-group-audience=""
          >
            <Heading as="h3" size="subsection">
              Who is in this group
            </Heading>
            <RosterList label="Group audience" rows={[creatorRow(), ...addedRows()]} />
            <Text variant="caption" tone="muted">
              {groupAudienceCopy.creatorFounded}
            </Text>
            <Show when={canPick()}>
              <AudiencePicker
                choices={choices()}
                disabled={pending()}
                onToggle={(key) => edit(setSelected)(toggleSelection(selected(), key))}
                problems={failure()?.perParticipant ?? {}}
                selected={selected()}
              />
            </Show>
            <Notices removal={false} />
          </section>
          <Show when={notice()}>
            {(text) => (
              <Alert role="status" data-group-notice="">
                <AlertDescription>{text()}</AlertDescription>
              </Alert>
            )}
          </Show>
          <Show when={failure()}>{(value) => <FailureAlert failure={value()} />}</Show>
          <Button type="submit" disabled={pending() || props.busy || empty()}>
            {pending() || props.busy
              ? 'Creating…'
              : failure()?.retrySame
                ? 'Try again'
                : 'Create conversation'}
          </Button>
        </form>
      </Show>
    </ModalDialog>
  )
}

/**
 * The new-group dialog with the tenant's real lists. It reads the workspace's members and workspaces only
 * while it is open, so a host passes the Agents it already has and never loads audience data for a dialog
 * nobody opened. Agents from other workspaces are offered only when the host's list holds them.
 */
export function ConnectedCreateGroupDialog(
  props: Omit<Parameters<typeof CreateGroupDialog>[0], 'audience'> & {
    agents: readonly AgentSummary[]
    client: AgentHqApiClient
    currentUserId: string | undefined
    workspaceId: string
  }
) {
  const members = useWorkspaceMembersQuery(props.client, () => props.workspaceId)
  const workspaces = useWorkspaceListQuery(props.client)
  const audience = createMemo<GroupAudienceContext>(() => ({
    agents: props.agents,
    currentUserId: props.currentUserId,
    members: settledData(members)?.members,
    workspaceId: props.workspaceId,
    workspaces: settledData(workspaces) ?? [],
  }))
  return (
    <CreateGroupDialog
      audience={audience()}
      busy={props.busy}
      onClose={props.onClose}
      onCreate={props.onCreate}
      onOpen={props.onOpen}
      open={props.open}
      scope={props.scope}
    />
  )
}

/**
 * The manage dialog: the roster the server holds, the changes the person has drafted against it, and the
 * history and removal consequences in plain words. A change is saved against the version it was drafted on;
 * if the group moved under the draft the draft is kept and re-based, and the person reviews before saving.
 */
export function GroupManageDialog(props: {
  audience: GroupAudienceContext
  channel: ChannelSummary
  onClose: () => void
  /** Called when the server reports a stale version, so the host re-reads the group. */
  onStale?: () => void
  onSave: (request: GroupRosterSaveRequest) => Promise<ChannelSummary>
  open: boolean
}) {
  const [draft, setDraft] = createSignal<RosterDraft>(emptyDraft)
  const [failure, setFailure] = createSignal<GroupFailure | null>(null)
  const [pending, setPending] = createSignal(false)
  const [reviewed, setReviewed] = createSignal(props.channel.version)
  const [rosterAtReview, setRosterAtReview] = createSignal(props.channel.participants)
  const [local, setLocal] = createSignal<string | null>(null)
  const [saved, setSaved] = createSignal(false)
  let inFlight = false
  // See CreateGroupDialog: an answer to a send that began before a switch is dropped even after switching back.
  let generation = 0
  const choices = createMemo(() =>
    audienceChoices({
      agents: props.audience.agents,
      members: props.audience.members ?? [],
      workspaces: props.audience.workspaces,
    })
  )
  const context = createMemo(
    () => `${props.audience.workspaceId}|${props.audience.currentUserId ?? ''}|${props.channel.id}`
  )
  const token = () => `${context()}#${generation}`
  // See CreateGroupDialog: closing or unmounting ends any send still waiting.
  const invalidate = () => {
    generation += 1
    inFlight = false
  }
  onCleanup(invalidate)
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (open) return
        invalidate()
        setPending(false)
      },
      { defer: true }
    )
  )
  // Set when the last save's outcome was not known, so a conflict right after it is explained truthfully.
  let unclear = false
  const sameWorkspace = () => props.channel.workspaceId === props.audience.workspaceId
  const archived = () => props.channel.lifecycleState !== 'active'
  const canManage = () =>
    props.audience.members
      ? canManageGroup(props.audience.members, props.audience.currentUserId)
      : false
  const canChange = () => canManage() && !archived()
  const stale = () => props.channel.version !== reviewed()
  const unavailable = () => failure()?.kind === 'unavailable'
  // Once access is gone the group's title and roster are not shown any more, whatever was loaded before.
  const hidden = () => !sameWorkspace() || unavailable()

  createEffect(
    on(
      context,
      () => {
        generation += 1
        inFlight = false
        unclear = false
        setPending(false)
        setDraft(emptyDraft)
        setFailure(null)
        setLocal(null)
        setSaved(false)
        setReviewed(props.channel.version)
        setRosterAtReview(props.channel.participants)
      },
      { defer: true }
    )
  )

  const review = () => {
    const next = rebaseDraft(draft(), props.channel.participants, choices())
    setDraft(next.draft)
    setReviewed(props.channel.version)
    setRosterAtReview(props.channel.participants)
    setFailure(null)
    setLocal(
      next.droppedAdds > 0
        ? `${next.droppedAdds} ${next.droppedAdds === 1 ? 'person or Agent' : 'people or Agents'} you chose to add ${next.droppedAdds === 1 ? 'is' : 'are'} no longer available and ${next.droppedAdds === 1 ? 'was' : 'were'} dropped from your changes.`
        : null
    )
  }
  const changes = createMemo(() =>
    rosterChange(rosterAtReview(), props.channel.participants, draft())
  )
  const labelOf = (key: string) => {
    const found = [...describeHumans(choices().humans), ...describeAgents(choices().agents)].find(
      ({ choice }) => choice.key === key
    )
    return found?.label ?? 'Someone'
  }

  const rows = createMemo<readonly RosterRowView[]>(() => {
    const removing = new Set(draft().remove)
    const current = props.channel.participants.map((participant): RosterRowView => {
      const key = participantKey(participant)
      return {
        key,
        kind: participant.kind,
        label: participantLabel(participant, choices(), props.audience.currentUserId),
        note: removing.has(key) ? 'Will be removed when you save.' : undefined,
        problem: failure()?.perParticipant[key],
        tone: removing.has(key) ? 'removing' : undefined,
      }
    })
    const present = new Set(current.map(({ key }) => key))
    const adding = draft()
      .add.filter((key) => !present.has(key))
      .map((key): RosterRowView => {
        const isHuman = key.startsWith('user:')
        return {
          key,
          kind: isHuman ? 'user' : 'agent',
          label: labelOf(key),
          note: 'Will be added when you save. Sees the conversation from the moment they join.',
          problem: failure()?.perParticipant[key],
          tone: 'adding',
        }
      })
    return [...current, ...adding]
  })

  const addable = createMemo<AudienceChoices>(() => {
    const present = new Set(props.channel.participants.map(participantKey))
    return {
      agents: choices().agents.filter(({ key }) => !present.has(key)),
      humans: choices().humans.filter(({ key }) => !present.has(key)),
    }
  })

  const toggleRemove = (key: string) =>
    setDraft((value) => ({ ...value, remove: toggleSelection(value.remove, key) }))
  const toggleAdd = (key: string) =>
    setDraft((value) => ({ ...value, add: toggleSelection(value.add, key) }))

  const save = async () => {
    if (inFlight || draftIsEmpty(draft()) || stale() || !canChange()) return
    const participants = applyDraft(props.channel.participants, draft(), choices())
    setLocal(null)
    if (!participants.some((participant) => participant.kind === 'user')) {
      setLocal(
        `A group needs at least one person. ${participants.length === 0 ? 'Nobody' : 'Only Agents'} would be left.`
      )
      return
    }
    const humans = participants.flatMap((participant) =>
      participant.kind === 'user' ? [participant.userId] : []
    )
    const agents: QualifiedAgentIdentity[] = []
    const unknown: string[] = []
    for (const participant of participants) {
      if (participant.kind !== 'agent') continue
      const known = choices().agents.find(({ agentId }) => agentId === participant.agentId)
      const workspaceId = known?.workspaceId ?? props.audience.agentHomes?.get(participant.agentId)
      if (workspaceId) agents.push({ agentId: participant.agentId, workspaceId })
      else unknown.push(participantLabel(participant, choices()))
    }
    if (unknown.length) {
      setLocal(
        `The workspace of ${unknown.join(', ')} is not known here, so ${unknown.length === 1 ? 'it' : 'they'} cannot be identified exactly. Remove ${unknown.length === 1 ? 'it' : 'them'} from the group or save from a place that knows ${unknown.length === 1 ? 'its' : 'their'} workspace.`
      )
      return
    }
    inFlight = true
    const started = generation
    setPending(true)
    setFailure(null)
    setSaved(false)
    const expectedVersion = props.channel.version
    const outcome = await runGroupSave({
      context: token,
      operation: 'manage',
      send: () =>
        props.onSave({
          expectedVersion,
          selection: { agents, humans },
        }),
    })
    if (started !== generation) return
    inFlight = false
    setPending(false)
    if (outcome.status === 'ignored') return
    if (outcome.status === 'failed') {
      const next =
        unclear && outcome.failure.kind === 'conflict' ? conflictAfterUnclearSave : outcome.failure
      unclear = next.ambiguous
      if (next.kind === 'unavailable') {
        // Access is gone: nothing retained about the group stays on screen or in the draft.
        setDraft(emptyDraft)
        setRosterAtReview([])
        setLocal(null)
        setSaved(false)
      }
      setFailure(next)
      // A conflict, or a save that may or may not have landed, means the host should read the group again.
      if (next.kind === 'conflict' || next.ambiguous) props.onStale?.()
      return
    }
    unclear = false
    setDraft(emptyDraft)
    setReviewed(outcome.value.version)
    setRosterAtReview(outcome.value.participants)
    setSaved(true)
  }

  const summary = () => {
    const adds = draft().add.filter(
      (key) => !props.channel.participants.some((p) => participantKey(p) === key)
    ).length
    const removes = draft().remove.length
    if (adds === 0 && removes === 0) return 'No changes yet.'
    return [adds ? `${adds} to add` : null, removes ? `${removes} to remove` : null]
      .filter(Boolean)
      .join(', ')
  }

  return (
    <ModalDialog
      modal={false}
      class="max-h-full overflow-y-auto"
      open={props.open}
      onClose={props.onClose}
      title={hidden() ? 'Manage group' : `Manage ${props.channel.title}`}
      description="Who can read this conversation and take part in it."
    >
      <Show
        when={!hidden()}
        fallback={
          <div class="grid gap-4" data-group-unavailable="">
            <Alert role="alert" data-group-failure="unavailable">
              <AlertDescription>
                {sameWorkspace()
                  ? (failure()?.text ??
                    'This group is not available to you anymore, so nothing about it is shown.')
                  : 'This group belongs to a different workspace than the one you are in, so nothing about it is shown.'}
              </AlertDescription>
            </Alert>
            <div class="flex justify-end">
              <Button variant="outline" onClick={() => props.onClose()}>
                Close
              </Button>
            </div>
          </div>
        }
      >
        <div class="grid gap-4" aria-busy={pending()} data-group-manage="">
          <Show when={stale()}>
            <Alert role="alert" data-group-stale="">
              <AlertDescription>
                <span class="flex flex-col gap-2">
                  <span>
                    This group changed while you were editing (version {reviewed()} to{' '}
                    {props.channel.version}).
                    <Show when={changes().joined.length}>
                      {' '}
                      Added since: {changes().joined.map(labelOf).join(', ')}.
                    </Show>
                    <Show when={changes().left.length}>
                      {' '}
                      Removed since: {changes().left.map(labelOf).join(', ')}.
                    </Show>{' '}
                    Your changes are kept. Review the updated roster before saving.
                  </span>
                  <span>
                    <Button size="sm" variant="outline" onClick={review}>
                      Review updated roster
                    </Button>
                  </span>
                </span>
              </AlertDescription>
            </Alert>
          </Show>
          <Show when={archived()}>
            <Text variant="caption" tone="muted" role="status">
              This conversation is archived, so who is in it cannot change.
            </Text>
          </Show>
          <section class="flex flex-col gap-2" aria-label="Current participants">
            <Heading as="h3" size="subsection">
              Who is in this group
            </Heading>
            <RosterList label="Participants" rows={rows()}>
              {(row) => (
                <Show when={canChange() && row.tone !== 'adding' && !unavailable()}>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={pending()}
                    aria-pressed={row.tone === 'removing'}
                    aria-label={`${row.tone === 'removing' ? 'Keep' : 'Remove'} ${row.label}`}
                    onClick={() => toggleRemove(row.key)}
                  >
                    {row.tone === 'removing' ? 'Keep' : 'Remove'}
                  </Button>
                </Show>
              )}
            </RosterList>
          </section>
          <Show
            when={canChange()}
            fallback={
              <Text variant="caption" tone="muted" role="status" data-group-readonly="">
                {archived() || canManage() ? '' : groupAudienceCopy.manageNeedsAuthority}
              </Text>
            }
          >
            <section class="flex flex-col gap-2" aria-label="Add to this group">
              <Heading as="h3" size="subsection">
                Add people and Agents
              </Heading>
              <AudiencePicker
                choices={addable()}
                disabled={pending() || unavailable()}
                onToggle={toggleAdd}
                problems={failure()?.perParticipant ?? {}}
                selected={draft().add}
              />
            </section>
          </Show>
          <Notices />
          <Show when={local()}>
            {(text) => (
              <Alert role="alert" data-group-local="">
                <AlertDescription>{text()}</AlertDescription>
              </Alert>
            )}
          </Show>
          <Show when={failure()}>{(value) => <FailureAlert failure={value()} />}</Show>
          <Show when={saved()}>
            <Text variant="caption" role="status" data-group-saved="">
              Saved. The roster above is what the server now holds.
            </Text>
          </Show>
          <Show when={canChange()}>
            <div class="flex flex-wrap items-center justify-between gap-2">
              <Text variant="caption" tone="muted" role="status" data-group-draft-summary="">
                {summary()}
              </Text>
              <div class="flex gap-2">
                <Button variant="outline" onClick={() => props.onClose()}>
                  Close
                </Button>
                <Button
                  disabled={pending() || draftIsEmpty(draft()) || stale() || unavailable()}
                  onClick={() => void save()}
                >
                  {pending()
                    ? 'Saving…'
                    : failure()?.retrySame || failure()?.ambiguous
                      ? 'Try again'
                      : 'Save changes'}
                </Button>
              </div>
            </div>
          </Show>
          <Show when={!canChange()}>
            <div class="flex justify-end">
              <Button variant="outline" onClick={() => props.onClose()}>
                Close
              </Button>
            </div>
          </Show>
        </div>
      </Show>
    </ModalDialog>
  )
}
