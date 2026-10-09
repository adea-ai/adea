/*
 * The desktop seam of the account-wide directory and inbox (M11.03, #1174).
 * Mounted under browser-condition Solid exactly like the sibling
 * account-directory suites; plain discovery spawns that runner. The desktop
 * runtime is exercised for real through a stubbed shell origin and a
 * recording fetch, so the requests carry what the real client would send.
 *
 * The load-bearing property under regression: the client instance the mounted
 * surface captures (createAccountDirectoryPages closes over it for refresh,
 * the inbox poll, and every appended page) must resolve its credential from
 * the LIVE session on every request. A rotation or sign-out in the same
 * workspace never remounts the surface, so a captured snapshot credential
 * keeps authorizing requests with a dead (or someone else's) session.
 * Account-change fencing (watchAccountIdentity clearing the ['account', …]
 * entries) and late-response fencing (a stale in-flight page cannot resurrect
 * cleared cache) are pinned alongside, because the live resolution must not
 * weaken them.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ApiClientError } from '@adea-ai/api-client'
import type { AccountDirectoryApiClient } from '@adea-ai/api-client/account-directory'
import type { DesktopSession } from '@adea-ai/auth/desktop'
import { accountQueryKeys } from '@adea-ai/data'
import type {
  AccountConversationInboxEntry,
  AccountDirectoryAgent,
} from '@adea-ai/types/account-directory'
import { QueryClient } from '@tanstack/solid-query'
import { createRoot, createSignal, type Accessor } from 'solid-js'
import { isServer as isServerSolid } from 'solid-js/web'

import {
  createAccountDirectoryPages,
  createAccountInboxPages,
  watchAccountIdentity,
} from '../src/lib/account-directory'
import { desktopRuntime } from '../src/lib/desktop-runtime'

const tick = () => new Promise<void>((done) => setTimeout(done, 0))
const settle = async () => {
  for (let index = 0; index < 8; index += 1) await tick()
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

const conversation = (id: string): AccountConversationInboxEntry => ({
  agentId: 'agent-1',
  createdAt: '2026-10-01T00:00:00.000Z',
  id,
  isPrimaryProjectChannel: false,
  kind: 'direct_agent',
  latestTopLevelSequence: 4,
  lifecycleState: 'active',
  sortOrder: 0,
  threadUnreadCount: 0,
  title: `Conversation ${id}`,
  topLevelUnreadCount: 0,
  unread: false,
  unreadMentions: 0,
  updatedAt: '2026-10-02T00:00:00.000Z',
  version: 3,
  visibility: 'participants',
  workspaceId: 'workspace-1',
})

/** Two distinct shell sessions for the same workspace: a rotation, not a switch. */
const accountA: DesktopSession = {
  credential: 'a'.repeat(32),
  expiresAt: '2027-01-01T00:00:00.000Z',
  sessionId: '11111111-1111-4111-8111-111111111111',
}
const accountB: DesktopSession = {
  credential: 'b'.repeat(32),
  expiresAt: '2027-01-01T00:00:00.000Z',
  sessionId: '22222222-2222-4222-8222-222222222222',
}

type RecordedCall = Readonly<{
  path: string
  after?: string
  authorization?: string
  sessionId?: string
}>

/** Mutable per-test fetch state; installed fresh by `beforeEach`. */
let calls: RecordedCall[]
let directoryPages: AccountDirectoryAgent[][]
let inboxPages: AccountConversationInboxEntry[][]
/** Arms exactly one park: the next Agents request waits for its release. */
let parkNextAgentsRequest: boolean
let parkedAgents: ((response: Response) => void) | undefined

type GlobalsWithDesktop = typeof globalThis & {
  window?: { location: { origin: string } }
  __ADEA_DESKTOP_CLOUD_ORIGIN__?: string
}
const globals = globalThis as GlobalsWithDesktop

const previousFetch = globalThis.fetch
const previousWindow = globals.window
const previousCloudOrigin = globals.__ADEA_DESKTOP_CLOUD_ORIGIN__

/**
 * The client the mounted surface captures, built the way
 * `desktop-workspace-entry.tsx` builds it. The seam under regression lives in
 * this call: a snapshot session (`session()`) bakes the credential into the
 * captured instance forever; the live accessor (`session`) lets every request
 * re-resolve the current session.
 */
const buildSurfaceClient = (session: Accessor<DesktopSession | undefined>) =>
  desktopRuntime().createAccountDirectoryClient(session())

const mountDirectoryPages = (client: AccountDirectoryApiClient) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const mounted = createRoot((rootDispose) => ({
    rootDispose,
    pages: createAccountDirectoryPages(client, queryClient),
  }))
  return { queryClient, dispose: mounted.rootDispose, pages: mounted.pages }
}

const mountInboxPages = (client: AccountDirectoryApiClient) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const mounted = createRoot((rootDispose) => ({
    rootDispose,
    pages: createAccountInboxPages(client, queryClient),
  }))
  return { queryClient, dispose: mounted.rootDispose, pages: mounted.pages }
}

const lastCall = (): RecordedCall => calls[calls.length - 1]!

const isServer = isServerSolid

if (isServer) {
  test('browser-condition Solid runner carries the mounted desktop-client cases', () => {
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
  beforeEach(() => {
    calls = []
    directoryPages = [[agent('a1'), agent('a2')], [agent('a3')]]
    inboxPages = [[conversation('c1'), conversation('c2')], [conversation('c3')]]
    parkNextAgentsRequest = false
    parkedAgents = undefined
    globals.window = { location: { origin: 'http://localhost:1420' } }
    globals.__ADEA_DESKTOP_CLOUD_ORIGIN__ = 'https://cloud.adea.test'
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost:1420')
      const headers = new Headers(init?.headers)
      const call: RecordedCall = {
        path: url.pathname,
        after: url.searchParams.get('after') ?? undefined,
        authorization: headers.get('Authorization') ?? undefined,
        sessionId: headers.get('X-Adea-Desktop-Session') ?? undefined,
      }
      calls.push(call)
      // The server answers account-scoped reads only with a credential; a
      // credential-less request is the signed-out case and gets 401.
      if (!call.authorization) {
        return Response.json({ message: 'session required' }, { status: 401 })
      }
      const index = call.after === undefined ? 0 : Number(call.after)
      if (url.pathname === '/api/v1/account/agents') {
        if (parkNextAgentsRequest) {
          parkNextAgentsRequest = false
          return new Promise<Response>((resolve) => {
            parkedAgents = resolve
          })
        }
        const agents = directoryPages[index] ?? []
        return index + 1 < directoryPages.length
          ? Response.json({ agents, nextCursor: String(index + 1) })
          : Response.json({ agents })
      }
      if (url.pathname === '/api/v1/account/conversations') {
        const conversations = inboxPages[index] ?? []
        return index + 1 < inboxPages.length
          ? Response.json({ conversations, nextCursor: String(index + 1) })
          : Response.json({ conversations })
      }
      return Response.json({ message: 'not found' }, { status: 404 })
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = previousFetch
    globals.window = previousWindow
    if (previousCloudOrigin === undefined) delete globals.__ADEA_DESKTOP_CLOUD_ORIGIN__
    else globals.__ADEA_DESKTOP_CLOUD_ORIGIN__ = previousCloudOrigin
  })

  test('a same-workspace session rotation is honoured by the next refresh', async () => {
    const [session, setSession] = createSignal<DesktopSession | undefined>(accountA)
    const client = buildSurfaceClient(session)
    const mounted = mountDirectoryPages(client)
    try {
      await settle()
      expect(mounted.pages.error()).toBeUndefined()
      expect(calls.map(({ path, authorization }) => ({ path, authorization }))).toEqual([
        { path: '/api/v1/account/agents', authorization: `Desktop ${accountA.credential}` },
      ])

      // Rotation in the SAME workspace: no remount happens, only the
      // credential moves. The captured client must follow it.
      setSession(accountB)
      mounted.pages.refresh()
      await settle()
      expect(lastCall().authorization).toBe(`Desktop ${accountB.credential}`)
      expect(lastCall().sessionId).toBe(accountB.sessionId)
      expect(mounted.pages.error()).toBeUndefined()
    } finally {
      mounted.dispose()
      mounted.queryClient.clear()
    }
  })

  test('pagination after a rotation continues on the returned cursor with the new credential', async () => {
    const [session, setSession] = createSignal<DesktopSession | undefined>(accountA)
    const client = buildSurfaceClient(session)
    const mounted = mountDirectoryPages(client)
    try {
      await settle()
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['a1', 'a2'])
      expect(mounted.pages.canLoadMore()).toBe(true)

      setSession(accountB)
      mounted.pages.loadMore()
      await settle()
      expect(calls[1]).toMatchObject({
        path: '/api/v1/account/agents',
        after: '1',
        authorization: `Desktop ${accountB.credential}`,
        sessionId: accountB.sessionId,
      })
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['a1', 'a2', 'a3'])
      expect(mounted.pages.exhausted()).toBe(true)
    } finally {
      mounted.dispose()
      mounted.queryClient.clear()
    }
  })

  test('the inbox poll path refetches with the current credential', async () => {
    const [session, setSession] = createSignal<DesktopSession | undefined>(accountA)
    const client = buildSurfaceClient(session)
    const mounted = mountInboxPages(client)
    try {
      await settle()
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['c1', 'c2'])

      // The 60s interval fires the same observer fetch a manual refetch runs;
      // refetchQueries exercises exactly that path without waiting a minute.
      setSession(accountB)
      await mounted.queryClient.refetchQueries({ queryKey: accountQueryKeys.inbox })
      await settle()
      expect(
        calls
          .filter(({ path }) => path === '/api/v1/account/conversations')
          .map(({ authorization }) => authorization)
      ).toEqual([`Desktop ${accountA.credential}`, `Desktop ${accountB.credential}`])
    } finally {
      mounted.dispose()
      mounted.queryClient.clear()
    }
  })

  test('sign-out drops the credential from the next request instead of leaking the captured one', async () => {
    const [session, setSession] = createSignal<DesktopSession | undefined>(accountA)
    const client = buildSurfaceClient(session)
    const mounted = mountDirectoryPages(client)
    try {
      await settle()
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['a1', 'a2'])

      setSession(undefined)
      mounted.pages.refresh()
      await settle()
      // The server 401s the credential-less request; the surface must show
      // the signed-out failure, not keep serving the stale session's rows.
      expect(lastCall().authorization).toBeUndefined()
      expect(lastCall().sessionId).toBeUndefined()
      expect(mounted.pages.error()).toBeInstanceOf(ApiClientError)
      expect((mounted.pages.error() as ApiClientError).status).toBe(401)
      expect(mounted.pages.rows()).toEqual([])
    } finally {
      mounted.dispose()
      mounted.queryClient.clear()
    }
  })

  test('an account switch clears the account cache and refetches as the new account', async () => {
    const [session, setSession] = createSignal<DesktopSession | undefined>(accountA)
    const client = buildSurfaceClient(session)
    const mounted = mountDirectoryPages(client)
    const [principalId, setPrincipalId] = createSignal<string | null | undefined>('user-a')
    const guard = createRoot((rootDispose) => {
      watchAccountIdentity(mounted.queryClient, principalId)
      return rootDispose
    })
    try {
      // An unobserved account entry (the summary) proves the guard ran: the
      // mounted pages would recreate their own keys on refetch.
      mounted.queryClient.setQueryData(accountQueryKeys.summary, { workspaces: [] })
      await settle()
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['a1', 'a2'])

      // The server now answers as account B; the switch must drop account A's
      // cached rows and the refetch must ride B's credential.
      directoryPages = [[agent('b1')]]
      setSession(accountB)
      setPrincipalId('user-b')
      await tick()
      await tick()
      expect(mounted.queryClient.getQueryData(accountQueryKeys.summary)).toBeUndefined()

      mounted.pages.refresh()
      await settle()
      expect(lastCall().authorization).toBe(`Desktop ${accountB.credential}`)
      expect(mounted.pages.rows().map(({ id }) => id)).toEqual(['b1'])
    } finally {
      guard()
      mounted.dispose()
      mounted.queryClient.clear()
    }
  })

  test('a stale in-flight page response cannot resurrect the cleared account cache', async () => {
    const [session, setSession] = createSignal<DesktopSession | undefined>(accountA)
    const client = buildSurfaceClient(session)
    const mounted = mountDirectoryPages(client)
    const [principalId, setPrincipalId] = createSignal<string | null | undefined>('user-a')
    const guard = createRoot((rootDispose) => {
      watchAccountIdentity(mounted.queryClient, principalId)
      return rootDispose
    })
    try {
      parkNextAgentsRequest = true
      await settle()
      const firstPageKey = accountQueryKeys.directory({ limit: 25 })
      expect(mounted.queryClient.getQueryData(firstPageKey)).toBeUndefined()

      // Sign out while the page is still in flight, then let the stale
      // response land: cancel-before-remove must keep the cache empty, and
      // nothing after the sign-out may ride the captured credential.
      setSession(undefined)
      setPrincipalId(undefined)
      await tick()
      await tick()
      expect(mounted.queryClient.getQueryData(firstPageKey)).toBeUndefined()

      parkedAgents?.(Response.json({ agents: [agent('a1'), agent('a2')] }))
      await settle()
      expect(mounted.queryClient.getQueryData(firstPageKey)).toBeUndefined()
      expect(mounted.pages.rows()).toEqual([])
      expect(
        calls.filter(({ authorization }) => authorization === `Desktop ${accountA.credential}`)
      ).toHaveLength(1)
    } finally {
      guard()
      mounted.dispose()
      mounted.queryClient.clear()
    }
  })
}
