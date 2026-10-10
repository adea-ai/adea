import { ApiClientError, type AgentHqApiClient } from '@adea-ai/api-client'
import { useArchiveWorkspaceMutation, useReopenWorkspaceMutation } from '@adea-ai/data'
import { SettingsRow } from '@adea-ai/ui/components/composites/settings'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { createSignal, Show } from 'solid-js'

type ArchivedWorkspace = Readonly<{ id: string; name: string }>

/** Maps the archive refusals the server names; anything else is a plain retry. */
function archiveFailure(failure: unknown): string {
  if (failure instanceof ApiClientError) {
    if (failure.code === 'workspace_personal_protected')
      return 'Your personal workspace cannot be archived.'
    if (failure.code === 'workspace_unavailable')
      return 'This workspace is unavailable. It may already be archived, or it is not yours to archive.'
  }
  return 'Workspace could not be archived. Try again.'
}

function reopenFailure(failure: unknown): string {
  if (failure instanceof ApiClientError && failure.code === 'workspace_unavailable')
    return 'This workspace is unavailable and cannot be reopened here.'
  return 'Workspace could not be reopened. Try again.'
}

/**
 * Archives an optional workspace for its owner. Archive hides the workspace and keeps its history and
 * links; the server repeats the owner check and refuses Home. Reopen is offered only while this
 * panel stays open, because no archived-workspace listing exists yet.
 */
export function WorkspaceArchiveSettings(props: {
  client: AgentHqApiClient
  workspace: Readonly<{ id: string; name: string }>
}) {
  const archive = useArchiveWorkspaceMutation(props.client)
  const reopen = useReopenWorkspaceMutation(props.client)
  const [confirming, setConfirming] = createSignal(false)
  const [archived, setArchived] = createSignal<ArchivedWorkspace | null>(null)
  const [status, setStatus] = createSignal('')
  const [error, setError] = createSignal<string | null>(null)
  const busy = () => archive.isPending || reopen.isPending

  async function archiveNow() {
    if (busy() || archived()) return
    const target = { id: props.workspace.id, name: props.workspace.name }
    setError(null)
    try {
      await archive.mutateAsync(target.id)
      setArchived(target)
      setConfirming(false)
      setStatus(`${target.name} is archived. Its history and links are kept.`)
    } catch (failure) {
      setError(archiveFailure(failure))
    }
  }

  async function reopenNow() {
    const target = archived()
    if (!target || busy()) return
    setError(null)
    try {
      await reopen.mutateAsync(target.id)
      setArchived(null)
      setStatus(`${target.name} is reopened.`)
    } catch (failure) {
      setError(reopenFailure(failure))
    }
  }

  return (
    <SettingsRow
      label="Archive workspace"
      description="Hides this workspace from your list. Its history and links are kept."
    >
      <div class="flex flex-col gap-2">
        <Show
          when={!archived()}
          fallback={
            <Button variant="outline" disabled={busy()} onClick={() => void reopenNow()}>
              Reopen workspace
            </Button>
          }
        >
          <Show
            when={confirming()}
            fallback={
              <Button variant="outline" disabled={busy()} onClick={() => setConfirming(true)}>
                Archive workspace
              </Button>
            }
          >
            <p>
              Archive {props.workspace.name}? It is hidden from your workspace list. Its history and
              links are kept.
            </p>
            <div class="flex items-center gap-2">
              <Button
                disabled={busy()}
                aria-busy={archive.isPending}
                onClick={() => void archiveNow()}
              >
                {archive.isPending ? 'Archiving…' : 'Archive workspace'}
              </Button>
              <Button variant="outline" disabled={busy()} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </Show>
        </Show>
        <Show when={status()}>
          <p role="status" aria-label="Archive status">
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
