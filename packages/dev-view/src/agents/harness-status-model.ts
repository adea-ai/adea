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
  RuntimeConnectionInventorySnapshot,
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

const CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  native: 'Native',
  models: 'Models',
  slash_commands: 'Slash commands',
  resume: 'Resume',
  acp: 'ACP',
  pty: 'Terminal',
}

/** A capability id as a chip label; ids the model does not know stay readable. */
export function capabilityLabel(capability: string): string {
  const known = CAPABILITY_LABELS[capability]
  if (known) return known
  const spaced = capability.replaceAll(/[_.]+/g, ' ').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export type HarnessInventoryRow = Readonly<{
  installationId: string
  /** The harness family (claude-code, codex, ...), the unit of a device default. */
  family: string
  name: string
  version?: string
  state: InstallationDisplayState
  stateLabel: string
  /** Capability chips exactly as the backend reported them, no inference. */
  capabilities: readonly string[]
  /** Typed eligibility blocker messages (why a launch would be refused). */
  blockers: readonly string[]
  /** The device-wide default: every workspace without its own uses this. */
  isDeviceDefault: boolean
  /** This workspace's own default, overriding the device default. */
  isWorkspaceDefault: boolean
  enabled: boolean
  /** True when it can be made the device default right now. */
  canMakeDeviceDefault: boolean
  /** True when it can be made this workspace's default right now. */
  canUseInWorkspace: boolean
  stale: boolean
}>

/** A workspace-level preference the user expressed (not the synthesized fallback). */
function workspaceChoice(
  preferences: readonly HarnessPreference[],
  installationId: string
): HarnessPreference | undefined {
  return preferences.find(
    (preference) =>
      preference.harnessInstallationId === installationId &&
      preference.projectId === undefined &&
      preference.rootDefault !== true
  )
}

/**
 * The selector's rows: every installation the backend reports (the
 * `dev.harness.inventory` read), plus the managed Pi installation when it is
 * ready and the inventory does not list it. Nothing is guessed: an empty
 * inventory is an empty list, and the managed row claims no capabilities it
 * was not reported to have.
 */
export function buildHarnessInventoryRows(input: {
  inventory: Pick<RuntimeConnectionInventorySnapshot, 'items' | 'freshness'> | undefined
  preferences: readonly HarnessPreference[]
  managedPi: Pick<ManagedPiStatus, 'state' | 'installationId' | 'executableLabel'> | undefined
  /** The device default family from `dev.harness.deviceDefault`, if set. */
  deviceDefaultFamily?: string | undefined
}): readonly HarnessInventoryRow[] {
  const items = input.inventory?.items ?? []
  const build = (base: {
    installationId: string
    family: string
    name: string
    version?: string
    discovered?: {
      auth: 'ready' | 'required' | 'expired' | 'unknown'
      health: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
    }
    capabilities: readonly string[]
    blockers: readonly string[]
    eligible: boolean
    stale: boolean
  }): HarnessInventoryRow => {
    const choice = workspaceChoice(input.preferences, base.installationId)
    const state = installationDisplayState({
      preference: choice,
      managedPi: input.managedPi,
      installationId: base.installationId,
      ...(base.discovered ? { discovered: base.discovered } : {}),
    })
    const isDeviceDefault = input.deviceDefaultFamily === base.family
    const isWorkspaceDefault = isGlobalDefault(choice)
    const usable = state === 'ready' && base.eligible
    return {
      installationId: base.installationId,
      family: base.family,
      name: base.name,
      ...(base.version !== undefined ? { version: base.version } : {}),
      state,
      stateLabel: INSTALLATION_STATE_LABELS[state],
      capabilities: base.capabilities,
      blockers: base.blockers,
      isDeviceDefault,
      isWorkspaceDefault,
      enabled: choice?.enabled ?? true,
      canMakeDeviceDefault: usable && !isDeviceDefault,
      canUseInWorkspace: usable && !isWorkspaceDefault,
      stale: base.stale,
    }
  }
  const rows: HarnessInventoryRow[] = items.map((entry, index) =>
    build({
      installationId: entry.id,
      family: entry.family,
      name: entry.displayName,
      ...(entry.version !== undefined ? { version: entry.version } : {}),
      discovered: { auth: entry.auth, health: entry.health },
      capabilities: entry.capabilities,
      blockers: entry.eligibility.blockers.map((blocker) => blocker.message),
      eligible: entry.eligibility.eligible,
      stale: input.inventory?.freshness[index] === 'stale',
    })
  )
  const managed = input.managedPi
  if (
    managed?.state === 'ready' &&
    managed.installationId !== undefined &&
    !items.some((entry) => entry.id === managed.installationId)
  ) {
    rows.unshift(
      build({
        installationId: managed.installationId,
        family: 'pi',
        name: managed.executableLabel ?? 'Pi (managed)',
        capabilities: [],
        blockers: [],
        eligible: true,
        stale: false,
      })
    )
  }
  return rows
}

export type HarnessDefaultSummary = Readonly<{
  /** Which rule decides a new session's harness. */
  source: 'workspace' | 'device' | 'fallback' | 'none'
  /** The harness a new session starts with, when it is known. */
  name?: string
  /** The device default's name when a workspace default overrides it. */
  overriddenDeviceName?: string
  /** The device default is set but is not installed and ready here. */
  deviceDefaultMissing: boolean
}>

/**
 * Which harness a new session in this workspace starts with, in the backend's
 * own order: workspace default, then device default, then the managed-Pi
 * fallback. A device default that is not usable here is reported as missing,
 * never substituted.
 */
export function summarizeHarnessDefault(input: {
  rows: readonly HarnessInventoryRow[]
  preferences: readonly HarnessPreference[]
  deviceDefaultFamily?: string | undefined
  managedPi: Pick<ManagedPiStatus, 'state' | 'installationId' | 'executableLabel'> | undefined
}): HarnessDefaultSummary {
  const deviceRow = input.rows.find((row) => row.isDeviceDefault)
  const workspaceRow = input.rows.find((row) => row.isWorkspaceDefault)
  const deviceUsable = deviceRow !== undefined && deviceRow.state === 'ready'
  const deviceDefaultMissing = input.deviceDefaultFamily !== undefined && !deviceUsable
  if (workspaceRow) {
    return {
      source: 'workspace',
      name: workspaceRow.name,
      ...(deviceRow && !workspaceRow.isDeviceDefault
        ? { overriddenDeviceName: deviceRow.name }
        : {}),
      deviceDefaultMissing,
    }
  }
  if (input.deviceDefaultFamily !== undefined) {
    return deviceUsable
      ? { source: 'device', name: deviceRow.name, deviceDefaultMissing: false }
      : { source: 'none', deviceDefaultMissing: true }
  }
  if (input.managedPi?.state === 'ready') {
    return {
      source: 'fallback',
      name: input.managedPi.executableLabel ?? 'Pi (managed)',
      deviceDefaultMissing: false,
    }
  }
  return { source: 'none', deviceDefaultMissing: false }
}
