// M10 #30: the supported local harness family registry.
//
// The closed supported-family table translates Orca's `src/shared/tui-agent.ts`
// shape (one closed registry of launchable coding agents) into a per-family
// detection/probe/eligibility spec, and carries Zeron's per-driver observation
// semantics (existence-only install probes, fixed-argv version probes, and
// existence-only auth markers that never read or modify native configuration).
//
// A family spec declares HOW to observe an installation; it never grants
// authority. Discovery distinguishes observation from enablement: a discovered
// installation is reported, never auto-enabled, and a missing/broken one is
// reported as a classified diagnostic instead of being silently dropped.
import type { HarnessProtocol } from './types'

export type HarnessFamilyId = 'claude-code' | 'codex' | 'opencode' | 'pi'

export type HarnessFamilySpec = Readonly<{
  family: HarnessFamilyId
  displayName: string
  /** Executable simple names tried inside every candidate directory. */
  executableNames: readonly string[]
  protocol: HarnessProtocol
  /** Adea-owned env override naming an explicit executable (tests, overrides). */
  envOverride: string
  /** HOME-relative directories probed after PATH (last-resort install spots). */
  homeRelativePaths: readonly string[]
  /** Fixed absolute directories probed last. */
  absolutePaths: readonly string[]
  /** Fixed version-probe argv appended after the executable path. */
  versionArgv: readonly string[]
  /**
   * HOME-relative existence-only auth markers. Presence classifies
   * `auth: 'ready'`, absence `auth: 'required'`; the contents are never read.
   * An empty list classifies `auth: 'unknown'` unless a vault reference says
   * otherwise.
   */
  authMarkers: readonly string[]
  /** Declared capabilities implied by protocol and driver support. */
  capabilities: readonly string[]
  /** Session operations the family is known to support once connected. */
  sessionOperations: readonly string[]
  entitlementHints: readonly string[]
  limitations: readonly string[]
  /** Capabilities that must be present for the connection to be eligible. */
  requiredCapabilities: readonly string[]
  /** Inclusive minimum supported version; unset accepts every parseable one. */
  minimumVersion?: string
}>

// Capability names are stable strings, not authority: launch-time revalidation
// rechecks everything it depends on. `native`/`acp`/`pty` mirror the protocol.
const NATIVE_SESSION_OPERATIONS = ['session.new', 'session.resume'] as const

export const harnessFamilySpecs: readonly HarnessFamilySpec[] = [
  {
    family: 'claude-code',
    displayName: 'Claude Code',
    executableNames: ['claude'],
    protocol: 'native',
    envOverride: 'ADEA_HARNESS_CLAUDE_CODE_EXECUTABLE',
    homeRelativePaths: ['.claude/local', '.local/bin'],
    absolutePaths: ['/opt/homebrew/bin', '/usr/local/bin'],
    versionArgv: ['--version'],
    authMarkers: ['.claude/.credentials.json'],
    capabilities: ['native', 'models', 'slash_commands', 'resume'],
    sessionOperations: [...NATIVE_SESSION_OPERATIONS, 'session.list'],
    entitlementHints: ['user_managed', 'native_auth'],
    limitations: ['history_is_native_not_adea'],
    requiredCapabilities: ['native'],
  },
  {
    family: 'codex',
    displayName: 'Codex',
    executableNames: ['codex'],
    protocol: 'native',
    envOverride: 'ADEA_HARNESS_CODEX_EXECUTABLE',
    homeRelativePaths: ['.local/bin'],
    absolutePaths: ['/opt/homebrew/bin', '/usr/local/bin'],
    versionArgv: ['--version'],
    authMarkers: ['.codex/auth.json'],
    capabilities: ['native', 'models', 'resume'],
    sessionOperations: [...NATIVE_SESSION_OPERATIONS],
    entitlementHints: ['user_managed', 'native_auth'],
    limitations: ['history_is_native_not_adea'],
    requiredCapabilities: ['native'],
  },
  {
    family: 'opencode',
    displayName: 'OpenCode',
    executableNames: ['opencode'],
    protocol: 'native',
    envOverride: 'ADEA_HARNESS_OPENCODE_EXECUTABLE',
    homeRelativePaths: ['.local/bin'],
    absolutePaths: ['/opt/homebrew/bin', '/usr/local/bin'],
    versionArgv: ['--version'],
    authMarkers: ['.local/share/opencode/auth.json'],
    capabilities: ['native', 'models', 'slash_commands', 'resume'],
    sessionOperations: [...NATIVE_SESSION_OPERATIONS, 'session.list'],
    entitlementHints: ['user_managed', 'native_auth'],
    limitations: ['history_is_native_not_adea'],
    requiredCapabilities: ['native'],
  },
  {
    family: 'pi',
    displayName: 'Pi',
    executableNames: ['pi'],
    protocol: 'native',
    envOverride: 'ADEA_HARNESS_PI_EXECUTABLE',
    homeRelativePaths: ['.local/bin'],
    absolutePaths: ['/opt/homebrew/bin', '/usr/local/bin'],
    versionArgv: ['--version'],
    // Agent HQ-managed Pi lifecycle (M10 #31) owns managed-installation
    // provenance and managed auth markers; user-managed detection here stays
    // marker-free so it never claims a native auth state it did not observe.
    authMarkers: [],
    capabilities: ['native', 'models', 'resume'],
    sessionOperations: [...NATIVE_SESSION_OPERATIONS],
    entitlementHints: ['user_managed'],
    limitations: ['history_is_native_not_adea', 'managed_lifecycle_owned_by_m10_31'],
    requiredCapabilities: ['native'],
  },
]

export function harnessFamilySpec(family: string): HarnessFamilySpec | undefined {
  return harnessFamilySpecs.find((spec) => spec.family === family)
}
