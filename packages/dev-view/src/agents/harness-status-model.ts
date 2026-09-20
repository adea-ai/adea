// Pure harness-status presentation model (#400): the truthful projection of
// HarnessRun / AcpConnection / ManagedPiStatus facts for the Agents pane.
//
// Precedence and labels are pure and component-free so tests can pin them.
// The model never invents state: an `unknown` run renders as unknown, a
// missing run renders as idle, and a fallback-only projection is labelled as
// such instead of masquerading as structured. Donor influence (Orca's
// status-OSC precedence, MIT, revision 403b62a8d8f) is conceptual only —
// authority here derives from canonical RuntimeSession/HarnessRun generation
// facts carried through the gate, never from raw terminal bytes.
import type {
  AcpConnection,
  HarnessPreference,
  HarnessRun,
  HarnessRunState,
  ManagedPiStatus,
} from '@adea-ai/types/dev-runtime'

export type HarnessStatusTone = 'neutral' | 'progress' | 'success' | 'failure' | 'unknown'

export type HarnessStatusView = Readonly<{
  /** The active run's state, or 'idle' when no run exists. */
  state: HarnessRunState | 'idle'
  /** Full accessible label; never a bare color/tone. */
  label: string
  tone: HarnessStatusTone
  /** The active run when one exists (drives resume/cancel affordances). */
  run?: HarnessRun
  /** True when the only live transport is a terminal transcript fallback. */
  terminalFallback: boolean
}>

const STATE_LABELS: Readonly<
  Record<HarnessRunState | 'idle', { label: string; tone: HarnessStatusTone }>
> = {
  idle: { label: 'No harness run', tone: 'neutral' },
  resolving: { label: 'Harness resolving installation', tone: 'progress' },
  starting: { label: 'Harness starting', tone: 'progress' },
  working: { label: 'Harness working', tone: 'success' },
  awaiting_input: { label: 'Harness awaiting your input', tone: 'progress' },
  awaiting_approval: { label: 'Harness awaiting approval', tone: 'progress' },
  completed: { label: 'Harness completed', tone: 'success' },
  failed: { label: 'Harness failed', tone: 'failure' },
  cancelled: { label: 'Harness cancelled', tone: 'neutral' },
  disconnected: { label: 'Harness disconnected', tone: 'failure' },
  unknown: { label: 'Harness state unknown', tone: 'unknown' },
}

/** Precedence for surfacing a run: live runs first, then recency. */
export function selectActiveRun(runs: readonly HarnessRun[]): HarnessRun | undefined {
  const live = runs.filter((run) => !isTerminalView(run.state))
  if (live.length > 0) {
    return live.toSorted((left, right) =>
      (right.startedAt ?? '').localeCompare(left.startedAt ?? '')
    )[0]
  }
  return runs.toSorted((left, right) =>
    (right.startedAt ?? '').localeCompare(left.startedAt ?? '')
  )[0]
}

function isTerminalView(state: HarnessRunState): boolean {
  return (
    state === 'completed' || state === 'failed' || state === 'cancelled' || state === 'disconnected'
  )
}

export function harnessStatusLabel(state: HarnessRunState | 'idle'): string {
  return STATE_LABELS[state].label
}

/**
 * Projects the session's harness status. A live run whose only transport is
 * a closed/failed ACP connection surfaces `terminalFallback` so the UI can
 * offer jump-to-terminal instead of implying structured events exist.
 */
export function deriveHarnessStatus(
  runs: readonly HarnessRun[],
  connections: readonly AcpConnection[] = []
): HarnessStatusView {
  const run = selectActiveRun(runs)
  if (!run) {
    return {
      state: 'idle',
      label: harnessStatusLabel('idle'),
      tone: 'neutral',
      terminalFallback: false,
    }
  }
  const base = STATE_LABELS[run.state]
  const liveConnection = connections.find(
    (connection) =>
      connection.runtimeSessionId === run.runtimeSessionId && connection.state === 'ready'
  )
  const terminalFallback = run.state === 'starting' || (run.state === 'working' && !liveConnection)
  return {
    state: run.state,
    label: base.label,
    tone: base.tone,
    run,
    terminalFallback,
  }
}

export type InstallationDisplayState =
  | 'ready'
  | 'disabled'
  | 'auth_required'
  | 'unhealthy'
  | 'not_installed'

/**
 * The Agents pane's harness-inventory row state: discovered facts joined with
 * the user preference. Each distinction from the issue's acceptance criteria
 * renders distinctly (installed/missing, auth-required, incompatible/update
 * surfaces stay with discovery; enabled/disabled/default live here).
 */
export function installationDisplayState(input: {
  preference: HarnessPreference | undefined
  managedPi: Pick<ManagedPiStatus, 'state' | 'installationId'> | undefined
  installationId: string
  /** Discovered facts from the M10 inventory; absent = not installed. */
  discovered?: {
    auth: 'ready' | 'required' | 'expired' | 'unknown'
    health: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
  }
}): InstallationDisplayState {
  if (input.preference && !input.preference.enabled) return 'disabled'
  const isManaged = input.managedPi?.installationId === input.installationId
  if (isManaged) return input.managedPi!.state === 'ready' ? 'ready' : 'not_installed'
  if (!input.discovered) return 'not_installed'
  if (input.discovered.auth !== 'ready') return 'auth_required'
  if (input.discovered.health !== 'healthy') return 'unhealthy'
  return 'ready'
}

export const INSTALLATION_STATE_LABELS: Readonly<Record<InstallationDisplayState, string>> = {
  ready: 'Ready',
  disabled: 'Disabled',
  auth_required: 'Authentication required',
  unhealthy: 'Unhealthy',
  not_installed: 'Not installed',
}

/** True when this preference is the effective global default. */
export function isGlobalDefault(preference: HarnessPreference | undefined): boolean {
  return (
    preference?.default === true &&
    preference?.enabled === true &&
    preference.projectId === undefined
  )
}
