import type { AccountDirectoryApiClient } from '@adea-ai/api-client/account-directory'
import type {
  AccountConversationInboxEntry,
  AccountDirectoryAgent,
  AccountDirectoryPageInput,
} from '@adea-ai/types/account-directory'
import type { WorkspaceSummary } from '@adea-ai/types'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { SidebarNavButton } from '@adea-ai/ui/components/layout/sidebar-nav'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Skeleton } from '@adea-ai/ui/components/ui/skeleton'
import { RefreshCw } from 'lucide-solid'
import { createAccountDirectoryPages, createAccountInboxPages } from '../lib/account-directory'
import {
  accountWorkspaceLabel,
  directoryAgentStatus,
  directoryErrorCopy,
  emptyAccountListCopy,
  inboxEntryLabel,
  inboxKindLabel,
  inboxUnreadModel,
  unreadBadgeText,
} from '../lib/account-directory'
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Accessor,
} from 'solid-js'
import type { ChannelSummary, AgentSummary } from '@adea-ai/types'

const SEARCH_DEBOUNCE_MS = 200

export type AccountDirectorySearchState = Readonly<{
  term: Accessor<string>
  setTerm: (value: string) => void
  includeArchived: Accessor<boolean>
  setIncludeArchived: (value: boolean) => void
}>

/**
 * Keep the rendered page rows in step with the committed server query. While
 * an account query key changes, its observer can still expose prior rows; the
 * API uses this same case-insensitive substring rule, so filtering here only
 * removes stale non-matches and never widens the authorized server result.
 */
function matchingSearchRows<Row>(
  rows: readonly Row[],
  search: string,
  textOf: (row: Row) => string
): readonly Row[] {
  const needle = search.toLowerCase()
  return needle ? rows.filter((row) => textOf(row).toLowerCase().includes(needle)) : rows
}

function useSearchInput(term: Accessor<string>) {
  const [search, setSearch] = createSignal(term().trim())
  createEffect(() => {
    const value = term()
    const timeout = window.setTimeout(() => setSearch(value.trim()), SEARCH_DEBOUNCE_MS)
    onCleanup(() => window.clearTimeout(timeout))
  })
  return search
}

function useBaseInput(search: () => string, includeArchived: () => boolean) {
  return createMemo<AccountDirectoryPageInput>(() => ({
    ...(search() ? { q: search() } : {}),
    ...(includeArchived() ? { includeArchived: true } : {}),
  }))
}

function AccountListError(props: { error: unknown; retry: () => void }) {
  return (
    <Alert variant="destructive" class="my-2" role="alert">
      <AlertDescription>
        {directoryErrorCopy(props.error)}{' '}
        <Button type="button" variant="secondary" size="sm" onClick={() => props.retry()}>
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  )
}

/** Account-wide durable identities embedded in the existing Agents surface. */
export function AccountDirectoryAgents(props: {
  client: AccountDirectoryApiClient
  workspaces: readonly WorkspaceSummary[]
  searchState: AccountDirectorySearchState
  /** This workspace's canonical Agents; they render in the roster above, not here. */
  localAgents: Accessor<readonly AgentSummary[]>
  onOpenAgent: (agent: AccountDirectoryAgent) => void
}) {
  const { term, setTerm, includeArchived, setIncludeArchived } = props.searchState
  const search = useSearchInput(term)
  const baseInput = useBaseInput(search, includeArchived)
  const pages = createAccountDirectoryPages(props.client, { baseInput })
  const localAgentIds = createMemo(() => new Set(props.localAgents().map((agent) => agent.id)))
  // Supplemental only: the workspace's own Agents stay in the canonical roster.
  const visibleAgents = createMemo(() =>
    matchingSearchRows(pages.rows(), search(), (agent) => agent.name).filter(
      (agent) => !localAgentIds().has(agent.id)
    )
  )
  const [online, setOnline] = createSignal(true)
  const updateOnlineStatus = () => setOnline(navigator.onLine)
  createEffect(() => {
    updateOnlineStatus()
    window.addEventListener('online', updateOnlineStatus)
    window.addEventListener('offline', updateOnlineStatus)
    onCleanup(() => {
      window.removeEventListener('online', updateOnlineStatus)
      window.removeEventListener('offline', updateOnlineStatus)
    })
  })
  const renderDirectoryAgent = (agent: AccountDirectoryAgent) => {
    const status = directoryAgentStatus(agent)
    const workspaceName = accountWorkspaceLabel(props.workspaces, agent.workspaceId)
    return (
      <Button
        type="button"
        variant="outline"
        size="lg"
        class="h-auto w-full justify-start text-left"
        aria-label={`Open ${agent.name} in ${workspaceName}`}
        onClick={() => props.onOpenAgent(agent)}
      >
        <span class="grid min-w-0 text-left">
          <span class="truncate font-medium">{agent.name}</span>
          <span class="text-muted-foreground truncate text-xs">
            {workspaceName} · {status.label}
          </span>
        </span>
      </Button>
    )
  }
  return (
    <section class="mt-6 border-t pt-4" aria-label="Agents across workspaces">
      <header class="mb-3">
        <h2 class="text-base font-semibold">Across your workspaces</h2>
        <p class="text-muted-foreground text-sm">
          Agents from your other workspaces. This workspace's Agents are listed above.
        </p>
      </header>
      <div class="mb-3 flex items-center gap-2">
        <Input
          type="search"
          aria-label="Search Agents across workspaces"
          placeholder="Search Agents"
          value={term()}
          onInput={(event) => setTerm(event.currentTarget.value)}
        />
        <ActionButton
          type="button"
          variant="outline"
          size="sm"
          aria-pressed={includeArchived()}
          tooltip={includeArchived() ? 'Hide archived Agents' : 'Also list archived Agents'}
          onClick={() => setIncludeArchived(!includeArchived())}
        >
          Archived
        </ActionButton>
        <ActionButton
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh Agents across workspaces"
          tooltip="Refresh Agents across workspaces"
          onClick={() => pages.refresh()}
        >
          <RefreshCw aria-hidden="true" />
        </ActionButton>
      </div>
      <Show when={!online()}>
        <p class="text-muted-foreground mb-2 text-xs" role="status">
          Offline. Results refresh when the connection returns.
        </p>
      </Show>
      <Show
        when={!pages.isLoading()}
        fallback={<Skeleton class="h-16 w-full" aria-label="Loading Agents across workspaces" />}
      >
        <Show
          when={!pages.error()}
          fallback={<AccountListError error={pages.error()} retry={pages.refresh} />}
        >
          <Show
            when={visibleAgents().length > 0}
            fallback={
              <p class="text-muted-foreground py-3 text-sm" role="status">
                {emptyAccountListCopy({
                  search: search(),
                  canLoadMore: pages.canLoadMore(),
                  noun: 'Agent',
                  exhaustedSearch: 'No authorized Agent name matches this search.',
                  exhaustedEmpty: 'Agents from your other workspaces appear here.',
                })}
              </p>
            }
          >
            <div class="conventional-agent-grid">
              <For each={visibleAgents()}>{renderDirectoryAgent}</For>
            </div>
          </Show>
        </Show>
      </Show>
      <Show when={pages.canLoadMore()}>
        <div class="flex justify-center pt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pages.isFetchingNextPage()}
            onClick={() => pages.loadMore()}
          >
            {pages.isFetchingNextPage() ? 'Loading…' : 'Load more Agents'}
          </Button>
        </div>
      </Show>
    </section>
  )
}

/** Account-wide inbox rows embedded under the existing Conversations section. */
export function AccountConversationInbox(props: {
  client: AccountDirectoryApiClient
  searchState: AccountDirectorySearchState
  workspaces: readonly WorkspaceSummary[]
  onOpenConversation: (entry: AccountConversationInboxEntry) => void
  selectedChannelId: Accessor<string | null | undefined>
  onCloseSheet?: () => void
  /** This workspace's canonical conversations; they render in the section above, not here. */
  localChannels: Accessor<readonly ChannelSummary[]>
}) {
  const { term, setTerm, includeArchived, setIncludeArchived } = props.searchState
  const search = useSearchInput(term)
  const baseInput = useBaseInput(search, includeArchived)
  const pages = createAccountInboxPages(props.client, { baseInput })
  const localChannelIds = createMemo(
    () => new Set(props.localChannels().map((channel) => channel.id))
  )
  // Supplemental only: the workspace's own conversations stay in the canonical list.
  const visibleConversations = createMemo(() =>
    matchingSearchRows(pages.rows(), search(), (entry) => entry.title).filter(
      (entry) => !localChannelIds().has(entry.id)
    )
  )
  const [online, setOnline] = createSignal(true)
  const updateOnlineStatus = () => setOnline(navigator.onLine)
  createEffect(() => {
    updateOnlineStatus()
    window.addEventListener('online', updateOnlineStatus)
    window.addEventListener('offline', updateOnlineStatus)
    onCleanup(() => {
      window.removeEventListener('online', updateOnlineStatus)
      window.removeEventListener('offline', updateOnlineStatus)
    })
  })
  const content = () => (
    <div class="conventional-account-inbox" data-account-inbox="">
      <div class="mb-2 flex items-center gap-2">
        <Input
          type="search"
          aria-label="Search conversations across workspaces"
          placeholder="Search conversations"
          value={term()}
          onInput={(event) => setTerm(event.currentTarget.value)}
        />
        <ActionButton
          type="button"
          variant="outline"
          size="sm"
          aria-pressed={includeArchived()}
          tooltip={
            includeArchived() ? 'Hide archived conversations' : 'Also list archived conversations'
          }
          onClick={() => setIncludeArchived(!includeArchived())}
        >
          Archived
        </ActionButton>
        <ActionButton
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh conversations across workspaces"
          tooltip="Refresh conversations across workspaces"
          onClick={() => pages.refresh()}
        >
          <RefreshCw aria-hidden="true" />
        </ActionButton>
      </div>
      <Show when={!online()}>
        <p class="text-muted-foreground mb-2 text-xs" role="status">
          Offline. Results refresh when the connection returns.
        </p>
      </Show>
      <Show when={pages.isFetching()}>
        <span class="text-muted-foreground text-xs" role="status">
          Updating conversations…
        </span>
      </Show>
      <Show
        when={!pages.isLoading()}
        fallback={
          <Skeleton class="h-12 w-full" aria-label="Loading conversations across workspaces" />
        }
      >
        <Show
          when={!pages.error()}
          fallback={<AccountListError error={pages.error()} retry={pages.refresh} />}
        >
          <Show
            when={visibleConversations().length > 0}
            fallback={
              <p class="text-muted-foreground py-2 text-xs" role="status">
                {emptyAccountListCopy({
                  search: search(),
                  canLoadMore: pages.canLoadMore(),
                  noun: 'conversation',
                  exhaustedSearch: 'No authorized conversation title matches this search.',
                  exhaustedEmpty: 'Conversations from your other workspaces appear here.',
                })}
              </p>
            }
          >
            <div class="grid gap-1">
              <For each={visibleConversations()}>
                {(entry) => {
                  const unread = () => inboxUnreadModel(entry)
                  return (
                    <SidebarNavButton
                      type="button"
                      class="min-h-10"
                      data-selected={entry.id === props.selectedChannelId() ? '' : undefined}
                      aria-current={entry.id === props.selectedChannelId() ? 'page' : undefined}
                      aria-label={inboxEntryLabel(
                        entry,
                        accountWorkspaceLabel(props.workspaces, entry.workspaceId)
                      )}
                      onClick={() => {
                        props.onOpenConversation(entry)
                        props.onCloseSheet?.()
                      }}
                    >
                      <span class="min-w-0 flex-1">
                        <span class="block truncate">{entry.title}</span>
                        <span class="text-muted-foreground block truncate text-xs">
                          {accountWorkspaceLabel(props.workspaces, entry.workspaceId)} ·{' '}
                          {inboxKindLabel(entry)}
                          {entry.lifecycleState === 'archived' ? ' · Archived' : ''}
                        </span>
                      </span>
                      <Show when={unread().mentions > 0}>
                        <span class="conventional-unread-badge" aria-hidden="true">
                          @{unreadBadgeText(unread().mentions)}
                        </span>
                      </Show>
                      <Show when={unread().count > 0 || unread().unread}>
                        <span class="conventional-unread-badge" aria-hidden="true">
                          {unread().count > 0 ? unreadBadgeText(unread().count) : '•'}
                        </span>
                      </Show>
                    </SidebarNavButton>
                  )
                }}
              </For>
            </div>
          </Show>
        </Show>
      </Show>
      <Show when={pages.canLoadMore()}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          class="w-full"
          disabled={pages.isFetchingNextPage()}
          onClick={() => pages.loadMore()}
        >
          {pages.isFetchingNextPage() ? 'Loading…' : 'Load more conversations'}
        </Button>
      </Show>
    </div>
  )
  return (
    <div class="conventional-sidebar__nav-nested">
      <p class="text-muted-foreground px-2 py-1 text-xs">Across your workspaces</p>
      {content()}
    </div>
  )
}
