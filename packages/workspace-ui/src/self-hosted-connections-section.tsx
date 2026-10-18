// The Connections section's mount of the self-hosted pane (#188). The pane resets everything it
// holds when the signed-in account or the workspace changes, so it needs the account's id before it
// can render hosts. That id comes from the shared bootstrap read the shell already makes; until it
// is settled, or when it cannot be read, the section says so and renders no host list. The pane gets
// no operations: the client exposes no pairing, rename or revoke call and no host-choice store is
// connected, so the pane shows those as unavailable with their reasons rather than as controls.
import type { AgentHqApiClient } from '@adea-ai/api-client'
import { settledData, useWorkspaceBootstrapQuery } from '@adea-ai/data'
import { SettingsSection } from '@adea-ai/ui/components/composites/settings'
import { EmptyDescription } from '@adea-ai/ui/components/ui/empty'
import { Show } from 'solid-js'

import SelfHostedConnectionPane from './self-hosted-connection-pane'

export default function SelfHostedConnectionsSection(props: {
  client?: AgentHqApiClient
  workspaceId: string
}) {
  return (
    <Show
      when={props.client}
      keyed
      fallback={<SelfHostedConnectionPane accountId="" workspaceId={props.workspaceId} />}
    >
      {(client) => <Account client={client} workspaceId={props.workspaceId} />}
    </Show>
  )
}

function Account(props: { client: AgentHqApiClient; workspaceId: string }) {
  const bootstrap = useWorkspaceBootstrapQuery(props.client)
  const accountId = () => settledData(bootstrap)?.principal.userId
  // A read that failed, or that settled for a principal with no account id (a temporary session),
  // will not produce an account: say so instead of waiting for one.
  const unavailableReason = () =>
    bootstrap.isError
      ? 'Self-hosted hosts are unavailable: your account could not be confirmed.'
      : bootstrap.isSuccess && !accountId()
        ? 'Self-hosted hosts need a signed-in account.'
        : undefined
  return (
    <Show
      when={accountId()}
      keyed
      fallback={
        <SettingsSection
          title="Self-hosted hosts"
          description="Servers you control that run work for this workspace."
        >
          <EmptyDescription role="status">
            {unavailableReason() ?? 'Confirming your account…'}
          </EmptyDescription>
        </SettingsSection>
      }
    >
      {(account) => (
        <SelfHostedConnectionPane
          accountId={account}
          client={props.client}
          workspaceId={props.workspaceId}
        />
      )}
    </Show>
  )
}
