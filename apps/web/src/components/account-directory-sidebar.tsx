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
  inboxEntryLabel,
  inboxKindLabel,
  inboxUnreadModel,
  rowsOutsideWorkspace,
  unreadBadgeText,
} from '../lib/account-directory'
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js'

const SEARCH_DEBOUNCE_MS = 200

function useSearchInput() {
  const [term, setTerm] = createSignal('')
  const [search, setSearch] = createSignal('')
  createEffect(() => {
    const value = term()
    const timeout = window.setTimeout(() => setSearch(value.trim()), SEARCH_DEBOUNCE_MS)
    onCleanup(() => window.clearTimeout(timeout))
  })
  return { term, setTerm, search }
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
  activeWorkspaceId: string
  workspaces: readonly WorkspaceSummary[]
  onOpenAgent: (agent: AccountDirectoryAgent) => void
}) {
  const { term, setTerm, search } = useSearchInput()
  const [includeArchived, setIncludeArchived] = createSignal(false)
  const baseInput = useBaseInput(search, includeArchived)
  const pages = createAccountDirectoryPages(props.client, { baseInput })
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
  const otherWorkspaceAgents = createMemo(() =>
    rowsOutsideWorkspace(pages.rows(), props.activeWorkspaceId)
  )
  const emptyMessage = createMemo(() =>
    pages.rows().length > 0 && otherWorkspaceAgents().length === 0
      ? 'The loaded Agents are in this workspace. Load more to find identities from other workspaces.'
      : search()
        ? 'No authorized Agent name matches this search.'
        : 'Durable identities from your other workspaces appear here.'
  )
  return (
    <section class="mt-6 border-t pt-4" aria-label="Agents from other workspaces">
      <header class="mb-3">
        <h2 class="text-base font-semibold">From other workspaces</h2>
        <p class="text-muted-foreground text-sm">Open a durable identity in its workspace.</p>
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
          onClick={() => setIncludeArchived((value) => !value)}
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
            when={otherWorkspaceAgents().length > 0}
            fallback={<p class="text-muted-foreground py-3 text-sm">{emptyMessage()}</p>}
          >
            <div class="grid gap-2">
              <For each={otherWorkspaceAgents()}>
                {(agent) => {
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
                }}
              </For>
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
  activeWorkspaceId?: string
  workspaces: readonly WorkspaceSummary[]
  onOpenConversation: (entry: AccountConversationInboxEntry) => void
  selectedChannelId?: string | null
  onCloseSheet?: () => void
}) {
  const { term, setTerm, search } = useSearchInput()
  const [includeArchived, setIncludeArchived] = createSignal(false)
  const baseInput = useBaseInput(search, includeArchived)
  const pages = createAccountInboxPages(props.client, { baseInput })
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
  const otherWorkspaceEntries = createMemo(() =>
    rowsOutsideWorkspace(pages.rows(), props.activeWorkspaceId)
  )
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
          onClick={() => setIncludeArchived((value) => !value)}
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
            when={otherWorkspaceEntries().length > 0}
            fallback={
              <p class="text-muted-foreground py-2 text-xs">
                {pages.rows().length > 0
                  ? 'The loaded conversations are in this workspace. Load more to find conversations from other workspaces.'
                  : 'Conversations from other workspaces appear here.'}
              </p>
            }
          >
            <div class="grid gap-1">
              <For each={otherWorkspaceEntries()}>
                {(entry) => {
                  const unread = () => inboxUnreadModel(entry)
                  const workspaceName = accountWorkspaceLabel(props.workspaces, entry.workspaceId)
                  return (
                    <SidebarNavButton
                      type="button"
                      class="min-h-10"
                      data-selected={entry.id === props.selectedChannelId ? '' : undefined}
                      aria-current={entry.id === props.selectedChannelId ? 'page' : undefined}
                      aria-label={inboxEntryLabel(entry, workspaceName)}
                      onClick={() => {
                        props.onOpenConversation(entry)
                        props.onCloseSheet?.()
                      }}
                    >
                      <span class="min-w-0 flex-1">
                        <span class="block truncate">{entry.title}</span>
                        <span class="text-muted-foreground block truncate text-xs">
                          {workspaceName} · {inboxKindLabel(entry)}
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
      <p class="text-muted-foreground px-2 py-1 text-xs">Other workspaces</p>
      {content()}
    </div>
  )
}
