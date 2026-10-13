/*
 * Cursor pagination for the account-wide directory and inbox (M11.03, #1174).
 * Mounted under browser-condition Solid exactly like the `@adea-ai/data`
 * resource tests; plain discovery spawns that runner.
 *
 * The load-bearing properties: pages are only ever requested by the cursor the
 * previous page returned (no unbounded fetches), loaded pages stay independent
 * of the selected workspace, and a refresh refetches exactly the pages the
 * surface holds.
 */
import { afterEach, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { AccountDirectoryApiClient } from '@adea-ai/api-client/account-directory'
import type {
  AccountConversationInboxEntry,
  AccountDirectoryAgent,
  AccountDirectoryPageInput,
} from '@adea-ai/types/account-directory'
import {
  accountQueryKeys,
  agentMutationOptions,
  channelMutationOptions,
  releaseWorkspaceCache,
} from '@adea-ai/data'
import { workspaceStore, type WorkspaceState } from '@adea-ai/state'
import { QueryClient } from '@tanstack/solid-query'
import { createRoot, createSignal } from 'solid-js'
import { isServer as isServerSolid } from 'solid-js/web'

import {
  createAccountDirectoryPages,
  createAccountInboxPages,
  emptyAccountListCopy,
} from '../src/lib/account-directory'

const tick = () => new Promise<void>((done) => setTimeout(done, 0))

async function settleUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await tick()
  }
  expect(predicate()).toBe(true)
}

const agent = (id: string): AccountDirectoryAgent => ({
  createdAt: '2026-10-01T00:00:00.000Z',
  id,
  isWorkspaceLead: false,
  lifecycleState: 'active',
  name: `Agent ${id}`,
  profile: { id: `prf_${id}`, state: 'available', version: '1', revision: 1 },
  updatedAt: '2026-10-02T00:00:00.000Z',
  workspaceId: 'workspace-1',
})

const conversation = (id: string, title: string): AccountConversationInboxEntry => ({
  createdAt: '2026-10-01T00:00:00.000Z',
  id,
  isPrimaryProjectChannel: false,
  kind: 'group',
  latestTopLevelSequence: 0,
  lifecycleState: 'active',
  sortOrder: 0,
  title,
  threadUnreadCount: 0,
  topLevelUnreadCount: 0,
  unread: false,
  unreadMentions: 0,
  updatedAt: '2026-10-02T00:00:00.000Z',
  version: 1,
  visibility: 'workspace',
  workspaceId: 'workspace-1',
})

/**
 * A directory API cut into cursor-addressed pages: `after` is the numeric
 * page index the previous page minted. The pages array is mutable so tests
 * can change what the server would answer next.
 */
function pagedDirectoryClient(pages: AccountDirectoryAgent[][]) {
  const calls: AccountDirectoryPageInput[] = []
  const client = {
    accountAgentDirectory: async (input: AccountDirectoryPageInput) => {
      calls.push(input)
      const index = input.after === undefined ? 0 : Number(input.after)
      const agents = pages[index] ?? []
      return index + 1 < pages.length ? { agents, nextCursor: String(index + 1) } : { agents }
    },
  } as unknown as AccountDirectoryApiClient
  return { client, calls }
}

const KEYSET_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'

function keysetAgent(index: number, name = `Agent${String(index).padStart(2, '0')}`) {
  const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
  return { ...agent(id), name, workspaceId: KEYSET_WORKSPACE_ID }
}

type DirectorySortKey = Readonly<{ workspaceId: string; name: string; id: string }>

function directorySortKey(row: AccountDirectoryAgent): DirectorySortKey {
  return { workspaceId: row.workspaceId, name: row.name, id: row.id }
}

function encodeDirectoryCursor(row: AccountDirectoryAgent): string {
  return Buffer.from(JSON.stringify({ ...directorySortKey(row), v: 1 }), 'utf8').toString(
    'base64url'
  )
}

function decodeDirectoryCursor(cursor: string): DirectorySortKey {
  const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as DirectorySortKey
  return { workspaceId: decoded.workspaceId, name: decoded.name, id: decoded.id }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Mirrors the server's strict `(workspace_id, name, id) > cursor` keyset. */
function compareDirectoryKeys(left: DirectorySortKey, right: DirectorySortKey): number {
  return (
    compareText(left.workspaceId, right.workspaceId) ||
    compareText(left.name, right.name) ||
    compareText(left.id, right.id)
  )
}

/** Mutable server fixture using the production directory's composite keyset order. */
function keysetDirectoryClient(initialAgents: AccountDirectoryAgent[]) {
  let agents = [...initialAgents]
  const calls: AccountDirectoryPageInput[] = []
  const client = {
    accountAgentDirectory: async (input: AccountDirectoryPageInput) => {
      calls.push(input)
      const after = input.after ? decodeDirectoryCursor(input.after) : undefined
      const sorted = agents.toSorted((left, right) =>
        compareDirectoryKeys(directorySortKey(left), directorySortKey(right))
      )
      const matches = after
        ? sorted.filter((row) => compareDirectoryKeys(directorySortKey(row), after) > 0)
        : sorted
      const page = matches.slice(0, input.limit ?? 50)
      const last = page.at(-1)
      return matches.length > page.length && last
        ? { agents: page, nextCursor: encodeDirectoryCursor(last) }
        : { agents: page }
    },
  } as unknown as AccountDirectoryApiClient
  return {
    client,
    calls,
    setAgents: (next: AccountDirectoryAgent[]) => {
      agents = [...next]
    },
  }
}

function mountPages(
  client: AccountDirectoryApiClient,
  baseInput?: () => AccountDirectoryPageInput
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const mounted = createRoot((rootDispose) => ({
    rootDispose,
    pages: createAccountDirectoryPages(client, {
      ...(baseInput ? { baseInput } : {}),
      queryClient,
    }),
  }))
  return { queryClient, dispose: mounted.rootDispose, pages: mounted.pages }
}

/** The inbox half of the account-wide seam: conversations instead of agents. */
function pagedInboxClient(pages: AccountConversationInboxEntry[][]) {
  const calls: AccountDirectoryPageInput[] = []
  const client = {
    accountConversationInbox: async (input: AccountDirectoryPageInput) => {
      calls.push(input)
      const index = input.after === undefined ? 0 : Number(input.after)
      const conversations = pages[index] ?? []
      return index + 1 < pages.length
        ? { conversations, nextCursor: String(index + 1) }
        : { conversations }
    },
  } as unknown as AccountDirectoryApiClient
  return { client, calls }
}

function mountInboxPages(
  client: AccountDirectoryApiClient,
  baseInput?: () => AccountDirectoryPageInput
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const mounted = createRoot((rootDispose) => ({
    rootDispose,
    pages: createAccountInboxPages(client, {
      ...(baseInput ? { baseInput } : {}),
      queryClient,
    }),
  }))
  return { queryClient, dispose: mounted.rootDispose, pages: mounted.pages }
}

const isServer = isServerSolid

/** Stands in for `ApiClientError` without importing the client's internals. */
class PageFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApiClientError'
  }
}

if (isServer) {
  test('browser-condition Solid runner carries the mounted pagination cases', () => {
    const child = spawnSync(
      process.execPath,
      ['--conditions=browser', '--conditions=development', 'test', fileURLToPath(import.meta.url)],
      { encoding: 'utf8', timeout: 20_000, cwd: new URL('..', import.meta.url).pathname }
    )
    const output = `${child.stdout ?? ''}${child.stderr ?? ''}`
    expect(child.error).toBeUndefined()
    expect(child.signal).toBeNull()
    expect(child.status, output).toBe(0)
    expect(output).toContain('0 fail')
  }, 25_000)
} else {
  const previousState: WorkspaceState = {
    ...workspaceStore.getState(),
    conversationAudienceEpochs: { ...workspaceStore.getState().conversationAudienceEpochs },
  }
  afterEach(() => workspaceStore.setState(previousState, true))

  test('the first page is bounded and load-more requests exactly the returned cursor', async () => {
    const seed = [[agent('a1'), agent('a2')], [agent('a3')]]
    const { client, calls } = pagedDirectoryClient(seed)
    const mounted = mountPages(client)
    try {
      await tick()
      await tick()
      expect(mounted.pages.isLoading()).toBe(false)
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['a1', 'a2'])
      expect(mounted.pages.canLoadMore()).toBe(true)
      expect(mounted.pages.exhausted()).toBe(false)
      expect(calls).toEqual([{ limit: 25 }])

      mounted.pages.loadMore()
      await tick()
      await tick()
      await tick()
      expect(calls).toEqual([{ limit: 25 }, { limit: 25, after: '1' }])
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['a1', 'a2', 'a3'])
      // The last page returned no cursor: the list is exhausted and load-more
      // is neither offered nor able to fetch again.
      expect(mounted.pages.exhausted()).toBe(true)
      expect(mounted.pages.canLoadMore()).toBe(false)
      mounted.pages.loadMore()
      await tick()
      await tick()
      expect(calls).toEqual([{ limit: 25 }, { limit: 25, after: '1' }])
    } finally {
      mounted.dispose()
      mounted.queryClient.clear()
    }
  })

  test('changing the walk input restarts from the first page under the new key', async () => {
    // The authoritative search term and archive flag belong in every cache
    // key. Give each term distinct rows so an old result cannot masquerade as
    // the new server response after the walk restarts.
    const calls: AccountDirectoryPageInput[] = []
    const client = {
      accountAgentDirectory: async (input: AccountDirectoryPageInput) => {
        calls.push(input)
        const pages = input.q
          ? [[agent('studio-1')], [agent('studio-2')]]
          : [[agent('garden-1'), agent('garden-2')], [agent('garden-3')]]
        const index = input.after === undefined ? 0 : Number(input.after)
        const agents = pages[index] ?? []
        return index + 1 < pages.length ? { agents, nextCursor: String(index + 1) } : { agents }
      },
    } as unknown as AccountDirectoryApiClient
    const [term, setTerm] = createSignal('')
    const mounted = mountPages(client, () => (term() ? { q: term() } : {}))
    try {
      await tick()
      await tick()
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['garden-1', 'garden-2'])
      mounted.pages.loadMore()
      await tick()
      await tick()
      await tick()
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['garden-1', 'garden-2', 'garden-3'])
      expect(calls).toEqual([{ limit: 25 }, { limit: 25, after: '1' }])

      setTerm('studio')
      await tick()
      await tick()
      await tick()
      // The cursor walk is over: the first page of the new term, no stale
      // `after` from the previous walk, and the old walk's rows gone.
      expect(calls.at(-1)).toEqual({ limit: 25, q: 'studio' })
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['studio-1'])
      expect(mounted.pages.canLoadMore()).toBe(true)
      expect(mounted.pages.exhausted()).toBe(false)

      // Load-more continues the NEW walk, carrying the term on every page.
      mounted.pages.loadMore()
      await tick()
      await tick()
      await tick()
      expect(calls.at(-1)).toEqual({ limit: 25, q: 'studio', after: '1' })
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['studio-1', 'studio-2'])

      // Clearing the term restarts the walk again — and re-keys it, so the
      // termless first page is the cached one from the start of the session.
      setTerm('')
      await tick()
      await tick()
      await tick()
      expect(calls.at(-1)).toEqual({ limit: 25 })
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['garden-1', 'garden-2'])
      expect(mounted.pages.exhausted()).toBe(false)
    } finally {
      mounted.dispose()
      mounted.queryClient.clear()
    }
  })

  test('a doubled load-more request cannot append the same cursor page twice', async () => {
    const seed = [[agent('a1')], [agent('a2')]]
    const { client, calls } = pagedDirectoryClient(seed)
    const mounted = mountPages(client)
    try {
      await tick()
      await tick()
      mounted.pages.loadMore()
      mounted.pages.loadMore()
      mounted.pages.loadMore()
      await tick()
      await tick()
      await tick()
      expect(calls).toEqual([{ limit: 25 }, { limit: 25, after: '1' }])
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['a1', 'a2'])
    } finally {
      mounted.dispose()
      mounted.queryClient.clear()
    }
  })

  test('Agent creation and archive refresh loaded account pages in place', async () => {
    let agents = [agent('a1'), agent('a2')]
    const calls: AccountDirectoryPageInput[] = []
    const client = {
      accountAgentDirectory: async (input: AccountDirectoryPageInput) => {
        calls.push(input)
        const matches = agents
          .filter(({ name }) => !input.q || name.toLowerCase().includes(input.q.toLowerCase()))
          .toSorted((left, right) => left.name.localeCompare(right.name))
        const offset = input.after === undefined ? 0 : Number(input.after)
        const page = matches.slice(offset, offset + 1)
        return offset + 1 < matches.length
          ? { agents: page, nextCursor: String(offset + 1) }
          : { agents: page }
      },
      createAgent: async () => {
        const created = agent('a0')
        agents = [...agents, created]
        return { agent: created }
      },
      archiveAgent: async (_workspaceId: string, agentId: string) => {
        agents = agents.filter(({ id }) => id !== agentId)
      },
    }
    const mounted = mountPages(client as unknown as AccountDirectoryApiClient)
    try {
      await tick()
      await tick()
      mounted.pages.loadMore()
      await tick()
      await tick()
      await tick()
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['a1', 'a2'])

      const create = agentMutationOptions.create(
        client as never,
        mounted.queryClient,
        'workspace-1'
      )
      const created = await create.mutationFn({
        name: 'Agent a0',
        profileId: 'engineer',
        profileVersion: '1',
      })
      await create.onSuccess(created as never)
      await tick()
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['a0', 'a1'])
      expect(calls.slice(-2)).toEqual([{ limit: 25 }, { limit: 25, after: '1' }])

      const archive = agentMutationOptions.archive(
        client as never,
        mounted.queryClient,
        'workspace-1'
      )
      const archived = await archive.mutationFn('a0')
      await archive.onSuccess(archived as never, 'a0')
      await tick()
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['a1', 'a2'])
      expect(calls.slice(-2)).toEqual([{ limit: 25 }, { limit: 25, after: '1' }])
    } finally {
      mounted.dispose()
      mounted.queryClient.clear()
    }
  })

  test('insertion before a loaded keyset boundary rebuilds the successor cursor', async () => {
    const initialAgents = Array.from({ length: 51 }, (_, index) => keysetAgent(index + 1))
    const fixture = keysetDirectoryClient(initialAgents)
    const mounted = mountPages(fixture.client)

    try {
      await settleUntil(() => mounted.pages.rows().length === 25 && !mounted.pages.isFetching())
      mounted.pages.loadMore()
      await settleUntil(() => mounted.pages.rows().length === 50 && !mounted.pages.isFetching())
      expect(mounted.pages.rows().map(({ name }) => name)).toEqual(
        Array.from({ length: 50 }, (_, index) => `Agent${String(index + 1).padStart(2, '0')}`)
      )

      // The old page two starts strictly after Agent25. Inserting Agent00
      // moves Agent25 into the refreshed first page, so page two must follow
      // the new Agent24 boundary or the row would disappear from the walk.
      fixture.setAgents([...initialAgents, keysetAgent(0)])
      mounted.pages.refresh()
      const firstTwoPageNames = Array.from(
        { length: 50 },
        (_, index) => `Agent${String(index).padStart(2, '0')}`
      )
      await settleUntil(
        () =>
          !mounted.pages.isFetching() &&
          JSON.stringify(mounted.pages.rows().map(({ name }) => name)) ===
            JSON.stringify(firstTwoPageNames)
      )

      expect(mounted.pages.rows().map(({ name }) => name)).toEqual(firstTwoPageNames)
      expect(
        fixture.calls.some(
          (input) => input.after && decodeDirectoryCursor(input.after).name === 'Agent24'
        )
      ).toBe(true)

      // Loaded depth remains two pages, and further pagination continues from
      // the refreshed Agent49 cursor rather than the stale Agent50 cursor.
      mounted.pages.loadMore()
      await settleUntil(() => mounted.pages.rows().length === 52 && !mounted.pages.isFetching())
      expect(mounted.pages.rows().map(({ name }) => name)).toEqual(
        Array.from({ length: 52 }, (_, index) => `Agent${String(index).padStart(2, '0')}`)
      )
    } finally {
      mounted.dispose()
      mounted.queryClient.clear()
    }
  })

  test('a cached exhausted cursor cannot truncate loaded depth while it refetches', async () => {
    const initialAgents = Array.from({ length: 26 }, (_, index) => keysetAgent(index + 1))
    const expandedAgents = Array.from({ length: 79 }, (_, index) => keysetAgent(index + 2))
    const restoredAgents = Array.from({ length: 80 }, (_, index) => keysetAgent(index + 1))
    const fixture = keysetDirectoryClient(initialAgents)
    let holdAgent25Refetch = false
    let agent25RefetchStarted = false
    let releaseAgent25Refetch!: () => void
    const agent25RefetchGate = new Promise<void>((resolve) => {
      releaseAgent25Refetch = resolve
    })
    const client = {
      accountAgentDirectory: async (input: AccountDirectoryPageInput) => {
        const response = fixture.client.accountAgentDirectory(input)
        if (
          holdAgent25Refetch &&
          input.after &&
          decodeDirectoryCursor(input.after).name === 'Agent25'
        ) {
          holdAgent25Refetch = false
          agent25RefetchStarted = true
          await agent25RefetchGate
        }
        return response
      },
    } as unknown as AccountDirectoryApiClient
    const mounted = mountPages(client)
    const afterAgent51 = accountQueryKeys.directory({
      limit: 25,
      after: encodeDirectoryCursor(keysetAgent(51)),
    })

    try {
      // Cache an exhausted page under `after Agent25`.
      await settleUntil(() => mounted.pages.rows().length === 25 && !mounted.pages.isFetching())
      mounted.pages.loadMore()
      await settleUntil(() => mounted.pages.rows().length === 26 && !mounted.pages.isFetching())
      expect(mounted.pages.exhausted()).toBe(true)

      // Move the first boundary to Agent26, then load three pages. The old
      // `after Agent25` cache remains available but is no longer in the walk.
      fixture.setAgents(expandedAgents)
      mounted.pages.refresh()
      await settleUntil(() => mounted.pages.rows().length === 50 && !mounted.pages.isFetching())
      mounted.pages.loadMore()
      await settleUntil(() => mounted.pages.rows().length === 75 && !mounted.pages.isFetching())
      expect(
        mounted.queryClient
          .getQueryCache()
          .find({ queryKey: afterAgent51, exact: true })
          ?.getObserversCount()
      ).toBe(1)

      // Restoring Agent01 moves page two back to its cached, exhausted key.
      // Hold that key's fresh request while it still exposes stale success data.
      fixture.setAgents(restoredAgents)
      holdAgent25Refetch = true
      mounted.pages.refresh()
      await settleUntil(() => agent25RefetchStarted)
      await tick()
      await tick()
      expect(mounted.pages.isFetching()).toBe(true)
      expect(
        mounted.queryClient
          .getQueryCache()
          .find({ queryKey: afterAgent51, exact: true })
          ?.getObserversCount()
      ).toBe(1)

      releaseAgent25Refetch()
      await settleUntil(() => mounted.pages.rows().length === 75 && !mounted.pages.isFetching())
      expect(mounted.pages.rows().map(({ name }) => name)).toEqual(
        Array.from({ length: 75 }, (_, index) => `Agent${String(index + 1).padStart(2, '0')}`)
      )
      expect(
        fixture.calls.some(
          (input) => input.after && decodeDirectoryCursor(input.after).name === 'Agent50'
        )
      ).toBe(true)
    } finally {
      releaseAgent25Refetch()
      mounted.dispose()
      mounted.queryClient.clear()
    }
  })

  test('rename across a loaded keyset boundary rebuilds successor pages', async () => {
    const initialAgents = Array.from({ length: 51 }, (_, index) => keysetAgent(index + 1))
    const fixture = keysetDirectoryClient(initialAgents)
    const renameTarget = initialAgents.at(-1)!
    const client = {
      ...fixture.client,
      updateAgentPresentation: async (
        _workspaceId: string,
        agentId: string,
        presentation: { name?: string }
      ) => {
        const renamed = initialAgents.map((row) =>
          row.id === agentId ? { ...row, name: presentation.name ?? row.name } : row
        )
        fixture.setAgents(renamed)
        return { agent: renamed.find(({ id }) => id === agentId)! }
      },
    } as unknown as AccountDirectoryApiClient
    const mounted = mountPages(client)

    try {
      await settleUntil(() => mounted.pages.rows().length === 25 && !mounted.pages.isFetching())
      mounted.pages.loadMore()
      await settleUntil(() => mounted.pages.rows().length === 50 && !mounted.pages.isFetching())

      const presentation = agentMutationOptions.presentation(
        client as never,
        mounted.queryClient,
        KEYSET_WORKSPACE_ID
      )
      const input = {
        agentId: renameTarget.id,
        presentation: { expectedRevision: 1, name: 'Agent00' },
      }
      const result = await presentation.mutationFn(input as never)
      await presentation.onSuccess(result as never)
      await settleUntil(() => mounted.pages.rows().length === 50 && !mounted.pages.isFetching())

      expect(mounted.pages.rows().map(({ name }) => name)).toEqual(
        Array.from({ length: 50 }, (_, index) => `Agent${String(index).padStart(2, '0')}`)
      )
      expect(
        fixture.calls.some(
          (request) => request.after && decodeDirectoryCursor(request.after).name === 'Agent24'
        )
      ).toBe(true)
      expect(mounted.pages.canLoadMore()).toBe(true)
    } finally {
      mounted.dispose()
      mounted.queryClient.clear()
    }
  })

  test('Agent rename crossing the search boundary refreshes the mounted directory', async () => {
    let agents = [{ ...agent('a1'), name: 'Old Agent name' }]
    const client = {
      accountAgentDirectory: async (input: AccountDirectoryPageInput) => {
        const matches = agents.filter(
          ({ name }) => !input.q || name.toLowerCase().includes(input.q.toLowerCase())
        )
        return { agents: matches }
      },
      updateAgentPresentation: async (
        _workspaceId: string,
        agentId: string,
        presentation: { name?: string }
      ) => {
        agents = agents.map((current) =>
          current.id === agentId ? { ...current, name: presentation.name ?? current.name } : current
        )
        return { agent: agents.find(({ id }) => id === agentId)! }
      },
    }
    const mounted = mountPages(client as unknown as AccountDirectoryApiClient, () => ({
      q: 'needle',
    }))
    try {
      await tick()
      await tick()
      expect(mounted.pages.rows()).toEqual([])

      const presentation = agentMutationOptions.presentation(
        client as never,
        mounted.queryClient,
        'workspace-1'
      )
      const rename = async (name: string, expectedRevision: number) => {
        const input = {
          agentId: 'a1',
          presentation: { expectedRevision, name },
        }
        const result = await presentation.mutationFn(input as never)
        await presentation.onSuccess(result as never)
        await tick()
      }

      await rename('Needle Agent', 1)
      expect(mounted.pages.rows().map(({ id, name }) => [id, name])).toEqual([
        ['a1', 'Needle Agent'],
      ])

      await rename('Old Agent name', 2)
      expect(mounted.pages.rows()).toEqual([])
    } finally {
      mounted.dispose()
      mounted.queryClient.clear()
    }
  })

  test('conversation creation and archive refresh loaded inbox pages in place', async () => {
    let conversations = [conversation('c1', 'Conversation A'), conversation('c2', 'Conversation B')]
    const calls: AccountDirectoryPageInput[] = []
    const client = {
      accountConversationInbox: async (input: AccountDirectoryPageInput) => {
        calls.push(input)
        const matches = conversations
          .filter(({ title }) => !input.q || title.toLowerCase().includes(input.q.toLowerCase()))
          .toSorted((left, right) => left.title.localeCompare(right.title))
        const offset = input.after === undefined ? 0 : Number(input.after)
        const page = matches.slice(offset, offset + 1)
        return offset + 1 < matches.length
          ? { conversations: page, nextCursor: String(offset + 1) }
          : { conversations: page }
      },
      createGroupChannel: async () => {
        const created = conversation('c0', 'Conversation 0')
        conversations = [...conversations, created]
        return { channel: { id: created.id, title: created.title } }
      },
      archiveChannel: async (_workspaceId: string, channelId: string) => {
        const archived = conversations.find(({ id }) => id === channelId)!
        conversations = conversations.filter(({ id }) => id !== channelId)
        return { channel: { id: archived.id, title: archived.title } }
      },
    }
    const mounted = mountInboxPages(client as unknown as AccountDirectoryApiClient)
    try {
      await tick()
      await tick()
      mounted.pages.loadMore()
      await tick()
      await tick()
      await tick()
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['c1', 'c2'])

      const create = channelMutationOptions.group(
        client as never,
        mounted.queryClient,
        'workspace-1'
      )
      const context = create.onMutate()
      const input = { idempotencyKey: 'new-group', title: 'Conversation 0' }
      const created = await create.mutationFn(input as never)
      await create.onSuccess(created as never, input as never, context)
      await tick()
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['c0', 'c1'])
      expect(calls.slice(-2)).toEqual([{ limit: 25 }, { limit: 25, after: '1' }])

      const archive = channelMutationOptions.archive(
        client as never,
        mounted.queryClient,
        'workspace-1'
      )
      const archiveContext = archive.onMutate()
      const archiveInput = { channelId: 'c0', expectedVersion: 1 }
      const archived = await archive.mutationFn(archiveInput)
      await archive.onSuccess(archived as never, archiveInput, archiveContext)
      await tick()
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['c1', 'c2'])
      expect(calls.slice(-2)).toEqual([{ limit: 25 }, { limit: 25, after: '1' }])
    } finally {
      mounted.dispose()
      mounted.queryClient.clear()
    }
  })

  test('conversation rename crossing the search boundary refreshes the mounted cursor walk', async () => {
    let conversations = [
      conversation('c1', 'Needle Alpha'),
      conversation('c2', 'Needle Beta'),
      conversation('c3', 'Other Gamma'),
    ]
    const calls: AccountDirectoryPageInput[] = []
    const client = {
      accountConversationInbox: async (input: AccountDirectoryPageInput) => {
        calls.push(input)
        const matches = conversations
          .filter(({ title }) => !input.q || title.toLowerCase().includes(input.q.toLowerCase()))
          .toSorted((left, right) => left.title.localeCompare(right.title))
        const offset = input.after === undefined ? 0 : Number(input.after)
        const page = matches.slice(offset, offset + 1)
        return offset + 1 < matches.length
          ? { conversations: page, nextCursor: String(offset + 1) }
          : { conversations: page }
      },
      updateChannel: async (
        _workspaceId: string,
        channelId: string,
        update: { title?: string }
      ) => {
        const current = conversations.find(({ id }) => id === channelId)!
        const renamed = { ...current, title: update.title ?? current.title }
        conversations = conversations.map((entry) => (entry.id === channelId ? renamed : entry))
        return { channel: { id: renamed.id, title: renamed.title } }
      },
    }
    const mounted = mountInboxPages(client as unknown as AccountDirectoryApiClient, () => ({
      q: 'needle',
    }))
    try {
      await tick()
      await tick()
      mounted.pages.loadMore()
      await tick()
      await tick()
      await tick()
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['c1', 'c2'])

      const update = channelMutationOptions.update(
        client as never,
        mounted.queryClient,
        'workspace-1'
      )
      const rename = async (title: string, expectedVersion: number) => {
        const context = update.onMutate()
        const input = { channelId: 'c3', expectedVersion, update: { title } }
        const result = await update.mutationFn(input as never)
        await update.onSuccess(result as never, input as never, context)
        await tick()
      }

      await rename('Needle 0', 1)
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['c3', 'c1'])
      mounted.pages.loadMore()
      await tick()
      await tick()
      await tick()
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['c3', 'c1', 'c2'])

      await rename('Other Gamma', 2)
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['c1', 'c2'])
      expect(calls.slice(-3)).toEqual([
        { limit: 25, q: 'needle' },
        { limit: 25, q: 'needle', after: '1' },
        { limit: 25, q: 'needle', after: '2' },
      ])
    } finally {
      mounted.dispose()
      mounted.queryClient.clear()
    }
  })

  test('rows stay deduplicated when the server repeats an id across pages', async () => {
    // The keyset contract makes a repeated id a server bug; while it lasts the
    // UI must not show the row twice.
    const seed = [[agent('a1'), agent('a2')], [agent('a1')]]
    const { client } = pagedDirectoryClient(seed)
    const mounted = mountPages(client)
    try {
      await tick()
      await tick()
      mounted.pages.loadMore()
      await tick()
      await tick()
      await tick()
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['a1', 'a2'])
    } finally {
      mounted.dispose()
      mounted.queryClient.clear()
    }
  })

  test('a failed cursor page surfaces its error, stops load-more, and refresh recovers', async () => {
    const seed = [[agent('a1')], [agent('a2')]]
    const calls: AccountDirectoryPageInput[] = []
    let failNextPage = true
    const client = {
      accountAgentDirectory: async (input: AccountDirectoryPageInput) => {
        calls.push(input)
        if (input.after !== undefined && failNextPage) throw new PageFailure('page unavailable')
        const index = input.after === undefined ? 0 : Number(input.after)
        const agents = seed[index] ?? []
        return index + 1 < seed.length ? { agents, nextCursor: '1' } : { agents }
      },
    } as unknown as AccountDirectoryApiClient
    const mounted = mountPages(client)
    try {
      await tick()
      await tick()
      mounted.pages.loadMore()
      await tick()
      await tick()
      await tick()
      expect(mounted.pages.error()).toBeInstanceOf(Error)
      expect(mounted.pages.canLoadMore()).toBe(false)
      // Refresh revalidates every loaded page; with the failure removed the
      // same mounted surface converges without a remount.
      failNextPage = false
      mounted.pages.refresh()
      await tick()
      await tick()
      await tick()
      expect(mounted.pages.error()).toBeUndefined()
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['a1', 'a2'])
    } finally {
      mounted.dispose()
      mounted.queryClient.clear()
    }
  })

  test('an empty directory first page settles exhausted with no rows and no load-more request', async () => {
    const { client, calls } = pagedDirectoryClient([[]])
    const mounted = mountPages(client)
    try {
      await tick()
      await tick()
      expect(mounted.pages.rows()).toEqual([])
      expect(mounted.pages.isLoading()).toBe(false)
      expect(mounted.pages.error()).toBeUndefined()
      expect(mounted.pages.exhausted()).toBe(true)
      expect(mounted.pages.canLoadMore()).toBe(false)
      mounted.pages.loadMore()
      await tick()
      // The empty walk is complete: no cursor exists, so nothing is requested.
      expect(calls).toEqual([{ limit: 25 }])
      expect(mounted.pages.rows()).toEqual([])
    } finally {
      mounted.dispose()
      mounted.queryClient.clear()
    }
  })

  test('an empty inbox first page settles exhausted with no rows and no load-more request', async () => {
    const { client, calls } = pagedInboxClient([[]])
    const mounted = mountInboxPages(client)
    try {
      await tick()
      await tick()
      expect(mounted.pages.rows()).toEqual([])
      expect(mounted.pages.error()).toBeUndefined()
      expect(mounted.pages.exhausted()).toBe(true)
      expect(mounted.pages.canLoadMore()).toBe(false)
      mounted.pages.loadMore()
      await tick()
      expect(calls).toEqual([{ limit: 25 }])
    } finally {
      mounted.dispose()
      mounted.queryClient.clear()
    }
  })

  test('loaded pages are independent of the selected workspace and its cache release', async () => {
    const seed = [[agent('a1')], [agent('a2')]]
    const { client, calls } = pagedDirectoryClient(seed)
    const mounted = mountPages(client)
    try {
      await tick()
      await tick()
      mounted.pages.loadMore()
      await tick()
      await tick()
      await tick()
      const key = accountQueryKeys.directory({ limit: 25, after: '1' })
      expect(mounted.queryClient.getQueryData(key)).toBeDefined()

      // Switching the selected workspace releases that workspace's cache; the
      // account-wide pages sit outside the per-workspace prefix and stay, and
      // the mounted rows do not move or refetch.
      workspaceStore.getState().switchWorkspace('workspace-other')
      releaseWorkspaceCache(mounted.queryClient, 'workspace-other')
      expect(mounted.queryClient.getQueryData(key)).toBeDefined()
      await tick()
      await tick()
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['a1', 'a2'])
      expect(calls).toEqual([{ limit: 25 }, { limit: 25, after: '1' }])
    } finally {
      mounted.dispose()
      mounted.queryClient.clear()
    }
  })
}

test('an empty supplemental list claims no results only after every page was read', () => {
  const copy = {
    noun: 'Agent',
    exhaustedSearch: 'No authorized Agent name matches this search.',
    exhaustedEmpty: 'Agents from your other workspaces appear here.',
  }
  expect(emptyAccountListCopy({ ...copy, search: 'zzz', canLoadMore: false })).toBe(
    copy.exhaustedSearch
  )
  expect(emptyAccountListCopy({ ...copy, search: '', canLoadMore: false })).toBe(
    copy.exhaustedEmpty
  )
  // More pages remain: the loaded rows may simply have been filtered out.
  expect(emptyAccountListCopy({ ...copy, search: 'zzz', canLoadMore: true })).toContain(
    'in the results loaded so far'
  )
  expect(emptyAccountListCopy({ ...copy, search: '', canLoadMore: true })).toContain(
    'in the results loaded so far'
  )
})
