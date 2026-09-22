import type {
  DevRuntimePage,
  Group,
  Project,
  RuntimeEvent,
  RuntimeSession,
  Scope,
} from '@adea-ai/types/dev-runtime'
import type { DevRuntimeService } from '../../platform'

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
  const firstPrompt = [...events]
    .filter(
      (event) => event.runtimeSessionId === session.id && event.generation <= session.generation
    )
    .toSorted((left, right) => (eventSequence(left) < eventSequence(right) ? -1 : 1))
    .map(payloadText)
    .find((text): text is string => text !== undefined)
  if (firstPrompt) return Array.from(firstPrompt).slice(0, 80).join('').trim()
  return session.displayName?.trim() || 'New conversation'
}

/** Lifecycle status comes from canonical session state/events only. */
export function deriveConversationStatus(
  session: RuntimeSession,
  events: readonly RuntimeEvent[]
): ChatConversationStatus {
  const latest = [...events]
    .filter(
      (event) => event.runtimeSessionId === session.id && event.generation === session.generation
    )
    .toSorted((left, right) => (eventSequence(left) < eventSequence(right) ? -1 : 1))
    .at(-1)
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
    const retentionEvents = events.toSorted((left, right) =>
      eventSequence(left) < eventSequence(right) ? -1 : 1
    )
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
  const projects = input.projects
    .filter((project) => scopeMatches(project.scope, input.scope))
    .map<ChatProjectProjection>((project) => ({
      id: project.id,
      name: project.name,
      groupIds: groupsForProject(project, input.groups),
      conversationIds: conversations
        .filter((conversation) => conversation.projectId === project.id)
        .map((conversation) => conversation.runtimeSessionId),
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
  const createRequests = new Map<
    string,
    { fingerprint: string; promise: Promise<ChatConversation> }
  >()
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
    const merged = events.get(session.id) ?? []
    for (const event of newEvents)
      if (!merged.some((entry) => entry.eventId === event.eventId)) merged.push(event)
    events.set(session.id, merged)
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
    if (
      input.initialPrompt !== undefined &&
      (input.agentProfileId === undefined || input.agentProfileVersion === undefined)
    )
      throw new ChatRuntimeError({
        code: 'invalid_state',
        retryable: false,
        message: 'An agent profile is required when creating a prompted conversation.',
      })
    const idempotencyKey = input.idempotencyKey ?? randomId()
    const fingerprint = JSON.stringify({ ...input, idempotencyKey: undefined })
    const existing = createRequests.get(idempotencyKey)
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new ChatRuntimeError({
          code: 'idempotency_conflict',
          retryable: false,
          message: 'The idempotency key was reused for another conversation.',
        })
      return existing.promise
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
      let canonical = remember(created)
      if (input.agentProfileId !== undefined || input.initialPrompt !== undefined) {
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
    createRequests.set(idempotencyKey, { fingerprint, promise })
    return promise
  }
  const attach = async (runtimeSessionId: string): Promise<ChatConversation> => {
    await loadHierarchy()
    const page = await executeChatCommand<DevRuntimePage<RuntimeSession>>(
      service,
      buildDevCommand({
        operation: 'dev.session.list',
        scope,
        body: { runtimeSessionId },
      })
    )
    const session = page.items.find((item) => item.id === runtimeSessionId)
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
    const socket = transport.connect(grant as never, {
      onFrame: (frame) => {
        transcript = acceptRuntimeStreamFrame(
          transcript,
          frame,
          eventSourceForStream({ source: streamOptions.source })
        )
        if (frame.type === 'data') {
          const latest = transcript.events.at(-1)
          if (latest) {
            const existing = events.get(runtimeSessionId) ?? []
            if (!existing.some((event) => event.eventId === latest.eventId)) existing.push(latest)
            events.set(runtimeSessionId, existing)
          }
        }
      },
      onClose: (_code, _reason) => undefined,
    })
    return { state: () => transcript, close: () => socket.close(1000, 'chat detached') }
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
