import type { AgentHqApiClient } from '@adea-ai/api-client'
import type { AccountDirectoryApiClient } from '@adea-ai/api-client/account-directory'
import type { AccountDirectoryPageInput } from '@adea-ai/types/account-directory'
import type { TaskSummary } from '@adea-ai/types'
import { workspaceStore } from '@adea-ai/state'
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/solid-query'

export { AgentHqQueryProvider, releaseWorkspaceCache } from './provider'
export * from './dev-runtime'
export { settledConversationPage } from './conversation-audience'
export * from './sharing'

/** A value that may be supplied as a Solid accessor so queries stay reactive. */
export type MaybeAccessor<T> = T | (() => T)

function resolveAccessor<T>(value: MaybeAccessor<T>): T {
  return typeof value === 'function' ? (value as () => T)() : value
}

/**
 * Reads settled query data.
 *
 * Solid Query backs every result's `data` with a resource. A read while the
 * query has not settled registers the nearest `Suspense` boundary, which
 * replaces that boundary's content with its fallback (the Start route has none,
 * so the workspace disappears), and a read of a query that failed throws its
 * error at the reader. Going through this guard makes a pending or failed query
 * render as "no data" — the behavior the workspace was built against — instead
 * of tearing the workspace down.
 */
export function settledData<TData>(result: {
  readonly isSuccess: boolean
  readonly data: TData | undefined
}): TData | undefined {
  return result.isSuccess ? result.data : undefined
}

export const workspaceQueryKeys = {
  all: ['workspaces'] as const,
  bootstrap: ['workspaces', 'bootstrap'] as const,
  detail: (workspaceId: string) => ['workspaces', 'detail', workspaceId] as const,
  list: ['workspaces', 'list'] as const,
}

export const projectQueryKeys = {
  all: (workspaceId: string) => ['workspaces', workspaceId, 'projects'] as const,
  detail: (workspaceId: string, projectId: string) =>
    ['workspaces', workspaceId, 'projects', 'detail', projectId] as const,
  list: (workspaceId: string) => ['workspaces', workspaceId, 'projects', 'list'] as const,
}

export const agentQueryKeys = {
  all: (workspaceId: string) => ['workspaces', workspaceId, 'agents'] as const,
  detail: (workspaceId: string, agentId: string) =>
    ['workspaces', workspaceId, 'agents', 'detail', agentId] as const,
  list: (workspaceId: string) => ['workspaces', workspaceId, 'agents', 'list'] as const,
}

export const taskQueryKeys = {
  all: (workspaceId: string) => ['workspaces', workspaceId, 'tasks'] as const,
  detail: (workspaceId: string, taskId: string) =>
    ['workspaces', workspaceId, 'tasks', 'detail', taskId] as const,
  list: (workspaceId: string) => ['workspaces', workspaceId, 'tasks', 'list'] as const,
}

export const artifactQueryKeys = {
  all: (workspaceId: string) => ['workspaces', workspaceId, 'artifacts'] as const,
  detail: (workspaceId: string, artifactId: string) =>
    ['workspaces', workspaceId, 'artifacts', 'detail', artifactId] as const,
  list: (workspaceId: string) => ['workspaces', workspaceId, 'artifacts', 'list'] as const,
}

/**
 * User-scoped account queries. They sit outside the per-workspace
 * `['workspaces', workspaceId]` prefix, so a workspace switch (which releases
 * that prefix) keeps them, and they describe every workspace at once. The
 * directory and inbox carry their page input in the key: cached pages are
 * scoped to the signed-in account's authorization context — the server answers
 * from the caller's own memberships alone, and no workspace id participates.
 */
export const accountQueryKeys = {
  all: ['account'] as const,
  summary: ['account', 'summary'] as const,
  directory: (input: AccountDirectoryPageInput = {}) => ['account', 'directory', input] as const,
  inbox: (input: AccountDirectoryPageInput = {}) => ['account', 'inbox', input] as const,
}

/** How often the account summary polls for workspaces without an open stream. */
export const ACCOUNT_SUMMARY_REFETCH_INTERVAL_MS = 60_000

export const accountQueryOptions = {
  summary: (client: AgentHqApiClient) => ({
    queryKey: accountQueryKeys.summary,
    queryFn: () => client.accountSummary(),
    refetchInterval: ACCOUNT_SUMMARY_REFETCH_INTERVAL_MS,
    refetchOnWindowFocus: true,
  }),
  /** One keyset page of the account-wide Agents directory (M11.03). */
  directory: (client: AccountDirectoryApiClient, input: AccountDirectoryPageInput = {}) => ({
    queryKey: accountQueryKeys.directory(input),
    queryFn: () => client.accountAgentDirectory(input),
  }),
  /** One keyset page of the account-wide conversation inbox (M11.03). */
  inbox: (client: AccountDirectoryApiClient, input: AccountDirectoryPageInput = {}) => ({
    queryKey: accountQueryKeys.inbox(input),
    queryFn: () => client.accountConversationInbox(input),
  }),
}

export const readStateQueryKeys = {
  detail: (workspaceId: string) => ['workspaces', workspaceId, 'read-state'] as const,
}

export const workspaceSearchQueryKeys = {
  search: (workspaceId: string, query: string, channelId?: string) =>
    ['workspaces', workspaceId, 'search', { channelId, query }] as const,
}

export const readStateQueryOptions = {
  detail: (client: AgentHqApiClient, workspaceId?: string) => ({
    queryKey: readStateQueryKeys.detail(workspaceId ?? ''),
    queryFn: () => client.getReadState(workspaceId!),
    enabled: Boolean(workspaceId),
  }),
}

export const workspaceSearchQueryOptions = {
  search: (client: AgentHqApiClient, workspaceId?: string, query = '', channelId?: string) => ({
    queryKey: workspaceSearchQueryKeys.search(workspaceId ?? '', query, channelId),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      client.searchWorkspace(workspaceId!, query, { channelId, limit: 30, signal }),
    enabled: Boolean(workspaceId && query.trim().length >= 2),
  }),
}

type ConversationMutationContext = Readonly<{ audienceEpoch: number }>

function conversationMutationContext(workspaceId: string): ConversationMutationContext {
  return { audienceEpoch: workspaceStore.getState().conversationAudienceEpochs[workspaceId] ?? 0 }
}

function currentConversationMutation(workspaceId: string, context?: ConversationMutationContext) {
  return (
    context !== undefined &&
    context.audienceEpoch ===
      (workspaceStore.getState().conversationAudienceEpochs[workspaceId] ?? 0)
  )
}

function readStateMutationSuccess(queryClient: QueryClient, workspaceId: string) {
  return (
    result: Awaited<ReturnType<AgentHqApiClient['getReadState']>>,
    _variables?: unknown,
    context?: ConversationMutationContext
  ) => {
    if (!currentConversationMutation(workspaceId, context)) return
    queryClient.setQueryData(readStateQueryKeys.detail(workspaceId), result)
    // The account summary counts this workspace's unread channels too.
    void queryClient.invalidateQueries({ queryKey: accountQueryKeys.summary })
  }
}

export const readStateMutationOptions = {
  all: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: () => client.markAllRead(workspaceId),
    onMutate: () => conversationMutationContext(workspaceId),
    onSuccess: readStateMutationSuccess(queryClient, workspaceId),
  }),
  channel: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{
        action: 'read' | 'unread'
        channelId: string
        lastReadSequence?: number
      }>
    ) =>
      client.setChannelReadState(workspaceId, input.channelId, {
        action: input.action,
        ...(input.lastReadSequence === undefined
          ? {}
          : { lastReadSequence: input.lastReadSequence }),
      }),
    onMutate: () => conversationMutationContext(workspaceId),
    onSuccess: readStateMutationSuccess(queryClient, workspaceId),
  }),
  thread: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{
        action: 'read' | 'unread'
        channelId: string
        lastReadSequence?: number
        threadRootMessageId: string
      }>
    ) =>
      client.setThreadReadState(workspaceId, input.channelId, input.threadRootMessageId, {
        action: input.action,
        ...(input.lastReadSequence === undefined
          ? {}
          : { lastReadSequence: input.lastReadSequence }),
      }),
    onMutate: () => conversationMutationContext(workspaceId),
    onSuccess: readStateMutationSuccess(queryClient, workspaceId),
  }),
}

export const artifactQueryOptions = {
  detail: (client: AgentHqApiClient, workspaceId?: string, artifactId?: string) => ({
    queryKey: artifactQueryKeys.detail(workspaceId ?? '', artifactId ?? ''),
    queryFn: () => client.getArtifact(workspaceId!, artifactId!),
    enabled: Boolean(workspaceId && artifactId),
  }),
  list: (client: AgentHqApiClient, workspaceId?: string) => ({
    queryKey: artifactQueryKeys.list(workspaceId ?? ''),
    queryFn: () => client.listArtifacts(workspaceId!),
    enabled: Boolean(workspaceId),
  }),
}

export const channelQueryKeys = {
  all: (workspaceId: string) => ['workspaces', workspaceId, 'channels'] as const,
  detail: (workspaceId: string, channelId: string) =>
    ['workspaces', workspaceId, 'channels', 'detail', channelId] as const,
  list: (workspaceId: string) => ['workspaces', workspaceId, 'channels', 'list'] as const,
}
export const messageQueryKeys = {
  all: (workspaceId: string, channelId: string) =>
    ['workspaces', workspaceId, 'channels', channelId, 'messages'] as const,
  detail: (workspaceId: string, messageId: string) =>
    ['workspaces', workspaceId, 'messages', 'detail', messageId] as const,
  list: (workspaceId: string, channelId: string) =>
    ['workspaces', workspaceId, 'channels', channelId, 'messages', 'list'] as const,
  page: (
    workspaceId: string,
    channelId: string,
    options: Readonly<{ afterSequence?: number; limit?: number; threadRootMessageId?: string }>
  ) => ['workspaces', workspaceId, 'channels', channelId, 'messages', 'list', options] as const,
}
export const channelQueryOptions = {
  detail: (client: AgentHqApiClient, workspaceId?: string, channelId?: string) => ({
    queryKey: channelQueryKeys.detail(workspaceId ?? '', channelId ?? ''),
    queryFn: () => client.getChannel(workspaceId!, channelId!),
    enabled: Boolean(workspaceId && channelId),
  }),
  list: (client: AgentHqApiClient, workspaceId?: string) => ({
    queryKey: channelQueryKeys.list(workspaceId ?? ''),
    queryFn: async () => {
      const conversationAudienceEpoch =
        workspaceStore.getState().conversationAudienceEpochs[workspaceId!] ?? 0
      const channels = await client.listChannels(workspaceId!)
      return Object.assign([...channels], {
        conversationAudienceEpoch,
        conversationWorkspaceId: workspaceId,
      })
    },
    // Array structural sharing discards custom properties, including the
    // authority generation needed while Solid retains the previous resource.
    structuralSharing: false,
    enabled: Boolean(workspaceId),
  }),
}
export const messageQueryOptions = {
  detail: (client: AgentHqApiClient, workspaceId?: string, messageId?: string) => ({
    queryKey: messageQueryKeys.detail(workspaceId ?? '', messageId ?? ''),
    queryFn: () => client.getMessage(workspaceId!, messageId!),
    enabled: Boolean(workspaceId && messageId),
  }),
  list: (
    client: AgentHqApiClient,
    workspaceId?: string,
    channelId?: string,
    options: Readonly<{ afterSequence?: number; limit?: number; threadRootMessageId?: string }> = {}
  ) => ({
    queryKey:
      Object.keys(options).length === 0
        ? messageQueryKeys.list(workspaceId ?? '', channelId ?? '')
        : messageQueryKeys.page(workspaceId ?? '', channelId ?? '', options),
    queryFn: async (): Promise<
      Awaited<ReturnType<AgentHqApiClient['listMessages']>> & { conversationAudienceEpoch?: number }
    > => {
      const conversationAudienceEpoch =
        workspaceStore.getState().conversationAudienceEpochs[workspaceId!] ?? 0
      const page = await client.listMessages(workspaceId!, channelId!, options)
      return { ...page, conversationAudienceEpoch }
    },
    enabled: Boolean(workspaceId && channelId),
  }),
}

function channelMutationSuccess(queryClient: QueryClient, workspaceId: string) {
  return async (
    result: Awaited<ReturnType<AgentHqApiClient['getChannel']>>,
    _variables?: unknown,
    context?: ConversationMutationContext
  ) => {
    if (!currentConversationMutation(workspaceId, context)) return
    queryClient.setQueryData(channelQueryKeys.detail(workspaceId, result.channel.id), result)
    await queryClient.invalidateQueries({ queryKey: channelQueryKeys.list(workspaceId) })
  }
}
export const channelMutationOptions = {
  archive: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (input: Readonly<{ channelId: string; expectedVersion: number }>) =>
      client.archiveChannel(workspaceId, input.channelId, input.expectedVersion),
    onMutate: () => conversationMutationContext(workspaceId),
    onSuccess: channelMutationSuccess(queryClient, workspaceId),
  }),
  direct: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (agentId: string) => client.createDirectAgentChannel(workspaceId, agentId),
    onMutate: () => conversationMutationContext(workspaceId),
    onSuccess: channelMutationSuccess(queryClient, workspaceId),
  }),
  directTopic: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (input: Parameters<AgentHqApiClient['createDirectAgentTopic']>[1]) =>
      client.createDirectAgentTopic(workspaceId, input),
    onMutate: () => conversationMutationContext(workspaceId),
    onSuccess: channelMutationSuccess(queryClient, workspaceId),
  }),
  group: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (input: Parameters<AgentHqApiClient['createGroupChannel']>[1]) =>
      client.createGroupChannel(workspaceId, input),
    onMutate: () => conversationMutationContext(workspaceId),
    onSuccess: channelMutationSuccess(queryClient, workspaceId),
  }),
  participants: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{
        channelId: string
        expectedVersion: number
        participants: Parameters<AgentHqApiClient['setChannelParticipants']>[2]
      }>
    ) =>
      client.setChannelParticipants(
        workspaceId,
        input.channelId,
        input.participants,
        input.expectedVersion
      ),
    onMutate: () => conversationMutationContext(workspaceId),
    onSuccess: channelMutationSuccess(queryClient, workspaceId),
  }),
  project: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (input: Parameters<AgentHqApiClient['createProjectChannel']>[1]) =>
      client.createProjectChannel(workspaceId, input),
    onMutate: () => conversationMutationContext(workspaceId),
    onSuccess: channelMutationSuccess(queryClient, workspaceId),
  }),
  update: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{
        channelId: string
        expectedVersion: number
        update: Parameters<AgentHqApiClient['updateChannel']>[2]
      }>
    ) => client.updateChannel(workspaceId, input.channelId, input.update, input.expectedVersion),
    onMutate: () => conversationMutationContext(workspaceId),
    onSuccess: channelMutationSuccess(queryClient, workspaceId),
  }),
}

function messageMutationSuccess(queryClient: QueryClient, workspaceId: string, channelId?: string) {
  return async (
    result: Awaited<ReturnType<AgentHqApiClient['getMessage']>>,
    _variables?: unknown,
    context?: ConversationMutationContext
  ) => {
    if (!currentConversationMutation(workspaceId, context)) return
    queryClient.setQueryData(messageQueryKeys.detail(workspaceId, result.message.id), result)
    const targetChannelId = channelId ?? result.message.channelId
    await queryClient.invalidateQueries({
      queryKey: messageQueryKeys.all(workspaceId, targetChannelId),
    })
  }
}
export const messageMutationOptions = {
  create: (
    client: AgentHqApiClient,
    queryClient: QueryClient,
    workspaceId: string,
    channelId: string
  ) => ({
    mutationFn: (input: Parameters<AgentHqApiClient['createMessage']>[2]) =>
      client.createMessage(workspaceId, channelId, input),
    onMutate: () => conversationMutationContext(workspaceId),
    onSuccess: messageMutationSuccess(queryClient, workspaceId, channelId),
  }),
  delete: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (input: Readonly<{ expectedVersion: number; messageId: string }>) =>
      client.deleteMessage(workspaceId, input.messageId, input.expectedVersion),
    onMutate: () => conversationMutationContext(workspaceId),
    onSuccess: messageMutationSuccess(queryClient, workspaceId),
  }),
  edit: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{
        edit: Parameters<AgentHqApiClient['editMessage']>[2]
        expectedVersion: number
        messageId: string
      }>
    ) => client.editMessage(workspaceId, input.messageId, input.edit, input.expectedVersion),
    onMutate: () => conversationMutationContext(workspaceId),
    onSuccess: messageMutationSuccess(queryClient, workspaceId),
  }),
}
export const taskQueryOptions = {
  detail: (client: AgentHqApiClient, workspaceId?: string, taskId?: string) => ({
    queryKey: taskQueryKeys.detail(workspaceId ?? '', taskId ?? ''),
    queryFn: () => client.getTask(workspaceId!, taskId!),
    enabled: Boolean(workspaceId && taskId),
  }),
  list: (client: AgentHqApiClient, workspaceId?: string) => ({
    queryKey: taskQueryKeys.list(workspaceId ?? ''),
    queryFn: () => client.listTasks(workspaceId!),
    enabled: Boolean(workspaceId),
  }),
}

/**
 * Settles a Task write. The server's copy of the Task replaces the cached row
 * at once, so a caller awaiting the mutation sees the board in its final state
 * without waiting for a list refetch; the refetch still runs, in the background,
 * to pick up anything else the write changed (dependants, ordering).
 */
function taskMutationSuccess(queryClient: QueryClient, workspaceId: string) {
  return async (
    result: Awaited<ReturnType<AgentHqApiClient['getTask']>>,
    _input?: unknown,
    snapshot?: TaskListSnapshot
  ) => {
    queryClient.setQueryData<typeof result>(
      taskQueryKeys.detail(workspaceId, result.task.id),
      (current) => (current && current.task.version > result.task.version ? current : result)
    )
    queryClient.setQueryData<readonly TaskSummary[]>(taskQueryKeys.list(workspaceId), (tasks) => {
      if (!tasks) return tasks
      if (!tasks.some((task) => task.id === result.task.id)) return [...tasks, result.task]
      return tasks.map((task) =>
        task.id === result.task.id && task.version <= result.task.version ? result.task : task
      )
    })
    finishTaskWrite(queryClient, workspaceId, result.task.id, snapshot)
  }
}

type TaskListSnapshot = Readonly<{
  before: TaskSummary | undefined
  optimistic: TaskSummary | undefined
  token: symbol
}>

const taskWriteTokens = new WeakMap<QueryClient, Map<string, Map<string, symbol>>>()
function pendingTaskWrites(queryClient: QueryClient, workspaceId: string): Map<string, symbol> {
  let workspaces = taskWriteTokens.get(queryClient)
  if (!workspaces) {
    workspaces = new Map()
    taskWriteTokens.set(queryClient, workspaces)
  }
  let pending = workspaces.get(workspaceId)
  if (!pending) {
    pending = new Map()
    workspaces.set(workspaceId, pending)
  }
  return pending
}

function finishTaskWrite(
  queryClient: QueryClient,
  workspaceId: string,
  taskId: string,
  snapshot?: TaskListSnapshot
) {
  const pending = pendingTaskWrites(queryClient, workspaceId)
  if (snapshot && pending.get(taskId) === snapshot.token) pending.delete(taskId)
  // A refetch must not replace another card's still-pending optimistic move.
  if (pending.size === 0)
    void queryClient.invalidateQueries({ queryKey: taskQueryKeys.list(workspaceId) })
}

/**
 * Applies a Task write to the cached list before the server answers, and puts
 * the list back if the server refuses it. A card dropped on a lane lands there
 * immediately; a refused move returns to where it was, and the caller still
 * receives the error to explain why.
 */
function optimisticTaskWrite<Input extends Readonly<{ taskId: string }>>(
  queryClient: QueryClient,
  workspaceId: string,
  patch: (task: TaskSummary, input: Input) => TaskSummary
) {
  const listKey = taskQueryKeys.list(workspaceId)
  return {
    onMutate: async (input: Input): Promise<TaskListSnapshot> => {
      const pending = pendingTaskWrites(queryClient, workspaceId)
      if (pending.has(input.taskId))
        throw new Error('This task is already being updated. Try again when the update finishes.')
      await queryClient.cancelQueries({ queryKey: listKey })
      // Two callers can reach the cancellation await together. Only one may
      // write against this task version; other cards remain independent.
      if (pending.has(input.taskId))
        throw new Error('This task is already being updated. Try again when the update finishes.')
      const before = queryClient
        .getQueryData<readonly TaskSummary[]>(listKey)
        ?.find((task) => task.id === input.taskId)
      const token = Symbol('task-write')
      pending.set(input.taskId, token)
      queryClient.setQueryData<readonly TaskSummary[]>(listKey, (current) =>
        current?.map((task) => (task.id === input.taskId ? patch(task, input) : task))
      )
      const optimistic = queryClient
        .getQueryData<readonly TaskSummary[]>(listKey)
        ?.find((task) => task.id === input.taskId)
      return { before, optimistic, token }
    },
    onError: (_error: unknown, input: Input, snapshot: TaskListSnapshot | undefined) => {
      // onMutate can refuse an overlapping write before any API call. That
      // refusal must not reconcile or disturb the active write's caches.
      if (!snapshot) return
      if (
        snapshot?.before &&
        pendingTaskWrites(queryClient, workspaceId).get(input.taskId) === snapshot.token
      ) {
        const before = snapshot.before
        queryClient.setQueryData<readonly TaskSummary[]>(listKey, (current) =>
          current?.map((task) =>
            task.id === input.taskId && task === snapshot.optimistic ? before : task
          )
        )
      }
      finishTaskWrite(queryClient, workspaceId, input.taskId, snapshot)
      void queryClient.invalidateQueries({
        queryKey: taskQueryKeys.detail(workspaceId, input.taskId),
      })
    },
  }
}

const toLifecycleState =
  (lifecycleState: TaskSummary['lifecycleState']) =>
  (task: TaskSummary): TaskSummary => ({ ...task, lifecycleState })

export const taskMutationOptions = {
  archive: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{ command: Parameters<AgentHqApiClient['archiveTask']>[2]; taskId: string }>
    ) => client.archiveTask(workspaceId, input.taskId, input.command),
    ...optimisticTaskWrite(queryClient, workspaceId, toLifecycleState('archived')),
    onSuccess: taskMutationSuccess(queryClient, workspaceId),
  }),
  artifacts: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{
        artifactRefs: readonly string[]
        command: Parameters<AgentHqApiClient['setTaskArtifactReferences']>[3]
        taskId: string
      }>
    ) =>
      client.setTaskArtifactReferences(
        workspaceId,
        input.taskId,
        input.artifactRefs,
        input.command
      ),
    onSuccess: taskMutationSuccess(queryClient, workspaceId),
  }),
  assign: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{
        agentId: string | null
        command: Parameters<AgentHqApiClient['assignTask']>[3]
        taskId: string
      }>
    ) => client.assignTask(workspaceId, input.taskId, input.agentId, input.command),
    ...optimisticTaskWrite(
      queryClient,
      workspaceId,
      (task, input: Readonly<{ agentId: string | null; taskId: string }>) => ({
        ...task,
        agentId: input.agentId ?? undefined,
      })
    ),
    onSuccess: taskMutationSuccess(queryClient, workspaceId),
  }),
  cancel: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{ command: Parameters<AgentHqApiClient['cancelTask']>[2]; taskId: string }>
    ) => client.cancelTask(workspaceId, input.taskId, input.command),
    ...optimisticTaskWrite(queryClient, workspaceId, toLifecycleState('cancelled')),
    onSuccess: taskMutationSuccess(queryClient, workspaceId),
  }),
  conversation: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{
        command: Parameters<AgentHqApiClient['setTaskConversationReferences']>[3]
        conversation: Parameters<AgentHqApiClient['setTaskConversationReferences']>[2]
        taskId: string
      }>
    ) =>
      client.setTaskConversationReferences(
        workspaceId,
        input.taskId,
        input.conversation,
        input.command
      ),
    onSuccess: taskMutationSuccess(queryClient, workspaceId),
  }),
  create: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{
        command: Parameters<AgentHqApiClient['createTask']>[2]
        task: Parameters<AgentHqApiClient['createTask']>[1]
      }>
    ) => client.createTask(workspaceId, input.task, input.command),
    onSuccess: taskMutationSuccess(queryClient, workspaceId),
  }),
  dependencies: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{
        command: Parameters<AgentHqApiClient['setTaskDependencies']>[3]
        dependencyIds: readonly string[]
        taskId: string
      }>
    ) => client.setTaskDependencies(workspaceId, input.taskId, input.dependencyIds, input.command),
    onSuccess: taskMutationSuccess(queryClient, workspaceId),
  }),
  moveProject: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{
        command: Parameters<AgentHqApiClient['moveTaskToProject']>[3]
        projectId: string | null
        taskId: string
      }>
    ) => client.moveTaskToProject(workspaceId, input.taskId, input.projectId, input.command),
    ...optimisticTaskWrite(
      queryClient,
      workspaceId,
      (task, input: Readonly<{ projectId: string | null; taskId: string }>) => ({
        ...task,
        projectId: input.projectId ?? undefined,
      })
    ),
    onSuccess: taskMutationSuccess(queryClient, workspaceId),
  }),
  queue: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{ command: Parameters<AgentHqApiClient['queueTask']>[2]; taskId: string }>
    ) => client.queueTask(workspaceId, input.taskId, input.command),
    ...optimisticTaskWrite(queryClient, workspaceId, toLifecycleState('queued')),
    onSuccess: taskMutationSuccess(queryClient, workspaceId),
  }),
  review: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{ command: Parameters<AgentHqApiClient['reviewTask']>[2]; taskId: string }>
    ) => client.reviewTask(workspaceId, input.taskId, input.command),
    ...optimisticTaskWrite(queryClient, workspaceId, toLifecycleState('in_review')),
    onSuccess: taskMutationSuccess(queryClient, workspaceId),
  }),
  start: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{ command: Parameters<AgentHqApiClient['startTask']>[2]; taskId: string }>
    ) => client.startTask(workspaceId, input.taskId, input.command),
    ...optimisticTaskWrite(queryClient, workspaceId, toLifecycleState('in_progress')),
    onSuccess: taskMutationSuccess(queryClient, workspaceId),
  }),
  complete: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{ command: Parameters<AgentHqApiClient['completeTask']>[2]; taskId: string }>
    ) => client.completeTask(workspaceId, input.taskId, input.command),
    ...optimisticTaskWrite(queryClient, workspaceId, toLifecycleState('completed')),
    onSuccess: taskMutationSuccess(queryClient, workspaceId),
  }),
  update: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{
        command: Parameters<AgentHqApiClient['updateTask']>[3]
        taskId: string
        update: Parameters<AgentHqApiClient['updateTask']>[2]
      }>
    ) => client.updateTask(workspaceId, input.taskId, input.update, input.command),
    ...optimisticTaskWrite(
      queryClient,
      workspaceId,
      (
        task,
        input: Readonly<{ taskId: string; update: Parameters<AgentHqApiClient['updateTask']>[2] }>
      ) => ({
        ...task,
        kind: input.update.kind ?? task.kind,
        objective: input.update.objective ?? task.objective,
        priority: input.update.priority ?? task.priority,
        title: input.update.title ?? task.title,
      })
    ),
    onSuccess: taskMutationSuccess(queryClient, workspaceId),
  }),
}
export const agentQueryOptions = {
  detail: (client: AgentHqApiClient, workspaceId?: string, agentId?: string) => ({
    queryKey: agentQueryKeys.detail(workspaceId ?? '', agentId ?? ''),
    queryFn: () => client.getAgent(workspaceId!, agentId!),
    enabled: Boolean(workspaceId && agentId),
  }),
  list: (client: AgentHqApiClient, workspaceId?: string) => ({
    queryKey: agentQueryKeys.list(workspaceId ?? ''),
    queryFn: () => client.listAgents(workspaceId!),
    enabled: Boolean(workspaceId),
  }),
}
export const agentMutationOptions = {
  assignProject: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{ agentId: string; expectedRevision: number; projectId: string | null }>
    ) =>
      client.assignAgentToProject(workspaceId, input.agentId, {
        expectedRevision: input.expectedRevision,
        projectId: input.projectId,
      }),
    onSuccess: async (result: Awaited<ReturnType<AgentHqApiClient['assignAgentToProject']>>) => {
      queryClient.setQueryData(agentQueryKeys.detail(workspaceId, result.agent.id), result)
      await queryClient.invalidateQueries({ queryKey: agentQueryKeys.list(workspaceId) })
    },
  }),
  create: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (input: Parameters<AgentHqApiClient['createAgent']>[1]) =>
      client.createAgent(workspaceId, input),
    onSuccess: async (result: Awaited<ReturnType<AgentHqApiClient['createAgent']>>) => {
      queryClient.setQueryData(agentQueryKeys.detail(workspaceId, result.agent.id), result)
      await queryClient.invalidateQueries({ queryKey: agentQueryKeys.all(workspaceId) })
    },
  }),
  archive: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (agentId: string) => client.archiveAgent(workspaceId, agentId),
    onSuccess: async (_result: unknown, agentId: string) => {
      queryClient.removeQueries({ queryKey: agentQueryKeys.detail(workspaceId, agentId) })
      await queryClient.invalidateQueries({ queryKey: agentQueryKeys.all(workspaceId) })
    },
  }),
  profile: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{
        agentId: string
        profile: Parameters<AgentHqApiClient['changeAgentProfile']>[2]
      }>
    ) => client.changeAgentProfile(workspaceId, input.agentId, input.profile),
    onSuccess: async (result: Awaited<ReturnType<AgentHqApiClient['changeAgentProfile']>>) => {
      queryClient.setQueryData(agentQueryKeys.detail(workspaceId, result.agent.id), result)
      await queryClient.invalidateQueries({ queryKey: agentQueryKeys.list(workspaceId) })
    },
  }),
  presentation: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{
        agentId: string
        presentation: Parameters<AgentHqApiClient['updateAgentPresentation']>[2]
      }>
    ) => client.updateAgentPresentation(workspaceId, input.agentId, input.presentation),
    onSuccess: async (result: Awaited<ReturnType<AgentHqApiClient['updateAgentPresentation']>>) => {
      queryClient.setQueryData(agentQueryKeys.detail(workspaceId, result.agent.id), result)
      await queryClient.invalidateQueries({ queryKey: agentQueryKeys.list(workspaceId) })
    },
  }),
}

export const projectQueryOptions = {
  detail: (client: AgentHqApiClient, workspaceId?: string, projectId?: string) => ({
    queryKey: projectQueryKeys.detail(workspaceId ?? '', projectId ?? ''),
    queryFn: () => client.getProject(workspaceId!, projectId!),
    enabled: Boolean(workspaceId && projectId),
  }),
  list: (client: AgentHqApiClient, workspaceId?: string) => ({
    queryKey: projectQueryKeys.list(workspaceId ?? ''),
    queryFn: () => client.listProjects(workspaceId!),
    enabled: Boolean(workspaceId),
  }),
}

export const projectMutationOptions = {
  archive: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (projectId: string) => client.archiveProject(workspaceId, projectId),
    onSuccess: async (_result: unknown, projectId: string) => {
      queryClient.removeQueries({ queryKey: projectQueryKeys.detail(workspaceId, projectId) })
      await queryClient.invalidateQueries({ queryKey: projectQueryKeys.all(workspaceId) })
    },
  }),
  restore: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      variables: Readonly<{
        input: Parameters<AgentHqApiClient['restoreProject']>[2]
        projectId: string
      }>
    ) => client.restoreProject(workspaceId, variables.projectId, variables.input),
    onSuccess: async (
      result: Awaited<ReturnType<AgentHqApiClient['restoreProject']>>,
      variables: Readonly<{ projectId: string }>
    ) => {
      queryClient.setQueryData(projectQueryKeys.detail(workspaceId, variables.projectId), result)
      await queryClient.invalidateQueries({ queryKey: projectQueryKeys.all(workspaceId) })
    },
  }),
  create: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (input: Parameters<AgentHqApiClient['createProject']>[1]) =>
      client.createProject(workspaceId, input),
    onSuccess: async (result: Awaited<ReturnType<AgentHqApiClient['createProject']>>) => {
      queryClient.setQueryData(projectQueryKeys.detail(workspaceId, result.project.id), result)
      await queryClient.invalidateQueries({ queryKey: projectQueryKeys.all(workspaceId) })
    },
  }),
  delete: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (projectId: string) => client.deleteProject(workspaceId, projectId),
    onSuccess: async (_result: unknown, projectId: string) => {
      queryClient.removeQueries({ queryKey: projectQueryKeys.detail(workspaceId, projectId) })
      await queryClient.invalidateQueries({ queryKey: projectQueryKeys.all(workspaceId) })
    },
  }),
  reorder: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (projectIds: readonly string[]) => client.reorderProjects(workspaceId, projectIds),
    onSuccess: (result: Awaited<ReturnType<AgentHqApiClient['reorderProjects']>>) => {
      queryClient.setQueryData(projectQueryKeys.list(workspaceId), result)
    },
  }),
  update: (client: AgentHqApiClient, queryClient: QueryClient, workspaceId: string) => ({
    mutationFn: (
      input: Readonly<{
        projectId: string
        update: Parameters<AgentHqApiClient['updateProject']>[2]
      }>
    ) => client.updateProject(workspaceId, input.projectId, input.update),
    onSuccess: async (result: Awaited<ReturnType<AgentHqApiClient['updateProject']>>) => {
      queryClient.setQueryData(projectQueryKeys.detail(workspaceId, result.project.id), result)
      await queryClient.invalidateQueries({ queryKey: projectQueryKeys.list(workspaceId) })
    },
  }),
}

export const workspaceMutationOptions = {
  claim: (client: AgentHqApiClient, queryClient: QueryClient) => ({
    mutationFn: (temporaryCredential: string) =>
      client.claimTemporaryWorkspace(temporaryCredential),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.all })
    },
  }),
  create: (client: AgentHqApiClient, queryClient: QueryClient) => ({
    mutationFn: (input: Parameters<AgentHqApiClient['createWorkspace']>[0]) =>
      client.createWorkspace(input),
    onSuccess: async (result: Awaited<ReturnType<AgentHqApiClient['createWorkspace']>>) => {
      queryClient.setQueryData(
        workspaceQueryKeys.bootstrap,
        (current: Awaited<ReturnType<AgentHqApiClient['bootstrapWorkspace']>> | undefined) =>
          current && !current.workspaces.some(({ id }) => id === result.workspace.id)
            ? {
                ...current,
                activeWorkspace: current.activeWorkspace ?? result.workspace,
                workspaces: [...current.workspaces, result.workspace],
              }
            : current
      )
      await queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.list })
      queryClient.setQueryData(workspaceQueryKeys.detail(result.workspace.id), {
        workspace: result.workspace,
        agents: [],
        tasks: [],
      })
    },
  }),
  update: (client: AgentHqApiClient, queryClient: QueryClient) => ({
    mutationFn: (
      input: Readonly<{
        update: Parameters<AgentHqApiClient['updateWorkspace']>[1]
        workspaceId: string
      }>
    ) => client.updateWorkspace(input.workspaceId, input.update),
    onSuccess: async (result: Awaited<ReturnType<AgentHqApiClient['updateWorkspace']>>) => {
      // Bootstrap establishes the session and is never refetched for a field
      // change, so its copy of the summary is patched in place.
      queryClient.setQueryData(
        workspaceQueryKeys.bootstrap,
        (current: Awaited<ReturnType<AgentHqApiClient['bootstrapWorkspace']>> | undefined) =>
          current && {
            ...current,
            activeWorkspace:
              current.activeWorkspace?.id === result.workspace.id
                ? result.workspace
                : current.activeWorkspace,
            workspaces: current.workspaces.map((workspace) =>
              workspace.id === result.workspace.id ? result.workspace : workspace
            ),
          }
      )
      await queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.list })
      await queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.detail(result.workspace.id),
      })
    },
  }),
  reopen: (client: AgentHqApiClient, queryClient: QueryClient) => ({
    mutationFn: (workspaceId: string) => client.reopenWorkspace(workspaceId),
    onSuccess: async (result: Awaited<ReturnType<AgentHqApiClient['reopenWorkspace']>>) => {
      await queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.all })
      await queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.detail(result.workspace.id),
      })
    },
  }),
  reorder: (client: AgentHqApiClient, queryClient: QueryClient) => ({
    mutationFn: (workspaceIds: readonly string[]) => client.reorderWorkspaces(workspaceIds),
    onSuccess: async (workspaces: Awaited<ReturnType<AgentHqApiClient['reorderWorkspaces']>>) => {
      queryClient.setQueryData(workspaceQueryKeys.list, workspaces)
      queryClient.setQueryData(
        workspaceQueryKeys.bootstrap,
        (current: Awaited<ReturnType<AgentHqApiClient['bootstrapWorkspace']>> | undefined) =>
          current && {
            ...current,
            workspaces,
            activeWorkspace:
              workspaces.find((workspace) => workspace.id === current.activeWorkspace?.id) ??
              workspaces.find((workspace) => workspace.isPersonal) ??
              workspaces[0] ??
              null,
          }
      )
    },
  }),
}

export const workspaceDeleteMutationOptions = (
  client: AgentHqApiClient,
  queryClient: QueryClient
) => ({
  onError: async (_error: unknown, input: { workspaceId: string }) => {
    // Recover the authoritative name/version after conflicts, and reconcile
    // an uncertain network outcome before another confirmation attempt.
    await queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.bootstrap })
    await queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.list })
    await queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.detail(input.workspaceId),
    })
  },
  mutationFn: (
    input: Readonly<{
      workspaceId: string
      confirmation: Parameters<AgentHqApiClient['deleteWorkspace']>[1]
    }>
  ) => client.deleteWorkspace(input.workspaceId, input.confirmation),
  onSuccess: async (result: Awaited<ReturnType<AgentHqApiClient['deleteWorkspace']>>) => {
    // Cancel in-flight reads before removing data so a late response cannot
    // repopulate the deleted workspace's private cache.
    const deletedWorkspaceQueries = {
      predicate: (query: { queryKey: readonly unknown[] }) =>
        (query.queryKey[0] === 'workspaces' &&
          (query.queryKey[1] === result.workspaceId ||
            (query.queryKey[1] === 'detail' && query.queryKey[2] === result.workspaceId))) ||
        (query.queryKey[0] === 'dev-runtime' && query.queryKey[2] === result.workspaceId),
    }
    await queryClient.cancelQueries({
      predicate: (query) =>
        deletedWorkspaceQueries.predicate(query) ||
        (query.queryKey[0] === 'workspaces' &&
          (query.queryKey[1] === 'bootstrap' || query.queryKey[1] === 'list')),
    })
    queryClient.removeQueries(deletedWorkspaceQueries)
    queryClient.setQueryData(
      workspaceQueryKeys.bootstrap,
      (current: Awaited<ReturnType<AgentHqApiClient['bootstrapWorkspace']>> | undefined) =>
        current && {
          ...current,
          workspaces: result.workspaces,
          activeWorkspace:
            result.workspaces.find(({ id }) => id === current.activeWorkspace?.id) ??
            result.workspaces.find((workspace) => workspace.isPersonal) ??
            result.workspaces[0] ??
            null,
        }
    )
    queryClient.setQueryData(workspaceQueryKeys.list, result.workspaces)
    await queryClient.invalidateQueries({ queryKey: ['account'] })
  },
})

export const workspaceQueryOptions = {
  bootstrap: (client: AgentHqApiClient) => ({
    queryKey: workspaceQueryKeys.bootstrap,
    queryFn: () => client.bootstrapWorkspace(),
    staleTime: 30_000,
  }),
  detail: (client: AgentHqApiClient, workspaceId?: string) => ({
    queryKey: workspaceQueryKeys.detail(workspaceId ?? ''),
    queryFn: () => client.getWorkspace(workspaceId!),
    enabled: Boolean(workspaceId),
  }),
  list: (client: AgentHqApiClient) => ({
    queryKey: workspaceQueryKeys.list,
    queryFn: () => client.listWorkspaces(),
  }),
}

export function useWorkspaceListQuery(client: AgentHqApiClient) {
  return useQuery(() => workspaceQueryOptions.list(client))
}

export function useWorkspaceBootstrapQuery(client: AgentHqApiClient) {
  return useQuery(() => workspaceQueryOptions.bootstrap(client))
}

export function useCreateWorkspaceMutation(client: AgentHqApiClient) {
  const queryClient = useQueryClient()
  return useMutation(() => workspaceMutationOptions.create(client, queryClient))
}

export function useDeleteWorkspaceMutation(client: AgentHqApiClient) {
  const queryClient = useQueryClient()
  return useMutation(() => workspaceDeleteMutationOptions(client, queryClient))
}

export function useReorderWorkspacesMutation(client: AgentHqApiClient) {
  const queryClient = useQueryClient()
  return useMutation(() => workspaceMutationOptions.reorder(client, queryClient))
}

export function useUpdateWorkspaceMutation(client: AgentHqApiClient) {
  const queryClient = useQueryClient()
  return useMutation(() => workspaceMutationOptions.update(client, queryClient))
}

export function useProjectListQuery(
  client: AgentHqApiClient,
  workspaceId?: MaybeAccessor<string | undefined>
) {
  return useQuery(() => projectQueryOptions.list(client, resolveAccessor(workspaceId)))
}

export function useCreateProjectMutation(
  client: AgentHqApiClient,
  workspaceId: MaybeAccessor<string>
) {
  const queryClient = useQueryClient()
  return useMutation(() =>
    projectMutationOptions.create(client, queryClient, resolveAccessor(workspaceId))
  )
}

export function useUpdateProjectMutation(
  client: AgentHqApiClient,
  workspaceId: MaybeAccessor<string>
) {
  const queryClient = useQueryClient()
  return useMutation(() =>
    projectMutationOptions.update(client, queryClient, resolveAccessor(workspaceId))
  )
}

export function useArchiveProjectMutation(
  client: AgentHqApiClient,
  workspaceId: MaybeAccessor<string>
) {
  const queryClient = useQueryClient()
  return useMutation(() =>
    projectMutationOptions.archive(client, queryClient, resolveAccessor(workspaceId))
  )
}

/** Soft delete: the project leaves every listing and its id is never reused. */
export function useDeleteProjectMutation(
  client: AgentHqApiClient,
  workspaceId: MaybeAccessor<string>
) {
  const queryClient = useQueryClient()
  return useMutation(() =>
    projectMutationOptions.delete(client, queryClient, resolveAccessor(workspaceId))
  )
}

/** Explicit promotion of an archived project at the observed revision. */
export function useRestoreProjectMutation(
  client: AgentHqApiClient,
  workspaceId: MaybeAccessor<string>
) {
  const queryClient = useQueryClient()
  return useMutation(() =>
    projectMutationOptions.restore(client, queryClient, resolveAccessor(workspaceId))
  )
}

export function useAgentListQuery(
  client: AgentHqApiClient,
  workspaceId?: MaybeAccessor<string | undefined>
) {
  return useQuery(() => agentQueryOptions.list(client, resolveAccessor(workspaceId)))
}
export function useCreateAgentMutation(
  client: AgentHqApiClient,
  workspaceId: MaybeAccessor<string>
) {
  return useMutation(() =>
    agentMutationOptions.create(client, useQueryClient(), resolveAccessor(workspaceId))
  )
}
export function useArchiveAgentMutation(
  client: AgentHqApiClient,
  workspaceId: MaybeAccessor<string>
) {
  return useMutation(() =>
    agentMutationOptions.archive(client, useQueryClient(), resolveAccessor(workspaceId))
  )
}
export function useAssignAgentProjectMutation(
  client: AgentHqApiClient,
  workspaceId: MaybeAccessor<string>
) {
  return useMutation(() =>
    agentMutationOptions.assignProject(client, useQueryClient(), resolveAccessor(workspaceId))
  )
}
export function useUpdateAgentPresentationMutation(
  client: AgentHqApiClient,
  workspaceId: MaybeAccessor<string>
) {
  return useMutation(() =>
    agentMutationOptions.presentation(client, useQueryClient(), resolveAccessor(workspaceId))
  )
}
export function useChangeAgentProfileMutation(
  client: AgentHqApiClient,
  workspaceId: MaybeAccessor<string>
) {
  return useMutation(() =>
    agentMutationOptions.profile(client, useQueryClient(), resolveAccessor(workspaceId))
  )
}

export function useTaskListQuery(
  client: AgentHqApiClient,
  workspaceId?: MaybeAccessor<string | undefined>
) {
  return useQuery(() => taskQueryOptions.list(client, resolveAccessor(workspaceId)))
}
export function useCreateTaskMutation(
  client: AgentHqApiClient,
  workspaceId: MaybeAccessor<string>
) {
  return useMutation(() =>
    taskMutationOptions.create(client, useQueryClient(), resolveAccessor(workspaceId))
  )
}
export function useUpdateTaskMutation(
  client: AgentHqApiClient,
  workspaceId: MaybeAccessor<string>
) {
  return useMutation(() =>
    taskMutationOptions.update(client, useQueryClient(), resolveAccessor(workspaceId))
  )
}
export function useAssignTaskMutation(
  client: AgentHqApiClient,
  workspaceId: MaybeAccessor<string>
) {
  return useMutation(() =>
    taskMutationOptions.assign(client, useQueryClient(), resolveAccessor(workspaceId))
  )
}
export function useMoveTaskProjectMutation(
  client: AgentHqApiClient,
  workspaceId: MaybeAccessor<string>
) {
  return useMutation(() =>
    taskMutationOptions.moveProject(client, useQueryClient(), resolveAccessor(workspaceId))
  )
}
export function useQueueTaskMutation(client: AgentHqApiClient, workspaceId: MaybeAccessor<string>) {
  return useMutation(() =>
    taskMutationOptions.queue(client, useQueryClient(), resolveAccessor(workspaceId))
  )
}
export function useReviewTaskMutation(
  client: AgentHqApiClient,
  workspaceId: MaybeAccessor<string>
) {
  return useMutation(() =>
    taskMutationOptions.review(client, useQueryClient(), resolveAccessor(workspaceId))
  )
}
export function useStartTaskMutation(client: AgentHqApiClient, workspaceId: MaybeAccessor<string>) {
  return useMutation(() =>
    taskMutationOptions.start(client, useQueryClient(), resolveAccessor(workspaceId))
  )
}
export function useCompleteTaskMutation(
  client: AgentHqApiClient,
  workspaceId: MaybeAccessor<string>
) {
  return useMutation(() =>
    taskMutationOptions.complete(client, useQueryClient(), resolveAccessor(workspaceId))
  )
}
export function useCancelTaskMutation(
  client: AgentHqApiClient,
  workspaceId: MaybeAccessor<string>
) {
  return useMutation(() =>
    taskMutationOptions.cancel(client, useQueryClient(), resolveAccessor(workspaceId))
  )
}
export function useArchiveTaskMutation(
  client: AgentHqApiClient,
  workspaceId: MaybeAccessor<string>
) {
  return useMutation(() =>
    taskMutationOptions.archive(client, useQueryClient(), resolveAccessor(workspaceId))
  )
}
export function useSetTaskDependenciesMutation(
  client: AgentHqApiClient,
  workspaceId: MaybeAccessor<string>
) {
  return useMutation(() =>
    taskMutationOptions.dependencies(client, useQueryClient(), resolveAccessor(workspaceId))
  )
}
export function useSetTaskConversationMutation(
  client: AgentHqApiClient,
  workspaceId: MaybeAccessor<string>
) {
  return useMutation(() =>
    taskMutationOptions.conversation(client, useQueryClient(), resolveAccessor(workspaceId))
  )
}

export function useArtifactListQuery(
  client: AgentHqApiClient,
  workspaceId?: MaybeAccessor<string | undefined>
) {
  return useQuery(() => artifactQueryOptions.list(client, resolveAccessor(workspaceId)))
}
export function useChannelListQuery(
  client: AgentHqApiClient,
  workspaceId?: MaybeAccessor<string | undefined>
) {
  return useQuery(() => channelQueryOptions.list(client, resolveAccessor(workspaceId)))
}
export function useCreateDirectChannelMutation(
  client: AgentHqApiClient,
  workspaceId: MaybeAccessor<string>
) {
  return useMutation(() =>
    channelMutationOptions.direct(client, useQueryClient(), resolveAccessor(workspaceId))
  )
}
export function useCreateGroupChannelMutation(
  client: AgentHqApiClient,
  workspaceId: MaybeAccessor<string>
) {
  return useMutation(() =>
    channelMutationOptions.group(client, useQueryClient(), resolveAccessor(workspaceId))
  )
}
export function useUpdateChannelMutation(
  client: AgentHqApiClient,
  workspaceId: MaybeAccessor<string>
) {
  return useMutation(() =>
    channelMutationOptions.update(client, useQueryClient(), resolveAccessor(workspaceId))
  )
}
export function useArchiveChannelMutation(
  client: AgentHqApiClient,
  workspaceId: MaybeAccessor<string>
) {
  return useMutation(() =>
    channelMutationOptions.archive(client, useQueryClient(), resolveAccessor(workspaceId))
  )
}
export function useMessageListQuery(
  client: AgentHqApiClient,
  workspaceId?: MaybeAccessor<string | undefined>,
  channelId?: MaybeAccessor<string | undefined>,
  options: Readonly<{
    afterSequence?: MaybeAccessor<number | undefined>
    limit?: number
    threadRootMessageId?: string
  }> = {},
  queryConfig: Readonly<{
    /** Ephemeral page shown while the fetch is in flight — not written to cache. */
    placeholderData?: () => Awaited<ReturnType<AgentHqApiClient['listMessages']>> | undefined
  }> = {}
) {
  // `afterSequence` is resolved HERE, inside the reactive query scope, so a
  // paging cursor participates in the query key. It used to be read once while
  // building a plain options object at component setup, so the key never
  // changed and "Load newer messages" could not refetch anything.
  return useQuery(() => {
    const afterSequence = resolveAccessor(options.afterSequence)
    const page: Readonly<{
      afterSequence?: number
      limit?: number
      threadRootMessageId?: string
    }> = {
      ...(afterSequence !== undefined ? { afterSequence } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.threadRootMessageId !== undefined
        ? { threadRootMessageId: options.threadRootMessageId }
        : {}),
    }
    return {
      ...messageQueryOptions.list(
        client,
        resolveAccessor(workspaceId),
        resolveAccessor(channelId),
        page
      ),
      ...(queryConfig.placeholderData ? { placeholderData: queryConfig.placeholderData } : {}),
    }
  })
}
/**
 * Warms the message-page cache for a channel on intent (hover/focus), so the
 * transcript's first paint hits the cache instead of the network. The options
 * must match the surface's list query exactly — prefetch keys are structural.
 */
export function usePrefetchChannelMessages(
  client: AgentHqApiClient,
  workspaceId?: MaybeAccessor<string | undefined>
) {
  const queryClient = useQueryClient()
  return (channelId: string) => {
    const id = resolveAccessor(workspaceId)
    if (!id) return
    void queryClient.prefetchQuery(messageQueryOptions.list(client, id, channelId, { limit: 100 }))
  }
}
/**
 * Warms a thread's reply page on intent (hover/focus of the thread
 * affordance), so the panel's first paint hits the cache. Options must match
 * the panel's list query exactly — prefetch keys are structural.
 */
export function usePrefetchThreadMessages(
  client: AgentHqApiClient,
  workspaceId?: MaybeAccessor<string | undefined>,
  channelId?: MaybeAccessor<string | undefined>
) {
  const queryClient = useQueryClient()
  return (rootMessageId: string) => {
    const workspace = resolveAccessor(workspaceId)
    const channel = resolveAccessor(channelId)
    if (!workspace || !channel) return
    void queryClient.prefetchQuery(
      messageQueryOptions.list(client, workspace, channel, {
        limit: 100,
        threadRootMessageId: rootMessageId,
      })
    )
  }
}
export function useCreateMessageMutation(
  client: MaybeAccessor<AgentHqApiClient>,
  workspaceId: MaybeAccessor<string>,
  channelId: MaybeAccessor<string>
) {
  return useMutation(() =>
    messageMutationOptions.create(
      resolveAccessor(client),
      useQueryClient(),
      resolveAccessor(workspaceId),
      resolveAccessor(channelId)
    )
  )
}
/**
 * Unread counts for every workspace the user belongs to, for the sidebar's
 * collapsed-workspace chips. Only the active workspace has an event stream;
 * the others are kept current by polling and window focus.
 */
export function useAccountSummaryQuery(client: AgentHqApiClient) {
  return useQuery(() => accountQueryOptions.summary(client))
}

export function useReadStateQuery(
  client: AgentHqApiClient,
  workspaceId?: MaybeAccessor<string | undefined>
) {
  return useQuery(() => readStateQueryOptions.detail(client, resolveAccessor(workspaceId)))
}

export function useMarkAllReadMutation(
  client: AgentHqApiClient,
  workspaceId: MaybeAccessor<string>
) {
  return useMutation(() =>
    readStateMutationOptions.all(client, useQueryClient(), resolveAccessor(workspaceId))
  )
}

export function useMarkChannelReadMutation(
  client: AgentHqApiClient,
  workspaceId: MaybeAccessor<string>
) {
  return useMutation(() =>
    readStateMutationOptions.channel(client, useQueryClient(), resolveAccessor(workspaceId))
  )
}

export function useMarkThreadReadMutation(
  client: AgentHqApiClient,
  workspaceId: MaybeAccessor<string>
) {
  return useMutation(() =>
    readStateMutationOptions.thread(client, useQueryClient(), resolveAccessor(workspaceId))
  )
}

export function useWorkspaceSearchQuery(
  client: AgentHqApiClient,
  workspaceId?: MaybeAccessor<string | undefined>,
  query: MaybeAccessor<string> = '',
  channelId?: MaybeAccessor<string | undefined>
) {
  return useQuery(() =>
    workspaceSearchQueryOptions.search(
      client,
      resolveAccessor(workspaceId),
      resolveAccessor(query),
      resolveAccessor(channelId)
    )
  )
}
