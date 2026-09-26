import { decodeCbor, decodeRuntimeEvent } from '@adea-ai/types/dev-runtime'
import type {
  DevRuntimePage,
  DevStreamFrame,
  Group,
  Project,
  RuntimeEvent,
  RuntimeSession,
  Scope,
} from '@adea-ai/types/dev-runtime'
import type { DevRuntimeService, DevStreamTransportSocket } from '../../platform'

import { buildDevCommand } from '../../browser/command'
import {
  ChatRuntimeError,
  executeChatCommand,
  eventSourceForStream,
  launchBody,
  makeChatUserInput,
  sessionResource,
} from './commands'
import {
  acceptRuntimeStreamFrame,
  CHAT_EVENT_RETENTION_LIMIT,
  createTranscriptAccumulator,
  type TranscriptAccumulator,
} from './transcript'
import type {
  ChatConversation,
  ChatConversationProjection,
  ChatConversationStatus,
  ChatGroupProjection,
  ChatInputTransport,
  ChatProjectProjection,
  ConversationCreateInput,
  ConversationModelOptions,
  ConversationRegistryInput,
} from './types'

export * from './commands'
export * from './transcript'
export * from './types'

const lifecycleByEvent: Readonly<Record<string, ChatConversationStatus>> = {
  'session.starting': 'preparing',
  'session.ready': 'ready',
  'session.resumed': 'active',
  'session.disconnected': 'disconnected',
  'session.completed': 'completed',
  'session.failed': 'failed',
  'session.cancelled': 'cancelled',
}

/** Matches the host's durable session-create result replay window. */
export const CHAT_CREATE_REPLAY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000

function scopeMatches(left: Scope, right: Scope): boolean {
  return (
    left.accountId === right.accountId &&
    left.workspaceId === right.workspaceId &&
    left.runtimeNodeId === right.runtimeNodeId
  )
}

function eventSequence(event: RuntimeEvent): bigint {
  try {
    return BigInt(event.seq)
  } catch {
    return -1n
  }
}

function compareEvents(left: RuntimeEvent, right: RuntimeEvent): number {
  if (left.generation !== right.generation) return left.generation < right.generation ? -1 : 1
  const leftSequence = eventSequence(left)
  const rightSequence = eventSequence(right)
  return leftSequence === rightSequence ? 0 : leftSequence < rightSequence ? -1 : 1
}

function eventIdentity(event: RuntimeEvent): string {
  return `${event.generation}\u0000${event.source}\u0000${event.sourceEventId}`
}

function mergeSessionEvents(
  runtimeSessionId: string,
  existing: readonly RuntimeEvent[],
  incoming: readonly RuntimeEvent[]
): RuntimeEvent[] {
  const merged = [...existing]
  for (const event of incoming) {
    if (event.runtimeSessionId !== runtimeSessionId) continue
    // The incoming identity is invariant across the scan; the previous
    // predicate rebuilt it for every retained event on every frame.
    const id = eventIdentity(event)
    let alreadyPresent = false
    for (const entry of merged)
      if (eventIdentity(entry) === id) {
        alreadyPresent = true
        break
      }
    if (alreadyPresent) continue
    merged.push(event)
  }
  // Streamed events arrive in ascending sequence, so the common case is already
  // ordered and within the retention window: skip the sort entirely. A Set of
  // identities was tried here for batch appends and measured WORSE in the
  // dominant single-append-per-frame shape (0.237ms vs 0.160ms at 1000 events),
  // because rebuilding the Set costs more than the one scan it replaces.
  if (merged.length <= CHAT_EVENT_RETENTION_LIMIT && isOrdered(compareEvents, merged)) return merged
  return merged.toSorted(compareEvents).slice(-CHAT_EVENT_RETENTION_LIMIT)
}

/** True when `values` is already in ascending order under `compare`. */
function isOrdered(compare: (a: RuntimeEvent, b: RuntimeEvent) => number, values: RuntimeEvent[]) {
  for (let index = 1; index < values.length; index += 1)
    if (compare(values[index - 1]!, values[index]!) > 0) return false
  return true
}

function payloadText(event: RuntimeEvent): string | undefined {
  if (
    event.kind !== 'turn.user_input' ||
    event.payload === null ||
    typeof event.payload !== 'object'
  )
    return undefined
  const payload = event.payload as Record<string, unknown>
  for (const key of ['text', 'content', 'message']) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/** Derive a title from canonical user-turn events; never from terminal bytes. */
export function deriveConversationTitle(
  session: RuntimeSession,
  events: readonly RuntimeEvent[]
): string {
  // Linear minimum rather than a full sort: the answer is the FIRST prompt in
  // sequence order, so sorting the whole window to read element zero was
  // O(n log n) for an O(n) question. The minimum is taken over events that
  // actually carry prompt text, matching the original `map(payloadText).find()`
  // — taking the minimum over all events would drop an earlier non-prompt
  // event's contribution to the search.
  let firstText: string | undefined
  let first: RuntimeEvent | undefined
  for (const event of events) {
    if (event.runtimeSessionId !== session.id || event.generation > session.generation) continue
    const text = payloadText(event)
    if (text === undefined) continue
    if (first === undefined || compareEvents(event, first) < 0) {
      first = event
      firstText = text
    }
  }
  if (firstText) return Array.from(firstText).slice(0, 80).join('').trim()
  return session.displayName?.trim() || 'New conversation'
}

/** Lifecycle status comes from canonical session state/events only. */
export function deriveConversationStatus(
  session: RuntimeSession,
  events: readonly RuntimeEvent[]
): ChatConversationStatus {
  // Same shape: a linear maximum instead of sorting the window to read the
  // last element.
  let latest: RuntimeEvent | undefined
  for (const event of events) {
    if (event.runtimeSessionId !== session.id || event.generation !== session.generation) continue
    if (latest === undefined || compareEvents(event, latest) > 0) latest = event
  }
  return (latest ? lifecycleByEvent[latest.kind] : undefined) ?? session.lifecycle
}

function groupsForProject(project: Project, groups: readonly Group[]): string[] {
  return groups
    .filter(
      (group) => project.groupIds.includes(group.id) && scopeMatches(group.scope, project.scope)
    )
    .toSorted((left, right) => left.sortKey.localeCompare(right.sortKey))
    .map((group) => group.id)
}

export function projectChatConversations(
  input: ConversationRegistryInput
): ChatConversationProjection {
  const projectsById = new Map(
    input.projects
      .filter((project) => scopeMatches(project.scope, input.scope))
      .map((project) => [project.id, project])
  )
  const groups = input.groups
    .filter((group) => scopeMatches(group.scope, input.scope))
    .toSorted((left, right) => left.sortKey.localeCompare(right.sortKey))
    .map<ChatGroupProjection>((group) => ({
      id: group.id,
      name: group.name,
      projectIds: [...group.projectIds],
    }))
  const conversations: ChatConversation[] = []
  for (const session of input.sessions) {
    if (!scopeMatches(session.scope, input.scope)) continue
    const project = projectsById.get(session.projectId)
    if (!project) continue
    const events = [...(input.events?.get(session.id) ?? [])]
    const retentionEvents = events.toSorted(compareEvents)
    const draft = input.drafts?.get(session.id) ?? ''
    conversations.push({
      runtimeSessionId: session.id,
      scope: input.scope,
      projectId: session.projectId,
      repoId: session.repoId,
      worktreeId: session.worktreeId,
      groupIds: groupsForProject(project, input.groups),
      title: deriveConversationTitle(session, events),
      status: deriveConversationStatus(session, events),
      archived: session.archived,
      projection: session.projection,
      generation: session.generation,
      version: session.version,
      ...(session.activeHarnessRunId !== undefined
        ? { activeHarnessRunId: session.activeHarnessRunId }
        : {}),
      draft,
      events,
      retention: {
        maxEvents: 1_000,
        ...(retentionEvents[0] ? { oldestSequence: retentionEvents[0].seq } : {}),
        ...(retentionEvents.at(-1) ? { newestSequence: retentionEvents.at(-1)!.seq } : {}),
        // A projected event array has no proof that earlier retained windows
        // were loaded. Only the runtime-events-v1 stream can supply that fact.
        complete: false,
      },
    })
  }
  // One pass to bucket conversations by project, instead of re-filtering the
  // whole conversation list inside the project map (O(projects x conversations)).
  const conversationIdsByProject = new Map<string, string[]>()
  for (const conversation of conversations) {
    const bucket = conversationIdsByProject.get(conversation.projectId)
    if (bucket) bucket.push(conversation.runtimeSessionId)
    else conversationIdsByProject.set(conversation.projectId, [conversation.runtimeSessionId])
  }
  const projects = input.projects
    .filter((project) => scopeMatches(project.scope, input.scope))
    .map<ChatProjectProjection>((project) => ({
      id: project.id,
      name: project.name,
      groupIds: groupsForProject(project, input.groups),
      conversationIds: conversationIdsByProject.get(project.id) ?? [],
    }))
  return { scope: input.scope, groups, projects, conversations }
}

export type ChatConversationModel = Readonly<{
  create(input: ConversationCreateInput): Promise<ChatConversation>
  attach(runtimeSessionId: string): Promise<ChatConversation>
  list(options?: {
    projectId?: string
    worktreeId?: string
    archived?: boolean
    cursor?: string
    limit?: number
  }): Promise<readonly ChatConversation[]>
  remember(session: RuntimeSession, events?: readonly RuntimeEvent[]): ChatConversation
  project(): ChatConversationProjection
  setDraft(runtimeSessionId: string, draft: string): ChatConversation
  switchTo(runtimeSessionId: string): ChatConversation
  resume(runtimeSessionId: string, harnessRunId?: string): Promise<ChatConversation>
  cancel(runtimeSessionId: string, harnessRunId?: string): Promise<ChatConversation>
  archive(runtimeSessionId: string, reason?: string): Promise<ChatConversation>
  unarchive(runtimeSessionId: string): Promise<ChatConversation>
  send(runtimeSessionId: string, text: string): Promise<void>
  openTranscript(
    runtimeSessionId: string,
    options?: { fromSequence?: string; source?: RuntimeEvent['source'] }
  ): Promise<{
    state: () => TranscriptAccumulator
    /**
     * Registers a listener invoked on every accepted frame (and once on
     * close). Subscribing replaces polling: a surface that only re-reads
     * `state` on a timer wakes the UI thread forever while idle and still
     * renders up to one tick stale.
     */
    subscribe: (listener: (state: TranscriptAccumulator) => void) => () => void
    close: () => void
  }>
}>

export function createChatConversationModel(
  service: DevRuntimeService,
  scope: Scope,
  options: ConversationModelOptions = {}
): ChatConversationModel {
  const sessions = new Map<string, RuntimeSession>()
  const events = new Map<string, RuntimeEvent[]>()
  const drafts = new Map<string, string>()
  const groups: Group[] = []
  const projects: Project[] = []
  type CreateRequest = {
    fingerprint: string
    promise?: Promise<ChatConversation>
    result?: ChatConversation
    createdAt: number
    expirationTimer?: ReturnType<typeof setTimeout>
  }
  const createRequests = new Map<string, CreateRequest>()
  const now = options.now ?? (() => new Date())
  const randomId = options.randomId ?? (() => crypto.randomUUID())
  let selectedRuntimeSessionId: string | undefined

  const registry = (): ChatConversationProjection =>
    projectChatConversations({
      scope,
      groups,
      projects,
      sessions: [...sessions.values()],
      events,
      drafts,
    })
  const loadHierarchy = async (): Promise<void> => {
    const [projectPage, groupPage] = await Promise.all([
      executeChatCommand<DevRuntimePage<Project>>(
        service,
        buildDevCommand({ operation: 'dev.project.list', scope, body: {} })
      ),
      executeChatCommand<DevRuntimePage<Group>>(
        service,
        buildDevCommand({ operation: 'dev.group.list', scope, body: {} })
      ),
    ])
    if (projectPage.nextCursor !== undefined || groupPage.nextCursor !== undefined)
      throw new ChatRuntimeError({
        code: 'invalid_state',
        retryable: true,
        message: 'Project and group registry pages must be complete before projection.',
      })
    projects.splice(0, projects.length, ...projectPage.items)
    groups.splice(0, groups.length, ...groupPage.items)
  }
  const requireConversation = (runtimeSessionId: string): ChatConversation => {
    const conversation = registry().conversations.find(
      (item) => item.runtimeSessionId === runtimeSessionId
    )
    if (!conversation)
      throw new ChatRuntimeError({
        code: 'not_found',
        retryable: false,
        message: `Runtime session ${runtimeSessionId} was not found.`,
      })
    return conversation
  }
  const remember = (
    session: RuntimeSession,
    newEvents: readonly RuntimeEvent[] = []
  ): ChatConversation => {
    if (!scopeMatches(session.scope, scope))
      throw new ChatRuntimeError({
        code: 'identity_mismatch',
        retryable: false,
        message: 'Runtime session belongs to another scope.',
      })
    if (!projects.some((project) => project.id === session.projectId))
      throw new ChatRuntimeError({
        code: 'not_found',
        retryable: true,
        message: 'The canonical project registry has not resolved this session.',
      })
    sessions.set(session.id, session)
    events.set(session.id, mergeSessionEvents(session.id, events.get(session.id) ?? [], newEvents))
    selectedRuntimeSessionId = selectedRuntimeSessionId ?? session.id
    return requireConversation(session.id)
  }
  const refresh = async (runtimeSessionId: string): Promise<ChatConversation> => {
    const command = buildDevCommand({
      operation: 'dev.session.get',
      scope,
      body: { runtimeSessionId },
      resource: sessions.has(runtimeSessionId)
        ? sessionResource(sessions.get(runtimeSessionId)!)
        : undefined,
    })
    return remember(
      await executeChatCommand<RuntimeSession>(service, command),
      events.get(runtimeSessionId)
    )
  }
  const create = async (input: ConversationCreateInput): Promise<ChatConversation> => {
    const hasAgentProfileId = input.agentProfileId !== undefined
    const hasAgentProfileVersion = input.agentProfileVersion !== undefined
    if (
      hasAgentProfileId !== hasAgentProfileVersion ||
      (input.initialPrompt !== undefined && (!hasAgentProfileId || !hasAgentProfileVersion))
    )
      throw new ChatRuntimeError({
        code: 'invalid_state',
        retryable: false,
        message: 'An agent profile is required when creating a prompted conversation.',
      })
    const idempotencyKey = input.idempotencyKey ?? randomId()
    const cutoff = now().getTime() - CHAT_CREATE_REPLAY_RETENTION_MS
    for (const [key, request] of createRequests) {
      if (request.createdAt <= cutoff) {
        if (request.expirationTimer !== undefined) clearTimeout(request.expirationTimer)
        createRequests.delete(key)
      }
    }
    const fingerprint = JSON.stringify({ ...input, idempotencyKey: undefined })
    const existing = createRequests.get(idempotencyKey)
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new ChatRuntimeError({
          code: 'idempotency_conflict',
          retryable: false,
          message: 'The idempotency key was reused for another conversation.',
        })
      if (existing.result) return existing.result
      if (existing.promise) return existing.promise
    }
    const request: CreateRequest = {
      fingerprint,
      createdAt: now().getTime(),
    }
    const promise = (async () => {
      await loadHierarchy()
      if (!projects.some((project) => project.id === input.projectId))
        throw new ChatRuntimeError({
          code: 'not_found',
          retryable: true,
          message: 'The canonical project registry has not resolved this conversation project.',
        })
      const createCommand = buildDevCommand({
        operation: 'dev.session.create',
        scope,
        body: {
          projectId: input.projectId,
          repoId: input.repoId,
          worktreeId: input.worktreeId,
          ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
          ...(input.agentProfileId !== undefined ? { agentProfileId: input.agentProfileId } : {}),
          ...(input.agentProfileVersion !== undefined
            ? { agentProfileVersion: input.agentProfileVersion }
            : {}),
          ...(input.harnessInstallationId !== undefined
            ? { harnessInstallationId: input.harnessInstallationId }
            : {}),
        },
        idempotencyKey,
      })
      const created = await executeChatCommand<RuntimeSession>(service, createCommand)
      const currentRequest = createRequests.get(idempotencyKey)
      if (currentRequest !== request) {
        // A newer request owns this key after the replay window elapsed. Do
        // not admit the late response into the projection; let the caller
        // observe the replacement result when it is available.
        if (currentRequest?.result) return currentRequest.result
        if (currentRequest?.promise) return currentRequest.promise
        return requireConversation(created.id)
      }
      let canonical = remember(created)
      if (input.agentProfileId !== undefined || input.initialPrompt !== undefined) {
        // An expired pending request may finish after a newer retry has
        // replayed the same host idempotency key. Only the current request
        // may orchestrate the launch, so a late transport response cannot
        // duplicate the side effect.
        if (createRequests.get(idempotencyKey) !== request) return canonical
        const launchOperation = input.harnessInstallationId
          ? 'dev.session.launchHarness'
          : 'dev.session.launchDefault'
        const launchCommand = buildDevCommand({
          operation: launchOperation,
          scope,
          body: launchBody(created, input),
          resource: sessionResource(created),
          idempotencyKey,
        })
        await executeChatCommand(service, launchCommand)
        canonical = await refresh(created.id)
      }
      return canonical
    })()
    request.promise = promise as Promise<ChatConversation>
    createRequests.set(idempotencyKey, request)
    const expirationTimer = setTimeout(() => {
      if (createRequests.get(idempotencyKey) === request) createRequests.delete(idempotencyKey)
    }, CHAT_CREATE_REPLAY_RETENTION_MS)
    request.expirationTimer = expirationTimer
    if (typeof expirationTimer === 'object' && expirationTimer !== null)
      (expirationTimer as { unref?: () => void }).unref?.()
    try {
      const result = await promise
      if (createRequests.get(idempotencyKey) === request) request.result = result
      return result
    } catch (error) {
      // A transport loss may follow a committed host create. Keep the body's
      // fingerprint, but retry the same key through the durable host replay.
      if (createRequests.get(idempotencyKey) === request) request.promise = undefined
      throw error
    } finally {
      if (createRequests.get(idempotencyKey) === request) request.promise = undefined
    }
  }
  const attach = async (runtimeSessionId: string): Promise<ChatConversation> => {
    await loadHierarchy()
    let cursor: string | undefined
    const seenCursors = new Set<string>()
    let session: RuntimeSession | undefined
    do {
      const body = cursor === undefined ? { limit: 500 } : { cursor, limit: 500 }
      const page = await executeChatCommand<DevRuntimePage<RuntimeSession>>(
        service,
        buildDevCommand({ operation: 'dev.session.list', scope, body })
      )
      session = page.items.find((item) => item.id === runtimeSessionId)
      if (session) break
      if (page.nextCursor !== undefined) {
        if (seenCursors.has(page.nextCursor))
          throw new ChatRuntimeError({
            code: 'invalid_state',
            retryable: true,
            message: 'The runtime session list returned a repeated cursor.',
          })
        seenCursors.add(page.nextCursor)
      }
      cursor = page.nextCursor
    } while (cursor !== undefined)
    if (!session)
      throw new ChatRuntimeError({
        code: 'not_found',
        retryable: false,
        message: `Runtime session ${runtimeSessionId} was not found.`,
      })
    return remember(session)
  }
  const mutateSession = async (
    runtimeSessionId: string,
    operation: 'dev.session.resumeHarness' | 'dev.session.cancelHarness',
    harnessRunId?: string
  ): Promise<ChatConversation> => {
    const current = sessions.get(runtimeSessionId)
      ? requireConversation(runtimeSessionId)
      : await attach(runtimeSessionId)
    const runId = harnessRunId ?? current.activeHarnessRunId
    if (!runId)
      throw new ChatRuntimeError({
        code: 'invalid_state',
        retryable: false,
        message: 'No harness run is bound to this session.',
      })
    const command = buildDevCommand({
      operation,
      scope,
      body: { runtimeSessionId, expectedGeneration: current.generation, harnessRunId: runId },
      resource: sessionResource(sessions.get(runtimeSessionId)!),
    })
    await executeChatCommand(service, command)
    return refresh(runtimeSessionId)
  }
  const archive = async (runtimeSessionId: string, reason?: string): Promise<ChatConversation> => {
    const current = sessions.get(runtimeSessionId)
      ? requireConversation(runtimeSessionId)
      : await attach(runtimeSessionId)
    const command = buildDevCommand({
      operation: 'dev.session.archive',
      scope,
      body: {
        runtimeSessionId,
        expectedGeneration: current.generation,
        ...(reason !== undefined ? { reason } : {}),
      },
      resource: sessionResource(sessions.get(runtimeSessionId)!),
    })
    await executeChatCommand(service, command)
    return refresh(runtimeSessionId)
  }
  const unarchive = async (runtimeSessionId: string): Promise<ChatConversation> => {
    const current = sessions.get(runtimeSessionId)
      ? requireConversation(runtimeSessionId)
      : await attach(runtimeSessionId)
    const command = buildDevCommand({
      operation: 'dev.session.unarchive',
      scope,
      body: { runtimeSessionId, expectedGeneration: current.generation },
      resource: sessionResource(sessions.get(runtimeSessionId)!),
    })
    await executeChatCommand(service, command)
    return refresh(runtimeSessionId)
  }
  const send = async (runtimeSessionId: string, text: string): Promise<void> => {
    const conversation = requireConversation(runtimeSessionId)
    if (conversation.archived || !['active', 'ready'].includes(conversation.status))
      throw new ChatRuntimeError({
        code: 'invalid_state',
        retryable: false,
        message: 'Chat input is unavailable for this session state.',
      })
    const sendInput: ChatInputTransport | undefined = options.sendInput
    if (!sendInput)
      throw new ChatRuntimeError({
        code: 'capability_unavailable',
        retryable: false,
        message: 'Chat input transport is unavailable.',
      })
    await sendInput(
      makeChatUserInput({ runtimeSessionId, generation: conversation.generation, text, now })
    )
  }
  const openTranscript = async (
    runtimeSessionId: string,
    streamOptions: { fromSequence?: string; source?: RuntimeEvent['source'] } = {}
  ) => {
    const current = sessions.get(runtimeSessionId)
      ? requireConversation(runtimeSessionId)
      : await attach(runtimeSessionId)
    const command = buildDevCommand({
      operation: 'dev.session.events',
      scope,
      body: {
        runtimeSessionId,
        expectedGeneration: current.generation,
        direction: 'read',
        ...(streamOptions.fromSequence !== undefined
          ? { fromSequence: streamOptions.fromSequence }
          : {}),
      },
      resource: sessionResource(sessions.get(runtimeSessionId)!),
    })
    const grant = await executeChatCommand<{
      resource: { generation: number }
      fromSequence: string
    }>(service, command)
    const transport = service.streams?.()
    if (!transport)
      throw new ChatRuntimeError({
        code: 'capability_unavailable',
        retryable: false,
        message: 'Runtime event stream is unavailable.',
      })
    let transcript = createTranscriptAccumulator({
      runtimeSessionId,
      generation: grant.resource.generation,
      fromSequence: grant.fromSequence,
    })
    let socket: DevStreamTransportSocket | undefined
    const pendingAcks: DevStreamFrame[] = []
    const listeners = new Set<(state: TranscriptAccumulator) => void>()
    const publish = () => {
      for (const listener of listeners) listener(transcript)
    }
    socket = transport.connect(grant as never, {
      onFrame: (frame) => {
        const source = eventSourceForStream({ source: streamOptions.source })
        let decodedEvent: RuntimeEvent | undefined
        if (frame.type === 'data') {
          try {
            const decoded = decodeCbor(frame.bytes)
            const candidate = decodeRuntimeEvent(decoded.value, { source })
            if (
              candidate.seq === frame.sequence &&
              candidate.runtimeSessionId === runtimeSessionId &&
              candidate.generation === current.generation
            )
              decodedEvent = candidate
          } catch {
            decodedEvent = undefined
          }
        }
        transcript = acceptRuntimeStreamFrame(transcript, frame, source)
        if (frame.type === 'data' && decodedEvent) {
          // The decoded identity is invariant across the window, so build it
          // once instead of once per retained event on every streamed frame.
          const decodedIdentity = eventIdentity(decodedEvent)
          const accepted = transcript.events.some(
            (event) => eventIdentity(event) === decodedIdentity
          )
          if (accepted)
            events.set(
              runtimeSessionId,
              mergeSessionEvents(runtimeSessionId, events.get(runtimeSessionId) ?? [], [
                decodedEvent,
              ])
            )
          if (
            accepted &&
            transcript.availability.status !== 'resync_required' &&
            transcript.availability.status !== 'conflict' &&
            transcript.availability.status !== 'stale_generation'
          ) {
            const ack: DevStreamFrame = {
              type: 'ack',
              throughSequence: frame.sequence,
              availableCreditBytes: frame.bytes.byteLength,
            }
            if (socket?.open) socket.send(ack)
            else pendingAcks.push(ack)
          }
        }
        publish()
      },
      onClose: (_code, _reason) => publish(),
    })
    for (const ack of pendingAcks) if (socket.open) socket.send(ack)
    return {
      state: () => transcript,
      subscribe: (listener: (state: TranscriptAccumulator) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      close: () => {
        listeners.clear()
        socket.close(1000, 'chat detached')
      },
    }
  }

  return {
    create,
    attach,
    async list(listOptions = {}) {
      const sessionPage = await executeChatCommand<DevRuntimePage<RuntimeSession>>(
        service,
        buildDevCommand({ operation: 'dev.session.list', scope, body: listOptions })
      )
      await loadHierarchy()
      for (const item of sessionPage.items) remember(item)
      if (
        sessionPage.nextCursor === undefined &&
        listOptions.projectId === undefined &&
        listOptions.worktreeId === undefined &&
        listOptions.archived === undefined &&
        listOptions.cursor === undefined &&
        listOptions.limit === undefined
      ) {
        const currentIds = new Set(sessionPage.items.map((item) => item.id))
        for (const id of sessions.keys()) {
          if (currentIds.has(id)) continue
          sessions.delete(id)
          events.delete(id)
          drafts.delete(id)
          if (selectedRuntimeSessionId === id) selectedRuntimeSessionId = undefined
        }
      }
      const pageIds = new Set(sessionPage.items.map((item) => item.id))
      return registry().conversations.filter(
        (item) =>
          pageIds.has(item.runtimeSessionId) &&
          (listOptions.projectId === undefined || item.projectId === listOptions.projectId) &&
          (listOptions.worktreeId === undefined || item.worktreeId === listOptions.worktreeId) &&
          (listOptions.archived === undefined || item.archived === listOptions.archived)
      )
    },
    remember,
    project: registry,
    setDraft(runtimeSessionId, draft) {
      requireConversation(runtimeSessionId)
      drafts.set(runtimeSessionId, draft)
      return requireConversation(runtimeSessionId)
    },
    switchTo(runtimeSessionId) {
      const conversation = requireConversation(runtimeSessionId)
      selectedRuntimeSessionId = runtimeSessionId
      return conversation
    },
    resume: (runtimeSessionId, harnessRunId) =>
      mutateSession(runtimeSessionId, 'dev.session.resumeHarness', harnessRunId),
    cancel: (runtimeSessionId, harnessRunId) =>
      mutateSession(runtimeSessionId, 'dev.session.cancelHarness', harnessRunId),
    archive,
    unarchive,
    send,
    openTranscript,
  }
}
