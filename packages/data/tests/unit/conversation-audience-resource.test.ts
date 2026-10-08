import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { AgentHqApiClient } from '@adea-ai/api-client'
import { messageQueryOptions, settledConversationPage } from '../../src'
import { useWorkspaceState, workspaceStore } from '@adea-ai/state'
import { QueryClient, useQuery } from '@tanstack/solid-query'
import { createEffect, createRoot, createSignal } from 'solid-js'
import { isServer } from 'solid-js/web'

const tick = () => new Promise<void>((done) => setTimeout(done, 0))

if (isServer) {
  test('normal unit discovery runs the mounted audience cases with browser-condition Solid', () => {
    const child = spawnSync(
      process.execPath,
      ['--conditions=browser', '--conditions=development', 'test', fileURLToPath(import.meta.url)],
      { encoding: 'utf8', timeout: 10_000 }
    )
    const output = `${child.stdout ?? ''}${child.stderr ?? ''}`
    expect(child.error).toBeUndefined()
    expect(child.signal).toBeNull()
    expect(child.status, output).toBe(0)
    expect(output).toContain('3 pass')
    expect(output).toContain('0 fail')
  }, 12_000)
} else {
  const workspaceId = 'audience-resource-workspace'
  const previousState = {
    ...workspaceStore.getState(),
    conversationAudienceEpochs: { ...workspaceStore.getState().conversationAudienceEpochs },
  }
  afterEach(() => workspaceStore.setState(previousState, true))

  test('unstamped resident pages wait for an authoritative audience-qualified fetch', () => {
    const resident: { messages: string[]; conversationAudienceEpoch?: number } = {
      messages: ['Resident page'],
    }
    expect(settledConversationPage({ isSuccess: true, data: resident }, 0)).toBeUndefined()
  })

  test('a mounted Solid query cannot readmit its old successful resource in the audience reset turn', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    workspaceStore.setState({ conversationAudienceEpochs: { [workspaceId]: 0 } })
    const oldPage = { messages: ['REVOKED-RESOURCE-CANARY'], conversationAudienceEpoch: 0 }
    const key = ['workspaces', workspaceId, 'channels', 'channel', 'messages']
    const mounted = createRoot((dispose) => {
      const epoch = useWorkspaceState((state) => state.conversationAudienceEpochs[workspaceId] ?? 0)
      const query = useQuery(
        () => ({
          queryKey: key,
          initialData: oldPage,
          staleTime: Infinity,
          queryFn: async () => {
            throw new Error('Channel unavailable')
          },
        }),
        () => client
      )
      const [transcript, setTranscript] = createSignal<string[]>([])
      let loadedEpoch = epoch()
      createEffect(() => {
        const currentEpoch = epoch()
        if (currentEpoch !== loadedEpoch) {
          loadedEpoch = currentEpoch
          setTranscript([])
        }
        const page = settledConversationPage(query, currentEpoch)
        if (page) setTranscript(page.messages)
      })
      return { dispose, query, transcript, epoch }
    })
    try {
      await tick()
      expect(mounted.transcript()).toEqual(oldPage.messages)
      const cached = client.getQueryCache().find({ queryKey: key })!
      // Solid Query queues the observer->resource update in a microtask. The UI
      // audience signal is synchronous and can run while the old success remains.
      cached.setState({ data: undefined, status: 'pending', fetchStatus: 'idle' })
      workspaceStore.getState().invalidateConversationAudience(workspaceId)
      expect(mounted.query.isSuccess).toBe(true)
      expect(mounted.query.data).toEqual(oldPage)
      expect(settledConversationPage(mounted.query, mounted.epoch())).toBeUndefined()
      expect(mounted.transcript()).toEqual([])
      await tick()
      await client.refetchQueries({ queryKey: key })
      await tick()
      expect(mounted.transcript()).toEqual([])
      expect(mounted.query.isError).toBe(true)
      client.setQueryData(key, {
        messages: ['Fresh authorized page'],
        conversationAudienceEpoch: 1,
      })
      await tick()
      expect(mounted.transcript()).toEqual(['Fresh authorized page'])
    } finally {
      mounted.dispose()
      client.clear()
    }
  })

  test('canonical page fetches retain their admission epoch even if the audience changes while awaiting the API', async () => {
    workspaceStore.setState({ conversationAudienceEpochs: { [workspaceId]: 0 } })
    let resolve!: (page: { messages: [] }) => void
    const api = {
      listMessages: () =>
        new Promise((done) => {
          resolve = done
        }),
    } as unknown as AgentHqApiClient
    const pending = messageQueryOptions.list(api, workspaceId, 'channel').queryFn()
    workspaceStore.getState().invalidateConversationAudience(workspaceId)
    resolve({ messages: [] })
    expect(await pending).toEqual({ messages: [], conversationAudienceEpoch: 0 })
  })
}
