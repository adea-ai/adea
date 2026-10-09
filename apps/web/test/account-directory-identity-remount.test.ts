/*
 * Cache ownership of the account-wide directory and inbox across a navigation
 * unmount/remount (M11.03, #1174). Mounted under browser-condition Solid
 * exactly like the sibling account-directory suites; plain discovery spawns
 * that runner.
 *
 * The load-bearing property under regression: the account-scoped cache entries
 * live on the app-level QueryClient (`AgentHqQueryProvider`), which OUTLIVES
 * the navigation that mounts `watchAccountIdentity` — the desktop sign-out
 * drops the `DesktopWorkspace` subtree while the workspace mount keeps the
 * client. A guard whose memory is closure-local forgets the previous identity
 * exactly then: a remount under a DIFFERENT account adopts that account as a
 * fresh baseline and the previous account's rows (and pagination cursors) are
 * served to — and refetched under — the new one. With the provider's real
 * `staleTime` the entries are still fresh, so no remount refetch corrects it.
 *
 * The suites mirror `AgentHqQueryProvider`'s QueryClient defaults, because the
 * durable form of the leak only exists under them.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
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

/** Two shell sessions of DIFFERENT accounts: the remount switches identity. */
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
 * The client the mounted surfaces capture, built the way
 * `desktop-workspace-entry.tsx` builds it: the LIVE session accessor, so every
 * request re-resolves the credential (a rotation is not an identity change).
 */
const buildSurfaceClient = (session: Accessor<DesktopSession | undefined>) =>
  desktopRuntime().createAccountDirectoryClient(session)

/**
 * The app-level QueryClient exactly as `AgentHqQueryProvider` creates it. The
 * `staleTime` is load-bearing for the reproduction: a remounted surface whose
 * keys still hold fresh entries of the PREVIOUS account never refetches on its
 * own, so the leak is durable instead of a one-frame flash.
 */
const mountQueryClient = () =>
  new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false } },
  })

/**
 * One mounted navigation "lifetime": the identity guard FIRST (the navigation
 * wires it before its subtree mounts), then the surface. Both share the given
 * app-level client.
 */
const mountNavigation = (
  queryClient: QueryClient,
  client: AccountDirectoryApiClient,
  principalId: Accessor<string | null | undefined>,
  surface: 'directory' | 'inbox'
) =>
  createRoot((rootDispose) => {
    watchAccountIdentity(queryClient, principalId)
    const pages =
      surface === 'directory'
        ? createAccountDirectoryPages(client, { queryClient })
        : createAccountInboxPages(client, { queryClient })
    return { dispose: rootDispose, pages }
  })

const lastCall = (): RecordedCall => calls[calls.length - 1]!

const isServer = isServerSolid

if (isServer) {
  test('browser-condition Solid runner carries the mounted identity-remount cases', () => {
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
      }
      calls.push(call)
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

  test('a remount under another principal on the same QueryClient never sees the previous rows, live or late', async () => {
    const queryClient = mountQueryClient()
    const [session, setSession] = createSignal<DesktopSession | undefined>(accountA)
    const client = buildSurfaceClient(session)
    const firstPageKey = accountQueryKeys.directory({ limit: 25 })
    const secondPageKey = accountQueryKeys.directory({ limit: 25, after: '1' })

    // Account A's navigation lifetime: the first page settles, and a parked
    // load-more page stays in flight across the unmount.
    const navigationA = mountNavigation(queryClient, client, () => 'user-a', 'directory')
    try {
      await settle()
      expect(navigationA.pages.rows().map(({ id }) => id)).toEqual(['a1', 'a2'])
      parkNextAgentsRequest = true
      navigationA.pages.loadMore()
      await tick()
      expect(calls).toHaveLength(2)

      // Sign-out drops the navigation while the app-level client keeps every
      // account entry; then account B signs in and the navigation remounts.
      navigationA.dispose()
      setSession(accountB)
      directoryPages = [[agent('b1')]]
      const navigationB = mountNavigation(queryClient, client, () => 'user-b', 'directory')
      try {
        await settle()

        // B's rows only — never A's, and fetched under B's credential: the
        // remount must not have adopted B as a fresh baseline over A's cache.
        expect(navigationB.pages.rows().map(({ id }) => id)).toEqual(['b1'])
        expect(navigationB.pages.error()).toBeUndefined()
        expect(lastCall()).toMatchObject({
          path: '/api/v1/account/agents',
          authorization: `Desktop ${accountB.credential}`,
        })
        const owned = queryClient.getQueryData<{
          agents: readonly AccountDirectoryAgent[]
        }>(firstPageKey)
        expect(owned?.agents.map(({ id }) => id)).toEqual(['b1'])

        // The parked A response lands after B mounted: it must not repopulate
        // or overwrite B's cache, and A's cursor page must stay cleared.
        parkedAgents?.(Response.json({ agents: [agent('a3')] }))
        await settle()
        expect(queryClient.getQueryData(secondPageKey)).toBeUndefined()
        expect(navigationB.pages.rows().map(({ id }) => id)).toEqual(['b1'])
        expect(
          calls.filter(({ authorization }) => authorization === `Desktop ${accountA.credential}`)
        ).toHaveLength(2)
      } finally {
        navigationB.dispose()
      }
    } finally {
      queryClient.clear()
    }
  })

  test('a remount under the SAME principal keeps the cached pages without refetching', async () => {
    const queryClient = mountQueryClient()
    const [session] = createSignal<DesktopSession | undefined>(accountA)
    const client = buildSurfaceClient(session)

    const navigationA = mountNavigation(queryClient, client, () => 'user-a', 'directory')
    try {
      await settle()
      expect(navigationA.pages.rows().map(({ id }) => id)).toEqual(['a1', 'a2'])
      expect(calls).toHaveLength(1)
      navigationA.dispose()

      // Same principal, same client: the guard must not treat the remount as a
      // change, and the still-fresh cache must serve the surface as-is.
      const navigationB = mountNavigation(queryClient, client, () => 'user-a', 'directory')
      try {
        await settle()
        expect(navigationB.pages.rows().map(({ id }) => id)).toEqual(['a1', 'a2'])
        expect(calls).toHaveLength(1)
      } finally {
        navigationB.dispose()
      }
    } finally {
      queryClient.clear()
    }
  })

  test("the inbox remount under another principal shows only the new principal's conversations", async () => {
    const queryClient = mountQueryClient()
    const [session, setSession] = createSignal<DesktopSession | undefined>(accountA)
    const client = buildSurfaceClient(session)

    const navigationA = mountNavigation(queryClient, client, () => 'user-a', 'inbox')
    try {
      await settle()
      expect(navigationA.pages.rows().map(({ id }) => id)).toEqual(['c1', 'c2'])
      navigationA.dispose()

      setSession(accountB)
      inboxPages = [[conversation('d1')]]
      const navigationB = mountNavigation(queryClient, client, () => 'user-b', 'inbox')
      try {
        await settle()
        expect(navigationB.pages.rows().map(({ id }) => id)).toEqual(['d1'])
        expect(
          calls
            .filter(({ path }) => path === '/api/v1/account/conversations')
            .map(({ authorization }) => authorization)
        ).toEqual([`Desktop ${accountA.credential}`, `Desktop ${accountB.credential}`])
      } finally {
        navigationB.dispose()
      }
    } finally {
      queryClient.clear()
    }
  })

  test('a GC-collected owner marker never lets a remount adopt the previous rows', async () => {
    // Mechanism model of the provider innocent of timing: every default but
    // gcTime mirrors AgentHqQueryProvider, and the tiny gcTime stands in for
    // the real five-minute entry GC that collects the NEVER-OBSERVED owner
    // marker while actively observed account rows (the open inbox) stay alive
    // indefinitely. Pre-fix this test fails: the remount reads a missing
    // marker as a fresh baseline and serves A's inbox rows to B.
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false, gcTime: 30 },
      },
    })
    const [session, setSession] = createSignal<DesktopSession | undefined>(accountA)
    const client = buildSurfaceClient(session)
    const navigationA = mountNavigation(queryClient, client, () => 'user-a', 'inbox')
    // A second, navigation-independent observer keeps the inbox entries alive
    // across the navigation unmount — the workspace mount outliving sign-out.
    const background = createRoot((dispose) => {
      createAccountInboxPages(client, { queryClient })
      return dispose
    })
    try {
      await settle()
      expect(navigationA.pages.rows().map(({ id }) => id)).toEqual(['c1', 'c2'])
      navigationA.dispose()
      // Entry GC sweeps every unobserved entry — the owner marker pre-fix —
      // while the observed inbox rows survive.
      await new Promise((done) => setTimeout(done, 150))
      setSession(accountB)
      inboxPages = [[conversation('d1')]]
      const navigationB = mountNavigation(queryClient, client, () => 'user-b', 'inbox')
      try {
        await settle()
        expect(navigationB.pages.rows().map(({ id }) => id)).toEqual(['d1'])
        expect(navigationB.pages.error()).toBeUndefined()
      } finally {
        navigationB.dispose()
      }
    } finally {
      background()
      queryClient.clear()
    }
  })

  test('an A to B to A remount shows only each mount principal rows', async () => {
    const queryClient = mountQueryClient()
    const [session, setSession] = createSignal<DesktopSession | undefined>(accountA)
    const client = buildSurfaceClient(session)
    const seen: string[][] = []
    const mountAs = async (sessionValue: DesktopSession, principal: string) => {
      setSession(sessionValue)
      const navigation = mountNavigation(queryClient, client, () => principal, 'inbox')
      try {
        await settle()
        seen.push(navigation.pages.rows().map(({ id }) => id))
      } finally {
        navigation.dispose()
      }
    }
    await mountAs(accountA, 'user-a')
    inboxPages = [[conversation('d1')]]
    await mountAs(accountB, 'user-b')
    inboxPages = [[conversation('e1')]]
    await mountAs(accountA, 'user-a')
    expect(seen).toEqual([['c1', 'c2'], ['d1'], ['e1']])
    expect(
      calls
        .filter(({ path }) => path === '/api/v1/account/conversations')
        .map(({ authorization }) => authorization)
    ).toEqual([
      `Desktop ${accountA.credential}`,
      `Desktop ${accountB.credential}`,
      `Desktop ${accountA.credential}`,
    ])
  })

  test('a parked first page resolving after the next mount never overwrites it', async () => {
    const queryClient = mountQueryClient()
    const [session, setSession] = createSignal<DesktopSession | undefined>(accountA)
    const client = buildSurfaceClient(session)
    const firstPageKey = accountQueryKeys.directory({ limit: 25 })

    parkNextAgentsRequest = true
    const navigationA = mountNavigation(queryClient, client, () => 'user-a', 'directory')
    try {
      await tick()
      expect(calls).toHaveLength(1)
      // The FIRST page is still in flight when the navigation drops and B mounts.
      navigationA.dispose()
      setSession(accountB)
      directoryPages = [[agent('b1')]]
      const navigationB = mountNavigation(queryClient, client, () => 'user-b', 'directory')
      try {
        await settle()
        expect(navigationB.pages.rows().map(({ id }) => id)).toEqual(['b1'])
        // A's first page lands late: cancelled and removed, it must neither
        // repopulate the key nor disturb B's rows.
        parkedAgents?.(Response.json({ agents: [agent('a1'), agent('a2')] }))
        await settle()
        expect(navigationB.pages.rows().map(({ id }) => id)).toEqual(['b1'])
        expect(
          queryClient
            .getQueryData<{ agents: readonly AccountDirectoryAgent[] }>(firstPageKey)
            ?.agents.map(({ id }) => id)
        ).toEqual(['b1'])
        expect(
          calls.filter(({ authorization }) => authorization === `Desktop ${accountA.credential}`)
        ).toHaveLength(1)
      } finally {
        navigationB.dispose()
      }
    } finally {
      queryClient.clear()
    }
  })
}
