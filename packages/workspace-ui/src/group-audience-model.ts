import { ApiClientError, type ApiGroupSelection } from '@adea-ai/api-client'
import type {
  AgentSummary,
  ConversationParticipantRef,
  GroupCreationRejectionReason,
  WorkspaceMemberRole,
  WorkspaceMemberSummary,
  WorkspaceSummary,
} from '@adea-ai/types'

/**
 * Group audience and Agent participation rules for adea-ai/adea#1178. Everything here is pure: the server
 * decides who is in a group and why, and this module only chooses who to ask for, remembers the draft and
 * says the result truthfully.
 *
 * The one rule that shapes it: **the client never makes a grant.** It sends a selection (user ids and
 * workspace-qualified Agent identities) and the server issues, bounds and checks every grant itself, inside
 * the same transaction that writes the roster. Member names, Agent names and ids only decide who to ask for;
 * none of them is ever an authority.
 */

/** What the person is told, in one place, so the dialogs, the tests and the PR describe the same behavior. */
export const groupAudienceCopy = {
  creatorFounded:
    'You start the group as its creator. The server checks that everyone you add belongs in it before the group is created.',
  earlierAccess:
    'Earlier history and earlier summaries are never shared by joining. Someone with a separate, explicit grant for them sees them; adding a person or an Agent does not.',
  joinPointHistory:
    'Everyone added sees the conversation from the moment they join. Messages sent before that stay hidden from them.',
  manageNeedsAuthority: 'Only workspace owners and admins can change who is in a group.',
  removal:
    'Removing someone stops them reading the conversation and taking turns right away. Jobs already started keep running under their own owner; removing someone does not cancel them. Records already kept are not erased.',
  sameNameAgents:
    'Agents can share a name. They are told apart by their workspace and their short id, and the server checks that identity, not the name.',
} as const

const UNKNOWN_WORKSPACE = 'Another workspace'

export function humanKey(userId: string) {
  return `user:${userId}`
}

/**
 * An Agent id is one global identifier, so it alone keys a choice. Its home workspace travels beside it as
 * part of the qualified identity a grant is issued for, and is what the label shows.
 */
export function agentKey(agentId: string) {
  return `agent:${agentId}`
}

export function participantKey(participant: ConversationParticipantRef) {
  return participant.kind === 'user' ? humanKey(participant.userId) : agentKey(participant.agentId)
}

export type HumanChoice = Readonly<{
  displayName: string | null
  key: string
  kind: 'human'
  role: WorkspaceMemberRole
  userId: string
}>

export type AgentChoice = Readonly<{
  agentId: string
  key: string
  kind: 'agent'
  name: string
  workspaceId: string
  workspaceLabel: string
}>

export type AudienceChoice = HumanChoice | AgentChoice

export type AudienceChoices = Readonly<{
  agents: readonly AgentChoice[]
  humans: readonly HumanChoice[]
}>

/** A choice as the person reads it. `label` already tells same-named choices apart. */
export type DescribedChoice<T extends AudienceChoice = AudienceChoice> = Readonly<{
  choice: T
  detail: string
  label: string
}>

function shortId(id: string) {
  return id.replaceAll('-', '').slice(0, 8)
}

/**
 * Choices come only from what the server lists for this tenant: its members and its active Agents.
 * `excludeUserId` leaves out the person who is creating or managing, who is never offered as someone to add.
 */
export function audienceChoices(input: {
  agents: readonly AgentSummary[]
  excludeUserId?: string
  members: readonly WorkspaceMemberSummary[]
  workspaces: readonly WorkspaceSummary[]
}): AudienceChoices {
  const workspaceNames = new Map(input.workspaces.map(({ id, name }) => [id, name]))
  return {
    agents: input.agents
      .filter((agent) => agent.lifecycleState === 'active')
      .map((agent) => ({
        agentId: agent.id,
        key: agentKey(agent.id),
        kind: 'agent' as const,
        name: agent.name,
        workspaceId: agent.workspaceId,
        workspaceLabel: workspaceNames.get(agent.workspaceId) ?? UNKNOWN_WORKSPACE,
      })),
    humans: input.members
      .filter(({ userId }) => userId !== input.excludeUserId)
      .map((member) => ({
        displayName: member.displayName,
        key: humanKey(member.userId),
        kind: 'human' as const,
        role: member.role,
        userId: member.userId,
      })),
  }
}

function roleLabel(role: WorkspaceMemberRole) {
  return role.charAt(0).toUpperCase() + role.slice(1)
}

/**
 * Labels the choices so no two read the same. A name that is unique reads as itself; a repeated name gains
 * what actually differs (a member's role and short id, an Agent's workspace and short id). The short id is
 * always added when the rest still collides, so two identical rows are never offered.
 */
function countLabels(labels: readonly string[]) {
  const seen = new Map<string, number>()
  for (const label of labels) seen.set(label, (seen.get(label) ?? 0) + 1)
  return seen
}

/**
 * Gives every item a label no other item has. The first form that is unique for an item is used; ids only
 * ever come in to break a tie, from a short prefix to the whole id when even that collides.
 */
function uniqueLabels(
  items: readonly { fuller: string; id: string; name: string }[],
  idPrefix = '',
  alwaysFuller = false
): string[] {
  const names = items.map(({ name }) => name)
  const nameCounts = countLabels(names)
  const fuller = items.map((item, index) =>
    alwaysFuller || (nameCounts.get(names[index]!) ?? 0) > 1 ? item.fuller : item.name
  )
  const fullerCounts = countLabels(fuller)
  const short = items.map((item, index) =>
    (fullerCounts.get(fuller[index]!) ?? 0) > 1
      ? `${fuller[index]} · ${idPrefix}${shortId(item.id)}`
      : fuller[index]!
  )
  const shortCounts = countLabels(short)
  return items.map((item, index) =>
    (shortCounts.get(short[index]!) ?? 0) > 1
      ? `${fuller[index]} · ${idPrefix}${item.id}`
      : short[index]!
  )
}

export function describeHumans(
  humans: readonly HumanChoice[]
): readonly DescribedChoice<HumanChoice>[] {
  const labels = uniqueLabels(
    humans.map((human) => {
      const name = human.displayName?.trim() || `Member ${shortId(human.userId)}`
      return { fuller: `${name} · ${roleLabel(human.role)}`, id: human.userId, name }
    })
  )
  return humans.map((human, index) => ({
    choice: human,
    detail: roleLabel(human.role),
    label: labels[index]!,
  }))
}

export function describeAgents(
  agents: readonly AgentChoice[]
): readonly DescribedChoice<AgentChoice>[] {
  const labels = uniqueLabels(
    agents.map((agent) => ({
      fuller: `${agent.name} · ${agent.workspaceLabel}`,
      id: agent.agentId,
      name: agent.name,
    })),
    'Agent ',
    // An Agent is always named with its workspace, as everywhere else in the group.
    true
  )
  return agents.map((agent, index) => ({
    choice: agent,
    detail: agent.workspaceLabel,
    label: labels[index]!,
  }))
}

/** The name of one participant already in a group, found by identity; unresolved ones keep a short id. */
export function participantLabel(
  participant: ConversationParticipantRef,
  choices: AudienceChoices,
  currentUserId?: string
): string {
  if (participant.kind === 'user') {
    if (participant.userId === currentUserId) return 'You'
    const found = describeHumans(choices.humans).find(
      ({ choice }) => choice.userId === participant.userId
    )
    return found?.label ?? `Member ${shortId(participant.userId)}`
  }
  const found = describeAgents(choices.agents).find(
    ({ choice }) => choice.agentId === participant.agentId
  )
  return found?.label ?? `Agent ${shortId(participant.agentId)} · ${UNKNOWN_WORKSPACE}`
}

/** What the person selected, remembered across a failed attempt: identity keys only. */
export type AudienceSelection = readonly string[]

export type ReconcileResult = Readonly<{
  /** Labels of selections whose choice is no longer offered, so the person is told, not silently changed. */
  dropped: readonly string[]
  kept: AudienceSelection
}>

/**
 * Keeps the selections whose identity is still offered. A member who left, an Agent that was archived or a
 * different workspace's list never keeps a selection that now names someone else.
 */
export function reconcileSelection(
  selected: AudienceSelection,
  previous: AudienceChoices,
  next: AudienceChoices
): ReconcileResult {
  const offered = new Set([...next.humans, ...next.agents].map(({ key }) => key))
  const labelled = new Map<string, string>()
  for (const { choice, label } of [
    ...describeHumans(previous.humans),
    ...describeAgents(previous.agents),
  ])
    labelled.set(choice.key, label)
  const kept: string[] = []
  const dropped: string[] = []
  for (const key of selected) {
    if (offered.has(key)) kept.push(key)
    else dropped.push(labelled.get(key) ?? 'Someone')
  }
  return { dropped, kept }
}

export function toggleSelection(selected: AudienceSelection, key: string): AudienceSelection {
  return selected.includes(key) ? selected.filter((entry) => entry !== key) : [...selected, key]
}

export function selectedChoices(selected: AudienceSelection, choices: AudienceChoices) {
  const chosen = new Set(selected)
  return {
    agents: choices.agents.filter(({ key }) => chosen.has(key)),
    humans: choices.humans.filter(({ key }) => chosen.has(key)),
  }
}

/**
 * The selection to send: qualified identities only, never a grant. Choices already carry their Agent's home
 * workspace; the dialogs refuse to send a member whose workspace is unknown instead of guessing one.
 */
export function groupSelection(input: {
  agents: readonly AgentChoice[]
  humans: readonly HumanChoice[]
}): ApiGroupSelection {
  return {
    agents: input.agents.map(({ agentId, workspaceId }) => ({ agentId, workspaceId })),
    humans: input.humans.map(({ userId }) => userId),
  }
}

/**
 * One create attempt. Its channel id and idempotency key stay the same for as long as the request does not
 * change, so a retry after a lost response replays the same request and cannot make a second group.
 */
export type GroupAttempt = Readonly<{
  channelId: string
  fingerprint: string
  idempotencyKey: string
}>

export function groupFingerprint(title: string, selected: AudienceSelection) {
  return JSON.stringify({ selected: selected.toSorted(), title: title.trim() })
}

/** The attempt to send: the previous one when nothing changed, otherwise a new identity. */
export function nextAttempt(
  previous: GroupAttempt | null,
  fingerprint: string,
  newId: () => string
): GroupAttempt {
  if (previous && previous.fingerprint === fingerprint) return previous
  return { channelId: newId(), fingerprint, idempotencyKey: newId() }
}

const rejectionCopy = {
  agent_inactive: 'This Agent is not active, so it cannot join.',
  agent_unknown: 'This Agent is not available to you.',
  audience_empty: 'A group needs at least one person.',
  audience_requires_human: 'A group needs at least one person, not only Agents.',
  duplicate_participant: 'This participant was listed twice.',
  grant_absent: 'No grant was provided for this participant.',
  grant_expired:
    'Access for this participant has expired. Remove them, then add them again to renew it.',
  grant_id_missing: 'The grant for this participant is not valid.',
  grant_mismatched_group: 'The grant for this participant belongs to a different group.',
  grant_mismatched_participant: 'The grant for this participant names someone else.',
  grant_not_yet_issued: 'The grant for this participant is not active yet.',
  grant_revision_invalid: 'The grant for this participant is not valid.',
  grant_revoked:
    'Access for this participant was withdrawn. Remove them, then add them again if they should come back.',
  grant_workspace_mismatch:
    'This participant belongs to a different workspace than the grant says.',
  group_id_missing: 'The group could not be identified.',
  group_workspace_missing: 'The group has no workspace.',
  participant_cross_tenant: 'This participant is outside this workspace and cannot join.',
  participant_unqualified: 'This participant could not be identified exactly.',
} as const satisfies Record<GroupCreationRejectionReason, string>

export type GroupFailureKind =
  | 'conflict'
  | 'invalid'
  | 'offline'
  | 'rejected'
  | 'unavailable'
  | 'unknown'

export type GroupFailure = Readonly<{
  /**
   * Whether the server may have committed the request. A group is only shown once the server confirms it, so
   * an ambiguous failure shows nothing, and sending the identical request again is the safe way to learn.
   */
  ambiguous: boolean
  kind: GroupFailureKind
  /** Reasons the server gave for individual participants, keyed by choice key. */
  perParticipant: Readonly<Record<string, string>>
  /** Whether the same request may be sent again unchanged. */
  retrySame: boolean
  text: string
}>

function isReason(value: unknown): value is GroupCreationRejectionReason {
  return typeof value === 'string' && Object.hasOwn(rejectionCopy, value)
}

function rejectionDetails(error: ApiClientError) {
  const perParticipant: Record<string, string> = {}
  const general: string[] = []
  for (const rejection of error.rejections ?? []) {
    const reason = isReason(rejection.reason) ? rejectionCopy[rejection.reason] : null
    const text = reason ?? 'The server refused this participant.'
    const participant = rejection.participant
    if (participant?.kind === 'user' && typeof participant.userId === 'string')
      perParticipant[humanKey(participant.userId)] = text
    else if (participant?.kind === 'agent' && typeof participant.agentId === 'string')
      perParticipant[agentKey(participant.agentId)] = text
    else general.push(text)
  }
  return { general, perParticipant }
}

/** Says what happened to a create or manage request, from what the server answered. */
export function groupFailure(error: unknown, operation: 'create' | 'manage'): GroupFailure {
  const none = {}
  if (error instanceof ApiClientError) {
    if (error.status === 401)
      return {
        ambiguous: false,
        kind: 'unavailable',
        perParticipant: none,
        retrySame: false,
        text: 'You are signed out. Sign in again, then try once more. Nothing was changed.',
      }
    if (error.status === 404 || error.status === 403 || error.code === 'workspace_unavailable')
      return {
        ambiguous: false,
        kind: 'unavailable',
        perParticipant: none,
        retrySame: false,
        text: 'This workspace or group is not available to you anymore. Your access may have been withdrawn, or it belongs to a different workspace. Nothing was changed.',
      }
    if (error.status === 409)
      return operation === 'manage'
        ? {
            ambiguous: false,
            kind: 'conflict',
            perParticipant: none,
            retrySame: false,
            text: 'Someone changed this group while you were editing. Your changes are kept. Review the updated roster, then save again. Nothing was changed.',
          }
        : {
            ambiguous: false,
            kind: 'conflict',
            perParticipant: none,
            retrySame: false,
            text: 'A group with this request already exists with different details. Review the details and try again.',
          }
    if (error.code === 'group_grant_rejected') {
      const { general, perParticipant } = rejectionDetails(error)
      return {
        ambiguous: false,
        kind: 'rejected',
        perParticipant,
        retrySame: false,
        text: `The server did not accept every participant, so ${
          operation === 'create' ? 'no group was created' : 'nothing was changed'
        }.${general.length ? ` ${general.join(' ')}` : ''} Fix the marked participants and try again.`,
      }
    }
    if (error.status >= 500)
      return operation === 'manage'
        ? manageUnclear('The server did not answer clearly', 'unknown')
        : {
            ambiguous: true,
            kind: 'unknown',
            perParticipant: none,
            retrySame: true,
            text: 'The server did not answer clearly, so it is not known whether this was saved. Trying again sends the same request and cannot make a second group.',
          }
    return {
      ambiguous: false,
      kind: 'invalid',
      perParticipant: none,
      retrySame: false,
      text: 'The server did not accept this request. Check the details and try again. Nothing was changed.',
    }
  }
  return operation === 'manage'
    ? manageUnclear('The request did not reach the server or its answer was lost', 'offline')
    : {
        ambiguous: true,
        kind: 'offline',
        perParticipant: none,
        retrySame: true,
        text: 'The request did not reach the server or its answer was lost, so it is not known whether this was saved. Trying again sends the same request and cannot make a second group.',
      }
}

/**
 * A roster save whose outcome is not known. Unlike a create, a retry is not the same request: it is checked
 * against the group's current version, so a save that did go through makes it a conflict, and the wording says
 * that, and says the group is being re-read so a save that did go through shows up in the roster.
 */
function manageUnclear(what: string, kind: 'offline' | 'unknown'): GroupFailure {
  return {
    ambiguous: true,
    kind,
    perParticipant: {},
    retrySame: false,
    text: `${what}, so it is not known whether your changes were saved. The group is being read again: if they were saved, the roster will change here and you will be asked to review it. Trying again is checked against the group's current version.`,
  }
}

/** A version conflict right after a save whose outcome was unknown: the earlier save may be what moved it. */
export const conflictAfterUnclearSave: GroupFailure = {
  ambiguous: false,
  kind: 'conflict',
  perParticipant: {},
  retrySame: false,
  text: 'The group changed since your changes were sent. Your earlier save may have gone through, or someone else may have edited it. Review the updated roster to see what it holds before saving again.',
}

export type SaveOutcome<T> =
  | Readonly<{ status: 'saved'; value: T }>
  | Readonly<{ status: 'failed'; failure: GroupFailure }>
  /** The workspace or account changed while the request ran: its answer belongs to nobody on screen now. */
  | Readonly<{ status: 'ignored' }>

/** Thrown by a send that found, after waiting, that the screen it started on is gone. */
export class StaleSaveError extends Error {
  constructor() {
    super('The account or workspace changed before the save could be sent.')
    this.name = 'StaleSaveError'
  }
}

/**
 * Runs one save with the context it started in. `context` returns a token that changes whenever the account,
 * workspace or group on screen changes. The send is handed `stillHere`, and must check it after every wait
 * and before anything that changes the server; if the token differs when the answer arrives, the answer is
 * dropped: it neither shows a group nor an error for somewhere else.
 */
export async function runGroupSave<T>(options: {
  context: () => string
  operation: 'create' | 'manage'
  send: (stillHere: () => boolean) => Promise<T>
}): Promise<SaveOutcome<T>> {
  const started = options.context()
  const stillHere = () => options.context() === started
  try {
    const value = await options.send(stillHere)
    return stillHere() ? { status: 'saved', value } : { status: 'ignored' }
  } catch (error) {
    if (!stillHere() || error instanceof StaleSaveError) return { status: 'ignored' }
    return { failure: groupFailure(error, options.operation), status: 'failed' }
  }
}

/** The roster the server confirmed, by identity key, for comparing with what was asked for. */
export function rosterKeys(participants: readonly ConversationParticipantRef[]) {
  return participants.map(participantKey).toSorted()
}

export type RosterDraft = Readonly<{
  /** Keys to add, from the offered choices. */
  add: AudienceSelection
  /** Keys of current participants to remove. */
  remove: AudienceSelection
}>

export const emptyDraft: RosterDraft = { add: [], remove: [] }

export function draftIsEmpty(draft: RosterDraft) {
  return draft.add.length === 0 && draft.remove.length === 0
}

/**
 * Applies a draft to a roster the server holds. Because the draft is relative to the roster (add these, remove
 * those), a roster that changed under it re-bases cleanly: someone already added is not added twice, and
 * someone already gone is not removed again.
 */
export function applyDraft(
  roster: readonly ConversationParticipantRef[],
  draft: RosterDraft,
  choices: AudienceChoices
): readonly ConversationParticipantRef[] {
  const removing = new Set(draft.remove)
  const kept = roster.filter((participant) => !removing.has(participantKey(participant)))
  const present = new Set(kept.map(participantKey))
  const added: ConversationParticipantRef[] = []
  for (const key of draft.add) {
    if (present.has(key)) continue
    const human = choices.humans.find((choice) => choice.key === key)
    if (human) added.push({ kind: 'user', userId: human.userId })
    const agent = choices.agents.find((choice) => choice.key === key)
    if (agent) added.push({ agentId: agent.agentId, kind: 'agent' })
    present.add(key)
  }
  return [...kept, ...added]
}

export type RosterChange = Readonly<{
  /** Draft entries the roster already satisfies after someone else's change. */
  satisfied: readonly string[]
  /** Participants who joined the roster since the draft was started. */
  joined: readonly string[]
  /** Participants who left the roster since the draft was started. */
  left: readonly string[]
}>

/** What changed between two server rosters, by key, and which draft entries it made moot. */
export function rosterChange(
  before: readonly ConversationParticipantRef[],
  after: readonly ConversationParticipantRef[],
  draft: RosterDraft
): RosterChange {
  const was = new Set(before.map(participantKey))
  const is = new Set(after.map(participantKey))
  return {
    joined: [...is].filter((key) => !was.has(key)),
    left: [...was].filter((key) => !is.has(key)),
    satisfied: [
      ...draft.add.filter((key) => is.has(key)),
      ...draft.remove.filter((key) => !is.has(key)),
    ],
  }
}

/** Drops draft entries a changed roster made moot or the choices no longer offer; says which. */
export function rebaseDraft(
  draft: RosterDraft,
  roster: readonly ConversationParticipantRef[],
  choices: AudienceChoices
): Readonly<{ draft: RosterDraft; droppedAdds: number }> {
  const present = new Set(roster.map(participantKey))
  const offered = new Set([...choices.humans, ...choices.agents].map(({ key }) => key))
  const add = draft.add.filter((key) => !present.has(key) && offered.has(key))
  return {
    draft: { add, remove: draft.remove.filter((key) => present.has(key)) },
    droppedAdds: draft.add.filter((key) => !present.has(key) && !offered.has(key)).length,
  }
}

export function canManageGroup(
  members: readonly WorkspaceMemberSummary[],
  currentUserId: string | undefined
) {
  const role = members.find(({ userId }) => userId === currentUserId)?.role
  return role === 'owner' || role === 'admin'
}
