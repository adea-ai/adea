import type { AgentHqApiClient } from '@adea-ai/api-client'
import {
  settledData,
  useAgentListQuery,
  useArchiveChannelMutation,
  useChannelListQuery,
  useCreateGroupChannelMutation,
  useMarkAllReadMutation,
  usePrefetchChannelMessages,
  useReadStateQuery,
  useUpdateChannelMutation,
} from '@adea-ai/data'
import type { ChannelSummary } from '@adea-ai/types'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { createMemo, createSignal, lazy, Show, Suspense } from 'solid-js'

import {
  ConversationsSection,
  GlobalQuickActions,
  readStateHasUnread,
} from './workspace-nav-sidebar'
import { createClientRequestId } from './request-id'
import { projectWorkspaceNavigation } from './workspace-model'

// The dialogs stay in their own dynamically imported module (ADR 0008).
const RenameConversationDialog = lazy(() =>
  import('./create-workspace-dialogs').then((module) => ({
    default: module.RenameConversationDialog,
  }))
)
const CreateGroupDialog = lazy(() =>
  import('./create-workspace-dialogs').then((module) => ({ default: module.CreateGroupDialog }))
)

/**
 * What a sidebar outside Chat and Virtual (the Dev sidebar, which the desktop
 * runtime Chat also uses) needs to render the global sections from the
 * active workspace's cloud data.
 */
export type WorkspaceGlobalNavProps = Readonly<{
  client: AgentHqApiClient
  workspaceId: string | undefined
  /** The conversation the team Chat surface shows, for the selected row. */
  selectedChannelId?: string | null
  onOpenAgents: () => void
  onOpenConversation: (channelId: string) => void
  portalMount?: HTMLElement
  tooltips?: boolean
}>

function copyChannelLink(channel: ChannelSummary): Promise<void> {
  const url = new URL(window.location.href)
  url.searchParams.set('view', 'chat')
  url.searchParams.set('channel', channel.id)
  return navigator.clipboard.writeText(url.toString())
}

/** Agents and Mark all read, reading the active workspace's unread state. */
export function WorkspaceQuickActions(props: WorkspaceGlobalNavProps) {
  const readState = useReadStateQuery(props.client, () => props.workspaceId)
  const markAllRead = useMarkAllReadMutation(props.client, () => props.workspaceId ?? '')
  const [error, setError] = createSignal<string>()
  return (
    <>
      <GlobalQuickActions
        hasUnread={readStateHasUnread(settledData(readState)?.readState ?? [])}
        onOpenAgents={() => props.onOpenAgents()}
        onMarkAllRead={() => {
          setError(undefined)
          void markAllRead
            .mutateAsync()
            .catch(() => setError('Unread conversations could not be marked as read.'))
        }}
      />
      <Show when={error()}>
        {(message) => (
          <Alert variant="destructive" class="mx-2 mb-2 w-auto">
            <AlertDescription>{message()}</AlertDescription>
          </Alert>
        )}
      </Show>
    </>
  )
}

/** The Conversations section with its own queries, rename and new group dialogs. */
export function WorkspaceConversations(props: WorkspaceGlobalNavProps) {
  const workspaceId = () => props.workspaceId
  const channels = useChannelListQuery(props.client, workspaceId)
  const agents = useAgentListQuery(props.client, workspaceId)
  const readState = useReadStateQuery(props.client, workspaceId)
  const prefetch = usePrefetchChannelMessages(props.client, workspaceId)
  const createGroup = useCreateGroupChannelMutation(props.client, () => workspaceId() ?? '')
  const updateChannel = useUpdateChannelMutation(props.client, () => workspaceId() ?? '')
  const archiveChannel = useArchiveChannelMutation(props.client, () => workspaceId() ?? '')
  const navigation = createMemo(() => projectWorkspaceNavigation([], settledData(channels) ?? []))
  const [renaming, setRenaming] = createSignal<ChannelSummary | null>(null)
  const [creating, setCreating] = createSignal(false)
  const [error, setError] = createSignal<string>()
  return (
    <>
      <Show when={error()}>
        {(message) => (
          <Alert variant="destructive" class="mx-2 mb-2 w-auto">
            <AlertDescription>{message()}</AlertDescription>
          </Alert>
        )}
      </Show>
      <ConversationsSection
        agents={settledData(agents) ?? []}
        createDisabled={!workspaceId()}
        directChannels={navigation().directAgentChannels}
        groupChannels={navigation().groupChannels}
        readState={settledData(readState)?.readState ?? []}
        selectedChannelId={props.selectedChannelId ?? null}
        onArchive={(channel) => {
          setError(undefined)
          void archiveChannel
            .mutateAsync({ channelId: channel.id, expectedVersion: channel.version })
            .catch(() => setError('Conversation could not be deleted.'))
        }}
        onCopyLink={(channel) => {
          setError(undefined)
          void copyChannelLink(channel).catch(() =>
            setError('Conversation link could not be copied.')
          )
        }}
        onCreateGroup={() => setCreating(true)}
        onIntent={prefetch}
        onOpenAgents={() => props.onOpenAgents()}
        onRename={setRenaming}
        onSelect={(channelId) => props.onOpenConversation(channelId)}
        portalMount={props.portalMount}
        tooltips={props.tooltips}
      />
      <Suspense fallback={null}>
        <Show when={renaming()}>
          {(channel) => (
            <RenameConversationDialog
              busy={updateChannel.isPending}
              initialTitle={channel().title}
              onClose={() => setRenaming(null)}
              onSave={(title) =>
                updateChannel
                  .mutateAsync({
                    channelId: channel().id,
                    expectedVersion: channel().version,
                    update: { title },
                  })
                  .then(() => undefined)
              }
              open
            />
          )}
        </Show>
        <Show when={creating()}>
          <CreateGroupDialog
            busy={createGroup.isPending}
            onClose={() => setCreating(false)}
            onCreate={async (title) => {
              const result = await createGroup.mutateAsync({
                idempotencyKey: createClientRequestId(),
                title,
              })
              props.onOpenConversation(result.channel.id)
            }}
            open
          />
        </Show>
      </Suspense>
    </>
  )
}

/** One entry for a lazily loaded host: either global section by name. */
export function WorkspaceGlobalNav(
  props: WorkspaceGlobalNavProps & { section: 'quick-actions' | 'conversations' }
) {
  return (
    <Show when={props.section === 'conversations'} fallback={<WorkspaceQuickActions {...props} />}>
      <WorkspaceConversations {...props} />
    </Show>
  )
}
