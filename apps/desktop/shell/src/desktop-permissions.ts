// macOS host-permission probes for the desktop shell (issue #471). Every
// status the permissions page shows is measured here, in the shell main
// process, through fixed-argv host commands with injectable runners — never
// from browser context, never hard-coded (donor semantics: Orca's
// PermissionStatusSnapshot probe/refresh coordination, MIT, translated to the
// Bun lane; see NOTICE and docs/research/dev-view-donor-audit.md).
//
// Probe honesty rules (Dev Runtime spec, "macOS permissions onboarding"):
// - A probe answers only what its command can prove. A host command that
//   cannot distinguish a state reports the coarser state, and a permission
//   with no command-line probe at all reports `capability_unavailable` —
//   it is never guessed, defaulted to denied, or read from fixtures.
// - The TCC prompt is left to the OS: probing `not_determined` permissions
//   surfaces the system prompt, and the bounded probe maps "still waiting on
//   the user" to `not_determined` instead of blocking the shell.
// - Deep links live only in the frozen SETTINGS_PANES table below; clients
//   name a permission id and the shell opens that fixed URL through `open`.
//   No client string ever reaches argv.
import {
  isMacPermissionId,
  macPermissionIds,
  type MacPermissionId,
  type MacPermissionReport,
  type MacPermissionsSnapshot,
  type MacPermissionSettingsOpenResult,
  type MacPermissionState,
  type MacPermissionUnavailableReason,
} from '../../../../packages/types/src/desktop-permissions'

/** A fixed-argv host command runner. Production uses Bun.spawn; tests script it. */
export type HostCommandRunner = (argv: readonly string[]) => Promise<HostCommandOutcome>

export type HostCommandOutcome = Readonly<{
  exitCode: number | null
  stdout: string
  stderr: string
  /** True when the runner killed the command at the probe deadline. */
  timedOut: boolean
  /** True when the executable could not be launched at all. */
  spawnFailed: boolean
}>

/** Error text macOS emits when the assistive-access (Accessibility) gate refuses a probe. */
const ASSISTIVE_ACCESS_DENIED = /assistive access/i
/** Error text macOS emits when the Automation (Apple Events) gate refuses a probe. */
const APPLE_EVENTS_DENIED = /not authorized to send apple events|errAEEventNotPermitted|-1743/i

/** How long a probe may wait before the TCC prompt counts as unanswered. */
export const PROBE_TIMEOUT_MS = 3_000

/**
 * The one copy of the System Settings deep links, keyed by permission id.
 * Anchors are the documented `x-apple.systempreferences` form, which macOS
 * 13–15 resolves to the current System Settings panes; `open` receives only
 * these exact strings (docs/specs/dev-runtime.md, "macOS permissions
 * onboarding").
 */
export const SETTINGS_PANES: Readonly<Record<MacPermissionId, string>> = Object.freeze({
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screen_recording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  notifications: 'x-apple.systempreferences:com.apple.preference.notifications',
  automation_apple_events:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
})

type ProbeResult = Readonly<{
  state: MacPermissionState
  unavailableReason?: MacPermissionUnavailableReason
  detail?: string
}>

type PermissionProbe = Readonly<{
  /** Fixed argv probed on the host; absent when this lane has no probe. */
  argv?: readonly string[]
  /** Explains `capability_unavailable` rows on the page and in the spec. */
  noProbeReason: string
  classify: (outcome: HostCommandOutcome) => ProbeResult
}>

/**
 * One probe per permission. Probes that exist:
 * - accessibility: scripting System Events is gated by TCC Accessibility for
 *   the responsible process; the refusal text is unambiguous.
 * - automation_apple_events: sending Apple Events to Finder is gated by the
 *   Automation service; per-target grants are documented on the page.
 * Permissions without a command-line probe in this lane (screen recording,
 * notifications, microphone need the app's own API surface — a native helper
 * arrives with the computer-use slice, issue #472) report typed unavailability.
 */
const PROBES: Readonly<Record<MacPermissionId, PermissionProbe>> = Object.freeze({
  accessibility: {
    argv: ['/usr/bin/osascript', '-e', 'tell application "System Events" to count processes'],
    noProbeReason: '',
    classify: (outcome: HostCommandOutcome): ProbeResult => {
      if (outcome.exitCode === 0) return { state: 'granted' }
      if (outcome.timedOut) {
        return { state: 'not_determined', detail: 'the macOS consent prompt is still open' }
      }
      if (ASSISTIVE_ACCESS_DENIED.test(outcome.stderr + outcome.stdout)) {
        return { state: 'denied' }
      }
      return {
        state: 'unavailable',
        unavailableReason: 'capability_unavailable',
        detail: firstLine(outcome.stderr) || 'the accessibility probe did not answer',
      }
    },
  },
  screen_recording: {
    noProbeReason:
      'no command-line probe exists for the screen-recording TCC service in this lane; ' +
      'the native helper lands with the computer-use slice (issue #472)',
    classify: (): ProbeResult => ({
      state: 'unavailable',
      unavailableReason: 'capability_unavailable',
    }),
  },
  notifications: {
    noProbeReason:
      'the notification authorization is readable only through the app bundle’s own ' +
      'UNUserNotificationCenter, which this lane does not host yet',
    classify: (): ProbeResult => ({
      state: 'unavailable',
      unavailableReason: 'capability_unavailable',
    }),
  },
  automation_apple_events: {
    argv: ['/usr/bin/osascript', '-e', 'tell application "Finder" to get name'],
    noProbeReason: '',
    classify: (outcome: HostCommandOutcome): ProbeResult => {
      if (outcome.exitCode === 0) return { state: 'granted' }
      if (outcome.timedOut) {
        return { state: 'not_determined', detail: 'the macOS consent prompt is still open' }
      }
      if (APPLE_EVENTS_DENIED.test(outcome.stderr + outcome.stdout)) {
        return { state: 'denied' }
      }
      return {
        state: 'unavailable',
        unavailableReason: 'capability_unavailable',
        detail: firstLine(outcome.stderr) || 'the Apple Events probe did not answer',
      }
    },
  },
  microphone: {
    noProbeReason:
      'the microphone authorization is readable only through the app bundle’s own ' +
      'AVCaptureDevice APIs, which this lane does not host yet',
    classify: (): ProbeResult => ({
      state: 'unavailable',
      unavailableReason: 'capability_unavailable',
    }),
  },
})

function firstLine(text: string): string {
  const line = text.trim().split('\n', 1)[0] ?? ''
  return line.slice(0, 160)
}

/** Production runner: fixed argv, piped output, probe-deadline kill. */
export function createHostCommandRunner(defaults?: { timeoutMs?: number }): HostCommandRunner {
  const timeoutMs = defaults?.timeoutMs ?? PROBE_TIMEOUT_MS
  return async (argv) => {
    try {
      const proc = Bun.spawn([...argv], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      let killedByProbe = false
      const timer = setTimeout(() => {
        killedByProbe = true
        try {
          proc.kill()
        } catch {
          /* already exited */
        }
      }, timeoutMs)
      try {
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ])
        const exitCode = await proc.exited
        return {
          exitCode,
          stdout,
          stderr,
          timedOut: killedByProbe && exitCode !== 0,
          spawnFailed: false,
        }
      } finally {
        clearTimeout(timer)
      }
    } catch {
      return { exitCode: null, stdout: '', stderr: '', timedOut: false, spawnFailed: true }
    }
  }
}

export type MacPermissionService = Readonly<{
  snapshot(options?: Readonly<{ force?: boolean }>): Promise<MacPermissionsSnapshot>
  /** Validates the id against the frozen registry; never opens client URLs. */
  openSettings(permissionId: string): Promise<MacPermissionSettingsOpenResult>
  /** The fixed deep link the shell would open — exposed for tests and the page copy. */
  settingsUrl(permissionId: string): string
}>

/**
 * The shell-side permission authority. Snapshot probes are single-flight
 * (donor PermissionStatusRefreshCoordinator semantics): a second call while
 * one probe is in flight awaits the same run instead of stacking osascript
 * processes. `force` re-runs a completed probe set; a cached result is never
 * presented as fresh — every report carries its own probe time.
 */
export function createMacPermissionService(input: {
  run?: HostCommandRunner
  platform?: NodeJS.Platform
  now?: () => string
  /** Overrides SETTINGS_PANES only in tests. */
  panes?: Readonly<Record<MacPermissionId, string>>
  /** Deadline override for the production runner (tests script their own). */
  timeoutMs?: number
}): MacPermissionService {
  const run =
    input.run ??
    (input.timeoutMs
      ? createHostCommandRunner({ timeoutMs: input.timeoutMs })
      : createHostCommandRunner())
  const platform = input.platform ?? process.platform
  const now = input.now ?? (() => new Date().toISOString())
  const panes = input.panes ?? SETTINGS_PANES
  const isMac = platform === 'darwin'

  let inFlight: Promise<MacPermissionsSnapshot> | undefined

  async function probePermission(id: MacPermissionId): Promise<MacPermissionReport> {
    const probedAt = now()
    const probe = PROBES[id]
    if (!isMac) {
      return { id, state: 'unavailable', unavailableReason: 'unsupported_platform', probedAt }
    }
    if (!probe.argv) {
      return {
        id,
        state: 'unavailable',
        unavailableReason: 'capability_unavailable',
        probedAt,
      }
    }
    const outcome = await run(probe.argv)
    const classified = probe.classify(outcome)
    return {
      id,
      state: classified.state,
      ...(classified.unavailableReason ? { unavailableReason: classified.unavailableReason } : {}),
      probedAt,
    }
  }

  return Object.freeze({
    snapshot(options) {
      if (!options?.force && inFlight) return inFlight
      const runAll = (async () => {
        const reports = await Promise.all(macPermissionIds.map((id) => probePermission(id)))
        return {
          hostPlatform: isMac ? ('macos' as const) : ('other' as const),
          permissions: reports,
          probedAt: now(),
        } satisfies MacPermissionsSnapshot
      })()
      inFlight = runAll
      void runAll.then(
        () => {
          if (inFlight === runAll) inFlight = undefined
        },
        () => {
          if (inFlight === runAll) inFlight = undefined
        }
      )
      return runAll
    },
    async openSettings(permissionId) {
      if (!isMacPermissionId(permissionId)) throw new Error('unknown permission id')
      const settingsUrl = panes[permissionId]
      if (!settingsUrl) throw new Error('no settings pane is registered for this permission')
      const outcome = await run(['/usr/bin/open', settingsUrl])
      if (outcome.spawnFailed || (outcome.exitCode !== null && outcome.exitCode !== 0)) {
        throw new Error(
          `could not open System Settings (${firstLine(outcome.stderr) || 'opener failed'})`
        )
      }
      return { permissionId, settingsUrl }
    },
    settingsUrl(permissionId) {
      if (!isMacPermissionId(permissionId)) throw new Error('unknown permission id')
      const settingsUrl = panes[permissionId]
      if (!settingsUrl) throw new Error('no settings pane is registered for this permission')
      return settingsUrl
    },
  })
}
