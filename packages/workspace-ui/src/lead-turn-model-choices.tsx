import type { AgentHqApiClient } from '@adea-ai/api-client'
import { settledData } from '@adea-ai/data'
import { useModelConnectionsQuery } from '@adea-ai/data/model-connections'
import { Button } from '@adea-ai/ui/components/ui/button'
import { EmptyDescription } from '@adea-ai/ui/components/ui/empty'
import { For, Show } from 'solid-js'
import { projectModelReadiness, projectSelectableModels } from './lead-model-state'
import type { LeadRequestedChoices } from './lead-model-request'

/** Per-turn choices do not change workspace defaults or authorize a model call. */
export function LeadTurnModelChoices(props: {
  client: AgentHqApiClient
  workspaceId: string
  choices: LeadRequestedChoices
  onChange: (choices: LeadRequestedChoices) => void
}) {
  return (
    <Show when={props.client} keyed>
      {(client) => <LeadTurnModelChoicesForClient {...props} client={client} />}
    </Show>
  )
}

function LeadTurnModelChoicesForClient(props: {
  client: AgentHqApiClient
  workspaceId: string
  choices: LeadRequestedChoices
  onChange: (choices: LeadRequestedChoices) => void
}) {
  const inventory = useModelConnectionsQuery(props.client, () => props.workspaceId)
  const currentInventory = () => (inventory.isFetching ? undefined : settledData(inventory))
  const models = () => projectSelectableModels(currentInventory())
  return (
    <section aria-label="Models for next lead turn" class="flex flex-col gap-2">
      <p>Models for your next saved message</p>
      <Show when={currentInventory()?.target}>
        {(target) => (
          <p>
            Execution location: {target().location} · Runtime: {target().harness}{' '}
            {target().harnessVersion}
          </p>
        )}
      </Show>
      <Button
        size="sm"
        variant="outline"
        disabled={inventory.isFetching}
        onClick={() => void inventory.refetch()}
      >
        Refresh available models
      </Button>
      <For each={['lead', 'child'] as const}>
        {(role) => (
          <div
            class="flex flex-wrap items-center gap-2"
            aria-label={role === 'lead' ? 'Lead model choice' : 'Delegated agent model choice'}
          >
            <span>{role === 'lead' ? 'Lead' : 'Delegated agents'}</span>
            <Show when={props.choices[role]}>
              {(choice) => <span>Requested: {choice().providerModel}</span>}
            </Show>
            <Button
              size="sm"
              variant="outline"
              aria-pressed={!props.choices[role]}
              onClick={() => {
                const next = { ...props.choices }
                delete next[role]
                props.onChange(next)
              }}
            >
              Use {role} workspace default
            </Button>
            <For each={models()}>
              {(model) => (
                <Button
                  size="sm"
                  variant="outline"
                  aria-pressed={
                    props.choices[role]?.connectionRef === model.choice.connectionRef &&
                    props.choices[role]?.providerModel === model.choice.providerModel
                  }
                  onClick={() => props.onChange({ ...props.choices, [role]: model.choice })}
                >
                  {model.provider} / {model.choice.providerModel} ({model.accountRef})
                </Button>
              )}
            </For>
          </div>
        )}
      </For>
      <For each={currentInventory()?.connections ?? []}>
        {(connection) => (
          <For each={connection.models}>
            {(model) => (
              <div class="flex flex-col gap-1">
                <p>
                  {connection.provider} / {model.providerModel}: Account {connection.accountRef} ·
                  Authentication {connection.authKind} · Funding {connection.fundingSource}
                </p>
                <Show when={!projectModelReadiness(model.readiness).ready}>
                  <EmptyDescription role="status">
                    {projectModelReadiness(model.readiness).remedy?.message}
                  </EmptyDescription>
                </Show>
              </div>
            )}
          </For>
        )}
      </For>
      <Show when={!models().length}>
        <EmptyDescription role="status">
          Current eligible models are unavailable. Existing choices will be checked again before
          saving; your draft is preserved if setup is blocked.
        </EmptyDescription>
      </Show>
      <EmptyDescription>
        Saved turns keep their requested models. Delegated agents use their own selected model or
        child workspace default. Review the lead’s actual model and payer before starting.
      </EmptyDescription>
    </section>
  )
}
