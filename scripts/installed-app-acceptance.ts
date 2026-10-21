// The installed-desktop acceptance lane.
//
// What this lane is: a HOST-SIDE driver for the INSTALLED macOS application.
// It installs the candidate bundle into a disposable install root, registers
// it with LaunchServices the way an installer does, launches the installed
// application with a disposable profile, and then exercises the application
// through the surfaces the installed application itself owns:
//
//   - the application's own loopback server, serving the client build that
//     was packaged INTO the installed bundle;
//   - the application's own bridge and gateway surface (`/__adea/*`);
//   - the application's own same-origin cloud proxy (`/api/*`);
//   - the operating system's own `adea://` URL handoff into the installed
//     application;
//   - the application's own process lifecycle (start, restart after an
//     interrupted run, relaunch with its state intact).
//
// What this lane is NOT: a source-level test, and not a browser-only test.
// Every row below is answered by the installed process, over the installed
// bundle's own server, or by the operating system's own URL routing. The one
// surface this lane cannot drive is the application's own WINDOW WIDGET: the
// macOS bundle renders through the native (WKWebView) renderer, which exposes
// no programmatic channel, and driving a native window needs an accessibility
// grant this environment does not have. The UI rows therefore run against the
// installed application's own origin, through the installed application's own
// bridge and gateway, and each row records which of the two it is.
//
// SAFETY RULES THIS LANE KEEPS, and how each one is enforced:
//   - it never deletes a path it did not create. The run's directory is a
//     UNIQUELY created child of a caller-named PARENT, and it carries an
//     ownership marker; the teardown removes it only when that marker still
//     matches this run. A caller-named path is never a removal target, and
//     two runs never share a directory;
//   - the artifact is written OUTSIDE the directory the teardown removes, so
//     the evidence of a run always outlives the run;
//   - it never deletes unrelated application-support data. Exactly ONE path is
//     even a candidate for removal: the renderer's own profile directory for
//     this application's identity AND channel, and only when that exact path
//     did not exist before the run. Nothing is inferred from a before/after
//     listing, and no other entry is ever touched;
//   - it never installs into the user's /Applications: the installed copy
//     lives in the disposable install root and is registered with
//     LaunchServices explicitly, and deregistered at teardown;
//   - it never reaches a credential store. The application's own credential
//     calls are observed, never issued by this lane;
//   - it never reaches a hosted service: the cloud origin is the one the
//     candidate bundle records.
//
// Usage:
//   bun scripts/installed-app-acceptance.ts --app-bundle <path to Adea-dev.app> \
//     [--artifact <path>] [--profile-parent <dir>]
//
// `--profile-parent` names the PARENT directory the run creates its unique
// directory in. The parent is never removed, and the run never writes into it
// outside the unique directory it creates.
import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import { INSTALLED_APP_UI_ROW_IDS, runInstalledAppUiRows } from './installed-app-ui-rows'

/** The loopback origin the packaged desktop shell serves its client on. */
export const INSTALLED_APP_ORIGIN = 'http://127.0.0.1:4789'
/** The desktop application's own bundle identifier (the installed identity). */
export const INSTALLED_APP_IDENTIFIER = 'dev.adea.desktop'
/** The URL scheme the desktop application registers with the operating system. */
export const INSTALLED_APP_SCHEME = 'adea'
/** The ownership marker file every directory this lane creates carries. */
export const ACCEPTANCE_OWNER_MARKER = '.adea-acceptance-owner'
/** LaunchServices' registration tool, used the way an installer uses it. */
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

/**
 * The outcome of one matrix row.
 *
 * `pending` is NOT a pass: it means the row could not be verified with the
 * authority this run has, and it keeps the run's verdict red. A hidden
 * unfinished flow is exactly what this lane exists to prevent.
 */
export type AcceptanceStatus = 'pass' | 'fail' | 'pending'

/** One row of the acceptance matrix. */
export type AcceptanceCheck = Readonly<{
  id: string
  /** What the installed application was asked to do. */
  expected: string
  /** What was observed. */
  actual: string
  /** Whether the row held. */
  ok: boolean
  /** The row's outcome; `pending` is never a pass. */
  status: AcceptanceStatus
  /**
   * How the answer was obtained. `installed-app` means the installed process
   * or the operating system answered; `installed-app-origin` means the
   * installed application's own origin answered (its server, bridge and
   * gateway), with the native window widget itself not involved.
   */
  evidence: 'installed-app' | 'installed-app-origin' | 'host'
}>

/** Builds a row, deriving `ok` from the status. */
export function acceptanceRow(
  row: Omit<AcceptanceCheck, 'ok'> & { ok?: boolean }
): AcceptanceCheck {
  const status = row.status ?? (row.ok === false ? 'fail' : 'pass')
  return { ...row, status, ok: status === 'pass' }
}

/** The disposable profile layout one acceptance run uses. */
export type AcceptanceProfile = Readonly<{
  /** The unique directory this run owns. Everything under it is removed at teardown. */
  root: string
  /** The disposable HOME the installed application is launched with. */
  home: string
  /** The disposable application data directory. */
  data: string
  /** The disposable install root the bundle is copied into. */
  installRoot: string
  /** The installed application bundle, inside the disposable install root. */
  installedApp: string
}>

/** Resolves the disposable profile layout for one run's own directory. */
export function resolveAcceptanceProfile(
  root: string,
  appName = 'Adea-dev.app'
): AcceptanceProfile {
  const base = resolve(root)
  return {
    root: base,
    home: join(base, 'home'),
    data: join(base, 'data'),
    installRoot: join(base, 'Applications'),
    installedApp: join(base, 'Applications', appName),
  }
}

/**
 * A directory this run created, and the token that proves it owns it.
 *
 * The directory is created UNIQUE (the operating system guarantees the name
 * is not in use), so two runs never share it and a caller-named path is never
 * a removal target. The token is written into the directory as an ownership
 * marker; the teardown refuses to remove a directory whose marker does not
 * match.
 */
export type DisposableRoot = Readonly<{
  /** The unique directory this run created. */
  path: string
  /** The token that proves this run owns the directory. */
  token: string
  /** The marker file inside the directory. */
  markerPath: string
  /** The parent the unique directory was created in. */
  parent: string
}>

/**
 * Creates the unique directory one run owns.
 *
 * The caller names a PARENT. The parent is only used as the place the unique
 * child is created in; it is never created, never written into and never
 * removed. The unique child carries the ownership marker.
 */
export function createDisposableRoot(
  options: {
    parent?: string
    prefix?: string
    token?: string
  } = {}
): DisposableRoot {
  const parent = resolve(options.parent ?? tmpdir())
  mkdirSync(parent, { recursive: true })
  const path = mkdtempSync(join(parent, options.prefix ?? 'adea-acceptance-'))
  const token = options.token ?? randomUUID()
  const markerPath = join(path, ACCEPTANCE_OWNER_MARKER)
  writeFileSync(markerPath, `${token}\n`, { mode: 0o600 })
  return { path, token, markerPath, parent }
}

/** The outcome of a teardown attempt. */
export type RootRemoval = Readonly<{ removed: boolean; reason: string }>

/**
 * Removes a directory this run created, and nothing else.
 *
 * The directory is removed only when its ownership marker still carries this
 * run's token. A directory without a marker, with a different marker, or one
 * that is not inside the parent it was created in, is left exactly as it is.
 */
export function removeOwnedRoot(root: DisposableRoot): RootRemoval {
  let marker: string
  try {
    marker = readFileSync(root.markerPath, 'utf8').trim()
  } catch {
    return { removed: false, reason: 'the directory carries no ownership marker' }
  }
  if (marker !== root.token) {
    return { removed: false, reason: 'the directory carries another run’s ownership marker' }
  }
  if (resolve(root.path) === resolve(root.parent)) {
    return { removed: false, reason: 'the directory is the parent itself' }
  }
  if (!resolve(root.path).startsWith(resolve(root.parent) + '/')) {
    return { removed: false, reason: 'the directory is outside the parent it was created in' }
  }
  try {
    rmSync(root.path, { force: true, recursive: true })
  } catch {
    return { removed: false, reason: 'the directory could not be removed' }
  }
  return { removed: true, reason: 'the directory this run created was removed' }
}

/**
 * The renderer's own profile directory for this application's identity and
 * channel — the ONE path outside the disposable directory that the installed
 * application writes to.
 */
export function resolveOwnedApplicationSupportPath(options: {
  identifier?: string
  channel?: string
  home?: string
}): string {
  const identifier = options.identifier ?? INSTALLED_APP_IDENTIFIER
  const channel = options.channel ?? 'dev'
  return join(options.home ?? homedir(), 'Library', 'Application Support', identifier, channel)
}

/** The outcome of the application-support cleanup decision. */
export type ApplicationSupportCleanup = Readonly<{ remove: boolean; reason: string }>

/**
 * Decides whether ONE application-support path may be removed.
 *
 * The decision never infers ownership from a before/after listing. A path is
 * removable only when it is the exact expected path for this application's
 * identity and channel, and that exact path did not exist before the run. A
 * path that existed before belongs to the operator and is never touched.
 */
export function planApplicationSupportCleanup(input: {
  path: string
  existedBefore: boolean
  expectedParent: string
}): ApplicationSupportCleanup {
  if (input.existedBefore) {
    return { remove: false, reason: 'the path existed before this run and is not this run’s' }
  }
  if (!resolve(input.path).startsWith(resolve(input.expectedParent) + '/')) {
    return { remove: false, reason: 'the path is outside the application identity directory' }
  }
  return {
    remove: true,
    reason: 'the exact path this run’s installation writes did not exist before the run',
  }
}

/**
 * The verdict of one run: every row, and the counts.
 *
 * A run is a pass only when every row is `pass`. A row that failed and a row
 * that could not be verified are both counted as not-passed: a hidden
 * unfinished flow is exactly what this lane exists to prevent.
 */
export function summarizeAcceptance(checks: readonly AcceptanceCheck[]): {
  passed: number
  failed: number
  pending: number
  total: number
  ok: boolean
} {
  const passed = checks.filter((check) => check.status === 'pass').length
  const pending = checks.filter((check) => check.status === 'pending').length
  const failed = checks.filter((check) => check.status === 'fail').length
  const total = checks.length
  return { passed, failed, pending, total, ok: total > 0 && passed === total }
}

/**
 * Removes anything that could carry a secret or a machine path from a
 * recorded string. The artifact is published, so it may not carry a token, a
 * credential, an account or the operator's home directory.
 */
export function redactRecordedText(text: string, home = homedir()): string {
  let output = text
  if (home) output = output.split(home).join('~')
  output = output.replace(/adea_tmp_[A-Za-z0-9_-]+/g, 'adea_tmp_<redacted>')
  output = output.replace(
    /\b(?:token|secret|password|code|verifier|challenge|credential)[=:]\s*"?[A-Za-z0-9._~+/=-]{8,}"?/gi,
    '$1=<redacted>'
  )
  output = output.replace(/\/(?:private\/)?tmp\/[^\s"']+/g, '/tmp/<redacted>')
  return output
}

/**
 * The run's log file, with an EXPLICIT file-descriptor lifecycle.
 *
 * The descriptor is opened when the application starts and closed when the
 * application stops. A write that fails is COUNTED and reported in the
 * artifact; it is never swallowed, because a silent log is a silent gap in
 * the evidence.
 */
export type AcceptanceLog = Readonly<{
  path: string
  /** The number of writes that failed. */
  failures: () => number
  /** Writes a chunk; returns false when the write failed. */
  write: (chunk: Buffer) => boolean
  /** Closes the descriptor. Safe to call more than once. */
  close: () => void
}>

/** Opens the run's log file with an explicit descriptor lifecycle. */
export function openAcceptanceLog(path: string, ledger?: LogFailureLedger): AcceptanceLog {
  const descriptor = openSync(path, 'w')
  let failures = 0
  let closed = false
  const record = () => {
    failures += 1
    ledger?.record()
  }
  return {
    path,
    failures: () => failures,
    write(chunk: Buffer) {
      if (closed) {
        // A write that arrives after the descriptor closed is still a failure
        // of this run's evidence, and it is counted.
        record()
        return false
      }
      try {
        writeSync(descriptor, chunk)
        return true
      } catch {
        record()
        return false
      }
    },
    close() {
      if (closed) return
      closed = true
      try {
        closeSync(descriptor)
      } catch {
        record()
      }
    },
  }
}

/**
 * The ledger of log-write failures across a whole run.
 *
 * A run launches the application more than once and each launch owns its own
 * descriptor. A failure in ANY launch — including a write that arrives after
 * that launch's descriptor was closed — belongs to the run's evidence, so the
 * failures are counted in one ledger that outlives every launch. A failure
 * that is merely recorded and then discarded is a silent gap in the evidence.
 */
export type LogFailureLedger = Readonly<{
  /** The number of failed writes across every launch of the run. */
  count: () => number
  /** Records one failed write. */
  record: () => void
}>

/**
 * The verdict of the run's own logging.
 *
 * A run whose evidence could not be written is not a pass: the failure count
 * decides the row, and a failure in ANY launch — including a write that
 * arrived after that launch's descriptor was closed — counts.
 */
export function assessLogCompleteness(
  failures: number,
  launches: number
): {
  status: AcceptanceStatus
  actual: string
} {
  if (failures > 0) {
    return {
      status: 'fail',
      actual: `${failures} log write failure(s) across ${launches} launch(es)`,
    }
  }
  return {
    status: 'pass',
    actual: `${launches} launch(es) were logged with no write failure`,
  }
}

/** Creates the run's log-failure ledger. */
export function createLogFailureLedger(): LogFailureLedger {
  let failures = 0
  return {
    count: () => failures,
    record: () => {
      failures += 1
    },
  }
}

/**
 * What the lane knows about where the native renderer will write.
 *
 * `isolated` is true only when the native profile root is OUTSIDE the real
 * user's Application Support directory. Anything else is a write into the
 * operator's own profile, and the lane must not perform it.
 */
export type NativeProfileIsolation = Readonly<{
  /** Whether the run's native profile root is isolated from the real user's profile. */
  isolated: boolean
  /** The exact contract that would be needed to isolate it, when it is not. */
  missing: string | null
  /** Where the native profile would be written. */
  profilePath: string
}>

/**
 * The evidence a run offers about its native profile isolation.
 *
 * The evidence is a CONTRACT the repository recognises, plus the environment
 * the run would use. A label, a channel name or a path somebody computed is
 * not evidence: none of them is checked against anything the native side
 * honours.
 */
export type IsolationEvidence = Readonly<{
  /** The native profile root the run would use. */
  profilePath: string
  /** The real user's Application Support root for this application's identity. */
  realRoot: string
  /** The contract the caller claims is in force, when it claims one. */
  claimed?: Readonly<{
    /** The contract's identifier. */
    id: string
    /** The environment the run would use. */
    environment: Readonly<Record<string, string | undefined>>
  }>
}>

/**
 * A supported contract that can establish that a run's native profile root
 * is outside the real user's Application Support directory.
 */
export type SupportedIsolationContract = Readonly<{
  /** The contract's identifier, as the supported contract names it. */
  id: string
  /**
   * Whether the contract is in force for this run, and the profile root it
   * establishes. A contract that is not in force establishes nothing.
   */
  inForce: (evidence: IsolationEvidence) => {
    inForce: boolean
    profilePath: string | null
  }
}>

/**
 * The supported native profile isolation contracts.
 *
 * The registry is **EMPTY on purpose**. The Electrobun native core resolves
 * the CEF profile root from the real user's home — the disposable `HOME` the
 * lane sets does not move it — and the devkit exposes no per-run
 * Application Support root (only `ELECTROBUN_INSTALL_ROOT_NAME`,
 * `ELECTROBUN_LAUNCHER_PID` and the Linux `XDG_*` variables). There is
 * therefore no contract this lane could validate, and the assessor fails
 * closed.
 *
 * When a supported per-run native profile contract lands, it is registered
 * here with the check that proves it is in force, and the assessor starts
 * honouring it — and only then.
 */
export const SUPPORTED_ISOLATION_CONTRACTS: readonly SupportedIsolationContract[] = []

/**
 * Decides whether the lane may launch the installed application at all.
 *
 * The lane launches only when a SUPPORTED contract is in force and the profile
 * root it establishes is outside the real user's Application Support
 * directory. Everything else fails closed:
 *
 *   - a claim that names a contract the repository does not support is
 *     refused — a descriptive label is not evidence;
 *   - a profile path outside the real root is not evidence by itself,
 *     because nothing proves the native side would use it.
 *
 * The exact missing contract is reported so the record says what would be
 * needed, instead of asserting an isolation nobody proved.
 */
export function assessNativeProfileIsolation(evidence: IsolationEvidence): NativeProfileIsolation {
  const profilePath = resolve(evidence.profilePath)
  const claimed = evidence.claimed
  const contract = claimed
    ? SUPPORTED_ISOLATION_CONTRACTS.find((entry) => entry.id === claimed.id)
    : undefined
  if (!contract) {
    return {
      isolated: false,
      missing: claimed
        ? `the claimed isolation contract "${claimed.id}" is not a supported native profile isolation contract; a label, a bundle channel or a computed path is not evidence`
        : "no supported native profile isolation contract is in force; the native renderer resolves its profile root from the real user home and the devkit exposes no per-run root, so launching writes into the operator's own Application Support directory",
      profilePath,
    }
  }
  const state = contract.inForce(evidence)
  if (!state.inForce || !state.profilePath) {
    return {
      isolated: false,
      missing: `the supported isolation contract "${contract.id}" is not in force for this run`,
      profilePath,
    }
  }
  const established = resolve(state.profilePath)
  const realRoot = resolve(evidence.realRoot)
  if (established === realRoot || established.startsWith(realRoot + '/')) {
    return {
      isolated: false,
      missing: `the supported isolation contract "${contract.id}" resolved a profile root inside the real user's Application Support directory`,
      profilePath: established,
    }
  }
  return { isolated: true, missing: null, profilePath: established }
}

/**
 * The evidence a run would offer about its native profile.
 *
 * It is read from the bundle's own identity, and reading it touches nothing:
 * the bundle is read, never copied, and the real user's profile is never
 * opened.
 */
export function isolationEvidenceForBundle(bundle: string, home = homedir()): IsolationEvidence {
  const identifier = readBundleIdentifier(bundle) ?? INSTALLED_APP_IDENTIFIER
  const channel = readBundleChannel(bundle)
  const realRoot = join(home, 'Library', 'Application Support', identifier)
  return {
    profilePath: resolveOwnedApplicationSupportPath({ identifier, channel, home }),
    realRoot,
  }
}

/**
 * The side effects a run performs, recorded for the evidence.
 *
 * The preflight records nothing: it exists so that a test can prove the
 * preflight performs none.
 */
export type RunSideEffects = Readonly<{
  /** Records one side effect. */
  record: (event: 'install' | 'register' | 'launch' | 'profile-touch') => void
}>

/**
 * The truthful result of a run that cannot launch.
 *
 * It is produced WITHOUT copying the bundle, WITHOUT registering it with
 * LaunchServices, WITHOUT launching anything and WITHOUT touching the real
 * user's profile: the decision to refuse comes first, and the evidence says
 * exactly which rows are unproved and why.
 */
export type PreflightRun = {
  checks: AcceptanceCheck[]
  artifact: Record<string, unknown>
}

/**
 * The side-effect-free preflight.
 *
 * It answers one question — may this run launch? — and records the truthful
 * pending evidence when the answer is no. It performs no install, no
 * registration, no launch and no profile access.
 */
export async function runInstalledAppPreflight(dependencies: {
  bundle: string
  evidence: IsolationEvidence
  /** Records side effects; the preflight records none. */
  sideEffects?: RunSideEffects
}): Promise<PreflightRun> {
  const isolation = assessNativeProfileIsolation(dependencies.evidence)
  const checks: AcceptanceCheck[] = []
  const add = (check: AcceptanceCheck) => {
    checks.push(check)
  }
  const target = readBuildTarget(dependencies.bundle)
  const scheme = bundleDeclaresScheme(dependencies.bundle)
  add(
    acceptanceRow({
      id: 'installed-bundle-identity',
      expected: `the installed bundle declares the ${INSTALLED_APP_SCHEME} URL scheme and carries its build target record`,
      actual: scheme
        ? `the scheme is declared; the recorded target is ${target?.mode ?? 'missing'} (${target?.cloudOrigin ?? 'no origin'})`
        : 'the bundle does not declare the URL scheme',
      status: scheme && target !== null ? 'pass' : 'fail',
      evidence: 'host',
    })
  )
  for (const row of launchDependentRows(isolation.missing ?? 'the isolation contract is unknown')) {
    add(row)
  }
  const summary = summarizeAcceptance(checks)
  return {
    checks,
    artifact: {
      summary,
      origin: INSTALLED_APP_ORIGIN,
      bundle: redactRecordedText(dependencies.bundle),
      isolation: {
        isolated: isolation.isolated,
        missing: isolation.missing,
        profilePath: redactRecordedText(isolation.profilePath),
      },
      installed: false,
      registered: false,
      launched: false,
      sideEffects: [],
      checks,
    },
  }
}

/**
 * The verdict of a socket observation.
 *
 * An empty observation is NOT a pass: no peer was seen, so the traffic was
 * not observed at all, and the row stays unproved.
 */
export function assessSocketObservation(peers: readonly string[]): {
  status: AcceptanceStatus
  actual: string
} {
  if (peers.length === 0) {
    return {
      status: 'pending',
      actual:
        'the socket discovery returned no peer, so the traffic was not observed and the row stays unproved',
    }
  }
  const offLoopback = peers.filter(
    (peer) => !peer.startsWith('127.') && !peer.startsWith('[::1]') && !peer.startsWith('::1')
  )
  if (offLoopback.length > 0) {
    return {
      status: 'fail',
      actual: `${offLoopback.length} of ${peers.length} peer(s) were off the loopback interface`,
    }
  }
  return {
    status: 'pass',
    actual: `the installed application talked to ${peers.length} peer(s), all on the loopback interface`,
  }
}

/**
 * What the acceptance environment says about a hosted provider.
 *
 * Two INDEPENDENT observations: the NAMES of variables that mention a Neon
 * identifier, and the NAMES of variables whose VALUE names a Neon host — a
 * `DATABASE_URL` that points at a Neon host is caught by the second check
 * even though its name says nothing about Neon. Only names are reported: a
 * value may carry a credential, and the artifact is published.
 */
export type ProviderEnvironmentFinding = Readonly<{
  /** The names of variables that mention a Neon identifier. */
  neonIdentifiers: readonly string[]
  /** The names of variables whose value names a Neon host. */
  neonHostVariables: readonly string[]
  /** Whether the environment names no Neon endpoint at all. */
  clean: boolean
}>

/** A host name that belongs to a hosted Neon endpoint. */
const NEON_HOST = /(^|[^a-z0-9-])([a-z0-9-]+\.)*neon\.(tech|build|dev|sh|aws|windows)\b/i

/** Inspects an environment for hosted Neon endpoints, by name and by value. */
export function inspectProviderEnvironment(
  environment: Record<string, string | undefined> = process.env
): ProviderEnvironmentFinding {
  const neonIdentifiers: string[] = []
  const neonHostVariables: string[] = []
  for (const [name, value] of Object.entries(environment)) {
    if (typeof value !== 'string') continue
    if (/neon/i.test(name)) neonIdentifiers.push(name)
    if (NEON_HOST.test(value)) neonHostVariables.push(name)
  }
  neonIdentifiers.sort()
  neonHostVariables.sort()
  return {
    neonIdentifiers,
    neonHostVariables,
    clean: neonIdentifiers.length === 0 && neonHostVariables.length === 0,
  }
}

/** The rows that need the installed application to be running. */
export const LAUNCH_DEPENDENT_ROW_IDS = [
  'installed-application-serves-its-own-client',
  'the-served-client-is-the-installed-build',
  'the-installed-bridge-is-served',
  'the-installed-cloud-proxy-answers',
  'the-operating-system-hands-the-callback-to-the-installed-app',
  'the-installed-application-traffic-stayed-on-the-loopback-interface',
  'the-installed-application-relaunches-with-its-own-state',
  'the-run-log-recorded-everything',
  'the-installed-application-survives-an-unreachable-cloud',
  'the-installed-application-recovers-when-the-cloud-returns',
] as const

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve_) => setTimeout(resolve_, ms))
}

async function waitFor(
  probe: () => Promise<boolean>,
  timeoutMs: number,
  label: string
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await probe()) return true
    } catch {
      /* the probe is expected to fail while the application is starting */
    }
    await sleep(500)
  }
  console.error(`installed-app acceptance: timed out waiting for ${label}`)
  return false
}

/** The mode of a directory, as the two low bits the owner cares about. */
function directoryMode(path: string): string | null {
  try {
    return (statSync(path).mode & 0o777).toString(8).padStart(3, '0')
  } catch {
    return null
  }
}

/** The bundle's own recorded build target (the cloud origin it was built for). */
function readBuildTarget(installedApp: string): { mode?: string; cloudOrigin?: string } | null {
  try {
    const text = readFileSync(
      join(installedApp, 'Contents', 'Resources', 'app', 'client', 'adea-desktop-target.json'),
      'utf8'
    )
    return JSON.parse(text) as { mode?: string; cloudOrigin?: string }
  } catch {
    return null
  }
}

/** The identifier the installed bundle carries. */
function readBundleIdentifier(appBundle: string): string | null {
  try {
    const identity = JSON.parse(
      readFileSync(join(appBundle, 'Contents', 'Resources', 'version.json'), 'utf8')
    ) as { identifier?: unknown }
    return typeof identity.identifier === 'string' ? identity.identifier : null
  } catch {
    return null
  }
}

/** The channel the installed bundle was built for. */
function readBundleChannel(installedApp: string): string {
  try {
    const identity = JSON.parse(
      readFileSync(join(installedApp, 'Contents', 'Resources', 'version.json'), 'utf8')
    ) as { channel?: unknown }
    return typeof identity.channel === 'string' ? identity.channel : 'dev'
  } catch {
    return 'dev'
  }
}

/** The `adea://` URL-scheme registration the installed bundle declares. */
function bundleDeclaresScheme(installedApp: string): boolean {
  try {
    const plist = readFileSync(join(installedApp, 'Contents', 'Info.plist'), 'utf8')
    return plist.includes(`<string>${INSTALLED_APP_SCHEME}</string>`)
  } catch {
    return false
  }
}

/**
 * Copies the candidate bundle into the disposable install root.
 *
 * The copy is made with `ditto`, the tool macOS itself uses to copy an
 * application bundle: it preserves the bundle's extended attributes, so the
 * bundle's code signature still matches its contents. A plain copy breaks the
 * sealed resources, and the operating system then refuses to route a URL to
 * the copy. The bundle is never re-signed.
 *
 * The install root is inside the run's own directory, which the run created
 * and owns; nothing outside it is removed.
 */
function installBundle(sourceBundle: string, profile: AcceptanceProfile): void {
  mkdirSync(profile.installRoot, { recursive: true })
  const copied = spawnSync('/usr/bin/ditto', [sourceBundle, profile.installedApp], {
    stdio: 'inherit',
  })
  if (copied.status !== 0 || !existsSync(profile.installedApp)) {
    throw new Error(`the candidate bundle was not installed at ${profile.installedApp}`)
  }
}

/**
 * The TCP peers the installed application's own processes are talking to.
 *
 * Every peer of a connected socket, as `lsof` reports it. A listening socket
 * has no peer and is not one.
 */
function installedApplicationPeers(installedApp: string): string[] {
  const pids = (
    spawnSync('/usr/bin/pgrep', ['-f', installedApp], { encoding: 'utf8' }).stdout ?? ''
  )
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (pids.length === 0) return []
  const listing = spawnSync('/usr/sbin/lsof', ['-nP', '-iTCP', '-a', '-p', ...pids], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  }).stdout
  if (typeof listing !== 'string') return []
  const peers: string[] = []
  for (const line of listing.split('\n').slice(1)) {
    if (line.includes('(LISTEN)')) continue
    const peer = line.split(/->\s*/)[1]?.trim()
    if (peer) peers.push(peer)
  }
  return [...new Set(peers)].toSorted()
}

/** Registers the installed copy with LaunchServices, the way an installer does. */
function registerWithLaunchServices(installedApp: string): boolean {
  const result = spawnSync(LSREGISTER, ['-f', installedApp], { encoding: 'utf8' })
  return result.status === 0
}

/** Removes the installed copy from LaunchServices. */
function deregisterFromLaunchServices(installedApp: string): void {
  spawnSync(LSREGISTER, ['-u', installedApp], { stdio: 'ignore' })
}

export type RunningApp = {
  /** The installed application's launcher process. */
  pid: number
  /** The installed application's log, as the launcher wrote it. */
  logPath: string
  /** The number of log writes that failed. */
  logWriteFailures: () => number
  /** The problems the finalization recorded: a teardown that did not complete. */
  teardownProblems?: () => readonly string[]
  /**
   * Stops the installed application, lets its output drain, and closes its
   * log descriptor.
   *
   * The call is AWAITABLE and resolves only when the process has gone, its
   * trailing output has been accounted for, and the descriptor is closed. A
   * verdict that is taken before it resolves can miss the final close failure
   * and the last bytes the process wrote.
   */
  stop(): Promise<void>
}

/** Launches the installed application with the disposable profile. */
function launchInstalledApp(
  profile: AcceptanceProfile,
  ledger: LogFailureLedger,
  index: number
): RunningApp {
  // One log file per launch: a second launch must not truncate the first
  // launch's evidence.
  const logPath = join(profile.root, `installed-app-${index}.log`)
  const launcher = join(profile.installedApp, 'Contents', 'MacOS', 'launcher')
  const log = openAcceptanceLog(logPath, ledger)
  const child = spawn(launcher, [], {
    cwd: profile.root,
    env: {
      ...process.env,
      HOME: profile.home,
      ADEA_DATA_DIR: profile.data,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  })
  const tee = (chunk: Buffer) => {
    log.write(chunk)
  }
  child.stdout?.on('data', tee)
  child.stderr?.on('data', tee)
  const stopper = createFinalizingStop({
    signal: () => {
      try {
        child.kill('SIGTERM')
      } catch {
        /* the process may already be gone */
      }
    },
    exit: child,
    streams: [child.stdout, child.stderr],
    close: () => log.close(),
    ledger,
  })
  return {
    pid: child.pid ?? -1,
    logPath,
    logWriteFailures: () => ledger.count(),
    teardownProblems: () => stopper.problems(),
    stop: () => stopper.stop(),
  }
}

/**
 * The probe that reports whether the application process has gone.
 *
 * It is a structural type, so a test can inject a process that never exits.
 */
export type ProcessExitProbe = {
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  once(event: string, listener: () => void): unknown
  off(event: string, listener: () => void): unknown
}

/**
 * The probe for one output stream of the application.
 *
 * It is a structural type, so a test can inject a stream that never ends.
 */
export type OutputStreamProbe = {
  once(event: string, listener: () => void): unknown
  removeListener?(event: string, listener: () => void): unknown
  readonly destroyed?: boolean
  readonly readableEnded?: boolean
}

/**
 * What one teardown step achieved, and what it could not achieve.
 *
 * A timeout is a FAILURE of the teardown, never a successful wait: a process
 * that did not exit, or a stream that did not end, may still produce output
 * after the log descriptor is closed.
 */
export type TeardownOutcome = Readonly<{
  /** Whether the step completed. */
  completed: boolean
  /** The fixed reasons the step did not complete. */
  problems: readonly string[]
}>

/**
 * Waits for the application process to go, bounded.
 *
 * The bound keeps a stuck process from hanging the run — and the bound is a
 * FAILURE, not a success: the outcome says the process was not observed to
 * exit, so the caller can record it before the verdict is taken.
 */
export async function waitForProcessExit(
  probe: ProcessExitProbe,
  timeoutMs = 10_000
): Promise<TeardownOutcome> {
  if (probe.exitCode !== null || probe.signalCode !== null) {
    return { completed: true, problems: [] }
  }
  return new Promise<TeardownOutcome>((resolve_) => {
    const finish = (completed: boolean, problem?: string) => {
      clearTimeout(timer)
      probe.off('exit', onExit)
      resolve_({
        completed,
        problems: problem === undefined ? [] : [problem],
      })
    }
    const onExit = () => finish(true)
    const timer = setTimeout(
      () => finish(false, `the application process did not exit within ${timeoutMs}ms`),
      timeoutMs
    )
    probe.once('exit', onExit)
  })
}

/**
 * Waits for the application's output streams to end, bounded.
 *
 * The trailing bytes a process writes as it goes down are part of the
 * evidence, so the drain is awaited before the descriptor is closed — and
 * only a CONFIRMED readable end counts as a successful drain.
 *
 * A stream that is destroyed before it ended, a stream that closes before it
 * ended, a stream that fails, and a stream that does not end within the
 * bound are all FAILURES of the teardown: in each of them the trailing bytes
 * may have been discarded, so the run may not record a clean verdict. The
 * failure reasons are fixed and carry no stream text, so a path, a value or
 * an error message cannot reach the artifact.
 */
export async function drainOutputStreams(
  streams: readonly (OutputStreamProbe | null | undefined)[],
  timeoutMs = 5_000
): Promise<TeardownOutcome> {
  const problems: string[] = []
  await Promise.all(
    streams.map(
      (stream, index) =>
        new Promise<void>((resolve_) => {
          if (!stream) {
            resolve_()
            return
          }
          // A stream that has already ended is drained.
          if (stream.readableEnded === true) {
            resolve_()
            return
          }
          // A stream that is already destroyed and never ended is a failed
          // drain: its trailing bytes were discarded.
          if (stream.destroyed === true) {
            problems.push(`the application's output stream ${index} was destroyed before it ended`)
            resolve_()
            return
          }
          const finish = (problem?: string) => {
            clearTimeout(timer)
            stream.removeListener?.('end', onEnd)
            stream.removeListener?.('close', onClose)
            stream.removeListener?.('error', onError)
            if (problem !== undefined) problems.push(problem)
            resolve_()
          }
          const onEnd = () => finish()
          const onClose = () =>
            finish(`the application's output stream ${index} closed before it ended`)
          // The stream's own failure is recorded as a fixed reason; the error
          // itself is never carried into the artifact.
          const onError = () =>
            finish(`the application's output stream ${index} failed while draining`)
          const timer = setTimeout(
            () =>
              finish(`the application's output stream ${index} did not end within ${timeoutMs}ms`),
            timeoutMs
          )
          stream.once('end', onEnd)
          stream.once('close', onClose)
          stream.once('error', onError)
        })
    )
  )
  return { completed: problems.length === 0, problems: problems.toSorted() }
}

/**
 * The dependencies of one launch's finalization.
 *
 * Everything is injected, so the teardown's behaviour — including its
 * timeouts — can be exercised without an application.
 */
export type FinalizingStopDependencies = {
  /** Signals the application to stop. */
  signal: () => void
  /** The probe that reports whether the application exited. */
  exit: ProcessExitProbe
  /** The application's output streams. */
  streams: readonly (OutputStreamProbe | null | undefined)[]
  /** Closes the application's log descriptor. */
  close: () => void
  /** The ledger the teardown failures are recorded in. */
  ledger: LogFailureLedger
  /** The bounds of the two waits, in milliseconds. */
  bounds?: { exit?: number; drain?: number }
}

/**
 * One launch's finalization.
 *
 * `stop()` is idempotent AND shared: repeated and concurrent callers await
 * the SAME in-flight finalization, so the descriptor is closed once and the
 * teardown's failures are recorded once.
 */
export type FinalizingStop = {
  /** Stops the launch; repeated and concurrent callers await the same work. */
  stop: () => Promise<void>
  /** The problems the finalization recorded. */
  problems: () => readonly string[]
}

/**
 * Creates one launch's finalization.
 *
 * The order is fixed: signal, wait for the exit, drain the output, close the
 * descriptor, and record whatever did not complete. A teardown that did not
 * complete is a failure of the run's evidence — output may still arrive after
 * the descriptor is closed — and it is recorded before the verdict is taken.
 */
export function createFinalizingStop(dependencies: FinalizingStopDependencies): FinalizingStop {
  const problems: string[] = []
  let inFlight: Promise<void> | undefined
  return {
    stop() {
      inFlight ??= (async () => {
        try {
          dependencies.signal()
        } catch {
          /* the process may already be gone */
        }
        const exit = await waitForProcessExit(dependencies.exit, dependencies.bounds?.exit)
        const drain = await drainOutputStreams(dependencies.streams, dependencies.bounds?.drain)
        dependencies.close()
        for (const problem of [...exit.problems, ...drain.problems]) {
          problems.push(problem)
          dependencies.ledger.record()
        }
      })()
      return inFlight
    },
    problems: () => problems,
  }
}

/**
 * Finalizes EVERY launch and only then decides the verdict.
 *
 * Each launch is stopped, drained and closed — and the ledger is snapshotted
 * AFTER every one of them is finished. A verdict taken earlier could miss the
 * final close failure and the trailing output of the last launch.
 */
export async function finalizeAndAssessLaunches(
  launches: readonly RunningApp[],
  ledger: LogFailureLedger
): Promise<{
  failures: number
  completeness: { status: AcceptanceStatus; actual: string }
}> {
  for (const app of launches) {
    try {
      await app.stop()
    } catch {
      // A stop that fails means the launch's output may never have been
      // written in full: that is a failure of the run's evidence, and it is
      // counted before the verdict is taken.
      ledger.record()
    }
  }
  const failures = ledger.count()
  return { failures, completeness: assessLogCompleteness(failures, launches.length) }
}

/**
 * The installed copies of one bundle identifier that LaunchServices knows.
 *
 * The operating system routes a URL to ONE registered copy of the
 * application. When several copies are registered — a stale build output of
 * another lane, for instance — the delivery is ambiguous, and a callback
 * aimed at this lane's installation can land in another copy. The lane
 * therefore knows what else is registered, so it can say so in the artifact.
 */
function registeredCopiesOf(identifier: string): string[] {
  const dump = spawnSync(LSREGISTER, ['-dump'], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  }).stdout
  if (typeof dump !== 'string') return []
  const paths: string[] = []
  for (const block of dump.split(/^bundle id:/m).slice(1)) {
    if (!new RegExp(`identifier:\\s+${identifier}\\b`).test(block)) continue
    // The dump appends the record's id in parentheses: "path: /a/b.app (0x1)".
    const match = /^path:\s+(.+?)\s+\(0x[0-9a-f]+\)$/m.exec(block)
    if (match) paths.push(match[1])
  }
  return [...new Set(paths)]
}

/**
 * Stops every process that belongs to the disposable install root.
 *
 * The scope is the disposable path, never the bundle identifier: another
 * installation of the same application on this machine is not this lane's to
 * stop.
 */
function stopInstalledProcesses(installedApp: string): void {
  spawnSync('/usr/bin/pkill', ['-f', installedApp], { stdio: 'ignore' })
}

/** Fetches a path from the installed application's own origin. */
async function fetchFromInstalledApp(path: string): Promise<{ status: number; body: string }> {
  const response = await fetch(`${INSTALLED_APP_ORIGIN}${path}`, {
    headers: {
      // The same-origin headers a browser sends for the installed
      // application's own pages. The application's channel surface trusts a
      // request by its origin, so a request without it is (correctly)
      // refused with 403.
      origin: INSTALLED_APP_ORIGIN,
      referer: `${INSTALLED_APP_ORIGIN}/`,
      'sec-fetch-dest': 'document',
      'sec-fetch-site': 'same-origin',
    },
  })
  return { status: response.status, body: await response.text() }
}

/** Whether the installed application's own origin answers. */
async function installedAppAnswers(): Promise<boolean> {
  const response = await fetch(`${INSTALLED_APP_ORIGIN}/`, { signal: AbortSignal.timeout(5_000) })
  return response.ok
}

/**
 * The rows that need the installed application to be running, as pending rows.
 *
 * Each keeps its own expectation, so the record says what was NOT proved and
 * why, instead of silently dropping the row.
 */
export function launchDependentRows(missing: string): AcceptanceCheck[] {
  const expectations: Record<string, string> = {
    'installed-application-serves-its-own-client':
      'the installed application answers on its own loopback origin with the client it was packaged with',
    'the-served-client-is-the-installed-build':
      'the served document is the packaged client with the desktop bridge injected',
    'the-installed-bridge-is-served':
      "the installed application's bridge script is served by the installed application",
    'the-installed-cloud-proxy-answers':
      "the installed application's own same-origin proxy forwards to the cloud it recorded",
    'the-operating-system-hands-the-callback-to-the-installed-app':
      'the operating system routes an adea:// callback into the installed application, which answers it with a typed decision',
    'the-installed-application-traffic-stayed-on-the-loopback-interface':
      'every TCP peer of the installed application is on the loopback interface',
    'the-installed-application-relaunches-with-its-own-state':
      'the installed application starts again and keeps its state directory, owner-only',
    'the-run-log-recorded-everything':
      "every launch of the installed application wrote its output to the run's own log, with no failed write",
    'the-installed-application-survives-an-unreachable-cloud':
      'the installed application keeps serving and reports the cloud as unreachable instead of failing',
    'the-installed-application-recovers-when-the-cloud-returns':
      'the installed application reaches the cloud again without a restart',
  }
  return [
    ...LAUNCH_DEPENDENT_ROW_IDS.map((id) =>
      acceptanceRow({
        id,
        expected: expectations[id] ?? 'the installed application does the thing',
        actual: `not launched: ${missing}`,
        status: 'pending',
        evidence: 'installed-app',
      })
    ),
    ...INSTALLED_APP_UI_ROW_IDS.map((id) =>
      acceptanceRow({
        id,
        expected: 'the client the installed application serves renders this flow',
        actual: `not launched: ${missing}`,
        status: 'pending',
        evidence: 'installed-app-origin',
      })
    ),
  ]
}

export type AcceptanceRun = {
  checks: AcceptanceCheck[]
  artifact: Record<string, unknown>
}

/**
 * Runs the installed-application acceptance lane.
 *
 * Every dependency the lane needs is injected, so the decision logic can be
 * exercised without an installed application, a browser, or an operating
 * system. The default dependencies are the real ones.
 */
export async function runInstalledAppAcceptance(dependencies: {
  bundle: string
  profile: AcceptanceProfile
  /**
   * The evidence about the run's native profile isolation. The lane computes
   * the decision from it through the supported-contract registry; an injected
   * decision is not accepted, because a decision is not evidence.
   */
  isolationEvidence?: IsolationEvidence
  /** Starts the installed application; returns the running application. */
  launch?: (profile: AcceptanceProfile, ledger: LogFailureLedger, index: number) => RunningApp
  /** Fetches a path from the installed application's origin. */
  fetchFromApp?: (path: string) => Promise<{ status: number; body: string }>
  /** Hands an `adea://` URL to the operating system. */
  openUrl?: (url: string) => void
  /** Runs the UI rows against the installed application's origin. */
  runUiRows?: (origin: string) => Promise<AcceptanceCheck[]>
  /** Stops the local cloud and reports whether it stopped. */
  stopCloud?: () => Promise<boolean>
  /** Starts the local cloud again. */
  startCloud?: () => Promise<boolean>
}): Promise<AcceptanceRun> {
  const checks: AcceptanceCheck[] = []
  /** The competing registrations the delivery recorded, for the artifact. */
  let competingCopies: string[] = []
  const add = (check: AcceptanceCheck) => {
    checks.push(check)
    // The row log is this lane's own report, not a test runner's verdict. A
    // line that opens with the bare token `FAIL` is read as a failing test by
    // every CI log scanner, and these rows are printed while the lane's own
    // tests run — so the status is namespaced and spelled with the same
    // vocabulary the artifact uses, and no line can be mistaken for a verdict.
    console.log(
      `installed-app acceptance: row ${check.status.padEnd(7)} ${check.id}: ${check.actual}`
    )
  }
  const profile = dependencies.profile
  // One ledger for the whole run: every launch reports its failures here, and
  // a failure anywhere in the run affects the verdict.
  const ledger = createLogFailureLedger()
  let launches = 0
  const launch =
    dependencies.launch ??
    ((nextProfile: AcceptanceProfile, nextLedger: LogFailureLedger, index: number) =>
      launchInstalledApp(nextProfile, nextLedger, index))
  const fetchFromApp = dependencies.fetchFromApp ?? fetchFromInstalledApp
  const openUrl =
    dependencies.openUrl ??
    ((url: string) => {
      // The installed copy is named explicitly: the operating system must
      // route the callback into THIS installation, not into another
      // registration of the same scheme.
      spawnSync('open', ['-a', profile.installedApp, url], { stdio: 'ignore' })
    })

  // 1. The installed bundle's own identity.
  const target = readBuildTarget(profile.installedApp)
  add(
    acceptanceRow({
      id: 'installed-bundle-identity',
      expected: `the installed bundle declares the ${INSTALLED_APP_SCHEME} URL scheme and carries its build target record`,
      actual: bundleDeclaresScheme(profile.installedApp)
        ? `the scheme is declared; the recorded target is ${target?.mode ?? 'missing'} (${target?.cloudOrigin ?? 'no origin'})`
        : 'the installed bundle does not declare the URL scheme',
      status: bundleDeclaresScheme(profile.installedApp) && target !== null ? 'pass' : 'fail',
      evidence: 'host',
    })
  )

  // 2. The launch gate.
  //
  // Launching the installed application makes the native renderer write its
  // profile into the REAL user's Application Support directory: the
  // disposable HOME the lane sets does not move that path, and the devkit
  // exposes no per-run root. A path that did not exist before the run proves
  // nothing — a real installation can create or use it concurrently — so the
  // lane does not launch on that basis. Without a proved isolation route the
  // lane records every row that needs the running application as PENDING, with
  // the exact contract that is missing, and touches nothing.
  const isolation = assessNativeProfileIsolation(
    dependencies.isolationEvidence ?? isolationEvidenceForBundle(profile.installedApp)
  )
  if (!isolation.isolated) {
    const pending = launchDependentRows(isolation.missing ?? 'the isolation contract is unknown')
    for (const row of pending) add(row)
    const summary = summarizeAcceptance(checks)
    return {
      checks,
      artifact: {
        summary,
        origin: INSTALLED_APP_ORIGIN,
        bundle: redactRecordedText(dependencies.bundle),
        profileRoot: redactRecordedText(profile.root),
        competingCopies,
        isolation: {
          isolated: isolation.isolated,
          missing: isolation.missing,
          profilePath: redactRecordedText(isolation.profilePath),
        },
        launched: false,
        checks,
      },
    }
  }

  // 3. The installed application starts and serves its own bundled client.
  let running = launch(profile, ledger, ++launches)
  // Every launch is kept, so that EVERY one of them can be finalized — and
  // the ledger snapshotted — before the verdict is taken.
  const allLaunches: RunningApp[] = [running]
  let logPath = running.logPath
  const served = await waitFor(installedAppAnswers, 60_000, 'the installed application to serve')
  add(
    acceptanceRow({
      id: 'installed-application-serves-its-own-client',
      expected:
        'the installed application answers on its own loopback origin with the client it was packaged with',
      actual: served
        ? 'the installed application answered on its own loopback origin'
        : 'the installed application never answered on its own loopback origin',
      status: served ? 'pass' : 'fail',
      evidence: 'installed-app',
    })
  )

  if (served) {
    const document = await fetchFromApp('/')
    add(
      acceptanceRow({
        id: 'the-served-client-is-the-installed-build',
        expected: 'the served document is the packaged client with the desktop bridge injected',
        actual: document.body.includes('/__adea/bridge.js')
          ? 'the served document carries the desktop bridge script'
          : 'the served document does not carry the desktop bridge script',
        status:
          document.status === 200 && document.body.includes('/__adea/bridge.js') ? 'pass' : 'fail',
        evidence: 'installed-app',
      })
    )

    const bridge = await fetchFromApp('/__adea/bridge.js')
    add(
      acceptanceRow({
        id: 'the-installed-bridge-is-served',
        expected:
          "the installed application's bridge script is served by the installed application",
        actual: `the bridge script answered ${bridge.status}`,
        status: bridge.status === 200 && bridge.body.length > 0 ? 'pass' : 'fail',
        evidence: 'installed-app',
      })
    )

    const proxied = await fetchFromApp('/api/workspaces')
    add(
      acceptanceRow({
        id: 'the-installed-cloud-proxy-answers',
        expected:
          "the installed application's own same-origin proxy forwards the cloud traffic it recorded at build time",
        actual: `the proxied request answered ${proxied.status}`,
        // A 401 is the cloud's own answer for an unauthenticated request; a 502
        // is the installed application's own "the cloud is unreachable".
        status: proxied.status !== 502 && proxied.status !== 500 ? 'pass' : 'fail',
        evidence: 'installed-app',
      })
    )

    // 3. The operating system's own `adea://` handoff into the installed app.
    const marker = `acceptanceMarker${Date.now()}`
    const callbackUrl = `${INSTALLED_APP_SCHEME}://auth/callback?code=${marker}&state=${marker}&nonce=${marker}`
    // The delivery names the installed copy explicitly, so the operating
    // system routes the URL into THIS installation rather than into another
    // registration of the same scheme. The competing registrations are only
    // RECORDED here: they are never deregistered, because a registration this
    // lane does not own belongs to another lane's build output.
    const competing = registeredCopiesOf(INSTALLED_APP_IDENTIFIER).filter(
      (path) => path !== profile.installedApp && path.endsWith('.app')
    )
    registerWithLaunchServices(profile.installedApp)
    openUrl(callbackUrl)
    const callbackFile = join(profile.data, 'desktop-state', 'auth-callback.json')
    // The observable is the installed application's OWN answer to the
    // operating system's delivery: either it queues the handoff, or it
    // refuses it with a typed reason. Both prove the operating system routed
    // the URL into the installed application.
    const answered = await waitFor(
      async () => {
        if (existsSync(callbackFile)) return true
        const log = readFileSync(logPath, 'utf8')
        return (
          log.includes('queued the adea://auth/callback handoff') ||
          log.includes('refused an adea://auth/callback')
        )
      },
      30_000,
      'the operating system to hand the callback to the installed application'
    )
    const log = readFileSync(logPath, 'utf8')
    competingCopies = competing.map((path) => redactRecordedText(path))
    const queued = log.includes('queued the adea://auth/callback handoff')
    const refused = /refused an adea:\/\/auth\/callback \(([^)]*)\)/.exec(log)?.[1] ?? null
    add(
      acceptanceRow({
        id: 'the-operating-system-hands-the-callback-to-the-installed-app',
        expected:
          'the operating system routes an adea:// callback into the installed application, which answers it with a typed decision',
        actual: answered
          ? queued
            ? 'the installed application queued the handoff the operating system delivered'
            : `the installed application refused the delivered callback with a typed reason (${refused ?? 'unknown'})`
          : 'the installed application never answered the callback the operating system delivered',
        status: answered ? 'pass' : 'fail',
        evidence: 'installed-app',
      })
    )

    // 4a. The installed application's traffic never left the loopback
    //     interface. This is the no-provider proof for this lane: the
    //     installed application had no hosted endpoint to reach, and none of
    //     its sockets left the machine.
    // The sample is taken while the installed application is talking to its
    // cloud, so the row is evidence of the traffic it actually makes rather
    // than an empty snapshot of an idle application.
    const inFlight = fetch(`${INSTALLED_APP_ORIGIN}/api/workspaces`, {
      signal: AbortSignal.timeout(20_000),
    }).catch(() => undefined)
    await sleep(500)
    const peers = installedApplicationPeers(profile.installedApp)
    await inFlight
    const observation = assessSocketObservation(peers)
    add(
      acceptanceRow({
        id: 'the-installed-application-traffic-stayed-on-the-loopback-interface',
        expected:
          'every TCP peer of the installed application is on the loopback interface, so no hosted provider was reached',
        actual: observation.actual,
        status: observation.status,
        evidence: 'installed-app',
      })
    )

    // 4b. The environment the installed application runs with names no Neon
    //     endpoint, so the application cannot reach one even by accident.
    const provider = inspectProviderEnvironment(process.env)
    add(
      acceptanceRow({
        id: 'the-acceptance-environment-names-no-neon-endpoint',
        expected:
          'no environment variable of the acceptance run names a Neon identifier, and no environment value names a Neon host, so the installed application cannot fall back to one',
        actual: provider.clean
          ? 'no Neon identifier and no Neon host are configured in the acceptance environment'
          : `the environment names ${provider.neonIdentifiers.length} Neon identifier(s) and ${provider.neonHostVariables.length} variable(s) whose value names a Neon host (${[
              ...provider.neonIdentifiers,
              ...provider.neonHostVariables,
            ]
              .filter((name, index, all) => all.indexOf(name) === index)
              .join(', ')})`,
        status: provider.clean ? 'pass' : 'fail',
        evidence: 'host',
      })
    )

    // 4c. The UI rows, over the installed application's own origin.
    if (dependencies.runUiRows) {
      const uiRows = await dependencies.runUiRows(INSTALLED_APP_ORIGIN)
      for (const row of uiRows) add(row)
    }
  }

  // 5. The application's own state survives a relaunch.
  const stateDirectory = join(profile.data, 'dev-runtime')
  const modeBefore = directoryMode(stateDirectory)
  await running.stop()
  await sleep(2_000)
  running = launch(profile, ledger, ++launches)
  allLaunches.push(running)
  const relaunched = await waitFor(
    installedAppAnswers,
    60_000,
    'the installed application to relaunch'
  )
  add(
    acceptanceRow({
      id: 'the-installed-application-relaunches-with-its-own-state',
      expected:
        'the installed application starts again and keeps the state directory it wrote, with owner-only permissions',
      actual: relaunched
        ? `the installed application answered again; its state directory is ${modeBefore ?? 'absent'}`
        : 'the installed application did not answer after the relaunch',
      status: relaunched && modeBefore === '700' ? 'pass' : 'fail',
      evidence: 'installed-app',
    })
  )

  // 6. Recovery: the application survives a cloud it cannot reach, and
  //    recovers when the cloud comes back.
  if (dependencies.stopCloud && dependencies.startCloud) {
    await dependencies.stopCloud()
    const unreachable = await fetchFromApp('/api/workspaces')
    add(
      acceptanceRow({
        id: 'the-installed-application-survives-an-unreachable-cloud',
        expected:
          'the installed application keeps serving and reports the cloud as unreachable instead of failing',
        actual: `the proxied request answered ${unreachable.status} while the cloud was down`,
        status: unreachable.status === 502 ? 'pass' : 'fail',
        evidence: 'installed-app',
      })
    )
    await dependencies.startCloud()
    const recovered = await waitFor(
      async () => (await fetchFromApp('/api/workspaces')).status !== 502,
      60_000,
      'the installed application to reach the cloud again'
    )
    add(
      acceptanceRow({
        id: 'the-installed-application-recovers-when-the-cloud-returns',
        expected: 'the installed application reaches the cloud again without a restart',
        actual: recovered
          ? 'the installed application reached the cloud again'
          : 'the installed application never reached the cloud again',
        status: recovered ? 'pass' : 'fail',
        evidence: 'installed-app',
      })
    )
  }

  // EVERY launch is finalized — stopped, drained, and its log descriptor
  // closed — BEFORE the ledger is snapshotted and the verdict is taken. A
  // verdict taken earlier could miss the final close failure and the trailing
  // output of the last launch, and would record a pass the evidence does not
  // support.
  const finalized = await finalizeAndAssessLaunches(allLaunches, ledger)
  const logWriteFailures = finalized.failures
  const completeness = finalized.completeness
  const teardownProblems = allLaunches.flatMap((app) => app.teardownProblems?.() ?? [])
  add(
    acceptanceRow({
      id: 'the-run-log-recorded-everything',
      expected:
        "every launch of the installed application wrote its output to the run's own log, with no failed write",
      actual: completeness.actual,
      status: completeness.status,
      evidence: 'installed-app',
    })
  )
  stopInstalledProcesses(profile.installedApp)
  const summary = summarizeAcceptance(checks)
  return {
    checks,
    artifact: {
      summary,
      origin: INSTALLED_APP_ORIGIN,
      // The published artifact may not carry a machine path.
      bundle: redactRecordedText(dependencies.bundle),
      profileRoot: redactRecordedText(profile.root),
      competingCopies,
      logWriteFailures,
      teardownProblems,
      checks,
    },
  }
}

/**
 * The artifact path a run uses when the caller names none.
 *
 * It is OUTSIDE the run's own directory, so the teardown that removes the
 * directory never removes the evidence the run produced.
 */
export function defaultArtifactPath(root: DisposableRoot): string {
  return join(root.parent, `${basename(root.path)}-installed-app-acceptance.json`)
}

/** The lane's entry point. */
async function main(): Promise<void> {
  const bundle = argValue('--app-bundle')
  const artifactPath = argValue('--artifact')
  const profileParent = argValue('--profile-parent') ?? tmpdir()
  if (!bundle) {
    console.error(
      'usage: installed-app-acceptance.ts --app-bundle <path> [--artifact <path>] [--profile-parent <dir>]'
    )
    process.exit(2)
  }

  // The DECISION comes first, and it is side-effect free: the preflight reads
  // the bundle's own identity and touches nothing else. Before this point
  // the lane has NOT copied the bundle, NOT registered it with
  // LaunchServices, NOT launched anything and NOT touched the real user's
  // profile.
  const evidence = isolationEvidenceForBundle(resolve(bundle))
  const isolation = assessNativeProfileIsolation(evidence)
  if (!isolation.isolated) {
    const preflight = await runInstalledAppPreflight({ bundle: resolve(bundle), evidence })
    const destination =
      artifactPath ??
      join(profileParent, `adea-acceptance-preflight-${randomUUID().slice(0, 8)}.json`)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, `${JSON.stringify(preflight.artifact, null, 2)}\n`)
    console.error(
      `installed-app acceptance: ${isolation.missing}; the application is NOT installed, NOT registered and NOT launched, and every row that needs it stays pending`
    )
    console.log(
      `installed-app acceptance: ${JSON.stringify(preflight.artifact.summary)} -> ${destination}`
    )
    process.exit(1)
  }

  // The run creates its OWN unique directory inside the caller-named parent.
  // The parent is never removed, and the run never writes into it outside the
  // directory it created.
  const root = createDisposableRoot({ parent: profileParent })
  const profile = resolveAcceptanceProfile(root.path)
  mkdirSync(profile.home, { recursive: true })
  mkdirSync(profile.data, { recursive: true })

  // The artifact lives OUTSIDE the directory the teardown removes, so the
  // evidence of a run always outlives the run.
  const destination = artifactPath ?? defaultArtifactPath(root)
  mkdirSync(dirname(destination), { recursive: true })

  const supportParent = evidence.realRoot
  const supportPath = evidence.profilePath

  installBundle(resolve(bundle), profile)
  const registered = registerWithLaunchServices(profile.installedApp)
  console.log(
    `installed-app acceptance: installed ${profile.installedApp}; LaunchServices registration ${registered ? 'succeeded' : 'failed'}`
  )

  const stopCloudCommand = argValue('--cloud-stop-command')
  const startCloudCommand = argValue('--cloud-start-command')

  let run: AcceptanceRun
  try {
    run = await runInstalledAppAcceptance({
      bundle: resolve(bundle),
      profile,
      isolationEvidence: evidence,
      runUiRows: (origin) => runInstalledAppUiRows(origin, dirname(destination)),
      ...(stopCloudCommand
        ? {
            stopCloud: async () => {
              spawnSync('/bin/sh', ['-c', stopCloudCommand], { stdio: 'ignore' })
              return true
            },
          }
        : {}),
      ...(startCloudCommand
        ? {
            startCloud: async () => {
              spawnSync('/bin/sh', ['-c', startCloudCommand], { stdio: 'ignore' })
              return true
            },
          }
        : {}),
    })
  } finally {
    stopInstalledProcesses(profile.installedApp)
    deregisterFromLaunchServices(profile.installedApp)
  }

  // Nothing under the real user's Application Support directory is written,
  // marked or removed by this lane — not before the run, not after it, and
  // not on the basis of what the directory looked like at any point. The only
  // directory the lane removes is the unique one it created and owns.
  run.artifact.launchServices = {
    identifier: INSTALLED_APP_IDENTIFIER,
    installedCopy: redactRecordedText(profile.installedApp),
    competingCopies: (run.artifact.competingCopies as string[] | undefined) ?? [],
  }
  delete run.artifact.competingCopies
  run.artifact.applicationSupport = {
    root: redactRecordedText(supportParent),
    nativeProfilePath: redactRecordedText(supportPath),
    touchedByThisRun: false,
    decision:
      'the lane writes, marks and removes nothing under the real user Application Support directory; the only directory it removes is the unique one it created and owns',
  }

  writeFileSync(destination, `${JSON.stringify(run.artifact, null, 2)}\n`)
  console.log(`installed-app acceptance: ${JSON.stringify(run.artifact.summary)} -> ${destination}`)

  // The teardown removes exactly the directory this run created, and only
  // when its ownership marker still matches.
  const removal = removeOwnedRoot(root)
  console.log(`installed-app acceptance: ${removal.reason}`)
  process.exit(run.checks.every((check) => check.status === 'pass') ? 0 : 1)
}

if (import.meta.main) {
  await main()
}
