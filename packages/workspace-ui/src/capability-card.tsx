'use client'

import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Button } from '@adea-ai/ui/components/ui/button'

import { capabilitySnapshotAge, presentCapability } from './capability-status'
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
export function CapabilityCard({ status }: Readonly<{ status: CapabilityStatus }>) {
  const capability = presentCapability(status)
  return (
    <div className="conventional-settings-row" data-capability={capability.id}>
      <div>
        <h4>{capability.title}</h4>
        <p>{capability.hint ?? 'This capability is ready on this device.'}</p>
      </div>
      <Badge
        variant={toneBadge[capability.tone]}
        aria-label={`${capability.title}: ${capability.label}`}
      >
        {capability.label}
      </Badge>
    </div>
  )
}

/**
 * The capability surface: every registered capability, plus the age of the
 * report, because the shell answers from a cached snapshot.
 */
export function CapabilityList({
  busy,
  onRefresh,
  snapshot,
}: Readonly<{
  busy?: boolean
  onRefresh?: () => void
  snapshot: CapabilitySnapshot
}>) {
  return (
    <div role="group" aria-label="Local capabilities" data-local-capabilities="true">
      {snapshot.capabilities.map((status) => (
        <CapabilityCard key={status.id} status={status} />
      ))}
      <div className="conventional-settings-note">
        <p>
          {capabilitySnapshotAge(snapshot)}
          {snapshot.servedFromCache ? ' (cached)' : ''}
        </p>
        {onRefresh ? (
          <Button
            aria-label="Refresh local capability status"
            disabled={busy}
            onClick={onRefresh}
            size="sm"
            type="button"
            variant="secondary"
          >
            Refresh
          </Button>
        ) : null}
      </div>
    </div>
  )
}
