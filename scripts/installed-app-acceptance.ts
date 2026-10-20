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

import { runInstalledAppUiRows } from './installed-app-ui-rows'

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
export function openAcceptanceLog(path: string): AcceptanceLog {
  const descriptor = openSync(path, 'w')
  let failures = 0
  let closed = false
  return {
    path,
    failures: () => failures,
    write(chunk: Buffer) {
      if (closed) {
        failures += 1
        return false
      }
      try {
        writeSync(descriptor, chunk)
        return true
      } catch {
        failures += 1
        return false
      }
    },
    close() {
      if (closed) return
      closed = true
      try {
        closeSync(descriptor)
      } catch {
        failures += 1
      }
    },
  }
}

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

type RunningApp = {
  /** The installed application's launcher process. */
  pid: number
  /** The installed application's log, as the launcher wrote it. */
  logPath: string
  /** The number of log writes that failed. */
  logWriteFailures: () => number
  /** Stops the installed application and closes its log descriptor. */
  stop(): void
}

/** Launches the installed application with the disposable profile. */
function launchInstalledApp(profile: AcceptanceProfile): RunningApp {
  const logPath = join(profile.root, 'installed-app.log')
  const launcher = join(profile.installedApp, 'Contents', 'MacOS', 'launcher')
  const log = openAcceptanceLog(logPath)
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
  let stopped = false
  return {
    pid: child.pid ?? -1,
    logPath,
    logWriteFailures: () => log.failures(),
    stop() {
      if (stopped) return
      stopped = true
      try {
        child.kill('SIGTERM')
      } catch {
        /* the process may already be gone */
      }
      log.close()
    },
  }
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
  /** Starts the installed application; returns the running application. */
  launch?: (profile: AcceptanceProfile) => RunningApp
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
    const label = check.status === 'pass' ? 'ok  ' : check.status === 'pending' ? 'PEND ' : 'FAIL'
    console.log(`${label} ${check.id}: ${check.actual}`)
  }
  const profile = dependencies.profile
  const launch = dependencies.launch ?? launchInstalledApp
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

  // 2. The installed application starts and serves its own bundled client.
  let running = launch(profile)
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
    const offLoopback = peers.filter(
      (peer) => !peer.startsWith('127.') && !peer.startsWith('[::1]') && !peer.startsWith('::1')
    )
    add(
      acceptanceRow({
        id: 'the-installed-application-traffic-stayed-on-the-loopback-interface',
        expected:
          'every TCP peer of the installed application is on the loopback interface, so no hosted provider was reached',
        actual:
          peers.length === 0
            ? 'the installed application held no connected TCP socket while it talked to its cloud'
            : `the installed application talked to ${peers.length} peer(s) while it reached its cloud; ${offLoopback.length} of them off the loopback interface`,
        status: offLoopback.length === 0 ? 'pass' : 'fail',
        evidence: 'installed-app',
      })
    )

    // 4b. The environment the installed application runs with names no Neon
    //     endpoint, so the application cannot reach one even by accident.
    const neonVariables = Object.entries(process.env).filter(
      ([name, value]) =>
        /neon/i.test(name) && typeof value === 'string' && /neon\.(tech|build|dev)/i.test(value)
    )
    add(
      acceptanceRow({
        id: 'the-acceptance-environment-names-no-neon-endpoint',
        expected:
          'no environment variable of the acceptance run names a Neon endpoint, so the installed application cannot fall back to one',
        actual:
          neonVariables.length === 0
            ? 'no Neon endpoint is configured in the acceptance environment'
            : `${neonVariables.length} Neon endpoint variable(s) are configured`,
        status: neonVariables.length === 0 ? 'pass' : 'fail',
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
  running.stop()
  await sleep(2_000)
  running = launch(profile)
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

  const logWriteFailures = running.logWriteFailures()
  running.stop()
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

  // The ONE application-support path this installation writes outside the
  // disposable directory. Its existence is recorded BEFORE the application
  // starts, and only this exact path is ever a removal candidate.
  const supportParent = join(homedir(), 'Library', 'Application Support', INSTALLED_APP_IDENTIFIER)
  const channel = readBundleChannel(resolve(bundle))
  const supportPath = resolveOwnedApplicationSupportPath({
    identifier: INSTALLED_APP_IDENTIFIER,
    channel,
  })
  const supportExistedBefore = existsSync(supportPath)

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

  // The application-support decision is made for exactly ONE path, from the
  // fact that the path did not exist before the run. No other entry under the
  // application identity is ever touched, and no before/after listing is used
  // to infer ownership.
  const cleanup = planApplicationSupportCleanup({
    path: supportPath,
    existedBefore: supportExistedBefore,
    expectedParent: supportParent,
  })
  if (cleanup.remove) {
    try {
      rmSync(supportPath, { force: true, recursive: true })
    } catch {
      cleanup.reason = 'the path this run created could not be removed'
    }
  }
  run.artifact.launchServices = {
    identifier: INSTALLED_APP_IDENTIFIER,
    installedCopy: redactRecordedText(profile.installedApp),
    competingCopies: (run.artifact.competingCopies as string[] | undefined) ?? [],
  }
  delete run.artifact.competingCopies
  run.artifact.applicationSupport = {
    root: redactRecordedText(supportParent),
    ownedPath: redactRecordedText(supportPath),
    existedBefore: supportExistedBefore,
    removedByThisRun: cleanup.remove,
    decision: cleanup.reason,
    otherEntriesTouched: false,
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
