// The Connections section's mount of the self-hosted pane (#188). The pane resets everything it
// holds when the signed-in account or the workspace changes, so it needs the account's id. That id
// comes from the lane's own session principal (the accessor the shell already uses to guard its
// account-scoped caches), never from a query cache that outlives a session: without one the section
// says so and renders no host list.
//
// Two operations are connected here, and only these two:
//   - rename: a product label for one registered host. The host keeps its own identity and keys.
//   - choice: which registered host this browser asks for work to run. It is a local preference,
//     scoped by account and workspace, and it is not authority over a host.
//
// Pairing and revocation stay unavailable: this build connects no pairing call and no revoke call,
// so the pane shows them as unavailable with their reasons and does not ship the code that would
// run them.
import type { AgentHqApiClient } from '@adea-ai/api-client'
import { SettingsSection } from '@adea-ai/ui/components/composites/settings'
import { EmptyDescription } from '@adea-ai/ui/components/ui/empty'
import { createEffect, createMemo, createSignal, Show } from 'solid-js'

import SelfHostedConnectionPaneCore from './self-hosted-connection-pane-core'
import type { SelfHostedOperations } from './self-hosted-connection-panel'
import {
  readSelfHostedHostPreference,
  writeSelfHostedHostPreference,
  type SelfHostedHostPreferenceScope,
} from './self-hosted-host-preference'

/** Browser storage is best-effort: a storage failure never blocks the view. */
const storage = () => (typeof window === 'undefined' ? undefined : window.localStorage)

export default function SelfHostedConnectionsSection(props: {
  accountId?: () => string | null | undefined
  client?: AgentHqApiClient
  workspaceId: string
}) {
  const [chosenHostId, setChosenHostId] = createSignal<string | undefined>()
  const currentAccountId = () => props.accountId?.()
  const scope = createMemo<SelfHostedHostPreferenceScope | undefined>(() => {
    const current = currentAccountId()
    return current ? { accountId: current, workspaceId: props.workspaceId } : undefined
  })
  // The stored choice belongs to one account and workspace. A change of either drops it.
  createEffect(() => {
    const current = scope()
    setChosenHostId(current ? readSelfHostedHostPreference(storage(), current) : undefined)
  })
  const operations = createMemo<SelfHostedOperations>(() => {
    const client = props.client
    if (!client) return {}
    return {
      renameHost: async (hostId: string, displayName: string) => {
        await client.renameRuntimeNode(props.workspaceId, hostId, displayName)
      },
    }
  })
  return (
    <Show
      when={props.accountId?.()}
      keyed
      fallback={
        <SettingsSection
          title="Self-hosted hosts"
          help="Servers you control that run work for this workspace."
        >
          <EmptyDescription role="status">
            Self-hosted hosts need a signed-in account.
          </EmptyDescription>
        </SettingsSection>
      }
    >
      {(account) => (
        <SelfHostedConnectionPaneCore
          accountId={account}
          chosenHostId={chosenHostId()}
          client={props.client}
          onChooseHost={(hostId) => {
            const current = scope()
            if (!current) return
            writeSelfHostedHostPreference(storage(), current, hostId)
            setChosenHostId(hostId)
          }}
          operations={operations()}
          workspaceId={props.workspaceId}
        />
      )}
    </Show>
  )
}
