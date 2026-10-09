// The account-wide directory and inbox seam (M11.03, #1174).
//
// Everything here consumes only the account-scoped client and query options
// the wiring slice published (#1203): the pages are keyed outside the
// per-workspace prefix, so the selected workspace never scopes, hides, or
// evicts them. This module keeps the URL/search patches, the cursor-paged
// query composition, and the account-identity cache guard in one place so the
// surface component stays presentational.
import type { AccountDirectoryApiClient } from '@adea-ai/api-client/account-directory'
import type {
  AccountConversationInboxEntry,
  AccountDirectoryAgent,
  AccountDirectoryPageInput,
} from '@adea-ai/types/account-directory'
import type { WorkspaceSummary } from '@adea-ai/types'
import { accountQueryKeys, accountQueryOptions } from '@adea-ai/data'
import { QueryClient, createQueries, useQueryClient } from '@tanstack/solid-query'
import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from 'solid-js'
import { ApiClientError } from '@adea-ai/api-client'

/** The two account-wide sections the directory surface can show. */
export type AccountDirectorySection = 'agents' | 'inbox'

/** Page size requested for every account-wide page. The server clamps 1..100. */
export const ACCOUNT_DIRECTORY_PAGE_SIZE = 25

/**
 * While the inbox is open, its pages follow the same slow poll as the account
 * summary, so unread badges move as data refreshes without a faster lane.
 */
export const ACCOUNT_INBOX_REFETCH_INTERVAL_MS = 60_000

/**
 * Prefixes of the account-wide page keys in `@adea-ai/data`. Invalidation is
 * prefix-based, and the shared key builder folds the page input in as a third
 * element, so the prefix is the first two elements of that key.
 */
const DIRECTORY_KEY_PREFIX = ['account', 'directory'] as const
const INBOX_KEY_PREFIX = ['account', 'inbox'] as const

/** Parses the `?directory=` search value; anything else is not a section. */
export function parseDirectorySection(
  value: string | undefined
): AccountDirectorySection | undefined {
  return value === 'agents' || value === 'inbox' ? value : undefined
}

/** The surface heading for one section. */
export function directoryTitle(section: AccountDirectorySection): string {
  return section === 'agents' ? 'Agents directory' : 'Conversations inbox'
}

/**
 * The workspace label shown on a directory or inbox row. Only names of
 * workspaces the account can still see resolve; a revoked or unknown id keeps
 * a neutral placeholder instead of leaking a name.
 */
export function accountWorkspaceLabel(
  workspaces: readonly WorkspaceSummary[],
  workspaceId: string
): string {
  return workspaces.find(({ id }) => id === workspaceId)?.name ?? 'Unavailable workspace'
}

/**
 * The search patch that opens one inbox conversation: the directory closes,
 * the conversation's own workspace becomes active, and the existing channel
 * deep link (`?workspace=…&channel=…`) selects it once that switch lands and
 * the workspace's conversation lists load. Stale single-surface params are
 * cleared so exactly the linked conversation is selected.
 */
export function conversationOpenPatch(entry: AccountConversationInboxEntry) {
  return {
    directory: undefined,
    task: undefined,
    thread: undefined,
    message: undefined,
    channel: entry.id,
    workspace: entry.workspaceId,
  }
}

/**
 * One conversation row's unread facts, straight from the entry's own counts.
 * The API computes them against the caller's read frontiers; this only shapes
 * them for rendering and accessible names.
 */
export function inboxUnreadModel(entry: AccountConversationInboxEntry) {
  return {
    /** Unread top-level plus thread messages. */
    count: entry.topLevelUnreadCount + entry.threadUnreadCount,
    /** Unread top-level messages that mention the caller. */
    mentions: entry.unreadMentions,
    /** The API's own unread verdict (includes a manual mark). */
    unread: entry.unread,
  }
}

/** Badge text for a count; past two digits the badge reads "99+". */
export function unreadBadgeText(count: number): string {
  return count > 99 ? '99+' : String(count)
}

/** The one-word kind of a conversation, for the row's kind chip. */
export function inboxKindLabel(entry: AccountConversationInboxEntry): string {
  if (entry.kind === 'direct_agent') return 'Direct'
  if (entry.kind === 'group') return 'Group'
  return 'Project'
}

/**
 * The row's accessible name: visible title first (WCAG 2.5.3), then the unread
 * facts and the workspace, so a screen reader hears what the badges show.
 */
export function inboxEntryLabel(
  entry: AccountConversationInboxEntry,
  workspaceName: string
): string {
  const unread = inboxUnreadModel(entry)
  const parts = [entry.title]
  if (unread.mentions > 0)
    parts.push(`${unread.mentions} ${unread.mentions === 1 ? 'mention' : 'mentions'}`)
  if (unread.count > 0) parts.push(`${unread.count} unread`)
  else if (unread.unread) parts.push('unread')
  parts.push(`in ${workspaceName}`)
  return parts.join(', ')
}

export type DirectoryAgentStatus = Readonly<{
  label: string
  tone: 'success' | 'warning' | 'neutral' | 'unknown'
  detail: string
}>

function agentProfileNotice(state: AccountDirectoryAgent['profile']['state']): string {
  if (state === 'available') return 'The selected profile version is configured.'
  if (state === 'unavailable')
    return 'Profile check unavailable. Refresh to retry; the selected version is unchanged.'
  return `This profile version is ${state}. Choose an approved, compatible version in the Agent's workspace.`
}

/**
 * Configuration status of one directory Agent — the same axis the workspace
 * roster's status chips report, derived from lifecycle and profile state only.
 * Runtime availability is never inferred.
 */
export function directoryAgentStatus(agent: AccountDirectoryAgent): DirectoryAgentStatus {
  if (agent.lifecycleState === 'archived')
    return { label: 'Archived', tone: 'neutral', detail: 'Archived Agent.' }
  if (agent.lifecycleState === 'configuration_error')
    return { label: 'Needs configuration', tone: 'warning', detail: 'Review configuration.' }
  if (agent.profile.state === 'available')
    return {
      label: 'Configured',
      tone: 'success',
      detail: agentProfileNotice(agent.profile.state),
    }
  return {
    label: 'Needs configuration',
    tone: 'warning',
    detail: agentProfileNotice(agent.profile.state),
  }
}

/** Non-leaking copy for a failed account-wide page request. */
export function directoryErrorCopy(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 401) return 'Your session expired. Sign in again to continue.'
    if (error.status === 403)
      return 'You do not have permission to view this directory with the current session.'
    if (error.status === 404) return 'This directory is no longer available.'
    if (error.status === 400) return 'The request was not valid. Retry from the directory.'
  }
  if (typeof navigator !== 'undefined' && !navigator.onLine)
    return 'You appear to be offline. Retry when the connection returns.'
  return 'Adea could not load this content. Your durable workspace was not changed.'
}

type PageOptions<Page> = {
  queryKey: readonly unknown[]
  queryFn: () => Promise<Page>
  refetchInterval?: number
}

export type AccountListPages<Row> = Readonly<{
  /** Rows of every settled page in page order, deduplicated by id. */
  rows: Accessor<readonly Row[]>
  /** True while the first page has not settled. */
  isLoading: Accessor<boolean>
  /** The first page error in page order, when any loaded page failed. */
  error: Accessor<unknown>
  /** True once the last loaded page ends without a continuation cursor. */
  exhausted: Accessor<boolean>
  /** True when another page may still be fetched by cursor. */
  canLoadMore: Accessor<boolean>
  /** True while a "load more" page is in flight. */
  isFetchingNextPage: Accessor<boolean>
  /** Appends the next cursor-bounded page. One page per cursor, ever. */
  loadMore: () => void
  /** Refetches every loaded page. */
  refresh: () => void
}>

/**
 * Cursor-paged account-wide list over `createQueries`.
 *
 * Each "load more" appends ONE page input whose key carries the cursor, so
 * every loaded page is a normal cache entry under the `['account', …]` prefix:
 * invalidation refetches exactly the pages the surface holds, a workspace
 * switch never touches them, and no code path can fetch without bound — a page
 * is only ever requested on an explicit load-more of the cursor the previous
 * page returned.
 */
function createAccountPages<
  Row extends Readonly<{ id: string }>,
  Page extends { nextCursor?: string },
>(
  keyPrefix: readonly [string, string],
  optionsFor: (input: AccountDirectoryPageInput) => PageOptions<Page>,
  rowsOf: (page: Page) => readonly Row[],
  queryClient: QueryClient
): AccountListPages<Row> {
  const [pageInputs, setPageInputs] = createSignal<readonly AccountDirectoryPageInput[]>([{}])
  // An account change (or any cache clear) removes the account-scoped page
  // entries while this surface still observes them. A removed query keeps
  // feeding its observer the pre-clear rows, and a refresh — which
  // invalidates what the CACHE holds — would find nothing to refetch, so the
  // surface would keep showing the previous identity's data until a remount.
  // A removal of one of this surface's pages therefore re-observes from the
  // first page: the fresh query has no data, refetches immediately, and rides
  // the client's CURRENT credential (see the desktop session seam). Loaded
  // pages are dropped with it — their rows described the previous identity.
  const unsubscribeCache = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'removed') return
    if (event.query.queryKey[0] === keyPrefix[0] && event.query.queryKey[1] === keyPrefix[1]) {
      setPageInputs(() => [{}])
    }
  })
  onCleanup(unsubscribeCache)
  const queries = createQueries(
    () => ({
      queries: pageInputs().map((input) => optionsFor(input)),
    }),
    () => queryClient
  )
  const rows = createMemo<readonly Row[]>(() => {
    const seen = new Set<string>()
    const collected: Row[] = []
    for (const query of queries) {
      if (!query.isSuccess || !query.data) continue
      for (const row of rowsOf(query.data)) {
        if (seen.has(row.id)) continue
        seen.add(row.id)
        collected.push(row)
      }
    }
    return collected
  })
  const lastQuery = createMemo(() => queries[queries.length - 1])
  const error = createMemo<unknown>(
    () => queries.find((query) => query.isError)?.error ?? undefined
  )
  const exhausted = createMemo(() => {
    const last = lastQuery()
    return Boolean(last?.isSuccess && last.data && last.data.nextCursor === undefined)
  })
  const isFetchingNextPage = createMemo(
    () => queries.length > 1 && Boolean(lastQuery()?.isFetching)
  )
  return {
    rows,
    isLoading: createMemo(() => Boolean(queries[0]?.isPending)),
    error,
    exhausted,
    canLoadMore: createMemo(() => {
      if (error() !== undefined) return false
      const last = lastQuery()
      return Boolean(last?.isSuccess && last.data?.nextCursor)
    }),
    isFetchingNextPage,
    loadMore: () => {
      const last = lastQuery()
      if (error() !== undefined || !last?.isSuccess || !last.data?.nextCursor) return
      const cursor = last.data.nextCursor
      // One page per cursor: a doubled click cannot append the same page twice.
      setPageInputs((inputs) =>
        inputs.some((input) => input.after === cursor) ? inputs : [...inputs, { after: cursor }]
      )
    },
    refresh: () => {
      void queryClient.invalidateQueries({ queryKey: [...keyPrefix] })
    },
  }
}

/** The account-wide Agents directory, cursor-paged. */
export function createAccountDirectoryPages(
  client: AccountDirectoryApiClient,
  queryClient?: QueryClient
): AccountListPages<AccountDirectoryAgent> {
  return createAccountPages(
    DIRECTORY_KEY_PREFIX,
    (input) =>
      accountQueryOptions.directory(client, { limit: ACCOUNT_DIRECTORY_PAGE_SIZE, ...input }),
    (page) => page.agents,
    queryClient ?? useQueryClient()
  )
}

/** The account-wide conversation inbox, cursor-paged, polled while open. */
export function createAccountInboxPages(
  client: AccountDirectoryApiClient,
  queryClient?: QueryClient
): AccountListPages<AccountConversationInboxEntry> {
  return createAccountPages(
    INBOX_KEY_PREFIX,
    (input) => ({
      ...accountQueryOptions.inbox(client, { limit: ACCOUNT_DIRECTORY_PAGE_SIZE, ...input }),
      refetchInterval: ACCOUNT_INBOX_REFETCH_INTERVAL_MS,
    }),
    (page) => page.conversations,
    queryClient ?? useQueryClient()
  )
}

/**
 * Erases every account-scoped cache entry (summary, directory pages, inbox
 * pages). The cached rows are authorization-shaped: they only describe what
 * the previous evaluation of the caller's own memberships allowed, so an
 * identity change must drop them instead of risking a leak across accounts.
 */
export function clearAccountScopedCache(queryClient: QueryClient): void {
  void queryClient.cancelQueries({ queryKey: accountQueryKeys.all })
  queryClient.removeQueries({ queryKey: accountQueryKeys.all })
}

/**
 * Where the current cache owner is remembered: on the QueryClient the entries
 * live on, not in the guard's closure. The guard mounts and unmounts with the
 * navigation, but the app-level QueryClient (`AgentHqQueryProvider`) outlives
 * it — the desktop sign-out drops the navigation subtree while the workspace
 * mount keeps the client — so a closure-local baseline forgets the previous
 * identity exactly when a DIFFERENT account remounts the navigation: the fresh
 * guard would adopt that account as its baseline and never clear the previous
 * account's rows. The key sits OUTSIDE the `['account']` prefix on purpose:
 * `clearAccountScopedCache` must not erase the owner marker that makes the
 * next reconciliation correct.
 */
const ACCOUNT_IDENTITY_OWNER_KEY = ['account-identity', 'owner'] as const

/**
 * Records `principalId` as the cache owner and clears the account-scoped
 * entries when a DIFFERENT owner left them behind. A missing marker (a fresh
 * client — a page load, or the provider's own `clear()`) keeps the baseline
 * rule: whoever is observed first owns the caches that exist, which is nobody.
 * Signed-out states (`null`/`undefined`) are one owner: neither can hold rows,
 * because account reads answer 401 without a session.
 */
function reconcileAccountCacheOwner(
  queryClient: QueryClient,
  principalId: string | null | undefined
): void {
  const owner = queryClient.getQueryData<string | null>(ACCOUNT_IDENTITY_OWNER_KEY)
  queryClient.setQueryData(ACCOUNT_IDENTITY_OWNER_KEY, principalId ?? null)
  if (owner !== undefined && owner !== (principalId ?? null)) {
    clearAccountScopedCache(queryClient)
  }
}

/**
 * Watches the signed-in principal and clears the account-scoped caches when
 * the identity changes — to another account or to signed-out. The first
 * observed value is a baseline (a fresh client's caches belong to whoever is
 * signed in already, and a page reload rebuilds the cache anyway); every later
 * change clears. An uncertain identity (a failed bootstrap) also clears:
 * dropping cache entries is cheap, leaking them is not.
 *
 * The baseline is the CLIENT's memory, not the guard's: it is recorded on the
 * QueryClient and reconciled SYNCHRONOUSLY at mount, so it survives the
 * navigation's own unmount/remount (sign-out drops the navigation; the
 * app-level provider keeps the client) and runs before the remounted subtree's
 * observers can read the previous account's entries. The first observation
 * takes effect before the first effect flush for the same reason.
 *
 * Workspace switches deliberately do NOT clear these keys — that independence
 * is the point of the account-wide query keys (see `@adea-ai/data`).
 */
export function watchAccountIdentity(
  queryClient: QueryClient,
  principalId: Accessor<string | null | undefined>
): void {
  let previous: string | null | undefined = principalId()
  reconcileAccountCacheOwner(queryClient, previous)
  createEffect(() => {
    const id = principalId()
    if (id === previous) return
    previous = id
    reconcileAccountCacheOwner(queryClient, id)
  })
}
