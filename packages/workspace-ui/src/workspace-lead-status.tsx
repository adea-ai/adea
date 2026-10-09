import { createEffect, createSignal, onCleanup, Show } from 'solid-js'
import { Button } from '@adea-ai/ui/components/ui/button'
import { loadWorkspaceLeadSetup, type WorkspaceLeadClient } from './workspace-lead-load'
import type { WorkspaceLeadSetup } from './workspace-lead-setup'

/**
 * Canonical lead setup status for one workspace. Each workspace change starts a
 * new scoped load; an earlier load that settles after the switch cannot apply.
 */
export function WorkspaceLeadStatus(props: {
  client: WorkspaceLeadClient
  workspaceId: string
  onSignIn?: () => void
}) {
  const [setup, setSetup] = createSignal<WorkspaceLeadSetup>()
  const [attempt, setAttempt] = createSignal(0)
  let token = 0

  createEffect(() => {
    const workspaceId = props.workspaceId
    const client = props.client
    void attempt()
    const request = (token += 1)
    setSetup(undefined)
    loadWorkspaceLeadSetup({ client, workspaceId, isCurrent: () => request === token }).then(
      (result) => {
        if (result.current && request === token) setSetup(result.setup)
      },
      () => {
        if (request === token)
          setSetup({ state: 'unavailable', detail: 'Lead status could not be read. Try again.' })
      }
    )
  })
  onCleanup(() => {
    token += 1
  })

  return (
    <section aria-label="Workspace lead" class="grid gap-2">
      <Show when={setup()} fallback={<p role="status">Checking the workspace lead…</p>}>
        {(current) => (
          <>
            <p role="status" data-testid="lead-setup-state" data-state={current().state}>
              {current().detail}
            </p>
            <Show
              when={current().state === 'provisioning_failed' || current().state === 'unavailable'}
            >
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setAttempt((value) => value + 1)}
              >
                Try again
              </Button>
            </Show>
            <Show when={current().state === 'auth_required' && props.onSignIn}>
              <Button type="button" variant="outline" size="sm" onClick={() => props.onSignIn?.()}>
                Sign in
              </Button>
            </Show>
          </>
        )}
      </Show>
    </section>
  )
}
