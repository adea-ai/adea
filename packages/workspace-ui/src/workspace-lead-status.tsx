import { createEffect, createSignal, onCleanup, Show } from 'solid-js'
import type { AgentSummary } from '@adea-ai/types'
import { Button } from '@adea-ai/ui/components/ui/button'
import { loadWorkspaceLeadSetup, type WorkspaceLeadClient } from './workspace-lead-load'
import { workspaceLeadRevision } from './workspace-lead-revision'
import type { WorkspaceLeadSetup } from './workspace-lead-setup'

/**
 * Canonical lead setup status for one workspace. A workspace change, a retry, a
 * lead-relevant change elsewhere, or a change to the roster's agent list (the
 * same query the Agents surface invalidates on profile, presentation, and project
 * saves) starts a new scoped load. An earlier load that settles after that point
 * cannot apply.
 */
export function WorkspaceLeadStatus(props: {
  client: WorkspaceLeadClient
  workspaceId: string
  /** The roster's agent list. Its refetches are the lead's reload signal. */
  agents?: readonly AgentSummary[]
  /** Called after this status provisions the lead, so the roster list can refetch. */
  onProvisioned?: () => void
  onSignIn?: () => void
}) {
  const [setup, setSetup] = createSignal<WorkspaceLeadSetup>()
  const [attempt, setAttempt] = createSignal(0)
  let token = 0

  createEffect(() => {
    const workspaceId = props.workspaceId
    const client = props.client
    void props.agents
    void attempt()
    void workspaceLeadRevision(workspaceId)
    const request = (token += 1)
    setSetup(undefined)
    loadWorkspaceLeadSetup({
      client,
      workspaceId,
      isCurrent: () => request === token,
      onProvisioned: () => props.onProvisioned?.(),
    }).then(
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
