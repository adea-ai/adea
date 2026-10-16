import type {
  AgentSummary,
  ChannelSummary,
  ConversationParticipantRef,
  GroupAgentEnlistmentGrant,
  GroupAudienceGrant,
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
  Show,
  untrack,
  type JSX,
} from 'solid-js'

import {
  applyDraft,
  audienceChoices,
  canManageGroup,
  checkIssuedGrants,
  describeAgents,
  describeHumans,
  draftIsEmpty,
  emptyDraft,
  grantRequest,
  groupAudienceCopy,
  GroupGrantUnavailableError,
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
  type GroupGrantIssuer,
  type IssuedGroupGrants,
  type RosterDraft,
} from './group-audience-model'
import { createClientRequestId } from './request-id'

export { canManageGroup } from './group-audience-model'
export type { AudienceChoices, GroupGrantIssuer } from './group-audience-model'

/** What the server needs to create a group, exactly as the person's choices produced it. */
export type GroupCreateRequest = Readonly<{
  audienceGrants: readonly GroupAudienceGrant[]
  channelId: string
  enlistmentGrants: readonly GroupAgentEnlistmentGrant[]
  idempotencyKey: string
  title: string
}>

/** What the server needs to replace a group's roster: grants for everyone who is listed, and the version seen. */
export type GroupRosterSaveRequest = Readonly<{
  audienceGrants: readonly GroupAudienceGrant[]
  enlistmentGrants: readonly GroupAgentEnlistmentGrant[]
  expectedVersion: number
  participants: readonly ConversationParticipantRef[]
}>

/**
 * Everything the create and manage surfaces know about the tenant: the lists the server returned for this
 * workspace, and `issueGrants`, the trusted source of grants, which is absent until one exists.
 */
export type GroupAudienceContext = Readonly<{
  /** Home workspace of Agents the list does not include, learned from the group's own retained turns. */
  agentHomes?: ReadonlyMap<string, string>
  agents: readonly AgentSummary[]
  currentUserId: string | undefined
  issueGrants?: GroupGrantIssuer
  members?: readonly WorkspaceMemberSummary[]
  workspaceId: string
  workspaces: readonly WorkspaceSummary[]
}>

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

/** Asks the issuer, then proves what came back is what was asked for. Anything else is not sent. */
async function issueChecked(
  issue: GroupGrantIssuer,
  request: ReturnType<typeof grantRequest>
): Promise<IssuedGroupGrants> {
  let issued: IssuedGroupGrants
  try {
    issued = await issue(request)
  } catch (error) {
    throw new GroupGrantUnavailableError(error)
  }
  const checked = checkIssuedGrants(request, issued)
  if (!checked.ok) throw new GroupGrantUnavailableError()
  return checked.grants
}

const noGrants: IssuedGroupGrants = { audienceGrants: [], enlistmentGrants: [] }

/**
 * The new-group dialog. With a grant issuer it lets the person pick the actual audience and enlist Agents;
 * without one it says plainly that the group starts with only its creator. The group is shown as created only
 * when the server's answer arrives, and every failure keeps the title and selections for another try.
 */
export function CreateGroupDialog(props: {
  audience?: GroupAudienceContext
  busy: boolean
  onClose: () => void
  /** Legacy callers resolve with nothing and the dialog closes; a returned channel is shown as confirmed. */
  onCreate: (title: string, request?: GroupCreateRequest) => Promise<ChannelSummary | void>
  onOpen?: (channelId: string) => void
  open: boolean
}) {
  const [title, setTitle] = createSignal('')
  const [selected, setSelected] = createSignal<AudienceSelection>([])
  const [failure, setFailure] = createSignal<GroupFailure | null>(null)
  const [pending, setPending] = createSignal(false)
  const [created, setCreated] = createSignal<ChannelSummary | null>(null)
  const [notice, setNotice] = createSignal<string | null>(null)
  let attempt: GroupAttempt | null = null
  let inFlight = false
  const titleId = createUniqueId()
  // A memo, so the effects below run when the account or workspace changes, not whenever the tenant's lists reload.
  const context = createMemo(
    () => `${props.audience?.workspaceId ?? ''}|${props.audience?.currentUserId ?? ''}`
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
  const canIssue = () => Boolean(props.audience?.issueGrants)
  const empty = createMemo(() => title().trim().length === 0)

  // A different account or workspace is a different group: nothing typed or selected carries over.
  createEffect(
    on(
      context,
      () => {
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
    setPending(true)
    setFailure(null)
    const text = title().trim()
    const chosen = selectedChoices(selected(), choices())
    const current = nextAttempt(attempt, groupFingerprint(text, selected()), createClientRequestId)
    attempt = current
    const outcome = await runGroupSave({
      context,
      operation: 'create',
      send: async () => {
        let grants = current.grants
        if (!grants) {
          const wanted = chosen.humans.length + chosen.agents.length
          const issue = props.audience?.issueGrants
          if (wanted > 0 && !issue) throw new GroupGrantUnavailableError()
          grants =
            wanted > 0 && issue
              ? await issueChecked(
                  issue,
                  grantRequest({
                    agents: chosen.agents,
                    groupId: current.channelId,
                    humans: chosen.humans,
                    workspaceId: props.audience!.workspaceId,
                  })
                )
              : noGrants
          attempt = { ...current, grants }
        }
        return props.onCreate(text, {
          audienceGrants: grants.audienceGrants,
          channelId: current.channelId,
          enlistmentGrants: grants.enlistmentGrants,
          idempotencyKey: current.idempotencyKey,
          title: text,
        })
      },
    })
    inFlight = false
    setPending(false)
    if (outcome.status === 'ignored') return
    if (outcome.status === 'failed') {
      // A refused request is a different request next time: its grants are not reused.
      if (outcome.failure.kind === 'conflict') attempt = null
      else if (!outcome.failure.retrySame) attempt = attempt ? { ...attempt, grants: null } : null
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
      canIssue() && JSON.stringify(rosterKeys(channel.participants)) !== JSON.stringify(expected)
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
            <Show
              when={canIssue()}
              fallback={
                <Text variant="caption" tone="muted" role="status" data-group-issuer-missing="">
                  {groupAudienceCopy.issuerMissing}
                </Text>
              }
            >
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
  const sameWorkspace = () => props.channel.workspaceId === props.audience.workspaceId
  const archived = () => props.channel.lifecycleState !== 'active'
  const canManage = () =>
    props.audience.members
      ? canManageGroup(props.audience.members, props.audience.currentUserId)
      : false
  const canChange = () => canManage() && Boolean(props.audience.issueGrants) && !archived()
  const stale = () => props.channel.version !== reviewed()
  const unavailable = () => failure()?.kind === 'unavailable'

  createEffect(
    on(
      context,
      () => {
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
    const issue = props.audience.issueGrants!
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
        `The workspace of ${unknown.join(', ')} is not known here, so a grant cannot be requested for ${unknown.length === 1 ? 'it' : 'them'}. Remove ${unknown.length === 1 ? 'it' : 'them'} from the group or save from a place that knows ${unknown.length === 1 ? 'its' : 'their'} workspace.`
      )
      return
    }
    inFlight = true
    setPending(true)
    setFailure(null)
    setSaved(false)
    const expectedVersion = props.channel.version
    const outcome = await runGroupSave({
      context,
      operation: 'manage',
      send: async () => {
        const request = {
          agents,
          groupId: props.channel.id,
          humans,
          workspaceId: props.audience.workspaceId,
        }
        const grants = await issueChecked(issue, request)
        return props.onSave({ ...grants, expectedVersion, participants })
      },
    })
    inFlight = false
    setPending(false)
    if (outcome.status === 'ignored') return
    if (outcome.status === 'failed') {
      setFailure(outcome.failure)
      if (outcome.failure.kind === 'conflict') props.onStale?.()
      return
    }
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
      title={sameWorkspace() ? `Manage ${props.channel.title}` : 'Manage group'}
      description="Who can read this conversation and take part in it."
    >
      <Show
        when={sameWorkspace()}
        fallback={
          <Alert role="alert" data-group-failure="unavailable">
            <AlertDescription>
              This group belongs to a different workspace than the one you are in, so nothing about
              it is shown.
            </AlertDescription>
          </Alert>
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
                {archived()
                  ? ''
                  : !canManage()
                    ? groupAudienceCopy.manageNeedsAuthority
                    : groupAudienceCopy.manageNeedsIssuer}
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
                  {pending() ? 'Saving…' : failure()?.retrySame ? 'Try again' : 'Save changes'}
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
