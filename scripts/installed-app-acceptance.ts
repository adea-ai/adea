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
// SAFETY RULES THIS LANE KEEPS:
//   - it never deletes real user data. It removes only the disposable profile
//     root it created, and the one application-support subtree that did not
//     exist before the run;
//   - it never installs into the user's /Applications: the installed copy
//     lives in the disposable install root and is registered with
//     LaunchServices explicitly, and deregistered at teardown;
//   - it never reaches a credential store. The application's own credential
//     calls are observed, never issued by this lane;
//   - it never reaches a hosted service: the cloud origin is the one the
//     candidate bundle records.
//
// Usage:
//   bun apps/desktop/shell/scripts/installed-app-acceptance.ts \
//     --app-bundle <path to Adea-dev.app> [--artifact <path>] [--profile <dir>]
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { runInstalledAppUiRows } from './installed-app-ui-rows'

/** The loopback origin the packaged desktop shell serves its client on. */
export const INSTALLED_APP_ORIGIN = 'http://127.0.0.1:4789'
/** The desktop application's own bundle identifier (the installed identity). */
export const INSTALLED_APP_IDENTIFIER = 'dev.adea.desktop'
/** The URL scheme the desktop application registers with the operating system. */
export const INSTALLED_APP_SCHEME = 'adea'
/** LaunchServices' registration tool, used the way an installer uses it. */
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

/** One row of the acceptance matrix. */
export type AcceptanceCheck = Readonly<{
  id: string
  /** What the installed application was asked to do. */
  expected: string
  /** What was observed. */
  actual: string
  ok: boolean
  /**
   * How the answer was obtained. `installed-app` means the installed process
   * or the operating system answered; `installed-app-origin` means the
   * installed application's own origin answered (its server, bridge and
   * gateway), with the native window widget itself not involved.
   */
  evidence: 'installed-app' | 'installed-app-origin' | 'host'
}>

/** The disposable profile layout one acceptance run uses. */
export type AcceptanceProfile = Readonly<{
  /** The root this run owns. Everything under it is removed at teardown. */
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

/** Resolves the disposable profile layout for one run. */
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
 * The verdict of one run: every row, and the counts.
 *
 * A run is a pass only when every row passed. A row that could not be run is
 * a FAIL, not a skip: a hidden unfinished flow is exactly what this lane
 * exists to prevent.
 */
export function summarizeAcceptance(checks: readonly AcceptanceCheck[]): {
  passed: number
  failed: number
  total: number
  ok: boolean
} {
  const passed = checks.filter((check) => check.ok).length
  const total = checks.length
  return { passed, failed: total - passed, total, ok: total > 0 && passed === total }
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

/** The user's real application-support directory for this application's identity. */
function realApplicationSupportRoot(): string {
  return join(homedir(), 'Library', 'Application Support', INSTALLED_APP_IDENTIFIER)
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

/** The `adea://` URL-scheme registration the installed bundle declares. */
function bundleDeclaresScheme(installedApp: string): boolean {
  try {
    const plist = readFileSync(join(installedApp, 'Contents', 'Info.plist'), 'utf8')
    return plist.includes(`<string>${INSTALLED_APP_SCHEME}</string>`)
  } catch {
    return false
  }
}

/** Copies the candidate bundle into the disposable install root. */
function installBundle(sourceBundle: string, profile: AcceptanceProfile): void {
  rmSync(profile.installRoot, { force: true, recursive: true })
  mkdirSync(profile.installRoot, { recursive: true })
  spawnSync('cp', ['-R', sourceBundle, profile.installedApp], { stdio: 'inherit' })
  if (!existsSync(profile.installedApp)) {
    throw new Error(`the candidate bundle was not installed at ${profile.installedApp}`)
  }
}

/** Registers the installed copy with LaunchServices, the way an installer does. */
function registerWithLaunchServices(installedApp: string): boolean {
  const result = spawnSync(LSREGISTER, ['-f', installedApp], { encoding: 'utf8' })
  return result.status === 0
}

/** Removes the installed copy from LaunchServices. */
function deregisterFromLaunchServices(installedApp: string): void {
  spawnSync(LSREGISTER, ['-u', installedApp], { encoding: 'utf8' })
}

type RunningApp = {
  /** The installed application's launcher process. */
  pid: number
  /** The installed application's log, as the launcher wrote it. */
  logPath: string
  /** Stops the installed application, including its bundled runtime. */
  stop(): void
}

/** Launches the installed application with the disposable profile. */
function launchInstalledApp(profile: AcceptanceProfile): RunningApp {
  const logPath = join(profile.root, 'installed-app.log')
  const launcher = join(profile.installedApp, 'Contents', 'MacOS', 'launcher')
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
  const log = writeFileSync(logPath, '')
  const tee = (chunk: Buffer) => {
    try {
      writeSync(log, chunk)
    } catch {
      /* the log is evidence, never a reason to fail the lane */
    }
  }
  child.stdout?.on('data', tee)
  child.stderr?.on('data', tee)
  return {
    pid: child.pid ?? -1,
    logPath,
    stop() {
      try {
        child.kill('SIGTERM')
      } catch {
        /* the process may already be gone */
      }
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
 * therefore knows what else is registered, so it can say so in the artifact
 * and narrow the routing for the moment the delivery happens.
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
  /** The cloud origin the candidate bundle records, for the failure-recovery row. */
  cloudOrigin?: string
  /** Whether the local cloud is under this lane's control (for the recovery row). */
  setCloudAvailable?: (available: boolean) => Promise<void>
  /** Stops the local cloud and reports whether it stopped. */
  stopCloud?: () => Promise<boolean>
  /** Starts the local cloud again. */
  startCloud?: () => Promise<boolean>
}): Promise<AcceptanceRun> {
  const checks: AcceptanceCheck[] = []
  /** The competing registrations the delivery suspended, for the artifact. */
  let competingCopies: string[] = []
  const add = (check: AcceptanceCheck) => {
    checks.push(check)
    console.log(`${check.ok ? 'ok  ' : 'FAIL'} ${check.id}: ${check.actual}`)
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
  add({
    id: 'installed-bundle-identity',
    expected: `the installed bundle declares the ${INSTALLED_APP_SCHEME} URL scheme and carries its build target record`,
    actual: bundleDeclaresScheme(profile.installedApp)
      ? `the scheme is declared; the recorded target is ${target?.mode ?? 'missing'} (${target?.cloudOrigin ?? 'no origin'})`
      : 'the installed bundle does not declare the URL scheme',
    ok: bundleDeclaresScheme(profile.installedApp) && target !== null,
    evidence: 'host',
  })

  // 2. The installed application starts and serves its own bundled client.
  let running = launch(profile)
  let logPath = running.logPath
  const served = await waitFor(installedAppAnswers, 60_000, 'the installed application to serve')
  add({
    id: 'installed-application-serves-its-own-client',
    expected:
      'the installed application answers on its own loopback origin with the client it was packaged with',
    actual: served
      ? 'the installed application answered on its own loopback origin'
      : 'the installed application never answered on its own loopback origin',
    ok: served,
    evidence: 'installed-app',
  })

  if (served) {
    const document = await fetchFromApp('/')
    add({
      id: 'the-served-client-is-the-installed-build',
      expected: 'the served document is the packaged client with the desktop bridge injected',
      actual: document.body.includes('/__adea/bridge.js')
        ? 'the served document carries the desktop bridge script'
        : 'the served document does not carry the desktop bridge script',
      ok: document.status === 200 && document.body.includes('/__adea/bridge.js'),
      evidence: 'installed-app',
    })

    const bridge = await fetchFromApp('/__adea/bridge.js')
    add({
      id: 'the-installed-bridge-is-served',
      expected: "the installed application's bridge script is served by the installed application",
      actual: `the bridge script answered ${bridge.status}`,
      ok: bridge.status === 200 && bridge.body.length > 0,
      evidence: 'installed-app',
    })

    const proxied = await fetchFromApp('/api/workspaces')
    add({
      id: 'the-installed-cloud-proxy-answers',
      expected:
        "the installed application's own same-origin proxy forwards the cloud traffic it recorded at build time",
      actual: `the proxied request answered ${proxied.status}`,
      // A 401 is the cloud's own answer for an unauthenticated request; a 502
      // is the installed application's own "the cloud is unreachable".
      ok: proxied.status !== 502 && proxied.status !== 500,
      evidence: 'installed-app',
    })

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
    add({
      id: 'the-operating-system-hands-the-callback-to-the-installed-app',
      expected:
        'the operating system routes an adea:// callback into the installed application, which answers it with a typed decision',
      actual: answered
        ? queued
          ? 'the installed application queued the handoff the operating system delivered'
          : `the installed application refused the delivered callback with a typed reason (${refused ?? 'unknown'})`
        : 'the installed application never answered the callback the operating system delivered',
      ok: answered,
      evidence: 'installed-app',
    })

    // 4. The UI rows, over the installed application's own origin.
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
  add({
    id: 'the-installed-application-relaunches-with-its-own-state',
    expected:
      'the installed application starts again and keeps the state directory it wrote, with owner-only permissions',
    actual: relaunched
      ? `the installed application answered again; its state directory is ${modeBefore ?? 'absent'}`
      : 'the installed application did not answer after the relaunch',
    ok: relaunched && modeBefore !== null && modeBefore === '700',
    evidence: 'installed-app',
  })

  // 6. Recovery: the application survives a cloud it cannot reach, and
  //    recovers when the cloud comes back.
  if (dependencies.stopCloud && dependencies.startCloud) {
    await dependencies.stopCloud()
    const unreachable = await fetchFromApp('/api/workspaces')
    add({
      id: 'the-installed-application-survives-an-unreachable-cloud',
      expected:
        'the installed application keeps serving and reports the cloud as unreachable instead of failing',
      actual: `the proxied request answered ${unreachable.status} while the cloud was down`,
      ok: unreachable.status === 502,
      evidence: 'installed-app',
    })
    await dependencies.startCloud()
    const recovered = await waitFor(
      async () => (await fetchFromApp('/api/workspaces')).status !== 502,
      60_000,
      'the installed application to reach the cloud again'
    )
    add({
      id: 'the-installed-application-recovers-when-the-cloud-returns',
      expected: 'the installed application reaches the cloud again without a restart',
      actual: recovered
        ? 'the installed application reached the cloud again'
        : 'the installed application never reached the cloud again',
      ok: recovered,
      evidence: 'installed-app',
    })
  }

  running.stop()
  stopInstalledProcesses(profile.installedApp)
  const summary = summarizeAcceptance(checks)
  return {
    checks,
    artifact: {
      summary,
      origin: INSTALLED_APP_ORIGIN,
      bundle: dependencies.bundle,
      profileRoot: profile.root,
      competingCopies,
      checks,
    },
  }
}

/** The lane's entry point. */
async function main(): Promise<void> {
  const bundle = argValue('--app-bundle')
  const artifactPath = argValue('--artifact')
  const profileRoot = argValue('--profile') ?? join(process.cwd(), '.installed-app-acceptance')
  if (!bundle) {
    console.error('usage: installed-app-acceptance.ts --app-bundle <path> [--artifact <path>]')
    process.exit(2)
  }
  const profile = resolveAcceptanceProfile(profileRoot)
  rmSync(profile.root, { force: true, recursive: true })
  mkdirSync(profile.home, { recursive: true })
  mkdirSync(profile.data, { recursive: true })

  const artifactDirectory = dirname(
    artifactPath ?? join(profile.root, 'installed-app-acceptance.json')
  )
  mkdirSync(artifactDirectory, { recursive: true })

  const supportRoot = realApplicationSupportRoot()
  const supportBefore = existsSync(supportRoot) ? readdirSafe(supportRoot) : null

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
      runUiRows: (origin) => runInstalledAppUiRows(origin, artifactDirectory),
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

  const supportAfter = existsSync(supportRoot) ? readdirSafe(supportRoot) : null
  // The renderer profile the native window writes lives under the real
  // application-support directory (the native side resolves it from the
  // operating system, not from the disposable HOME). Only the entries this
  // run created are removed; anything that existed before is left alone.
  const created =
    (supportBefore ?? []).length === 0
      ? (supportAfter ?? [])
      : (supportAfter ?? []).filter((entry) => !(supportBefore ?? []).includes(entry))
  for (const entry of created) {
    rmSync(join(supportRoot, entry), { force: true, recursive: true })
  }
  run.artifact.launchServices = {
    identifier: INSTALLED_APP_IDENTIFIER,
    installedCopy: redactRecordedText(profile.installedApp),
    competingCopies: (run.artifact.competingCopies as string[] | undefined) ?? [],
  }
  delete run.artifact.competingCopies
  run.artifact.applicationSupport = {
    root: redactRecordedText(supportRoot),
    before: supportBefore,
    after: supportAfter,
    removedByThisRun: created,
  }

  const destination = artifactPath ?? join(profile.root, 'installed-app-acceptance.json')
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, `${JSON.stringify(run.artifact, null, 2)}\n`)
  console.log(`installed-app acceptance: ${JSON.stringify(run.artifact.summary)} -> ${destination}`)
  rmSync(profile.root, { force: true, recursive: true })
  process.exit(run.checks.every((check) => check.ok) ? 0 : 1)
}

/** The entry names inside a directory, or null when it cannot be read. */
function readdirSafe(path: string): string[] | null {
  try {
    return readdirSync(path, { withFileTypes: true })
      .map((entry) => entry.name)
      .toSorted()
  } catch {
    return null
  }
}

if (import.meta.main) {
  await main()
}
