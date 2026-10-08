import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { AgentHqApiClient } from '@adea-ai/api-client'
import type { ChannelSummary } from '@adea-ai/types'
import { channelQueryKeys, channelQueryOptions, workspaceQueryKeys } from '@adea-ai/data'
import { workspaceStore } from '@adea-ai/state'
import { QueryClient, QueryClientProvider } from '@tanstack/solid-query'
import { createComponent, createRoot } from 'solid-js'
import { isServer } from 'solid-js/web'
import { useWorkspaceController } from '../../../workspace-ui/src/use-workspace-controller'

const tick = () => new Promise<void>((done) => setTimeout(done, 0))
const workspaceId = 'controller-workspace'
const channel = (id: string): ChannelSummary => ({
  id,
  workspaceId,
  kind: 'direct_agent',
  title: id,
  agentId: 'agent',
  lifecycleState: 'active',
  visibility: 'participants',
  participants: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  sortOrder: 0,
  version: 1,
  isPrimaryProjectChannel: false,
})

function mount(initialChannels: readonly ChannelSummary[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  })
  let rows = initialChannels
  let denied = false
  let complete!: (value: { channel: ChannelSummary }) => void
  const api = {
    listChannels: async () => {
      if (denied) throw new Error('Audience denied')
      return rows
    },
    listProjects: async () => [],
    listAgents: async () => [],
    listTasks: async () => [],
    listArtifacts: async () => [],
    getReadState: async () => ({ readState: [] }),
    createGroupChannel: () =>
      new Promise((resolve) => {
        complete = resolve
      }),
    createDirectAgentChannel: () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  } as unknown as AgentHqApiClient
  const workspace = { id: workspaceId }
  client.setQueryData(workspaceQueryKeys.bootstrap, {
    workspaces: [workspace, { id: 'other' }],
    activeWorkspace: workspace,
  })
  workspaceStore.setState({
    selectedWorkspaceId: workspaceId,
    selectedChannelId: null,
    conversationAudienceEpochs: { [workspaceId]: 0 },
  })
  let controller!: ReturnType<typeof useWorkspaceController>
  const dispose = createRoot((cleanup) => {
    createComponent(QueryClientProvider, {
      client,
      get children() {
        controller = useWorkspaceController(api)
        return null
      },
    })
    return cleanup
  })
  return {
    controller,
    client,
    complete: (value: ChannelSummary) => complete({ channel: value }),
    deny: () => {
      denied = true
    },
    setRows: (value: readonly ChannelSummary[]) => {
      rows = value
    },
    close: () => {
      dispose()
      client.clear()
    },
  }
}

if (isServer) {
  test('controller audience regressions run with browser Solid', () => {
    const child = spawnSync(
      process.execPath,
      ['--conditions=browser', '--conditions=development', 'test', fileURLToPath(import.meta.url)],
      { encoding: 'utf8', timeout: 10000 }
    )
    expect(child.error).toBeUndefined()
    expect(child.status, `${child.stdout}${child.stderr}`).toBe(0)
    expect(`${child.stdout}${child.stderr}`).toContain('0 fail')
  }, 12000)
} else {
  const previousState = {
    ...workspaceStore.getState(),
    conversationAudienceEpochs: { ...workspaceStore.getState().conversationAudienceEpochs },
  }
  afterEach(() => workspaceStore.setState(previousState, true))

  test('retained successful list cannot reselect a revoked sole fallback; empty refresh stays clear', async () => {
    const mounted = mount([channel('revoked')])
    try {
      await tick()
      await tick()
      expect(workspaceStore.getState().selectedChannelId).toBe('revoked')
      mounted.setRows([])
      mounted.client
        .getQueryCache()
        .find({ queryKey: channelQueryKeys.list(workspaceId) })!
        .setState({ data: undefined, status: 'pending', fetchStatus: 'idle' })
      workspaceStore.getState().invalidateConversationAudience(workspaceId)
      expect(workspaceStore.getState().selectedChannelId).toBeNull()
      expect(mounted.controller.channels).toEqual([])
      mounted.setRows([])
      await mounted.client.refetchQueries({ queryKey: channelQueryKeys.list(workspaceId) })
      await tick()
      expect(workspaceStore.getState().selectedChannelId).toBeNull()
      mounted.setRows([channel('authorized')])
      await mounted.client.refetchQueries({ queryKey: channelQueryKeys.list(workspaceId) })
      await tick()
      expect(workspaceStore.getState().selectedChannelId).toBe('authorized')
    } finally {
      mounted.close()
    }
  })

  test('denied refresh cannot restore the revoked selected channel', async () => {
    const mounted = mount([channel('revoked')])
    try {
      await tick()
      await tick()
      mounted.deny()
      workspaceStore.getState().invalidateConversationAudience(workspaceId)
      await mounted.client.refetchQueries({ queryKey: channelQueryKeys.list(workspaceId) })
      await tick()
      expect(mounted.controller.channels).toEqual([])
      expect(mounted.controller.selectedChannel).toBeUndefined()
      expect(workspaceStore.getState().selectedChannelId).toBeNull()
    } finally {
      mounted.close()
    }
  })

  test('workspace switch cannot use the retained previous workspace list at the same epoch', async () => {
    const mounted = mount([channel('old-workspace')])
    try {
      await tick()
      await tick()
      mounted.setRows([])
      mounted.controller.selectWorkspace('other')
      expect(mounted.controller.channels).toEqual([])
      expect(workspaceStore.getState().selectedChannelId).toBeNull()
      await tick()
      await tick()
      expect(workspaceStore.getState().selectedChannelId).toBeNull()
    } finally {
      mounted.close()
    }
  })

  test('settled empty list clears a stale selection without using pending data', async () => {
    const mounted = mount([channel('removed')])
    try {
      await tick()
      await tick()
      mounted.setRows([])
      await mounted.client.refetchQueries({ queryKey: channelQueryKeys.list(workspaceId) })
      await tick()
      expect(workspaceStore.getState().selectedChannelId).toBeNull()
    } finally {
      mounted.close()
    }
  })

  test('channel fetch retains its original epoch across an audience change', async () => {
    workspaceStore.setState({ conversationAudienceEpochs: { [workspaceId]: 0 } })
    let complete!: (rows: readonly ChannelSummary[]) => void
    const api = {
      listChannels: () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    } as unknown as AgentHqApiClient
    const pending = channelQueryOptions.list(api, workspaceId).queryFn()
    workspaceStore.getState().invalidateConversationAudience(workspaceId)
    complete([channel('old-response')])
    expect((await pending).conversationAudienceEpoch).toBe(0)
  })

  test('late direct result cannot select after audience invalidation', async () => {
    const mounted = mount([])
    try {
      await tick()
      await tick()
      const pending = mounted.controller.openAgentConversation('agent')
      await tick()
      workspaceStore.getState().invalidateConversationAudience(workspaceId)
      mounted.complete(channel('late-revoked'))
      await pending
      await tick()
      expect(workspaceStore.getState().selectedChannelId).toBeNull()
    } finally {
      mounted.close()
    }
  })

  test('late group result cannot select after audience invalidation', async () => {
    const mounted = mount([])
    try {
      await tick()
      await tick()
      const pending = mounted.controller.createGroup('Group')
      await tick()
      workspaceStore.getState().invalidateConversationAudience(workspaceId)
      mounted.complete(channel('late-group'))
      await pending
      await tick()
      expect(workspaceStore.getState().selectedChannelId).toBeNull()
    } finally {
      mounted.close()
    }
  })

  test('same audience direct result selects and keeps its open thread on refresh', async () => {
    const mounted = mount([])
    try {
      await tick()
      await tick()
      const pending = mounted.controller.openAgentConversation('agent')
      await tick()
      mounted.complete(channel('new-topic'))
      await pending
      expect(workspaceStore.getState().selectedChannelId).toBe('new-topic')
      workspaceStore.setState({ threadRootMessageId: 'thread' })
      mounted.setRows([channel('new-topic')])
      await mounted.client.refetchQueries({ queryKey: channelQueryKeys.list(workspaceId) })
      await tick()
      expect(workspaceStore.getState().threadRootMessageId).toBe('thread')
    } finally {
      mounted.close()
    }
  })

  test('late direct result cannot select in another workspace', async () => {
    const mounted = mount([])
    try {
      await tick()
      await tick()
      const pending = mounted.controller.openAgentConversation('agent')
      await tick()
      mounted.controller.selectWorkspace('other')
      await tick()
      mounted.complete(channel('old-workspace-topic'))
      await pending
      await tick()
      expect(workspaceStore.getState().selectedChannelId).toBeNull()
    } finally {
      mounted.close()
    }
  })
}
