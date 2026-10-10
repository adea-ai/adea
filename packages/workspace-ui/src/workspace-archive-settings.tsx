import { ApiClientError, type AgentHqApiClient } from '@adea-ai/api-client'
import { useArchiveWorkspaceMutation } from '@adea-ai/data'
import { SettingsRow } from '@adea-ai/ui/components/composites/settings'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { createSignal, Show } from 'solid-js'

type ArchiveTarget = Readonly<{ id: string; name: string }>

/** Maps the archive refusals the server names; anything else is a plain retry. */
function archiveFailureMessage(failure: unknown): string {
  if (failure instanceof ApiClientError) {
    if (failure.code === 'workspace_personal_protected')
      return 'Your personal workspace cannot be archived.'
    if (failure.code === 'workspace_unavailable')
      return 'This workspace is unavailable. It may already be archived, or it is not yours to archive.'
  }
  return 'Workspace could not be archived. Try again.'
}

/**
 * Archives an optional workspace for its owner. The confirmation captures the target by ID and name
 * when it opens, so a change to the active workspace while it is open cannot retarget the archive.
 * Archive hides the workspace and keeps its history and links; the server repeats the owner check and
 * refuses Home. Reopen lives in the durable archived-workspaces list, not in this row.
 */
export function WorkspaceArchiveSettings(props: {
  client: AgentHqApiClient
  workspace: Readonly<{ id: string; name: string }>
}) {
  const archive = useArchiveWorkspaceMutation(props.client)
  const [target, setTarget] = createSignal<ArchiveTarget | null>(null)
  const [status, setStatus] = createSignal('')
  const [error, setError] = createSignal<string | null>(null)

  function openConfirmation() {
    setError(null)
    setStatus('')
    setTarget({ id: props.workspace.id, name: props.workspace.name })
  }

  async function confirmArchive() {
    const captured = target()
    if (!captured || archive.isPending) return
    setError(null)
    try {
      await archive.mutateAsync(captured.id)
      setTarget(null)
      setStatus(`${captured.name} is archived. Its history and links are kept.`)
    } catch (failure) {
      setError(archiveFailureMessage(failure))
    }
  }

  return (
    <SettingsRow
      label="Archive workspace"
      description="Hides this workspace from your list. Its history and links are kept."
    >
      <div class="flex flex-col gap-2">
        <Show
          when={target()}
          fallback={
            <Button variant="outline" disabled={archive.isPending} onClick={openConfirmation}>
              Archive workspace
            </Button>
          }
        >
          {(captured) => (
            <>
              <p>
                Archive {captured().name}? It is hidden from your workspace list. Its history and
                links are kept.
              </p>
              <div class="flex items-center gap-2">
                <Button
                  disabled={archive.isPending}
                  aria-busy={archive.isPending}
                  onClick={() => void confirmArchive()}
                >
                  {archive.isPending ? 'Archiving…' : 'Archive workspace'}
                </Button>
                <Button
                  variant="outline"
                  disabled={archive.isPending}
                  onClick={() => setTarget(null)}
                >
                  Cancel
                </Button>
              </div>
            </>
          )}
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
