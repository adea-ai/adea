// The account-wide Agents directory and conversation inbox (M11.03, #1174).
//
// One surface, two sections. It reads ONLY the account-scoped queries from
// `@adea-ai/data` (through `../lib/account-directory`), so the selected
// workspace never scopes its results: agents and conversations from every
// workspace the account can reach stay listed across workspace switches. The
// host (workspace-navigation) owns navigation; rows hand their entries back.
import { AlertTriangle, Bot, Inbox as InboxIcon, RefreshCw, Users } from 'lucide-solid'
import { For, Show } from 'solid-js'
import type { AccountDirectoryApiClient } from '@adea-ai/api-client/account-directory'
import type {
  AccountConversationInboxEntry,
  AccountDirectoryAgent,
} from '@adea-ai/types/account-directory'
import type { WorkspaceSummary } from '@adea-ai/types'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { Avatar, AvatarFallback } from '@adea-ai/ui/components/ui/avatar'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Button } from '@adea-ai/ui/components/ui/button'
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@adea-ai/ui/components/ui/card'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@adea-ai/ui/components/ui/empty'
import { Skeleton } from '@adea-ai/ui/components/ui/skeleton'
import { StatusChip } from '@adea-ai/ui/components/ui/status-chip'
import {
  accountWorkspaceLabel,
  createAccountDirectoryPages,
  createAccountInboxPages,
  directoryAgentStatus,
  directoryErrorCopy,
  directoryTitle,
  inboxEntryLabel,
  inboxKindLabel,
  inboxUnreadModel,
  unreadBadgeText,
  type AccountDirectorySection,
} from '../lib/account-directory'

export type AccountDirectorySurfaceProps = Readonly<{
  client: AccountDirectoryApiClient
  section: AccountDirectorySection
  /** Every workspace the account can see, for row labels. */
  workspaces: readonly WorkspaceSummary[]
  /** Switches the visible section (host routes it through the search). */
  onSwitchSection: (section: AccountDirectorySection) => void
  /** Opens one directory Agent in its own workspace (host-owned navigation). */
  onOpenAgent: (agent: AccountDirectoryAgent) => void
  /** Opens one inbox conversation in its own workspace. */
  onOpenConversation: (entry: AccountConversationInboxEntry) => void
}>

/**
 * The account-wide surface: a section switch, then the Agents directory or
 * the conversation inbox. Each section owns its cursor-paged queries, so
 * switching sections never holds the other's pages open.
 */
export function AccountDirectorySurface(props: AccountDirectorySurfaceProps) {
  return (
    <main class="conventional-directory" aria-labelledby="account-directory-title">
      <header class="conventional-surface-header">
        <div>
          <span>Across every workspace you belong to</span>
          <h1 id="account-directory-title">{directoryTitle(props.section)}</h1>
          <p>
            Authorized by your own memberships and participation. Switching workspaces does not
            change what is listed here.
          </p>
        </div>
        <div class="flex gap-2" role="group" aria-label="Directory sections">
          <Button
            type="button"
            variant={props.section === 'agents' ? 'default' : 'outline'}
            aria-pressed={props.section === 'agents'}
            onClick={() => props.onSwitchSection('agents')}
          >
            <Users aria-hidden="true" />
            Agents
          </Button>
          <Button
            type="button"
            variant={props.section === 'inbox' ? 'default' : 'outline'}
            aria-pressed={props.section === 'inbox'}
            onClick={() => props.onSwitchSection('inbox')}
          >
            <InboxIcon aria-hidden="true" />
            Conversations
          </Button>
        </div>
      </header>
      <Show
        when={props.section === 'inbox'}
        fallback={
          <AgentsSection
            client={props.client}
            onOpenAgent={props.onOpenAgent}
            workspaces={props.workspaces}
          />
        }
      >
        <InboxSection
          client={props.client}
          onOpenConversation={props.onOpenConversation}
          workspaces={props.workspaces}
        />
      </Show>
    </main>
  )
}

function DirectorySkeleton(props: { label: string }) {
  return (
    <div class="conventional-skeleton" aria-busy="true" aria-label={props.label}>
      <For each={Array.from({ length: 6 })}>
        {() => (
          <Skeleton class="h-3 w-104 max-w-3/4 nth-2:w-80 nth-2:max-w-3/5 nth-3:w-92 nth-3:max-w-2/3" />
        )}
      </For>
    </div>
  )
}

function DirectoryError(props: { error: unknown; onRetry: () => void }) {
  return (
    <section class="conventional-error" role="alert">
      <AlertTriangle aria-hidden="true" />
      <div>
        <h2>Something interrupted the directory</h2>
        <p>{directoryErrorCopy(props.error)}</p>
      </div>
      <Button type="button" variant="secondary" onClick={() => props.onRetry()}>
        <RefreshCw aria-hidden="true" />
        Retry
      </Button>
    </section>
  )
}

function DirectoryEmpty(props: { detail: string; icon: typeof Bot; title: string }) {
  return (
    <Empty role="region" aria-labelledby="account-directory-empty-title">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <props.icon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle id="account-directory-empty-title">{props.title}</EmptyTitle>
        <EmptyDescription>{props.detail}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

function LoadMoreRow(props: { canLoadMore: boolean; disabled: boolean; onLoadMore: () => void }) {
  return (
    <Show when={props.canLoadMore}>
      <div class="flex justify-center pt-4">
        <Button
          type="button"
          variant="outline"
          disabled={props.disabled}
          onClick={() => props.onLoadMore()}
        >
          {props.disabled ? 'Loading…' : 'Load more'}
        </Button>
      </div>
    </Show>
  )
}

function AgentsSection(props: {
  client: AccountDirectoryApiClient
  workspaces: readonly WorkspaceSummary[]
  onOpenAgent: (agent: AccountDirectoryAgent) => void
}) {
  const pages = createAccountDirectoryPages(props.client)
  return (
    <section aria-label="Agents directory">
      <div class="mb-4 flex justify-end">
        <ActionButton
          type="button"
          variant="ghost"
          size="icon-sm"
          tooltip="Refresh the Agents directory"
          aria-label="Refresh the Agents directory"
          onClick={() => pages.refresh()}
        >
          <RefreshCw aria-hidden="true" />
        </ActionButton>
      </div>
      <Show
        when={!pages.isLoading()}
        fallback={<DirectorySkeleton label="Loading the Agents directory" />}
      >
        <Show
          when={!pages.error()}
          fallback={<DirectoryError error={pages.error()} onRetry={pages.refresh} />}
        >
          <Show
            when={pages.rows().length > 0}
            fallback={
              <DirectoryEmpty
                detail="Agents from every workspace you belong to appear here once they exist. Create one inside a workspace to start."
                icon={Bot}
                title="No Agents are visible yet"
              />
            }
          >
            <div class="conventional-agent-grid">
              <For each={pages.rows()}>
                {(agent) => (
                  <DirectoryAgentCard
                    agent={agent}
                    onOpen={props.onOpenAgent}
                    workspaceName={accountWorkspaceLabel(props.workspaces, agent.workspaceId)}
                  />
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>
      <LoadMoreRow
        canLoadMore={pages.canLoadMore()}
        disabled={pages.isFetchingNextPage()}
        onLoadMore={pages.loadMore}
      />
    </section>
  )
}

function DirectoryAgentCard(props: {
  agent: AccountDirectoryAgent
  workspaceName: string
  onOpen: (agent: AccountDirectoryAgent) => void
}) {
  const status = () => directoryAgentStatus(props.agent)
  return (
    <article>
      <Card>
        <CardHeader>
          <Avatar size="lg" aria-hidden="true">
            <AvatarFallback name={props.agent.name} />
          </Avatar>
          <CardTitle role="heading" aria-level="2">
            {props.agent.name}
          </CardTitle>
          <StatusChip detail={status().detail} label={status().label} tone={status().tone} />
        </CardHeader>
        <CardContent>
          <div class="grid gap-3">
            <p>{props.agent.roleSummary ?? 'No role summary yet.'}</p>
            <p class="text-muted-foreground">In {props.workspaceName}</p>
            <Show when={props.agent.profile.state !== 'available'}>
              <p>{status().detail}</p>
            </Show>
          </div>
        </CardContent>
        <CardFooter>
          <Button
            type="button"
            variant="outline"
            aria-label={`Open ${props.agent.name} in its workspace`}
            onClick={() => props.onOpen(props.agent)}
          >
            Open in workspace
          </Button>
        </CardFooter>
      </Card>
    </article>
  )
}

function InboxSection(props: {
  client: AccountDirectoryApiClient
  workspaces: readonly WorkspaceSummary[]
  onOpenConversation: (entry: AccountConversationInboxEntry) => void
}) {
  const pages = createAccountInboxPages(props.client)
  return (
    <section aria-label="Conversation inbox">
      <div class="mb-4 flex justify-end">
        <ActionButton
          type="button"
          variant="ghost"
          size="icon-sm"
          tooltip="Refresh the conversation inbox"
          aria-label="Refresh the conversation inbox"
          onClick={() => pages.refresh()}
        >
          <RefreshCw aria-hidden="true" />
        </ActionButton>
      </div>
      <Show
        when={!pages.isLoading()}
        fallback={<DirectorySkeleton label="Loading the conversation inbox" />}
      >
        <Show
          when={!pages.error()}
          fallback={<DirectoryError error={pages.error()} onRetry={pages.refresh} />}
        >
          <Show
            when={pages.rows().length > 0}
            fallback={
              <DirectoryEmpty
                detail="Conversations from every workspace you belong to appear here as they arrive. Unread counts follow your own read state."
                icon={InboxIcon}
                title="No conversations are visible yet"
              />
            }
          >
            <div class="grid gap-2">
              <For each={pages.rows()}>
                {(entry) => (
                  <InboxRow
                    entry={entry}
                    onOpen={props.onOpenConversation}
                    workspaceName={accountWorkspaceLabel(props.workspaces, entry.workspaceId)}
                  />
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>
      <LoadMoreRow
        canLoadMore={pages.canLoadMore()}
        disabled={pages.isFetchingNextPage()}
        onLoadMore={pages.loadMore}
      />
    </section>
  )
}

function InboxRow(props: {
  entry: AccountConversationInboxEntry
  workspaceName: string
  onOpen: (entry: AccountConversationInboxEntry) => void
}) {
  const unread = () => inboxUnreadModel(props.entry)
  return (
    <Button
      type="button"
      variant="outline"
      class="w-full"
      aria-label={inboxEntryLabel(props.entry, props.workspaceName)}
      onClick={() => props.onOpen(props.entry)}
    >
      <span class="flex w-full items-center justify-between gap-3">
        <span class="flex min-w-0 items-center gap-2">
          <span class="truncate">{props.entry.title}</span>
          <Badge aria-hidden="true" size="sm" variant="secondary">
            {inboxKindLabel(props.entry)}
          </Badge>
          <span class="text-muted-foreground text-xs">{props.workspaceName}</span>
        </span>
        <span class="flex shrink-0 items-center gap-1">
          <Show when={unread().mentions > 0}>
            <Badge aria-hidden="true" size="sm" variant="destructive">
              @{unreadBadgeText(unread().mentions)}
            </Badge>
          </Show>
          <Show when={unread().count > 0 || unread().unread}>
            <Badge aria-hidden="true" size="sm" variant="notification">
              {unread().count > 0 ? unreadBadgeText(unread().count) : '•'}
            </Badge>
          </Show>
        </span>
      </span>
    </Button>
  )
}
