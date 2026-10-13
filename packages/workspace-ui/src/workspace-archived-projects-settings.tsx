import { ApiClientError, type AgentHqApiClient } from '@adea-ai/api-client'
import { useArchivedProjectsQuery, useRestoreProjectMutation } from '@adea-ai/data'
import { SettingsRow } from '@adea-ai/ui/components/composites/settings'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Text } from '@adea-ai/ui/components/ui/typography'
import { createSignal, For, Show } from 'solid-js'

import { restoreConsequences, restoreFailureMessage } from './workspace-archived-projects-model'

type RestoreTarget = Readonly<{ id: string; name: string; version: number }>

/**
 * The workspace's archived projects, with an explicit Restore. A restore is the one way an archived
 * project becomes active again: it names what comes back, captures the project's ID and the revision
 * the owner saw when the row was listed, and sends the opt-in the server requires. A project that
 * changed since the listing is refused as a conflict and the list is read again; nothing is retried
 * on the owner's behalf. The list is a query, so it survives closing the panel and reflects archives
 * made from Chat or Dev.
 */
export function WorkspaceArchivedProjectsSettings(props: {
  client: AgentHqApiClient
  workspace: Readonly<{ id: string; name: string }>
}) {
  const archived = useArchivedProjectsQuery(props.client, () => props.workspace.id)
  const restore = useRestoreProjectMutation(props.client, () => props.workspace.id)
  const [target, setTarget] = createSignal<RestoreTarget | null>(null)
  const [status, setStatus] = createSignal('')
  const [error, setError] = createSignal<string | null>(null)
  const rows = () => archived.data ?? []

  function openConfirmation(project: RestoreTarget) {
    if (restore.isPending) return
    setError(null)
    setStatus('')
    setTarget({ id: project.id, name: project.name, version: project.version })
  }

  async function confirmRestore() {
    const captured = target()
    if (!captured || restore.isPending) return
    setError(null)
    try {
      await restore.mutateAsync({
        input: { confirmed: true, expectedVersion: captured.version },
        projectId: captured.id,
      })
      setTarget(null)
      setStatus(`${captured.name} is restored.`)
    } catch (failure) {
      setError(restoreFailureMessage(failure))
      if (failure instanceof ApiClientError && failure.status !== 401 && failure.status < 500) {
        setTarget(null)
        void archived.refetch()
      }
    }
  }

  return (
    <SettingsRow
      label="Archived projects"
      description={`Projects in ${props.workspace.name} that were archived. A project returns to the sidebar only when you restore it here.`}
    >
      <div class="flex flex-col gap-2">
        <Show when={!archived.isPending} fallback={<p role="status">Loading archived projects…</p>}>
          <Show
            when={!archived.isError}
            fallback={
              <div class="flex items-center gap-2">
                <p>Archived projects could not be loaded.</p>
                <Button variant="outline" size="sm" onClick={() => void archived.refetch()}>
                  Try again
                </Button>
              </div>
            }
          >
            <Show when={rows().length > 0} fallback={<p>No archived projects.</p>}>
              <ul class="flex flex-col gap-2">
                <For each={rows()}>
                  {(project) => (
                    <li class="flex flex-col gap-2">
                      <div class="flex items-center justify-between gap-2">
                        <span>{project.name}</span>
                        <Show when={target()?.id !== project.id}>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={restore.isPending}
                            aria-label={`Restore ${project.name}`}
                            onClick={() =>
                              openConfirmation({
                                id: project.id,
                                name: project.name,
                                version: project.version,
                              })
                            }
                          >
                            Restore
                          </Button>
                        </Show>
                      </div>
                      <Show when={target()?.id === project.id ? target() : undefined}>
                        {(captured) => (
                          <div
                            class="flex flex-col gap-2"
                            role="group"
                            aria-label="Restore project"
                          >
                            <p>Restore {captured().name}?</p>
                            <ul
                              class="flex list-disc flex-col gap-1 ps-5"
                              aria-label="Restore consequences"
                            >
                              <For each={restoreConsequences()}>
                                {(line) => (
                                  <li>
                                    <Text variant="label">{line}</Text>
                                  </li>
                                )}
                              </For>
                            </ul>
                            <div class="flex items-center gap-2">
                              <Button
                                disabled={restore.isPending}
                                aria-busy={restore.isPending}
                                onClick={() => void confirmRestore()}
                              >
                                {restore.isPending ? 'Restoring…' : 'Restore project'}
                              </Button>
                              <Button
                                variant="outline"
                                disabled={restore.isPending}
                                onClick={() => setTarget(null)}
                              >
                                Cancel
                              </Button>
                            </div>
                          </div>
                        )}
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </Show>
        <Show when={status()}>
          <p role="status" aria-label="Archived projects status">
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
