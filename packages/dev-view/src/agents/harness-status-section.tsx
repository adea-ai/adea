/*
 * Agents pane status section (#400): binds the harness controller (canonical
 * run records, the preference overlay, the inventory, the device default and
 * the managed-Pi status read through the gate) to the pure HarnessStatusPane.
 * The section owns no authority and fabricates nothing: an unavailable
 * runtime renders the typed state, and empty runs render idle.
 */
import '@adea-ai/app-ui/dev-view.css'
import { Show } from 'solid-js'

import { hasDevUtilitySession, type DevUtilityContextReader } from '../utility-context'
import { createHarnessStatusController } from './harness-status-controller'
import { HarnessStatusPane } from './harness-status-pane'

export type HarnessStatusSectionProps = {
  context: DevUtilityContextReader
}

export function HarnessStatusSection(props: HarnessStatusSectionProps) {
  const context = () => props.context()
  const runtime = () => context().runtime
  const harness = createHarnessStatusController(() => props.context())

  return (
    <Show
      when={hasDevUtilitySession(context())}
      fallback={
        <p class="dev-pane-state__line" role="status">
          Agent status is unavailable until this view is bound to a canonical runtime session.
        </p>
      }
    >
      <Show
        when={runtime().state().status === 'ready'}
        fallback={<p class="dev-pane-state__line">Runtime unavailable</p>}
      >
        <HarnessStatusPane
          runs={harness.runs()}
          preferences={harness.preferences()}
          managedPi={harness.managedPi()}
          inventoryRows={harness.inventoryRows()}
          inventoryChecked={harness.inventoryChecked()}
          readErrors={harness.readErrors()}
          onRetry={harness.retryReads}
          busy={harness.busy()}
          {...(harness.actionError() !== undefined ? { actionError: harness.actionError() } : {})}
          defaultSummary={harness.defaultSummary()}
          onMakeDeviceDefault={(row) => void harness.makeDeviceDefault(row)}
          onUseInWorkspace={(row) => void harness.useInWorkspace(row)}
          onUseDeviceDefault={() => void harness.useDeviceDefault()}
          onRescan={() => void harness.rescan()}
        />
      </Show>
    </Show>
  )
}
