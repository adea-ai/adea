// The Connections section's mount of the self-hosted pane (#188). The pane resets everything it
// holds when the signed-in account or the workspace changes, so it needs the account's id. That id
// comes from the lane's own session principal (the accessor the shell already uses to guard its
// account-scoped caches), never from a query cache that outlives a session: without one the section
// says so and renders no host list. The pane gets no operations: the client exposes no pairing,
// rename or revoke call and no host-choice store is connected, so the pane shows those as
// unavailable with their reasons rather than as controls.
import type { AgentHqApiClient } from '@adea-ai/api-client'
import { SettingsSection } from '@adea-ai/ui/components/composites/settings'
import { EmptyDescription } from '@adea-ai/ui/components/ui/empty'
import { Show } from 'solid-js'

import SelfHostedConnectionPane from './self-hosted-connection-pane'

export default function SelfHostedConnectionsSection(props: {
  accountId?: () => string | null | undefined
  client?: AgentHqApiClient
  workspaceId: string
}) {
  return (
    <Show
      when={props.accountId?.()}
      keyed
      fallback={
        <SettingsSection
          title="Self-hosted hosts"
          description="Servers you control that run work for this workspace."
        >
          <EmptyDescription role="status">
            Self-hosted hosts need a signed-in account.
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
