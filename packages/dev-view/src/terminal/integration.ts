// Typed shell-integration availability for the terminal pane (issue #396).
//
// The pane says truthfully which shell-integration features are live, from
// two clearly separated evidence channels:
// - the host-declared wrapper feature set (markers/cwd/history — the
//   authenticated wrapper the creation path injected), and
// - what actually arrived: authenticated observations (MAC-verified
//   server-side) versus unauthenticated standard OSC 133/7 markers parsed
//   from the display stream.
// Command blocks and exit codes are rendered only on the authenticated
// channel, so the presentation can promise them only when that channel is
// proven live. A shell without the hook degrades TYPED — an explicit
// unavailable state with its reason — never a silent blank.
export type IntegrationEvent =
  | { type: 'observation' }
  | { type: 'stream-marker' }
  | { type: 'stream-cwd' }

export type IntegrationState = Readonly<{
  /** Wrapper features the host declared for this terminal (may be empty). */
  hostFeatures: readonly string[]
  /** At least one authenticated observation arrived. */
  authenticatedObservation: boolean
  /** The display stream carried standard (unauthenticated) OSC 133 markers. */
  streamMarkers: boolean
  /** The display stream carried an OSC 7 cwd report. */
  streamCwd: boolean
}>

export type IntegrationStatus = 'active' | 'pending' | 'unavailable'

export type IntegrationPresentation = Readonly<{
  status: IntegrationStatus
  /** Short header/status label. */
  label: string
  /** Why, in plain language — including what still works without it. */
  detail: string
  /** Screen-reader announcement for a status transition; undefined when quiet. */
  announcement?: string
}>

export function createIntegrationState(hostFeatures: readonly string[] = []): IntegrationState {
  return {
    hostFeatures: [...hostFeatures],
    authenticatedObservation: false,
    streamMarkers: false,
    streamCwd: false,
  }
}

export function reduceIntegration(
  state: IntegrationState,
  event: IntegrationEvent
): IntegrationState {
  switch (event.type) {
    case 'observation':
      if (state.authenticatedObservation) return state
      return { ...state, authenticatedObservation: true }
    case 'stream-marker':
      if (state.streamMarkers) return state
      return { ...state, streamMarkers: true }
    case 'stream-cwd':
      if (state.streamCwd) return state
      return { ...state, streamCwd: true }
  }
}

/** Whether blocks, exit codes, and the authenticated cwd display may render. */
export function integrationActive(state: IntegrationState): boolean {
  return state.authenticatedObservation
}

export function integrationPresentation(state: IntegrationState): IntegrationPresentation {
  if (state.authenticatedObservation) {
    return {
      status: 'active',
      label: 'Shell integration active',
      detail: 'Command blocks, exit codes, and cwd come from Adea’s authenticated wrapper.',
    }
  }
  if (state.hostFeatures.length > 0) {
    return {
      status: 'pending',
      label: 'Waiting for shell integration',
      detail: 'This shell launched with the Adea wrapper; the first prompt will report blocks.',
    }
  }
  if (state.streamMarkers || state.streamCwd) {
    const evidence = state.streamMarkers
      ? 'your shell emits its own unauthenticated prompt markers'
      : 'your shell reports its cwd'
    return {
      status: 'unavailable',
      label: 'Shell integration unavailable',
      detail:
        `No authenticated Adea wrapper is installed for this shell, so commands run without ` +
        `block boundaries or exit codes. The stream shows ${evidence}, which Adea does not ` +
        `trust for command blocks.`,
    }
  }
  return {
    status: 'unavailable',
    label: 'Shell integration unavailable',
    detail:
      'No authenticated Adea wrapper is installed for this shell, so commands run without ' +
      'block boundaries, exit codes, or cwd tracking. Everything else keeps working.',
  }
}

/**
 * Screen-reader announcement for a transition between two presentations. The
 * live region stays quiet unless the status actually moved.
 */
export function integrationAnnouncement(
  before: IntegrationPresentation,
  after: IntegrationPresentation
): string | undefined {
  if (before.status === after.status) return undefined
  if (after.status === 'active') return 'Shell integration active'
  if (after.status === 'unavailable') return 'Shell integration unavailable'
  return undefined
}
