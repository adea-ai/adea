import { afterEach, expect, test } from 'bun:test'
import { QueryClient, QueryObserver } from '@tanstack/solid-query'
import { workspaceStore } from '@adea-ai/state'

import { createWorkspaceEventSubscription } from '../../src/events'
import {
  accountQueryKeys,
  channelQueryKeys,
  messageQueryKeys,
  readStateQueryKeys,
  workspaceSearchQueryKeys,
} from '../../src/index'

const workspaceId = 'workspace-work'
const channelId = 'former-public-channel'
const secret = 'REVOKED-CONTENT-CANARY'
const previousState = {
  ...workspaceStore.getState(),
  conversationAudienceEpochs: { ...workspaceStore.getState().conversationAudienceEpochs },
}
afterEach(() => workspaceStore.setState(previousState, true))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const fetchImpl = (async (_input, init) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(value) {
          controller = value
          init?.signal?.addEventListener('abort', () => controller.close(), { once: true })
        },
      })
    )) as typeof fetch
  return {
    fetchImpl,
    send: (sequence: number, event = 'workspace.audience_changed', extra = {}) =>
      controller.enqueue(
        new TextEncoder().encode(
          `id: signed.cursor${sequence}\nevent: ${event}\ndata: ${JSON.stringify({ workspaceSequence: sequence, ...extra })}\n\n`
        )
      ),
  }
}

test('an audience change erases active observers, selection and resident bodies before denied refetch and late responses', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  const oldBody = {
    messages: [
      {
        id: 'private-message',
        channelId,
        bodyText: secret,
        bodyContentRefId: 'private-content-ref',
      },
    ],
  }
  const lateBody = deferred<typeof oldBody>()
  const lateAccount = deferred<{ workspaces: { workspaceId: string; unreadChannels: number }[] }>()
  let bodyReads = 0
  let accountReads = 0
  let bodySignal: AbortSignal | undefined
  let accountSignal: AbortSignal | undefined
  const body = new QueryObserver(client, {
    queryKey: messageQueryKeys.list(workspaceId, channelId),
    initialData: oldBody,
    queryFn: ({ signal }) => {
      bodySignal ??= signal
      if (++bodyReads === 1) return lateBody.promise
      throw new Error('Channel unavailable')
    },
  })
  const account = new QueryObserver(client, {
    queryKey: accountQueryKeys.summary,
    initialData: { workspaces: [{ workspaceId, unreadChannels: 2 }] },
    queryFn: ({ signal }) => {
      accountSignal ??= signal
      return ++accountReads === 1 ? lateAccount.promise : Promise.resolve({ workspaces: [] })
    },
  })
  const list = new QueryObserver(client, {
    queryKey: channelQueryKeys.list(workspaceId),
    initialData: [{ id: channelId, title: secret }],
    staleTime: Infinity,
    queryFn: async () => [],
  })
  const stopBody = body.subscribe(() => {})
  const stopAccount = account.subscribe(() => {})
  const stopList = list.subscribe(() => {})
  client.setQueryData(channelQueryKeys.detail(workspaceId, channelId), {
    channel: { id: channelId, title: secret },
  })
  client.setQueryData(messageQueryKeys.detail(workspaceId, 'private-message'), oldBody.messages[0])
  client.setQueryData(
    messageQueryKeys.page(workspaceId, channelId, { threadRootMessageId: 'private-message' }),
    oldBody
  )
  client.setQueryData(readStateQueryKeys.detail(workspaceId), { readState: [{ channelId }] })
  client.setQueryData(workspaceSearchQueryKeys.search(workspaceId, 'private'), {
    results: [{ snippet: secret }],
  })
  const sibling = { messages: [{ bodyText: 'Sibling remains readable' }] }
  client.setQueryData(messageQueryKeys.list('workspace-sibling', 'sibling-channel'), sibling)
  workspaceStore.setState({
    selectedWorkspaceId: workspaceId,
    selectedChannelId: channelId,
    threadRootMessageId: 'private-message',
    selectedRuntimeNodeId: 'node',
    selectedDevProjectId: 'dev-project',
    selectedRuntimeSessionId: 'direct-session',
    selectedDevPaneId: 'terminal',
  })
  const transport = stream()
  const applied = deferred<void>()
  let immediateResults: unknown[] = []
  const subscription = createWorkspaceEventSubscription({
    workspaceId,
    url: 'https://test/events',
    queryClient: client,
    fetchImpl: transport.fetchImpl,
    schedule: () => () => {},
    onAudienceChanged: () => {
      immediateResults = [
        body.getCurrentResult().data,
        account.getCurrentResult().data,
        list.getCurrentResult().data,
      ]
      workspaceStore.getState().invalidateConversationAudience(workspaceId)
    },
    onDiagnostic: ({ event }) => {
      if (event === 'applied') applied.resolve()
    },
  })
  try {
    transport.send(1)
    await Promise.race([applied.promise, new Promise((done) => setTimeout(done, 0))])
    expect(body.getCurrentResult().data).toBeUndefined()
    expect(immediateResults).toEqual([undefined, undefined, undefined])
    expect(bodySignal?.aborted).toBe(true)
    expect(accountSignal?.aborted).toBe(true)
    expect(workspaceStore.getState()).toMatchObject({
      selectedChannelId: null,
      threadRootMessageId: null,
      selectedRuntimeSessionId: 'direct-session',
      selectedDevPaneId: 'terminal',
    })
    expect(
      client.getQueryData(messageQueryKeys.detail(workspaceId, 'private-message'))
    ).toBeUndefined()
    expect(client.getQueryData(readStateQueryKeys.detail(workspaceId))).toBeUndefined()
    expect(
      client.getQueryData(workspaceSearchQueryKeys.search(workspaceId, 'private'))
    ).toBeUndefined()
    lateBody.resolve(oldBody)
    lateAccount.resolve({ workspaces: [{ workspaceId, unreadChannels: 2 }] })
    await new Promise((done) => setTimeout(done, 0))
    expect(body.getCurrentResult().data).toBeUndefined()
    expect(body.getCurrentResult().isError).toBe(true)
    expect(list.getCurrentResult().data).toEqual([])
    expect(account.getCurrentResult().data).toEqual({ workspaces: [] })
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .findAll({ queryKey: ['workspaces', workspaceId] })
          .map((query) => query.state.data)
      )
    ).not.toContain(secret)
    expect(
      client.getQueryData(messageQueryKeys.list('workspace-sibling', 'sibling-channel'))
    ).toEqual(sibling)
    expect(subscription.appliedSequence()).toBe(1)
    const epoch = workspaceStore.getState().conversationAudienceEpochs[workspaceId]
    transport.send(1)
    await new Promise((done) => setTimeout(done, 0))
    expect(workspaceStore.getState().conversationAudienceEpochs[workspaceId]).toBe(epoch)
  } finally {
    subscription.stop()
    stopBody()
    stopAccount()
    stopList()
    client.clear()
  }
})

test('withheld events preserve authorized caches and audience frames reject identifier payloads', async () => {
  const client = new QueryClient()
  client.setQueryData(messageQueryKeys.list(workspaceId, channelId), { messages: [secret] })
  const transport = stream()
  let resets = 0
  const stored = new Map<string, string>()
  const subscription = createWorkspaceEventSubscription({
    workspaceId,
    url: 'https://test/events',
    queryClient: client,
    fetchImpl: transport.fetchImpl,
    storage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => {
        stored.set(key, value)
      },
      removeItem: (key) => {
        stored.delete(key)
      },
    },
    schedule: () => () => {},
    onAudienceChanged: () => {
      resets += 1
    },
  })
  try {
    transport.send(1, 'workspace.withheld')
    transport.send(2, 'workspace.audience_changed', { channelId })
    await new Promise((done) => setTimeout(done, 0))
    expect(subscription.appliedSequence()).toBe(1)
    expect([...stored.values()]).toContain('signed.cursor1')
    expect([...stored.values()]).not.toContain('signed.cursor2')
    expect(resets).toBe(0)
    expect(client.getQueryData(messageQueryKeys.list(workspaceId, channelId))).toEqual({
      messages: [secret],
    })
  } finally {
    subscription.stop()
    client.clear()
  }
})
