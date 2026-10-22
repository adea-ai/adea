// The Connections section's mount of the self-hosted pane (#188). The pane resets everything it
// holds when the signed-in account or the workspace changes, so it needs the account's id. That id
// comes from the lane's own session principal (the accessor the shell already uses to guard its
// account-scoped caches), never from a query cache that outlives a session: without one the section
// says so and renders no host list.
//
// Two things are connected here, and only these two:
//   - rename: a product label for one registered host. The host keeps its own identity and keys.
//   - remember: which registered host this browser keeps a note about.
//
// The note is a local preference scoped by account and workspace. No submission path reads it, so it
// is not a routing decision and the copy says so. It never leaves this browser, and one workspace's
// note never appears in another.
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
import { RenameHostActions } from './self-hosted-rename-actions'
import {
  readSelfHostedHostPreference,
  writeSelfHostedHostPreference,
  type SelfHostedHostPreferenceScope,
} from './self-hosted-host-preference'
import {
  browserHostPreferenceStorage,
  selfHostedHostOperations,
} from './self-hosted-host-operations'

/**
 * The host actions this build mounts. The rename row on its own: revocation is not part of them,
 * so a revocation operation handed to the mounted component is never run.
 */
export function selfHostedHostActionsSlot() {
  return RenameHostActions
}

/** This browser's note store, or none when the browser refuses storage. */
const storage = () => browserHostPreferenceStorage()

export default function SelfHostedConnectionsSection(props: {
  accountId?: () => string | null | undefined
  client?: AgentHqApiClient
  workspaceId: string
}) {
  const [chosenHostId, setChosenHostId] = createSignal<string | null>(null)
  const scope = createMemo<SelfHostedHostPreferenceScope | undefined>(() => {
    const current = props.accountId?.()
    return current ? { accountId: current, workspaceId: props.workspaceId } : undefined
  })
  // The note belongs to one account and workspace. A change of either drops it.
  createEffect(() => {
    const current = scope()
    setChosenHostId(current ? (readSelfHostedHostPreference(storage(), current) ?? null) : null)
  })
  const operations = createMemo<SelfHostedOperations>(() =>
    selfHostedHostOperations(props.client, props.workspaceId)
  )
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
          chosenHostId={chosenHostId() ?? undefined}
          client={props.client}
          onChooseHost={(hostId) => {
            const current = scope()
            if (!current) return
            const outcome = writeSelfHostedHostPreference(storage(), current, hostId)
            // A write that did not happen is never shown as a remembered host: the note on screen
            // stays exactly as it was, so the badge cannot claim something that was not kept.
            if (outcome.status === 'failed') return
            setChosenHostId(hostId ?? null)
          }}
          operations={operations()}
          slots={{ HostActions: selfHostedHostActionsSlot() }}
          workspaceId={props.workspaceId}
        />
      )}
    </Show>
  )
}
