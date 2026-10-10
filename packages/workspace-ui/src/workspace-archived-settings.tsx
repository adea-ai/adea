import { ApiClientError, type AgentHqApiClient } from '@adea-ai/api-client'
import { useArchivedWorkspacesQuery, useReopenWorkspaceMutation } from '@adea-ai/data'
import { SettingsRow } from '@adea-ai/ui/components/composites/settings'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { createSignal, For, Show } from 'solid-js'

function reopenFailureMessage(failure: unknown): string {
  if (failure instanceof ApiClientError && failure.code === 'workspace_unavailable')
    return 'This workspace is no longer archived or is unavailable. The list has been refreshed.'
  return 'Workspace could not be reopened. Try again.'
}

/**
 * The signed-in owner's archived workspaces, durable across panel closes and reloads: the list is
 * a query, not local state. Each Reopen targets the row's own workspace ID. Reopen restores the
 * workspace with its history and links, through the existing reopen contract.
 */
export function WorkspaceArchivedSettings(props: { client: AgentHqApiClient }) {
  const archived = useArchivedWorkspacesQuery(props.client)
  const reopen = useReopenWorkspaceMutation(props.client)
  const [status, setStatus] = createSignal('')
  const [error, setError] = createSignal<string | null>(null)
  const rows = () => archived.data ?? []

  async function reopenRow(workspace: Readonly<{ id: string; name: string }>) {
    if (reopen.isPending) return
    setError(null)
    setStatus('')
    try {
      await reopen.mutateAsync(workspace.id)
      setStatus(`${workspace.name} is reopened.`)
    } catch (failure) {
      setError(reopenFailureMessage(failure))
      if (failure instanceof ApiClientError && failure.code === 'workspace_unavailable')
        void archived.refetch()
    }
  }

  return (
    <SettingsRow
      label="Archived workspaces"
      description="Workspaces you own that are hidden from your list. Reopening restores them with their history and links."
    >
      <div class="flex flex-col gap-2">
        <Show
          when={!archived.isPending}
          fallback={<p role="status">Loading archived workspaces…</p>}
        >
          <Show
            when={!archived.isError}
            fallback={
              <div class="flex items-center gap-2">
                <p>Archived workspaces could not be loaded.</p>
                <Button variant="outline" size="sm" onClick={() => void archived.refetch()}>
                  Try again
                </Button>
              </div>
            }
          >
            <Show when={rows().length > 0} fallback={<p>No archived workspaces.</p>}>
              <ul class="flex flex-col gap-2">
                <For each={rows()}>
                  {(workspace) => (
                    <li class="flex items-center justify-between gap-2">
                      <span>{workspace.name}</span>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={reopen.isPending}
                        aria-label={`Reopen ${workspace.name}`}
                        onClick={() => void reopenRow({ id: workspace.id, name: workspace.name })}
                      >
                        Reopen
                      </Button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </Show>
        <Show when={status()}>
          <p role="status" aria-label="Archived workspaces status">
            {status()}
          </p>
        </Show>
        <Show when={error()}>
          <Alert variant="destructive">
            <AlertDescription>{error()}</AlertDescription>
          </Alert>
        </Show>
      </div>
    </SettingsRow>
  )
}
