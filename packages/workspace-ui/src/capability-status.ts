import type { CapabilitySnapshot, CapabilityState, CapabilityStatus } from './platform'

export type CapabilityTone = 'ready' | 'attention' | 'blocked'

/**
 * How a capability state is presented. Kept as a pure mapping so the rendering
 * rules — which states are actionable, which are the user's to fix — are
 * testable without a DOM.
 */
export type CapabilityPresentation = Readonly<{
  tone: CapabilityTone
  label: string
  hint?: string
}>

export function presentCapabilityState(state: CapabilityState): CapabilityPresentation {
  switch (state.state) {
    case 'ready':
      return { tone: 'ready', label: 'Ready' }
    case 'missing':
      return { tone: 'attention', label: 'Not available yet', hint: state.hint }
    case 'permissionDenied':
      return { tone: 'blocked', label: 'Permission denied', hint: state.hint }
    case 'timedOut':
      return { tone: 'attention', label: 'Check timed out', hint: state.hint }
  }
}

export function presentCapability(status: CapabilityStatus): CapabilityPresentation & {
  id: string
  title: string
} {
  return { id: status.id, title: status.title, ...presentCapabilityState(status.state) }
}

/** The capabilities that need the user to do something, in report order. */
export function capabilitiesNeedingAttention(
  snapshot: CapabilitySnapshot | undefined
): readonly (CapabilityPresentation & { id: string; title: string })[] {
  if (!snapshot) return []
  return snapshot.capabilities
    .map(presentCapability)
    .filter((capability) => capability.tone !== 'ready')
}

/**
 * How old the reported status is. The shell caches snapshots behind a re-probe
 * floor, so the age is part of the answer rather than an implementation detail.
 */
export function capabilitySnapshotAge(snapshot: CapabilitySnapshot): string {
  const seconds = Math.round(snapshot.ageMs / 1000)
  if (seconds <= 0) return 'Checked now'
  if (seconds < 60) return `Checked ${seconds}s ago`
  return `Checked ${Math.round(seconds / 60)}m ago`
}
