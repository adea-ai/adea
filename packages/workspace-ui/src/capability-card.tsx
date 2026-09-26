import { For, Show } from 'solid-js'
import { Badge } from '@adea-ai/app-ui/components/ui/badge'
import { Button } from '@adea-ai/app-ui/components/ui/button'

import { capabilitySnapshotAge, presentCapability } from './capability-status'
import { keyedRows } from './keyed-rows'
import type { CapabilitySnapshot, CapabilityStatus } from './platform'

const toneBadge = {
  attention: 'outline',
  blocked: 'destructive',
  ready: 'secondary',
} as const satisfies Record<string, 'destructive' | 'outline' | 'secondary'>

/**
 * One capability's status. The shell reports every local prerequisite through
 * this shape, so a new capability needs no new rendering.
 */
export function CapabilityCard(props: { status: CapabilityStatus }) {
  const capability = () => presentCapability(props.status)
  return (
    <div class="conventional-settings-row" data-capability={capability().id}>
      <div>
        <h4>{capability().title}</h4>
        <p>{capability().hint ?? 'This capability is ready on this device.'}</p>
      </div>
      <Badge
        variant={toneBadge[capability().tone]}
        aria-label={`${capability().title}: ${capability().label}`}
      >
        {capability().label}
      </Badge>
    </div>
  )
}

/**
 * The capability surface: every registered capability, plus the age of the
 * report, because the shell answers from a cached snapshot.
 */
export function CapabilityList(props: {
  busy?: boolean
  onRefresh?: () => void
  snapshot: CapabilitySnapshot
}) {
  const capabilityRows = keyedRows(
    () => props.snapshot.capabilities,
    (status) => status.id
  )
  return (
    <div role="group" aria-label="Local capabilities" data-local-capabilities="true">
      <For each={capabilityRows()}>{(entry) => <CapabilityCard status={entry.item()} />}</For>
      <div class="conventional-settings-note">
        <p>
          {capabilitySnapshotAge(props.snapshot)}
          {props.snapshot.servedFromCache ? ' (cached)' : ''}
        </p>
        <Show when={props.onRefresh}>
          {(onRefresh) => (
            <Button
              aria-label="Refresh local capability status"
              disabled={props.busy}
              onClick={() => onRefresh()()}
              size="sm"
              type="button"
              variant="secondary"
            >
              Refresh
            </Button>
          )}
        </Show>
      </div>
    </div>
  )
}
