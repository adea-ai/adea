// Packaged supervision smoke (M10 #185/#34): proves the supervision engine's
// rules against REAL processes on the packaged app path — the same lane the
// terminal PTY smoke uses (repository-pinned Bun, macOS-gated).
//
// Five proofs, each one an acceptance behavior of `docs/specs/dev-runtime.md`
// ("Local stack supervision"):
//   0. install-location resolution (packaged mode) — every packaged
//      component's manifest label resolves to a real bundled artifact inside
//      the .app (containment + existence + SHA-256 digest), the sidecar
//      command is built from the bundled layout: the packaged sidecar entry
//      executed by the bundled Bun runtime, and the production shell entry's
//      own manifest loader resolves the same components from the bundled
//      entry directory — the exact boot path the composition feeds;
//   1. launch-record identity — the durable launch record carries the real
//      observed PID, start identity, executable identity, and process group;
//   2. observed exit — a stop is confirmed only when `ps` no longer sees the
//      identity; an already-dead process reports `already gone` without a
//      signal (a signal is never treated as an exit);
//   3. SIGKILL escalation — a component that ignores SIGTERM is delivered
//      SIGTERM (child testimony in the signal log), then SIGKILL inside the
//      bounded window, and the death is observed;
//   4. reconcile after restart — a fresh supervisor adopts the still-running
//      persisted launch (same processRecordId/generation), refuses and
//      journals an expected exit for a dead one, and never adopts — or
//      signals — a forged record whose identity fails the real-OS recheck.
//
// What this lane is NOT: a full packaged application run. In packaged mode
// (`--app-bundle <path to .app>`) the supervised `dev-runtime-sidecar`
// component is the REAL packaged sidecar from the bundled layout; the
// smoke-graceful/smoke-stubborn components are the smoke's own real child
// processes (they exist to prove SIGTERM defiance). In dev-fallback mode
// (no bundle given or found) the sidecar runs from the source tree and the
// output says so — packaged evidence must come from the packaged lane
// (`bun run test:packaged`), which passes `--app-bundle` explicitly.
// Nothing here fakes evidence: every assertion reads OS state (`ps`) or the
// child's own signal log.
//
// Usage: bun apps/desktop/shell/scripts/supervision-smoke.ts [--app-bundle <path>] [--artifact <path>]
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'

import {
  BUN_INSTALL_LABEL,
  buildPackagedManifest,
  findAppBundle,
  loadPackagedManifestForEntry,
  resolvePackagedComponents,
  type PackagedIdentity,
} from './packaged-install'
import {
  decodeComponentManifest,
  type ComponentManifest,
  type ComponentSpec,
} from '../src/supervision/component-manifest'
import { createProcessAdapter, observeIdentity } from '../src/supervision/process-adapter'
import { createRecordStore, RECORDS_FILE } from '../src/supervision/records'
import { createSupervisor, type Supervisor } from '../src/supervision/supervisor'
import { readEndpointFile } from '../src/dev-runtime/terminal/sidecar/endpoint-file'

const HERE = import.meta.dir
const CHILD_SCRIPT = join(HERE, 'supervision-smoke-child.ts')
const DEV_SIDECAR_ENTRY = join(HERE, '../src/dev-runtime/terminal/sidecar/entry.ts')

// Bounded real windows: generous enough for a Bun child to react under load,
// short enough that the smoke stays under its per-test timeout.
const STOP_GRACE_MS = 3_000
const KILL_GRACE_MS = 3_000
const PROBE_DELAY_MS = 100

const failures: string[] = []
const evidence: Array<{ proof: string; check: string; ok: boolean; detail?: string }> = []
let currentProof = 'setup'

const POLL_STEP_MS = 100
const POLL_LIMIT_MS = 8_000

function check(condition: boolean, description: string, evidenceDetail?: string): void {
  evidence.push({
    proof: currentProof,
    check: description,
    ok: condition,
    ...(evidenceDetail !== undefined ? { detail: evidenceDetail } : {}),
  })
  if (condition) {
    console.log(`  ok: ${description}${evidenceDetail ? ` — ${evidenceDetail}` : ''}`)
  } else {
    failures.push(description)
    console.error(`  FAIL: ${description}${evidenceDetail ? ` — ${evidenceDetail}` : ''}`)
  }
}

/** Polls a real-OS condition inside a bounded window; reaping and exit take
 *  a beat after a signal, so proofs assert settled state, not a race. A
 *  predicate that cannot be evaluated yet (a file the child has not written)
 *  counts as "not met", never as failure. */
async function eventually(condition: () => boolean): Promise<boolean> {
  const deadline = Date.now() + POLL_LIMIT_MS
  for (;;) {
    let met = false
    try {
      met = condition()
    } catch {
      met = false
    }
    if (met) return true
    if (Date.now() >= deadline) return false
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_STEP_MS))
  }
}

function gone(pid: number): boolean {
  return observeIdentity(pid) === null
}

type ResolvedPackaged = ReturnType<typeof resolvePackagedComponents>

type SmokeMode = {
  name: 'packaged' | 'dev-fallback'
  appBundle: string | null
  packaged: ResolvedPackaged | null
}

let mode: SmokeMode = { name: 'dev-fallback', appBundle: null, packaged: null }

function devManifest(): ComponentManifest {
  const decoded = decodeComponentManifest({
    schemaVersion: 1,
    components: [
      {
        id: 'dev-runtime-sidecar',
        product: 'Dev Runtime terminal sidecar (dev fallback entry)',
        version: 'smoke',
        platform: 'universal',
        arch: 'universal',
        digestSha256: 'a'.repeat(64),
        signature: 'c2ln',
        compatibility: { minAppVersion: '0.1.0', maxAppVersion: '99.0.0' },
        installLocation: 'shell/src/dev-runtime/terminal/sidecar/entry.ts',
        dataLocation: 'dev-runtime/terminal-sidecar',
        startupPhase: 0,
        dependsOn: [],
        healthProbe: { kind: 'process', intervalMs: 15_000, unhealthyAfterMs: 45_000 },
        // The wire protocol constant (`SIDECAR_PROTOCOL`): the manifest must
        // declare what the sidecar registers with, or the engine's
        // adoption verdict would refuse the real endpoint protocol.
        protocol: { name: 'adea-terminal-sidecar', major: 1, minor: 0 },
        rollbackTargetVersion: null,
        required: false,
      },
      ...smokeFixtureSpecs(),
    ],
  })
  if (!decoded.ok) throw new Error(`smoke manifest rejected: ${decoded.reason}`)
  return decoded.manifest
}

/** The smoke's own fixture components: real child processes that exist to
 *  prove observed exit and SIGTERM defiance. They are smoke fixtures, not
 *  packaged components — their install labels stay dev-mode labels. */
function smokeFixtureSpecs(): ComponentSpec[] {
  const decoded = decodeComponentManifest({
    schemaVersion: 1,
    components: [
      {
        id: 'smoke-graceful',
        product: 'Supervision smoke graceful component',
        version: 'smoke',
        platform: 'universal',
        arch: 'universal',
        digestSha256: 'b'.repeat(64),
        signature: 'c2ln',
        compatibility: { minAppVersion: '0.1.0', maxAppVersion: '99.0.0' },
        installLocation: 'shell/scripts/supervision-smoke-child.ts',
        dataLocation: 'smoke-graceful',
        startupPhase: 1,
        dependsOn: [],
        healthProbe: { kind: 'process', intervalMs: 15_000, unhealthyAfterMs: 45_000 },
        protocol: null,
        rollbackTargetVersion: null,
        required: false,
      },
      {
        id: 'smoke-stubborn',
        product: 'Supervision smoke stubborn component',
        version: 'smoke',
        platform: 'universal',
        arch: 'universal',
        digestSha256: 'c'.repeat(64),
        signature: 'c2ln',
        compatibility: { minAppVersion: '0.1.0', maxAppVersion: '99.0.0' },
        installLocation: 'shell/scripts/supervision-smoke-child.ts',
        dataLocation: 'smoke-stubborn',
        startupPhase: 1,
        dependsOn: [],
        healthProbe: { kind: 'process', intervalMs: 15_000, unhealthyAfterMs: 45_000 },
        protocol: null,
        rollbackTargetVersion: null,
        required: false,
      },
    ],
  })
  if (!decoded.ok) throw new Error(`smoke fixture manifest rejected: ${decoded.reason}`)
  return decoded.manifest.components
}

/** The manifest for the selected mode: the packaged components resolved from
 *  the bundled layout plus the smoke fixtures, or the labeled dev fallback
 *  (sidecar from the source tree) when no bundle was given or found. */
function smokeManifest(appBundle: string | null): ComponentManifest {
  if (!appBundle) return devManifest()
  const packaged = resolvePackagedComponents(appBundle)
  const merged = decodeComponentManifest({
    schemaVersion: 1,
    components: [...packaged.specs, ...smokeFixtureSpecs()],
  })
  if (!merged.ok) throw new Error(`merged smoke manifest rejected: ${merged.reason}`)
  return merged.manifest
}

function commandsFor(
  sidecarDataDir: string,
  childLog: string,
  appBundle: string | null
): Record<string, { argv: string[]; env?: Record<string, string> }> {
  if (appBundle) {
    // Packaged mode: the sidecar command comes from the packaging lane's
    // install-location resolution (bundled Bun + packaged sidecar entry).
    const commands = resolvePackagedComponents(appBundle).commands(sidecarDataDir)
    return {
      ...commands,
      'smoke-graceful': { argv: [process.execPath, CHILD_SCRIPT, '--signal-log', childLog] },
      'smoke-stubborn': {
        argv: [process.execPath, CHILD_SCRIPT, '--signal-log', childLog, '--stubborn'],
      },
    }
  }
  return {
    // Direct execution (no `bun run` indirection): the supervised pid is the
    // process that actually runs the script.
    'dev-runtime-sidecar': {
      argv: [process.execPath, DEV_SIDECAR_ENTRY, '--data-dir', sidecarDataDir],
      env: {
        ADEA_SIDECAR_VERSION: 'smoke',
        ADEA_SIDECAR_IDENTITY: 'adea-terminal-sidecar@smoke',
      },
    },
    'smoke-graceful': { argv: [process.execPath, CHILD_SCRIPT, '--signal-log', childLog] },
    'smoke-stubborn': {
      argv: [process.execPath, CHILD_SCRIPT, '--signal-log', childLog, '--stubborn'],
    },
  }
}

function makeSmoke(root: string): {
  supervisor: Supervisor
  sidecarDataDir: string
  childLog: string
} {
  const sidecarDataDir = join(root, 'sidecar-data')
  const childLog = join(root, 'child-signals.log')
  // The #185 timer-flake policy (issue follow-up, 2026-09-18): the engine's
  // timing seams are injected explicitly, never left on defaults. The smoke
  // clock is a monotonic wall clock that advances only through the injected
  // probe delay, so every grace window (`stopGraceMs`/`killGraceMs`) is
  // measured on the same clock the engine audits with, in bounded probe
  // ticks — no proof depends on the engine's internal setTimeout default or
  // on a sleep count sized for an idle machine.
  let smokeNow = Date.now()
  const supervisor = createSupervisor({
    manifest: smokeManifest(mode.appBundle),
    adapter: createProcessAdapter(commandsFor(sidecarDataDir, childLog, mode.appBundle)),
    records: createRecordStore(join(root, 'records')),
    now: () => smokeNow,
    stopGraceMs: STOP_GRACE_MS,
    killGraceMs: KILL_GRACE_MS,
    terminationProbeDelayMs: PROBE_DELAY_MS,
    delay: async (ms) => {
      await new Promise<void>((resolve) => setTimeout(resolve, ms))
      smokeNow += ms
    },
  })
  return { supervisor, sidecarDataDir, childLog }
}

function launchedRecord(root: string): Record<string, unknown> {
  const body = readFileSync(join(root, 'records', RECORDS_FILE), 'utf8')
  const lines = body.split('\n').filter((line) => line.length > 0)
  const record = JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>
  if (record.kind !== 'launched') throw new Error(`expected a launched record, got ${record.kind}`)
  return record
}

/** Creates a fresh per-proof temp root; the caller removes it in finally. */
function withRoot(name: string): string {
  return mkdtempSync(join(tmpdir(), `adea-supervision-smoke-${name}-`))
}

/** PROOF 0 (packaged mode): the packaging lane's install-location resolution
 *  feeds the component manifest from the REAL bundled layout. Every manifest
 *  component's label must resolve to a regular file inside the .app whose
 *  SHA-256 equals the manifest digest, and the sidecar command must be built
 *  from the bundled layout: the packaged sidecar entry executed by the
 *  bundled Bun runtime. */
async function proof0InstallLocationResolution(packaged: PackagedIdentity): Promise<void> {
  currentProof = 'proof-0-install-location-resolution'
  console.log('PROOF 0 install-location resolution from the bundled layout')
  const built = buildPackagedManifest(packaged.appBundle)
  const bundleRoot = resolvePath(packaged.appBundle)
  check(
    built.manifest.components.length >= 2,
    'the packaged manifest carries packaged components',
    built.manifest.components.map((entry) => entry.id).join(', ')
  )
  for (const component of built.manifest.components) {
    const resolution = built.identity.resolutions.find(
      (entry) => entry.ok && entry.label === component.installLocation
    )
    if (!resolution || !resolution.ok) {
      check(false, `install label resolves inside the bundle: ${component.id}`)
      continue
    }
    check(
      resolution.absolutePath.startsWith(bundleRoot + '/'),
      `install label resolves inside the bundle: ${component.id} (${component.installLocation})`,
      resolution.absolutePath
    )
    check(
      component.digestSha256 === resolution.digestSha256,
      `manifest digest equals the bundled artifact digest: ${component.id}`,
      resolution.digestSha256.slice(0, 16) + '…'
    )
  }
  const bunResolution = built.identity.resolutions.find(
    (entry) => entry.ok && entry.label === BUN_INSTALL_LABEL
  )
  check(
    bunResolution !== undefined,
    'the bundled Bun runtime resolves from the bundle layout',
    BUN_INSTALL_LABEL
  )
  const sidecarCommand = built.commands(join(tmpdir(), 'adea-proof0-probe'))['dev-runtime-sidecar']
  const bunPath = bunResolution && bunResolution.ok ? bunResolution.absolutePath : ''
  check(
    sidecarCommand !== undefined &&
      sidecarCommand.argv[0] === bunPath &&
      sidecarCommand.argv[0] !== process.execPath,
    'the packaged sidecar runs on the bundled Bun runtime, not the smoke toolchain',
    String(sidecarCommand?.argv[0])
  )
  check(
    sidecarCommand?.argv[1]?.includes('dev-runtime-sidecar/entry.js') === true,
    'the sidecar argv points at the packaged sidecar entry',
    String(sidecarCommand?.argv[1])
  )

  // The production composition path (the #185 one-supervisor wiring): the
  // shipped shell entry loads its manifest with the same loader from the
  // bundled entry directory (`Contents/Resources/app`), so the component
  // manifest the composition holds is resolved exactly like this proof's.
  const entryLoad = loadPackagedManifestForEntry(join(packaged.appBundle, 'Contents/Resources/app'))
  check(
    entryLoad.ok && entryLoad.manifest.components.length === built.manifest.components.length,
    'the production entry loader resolves the packaged manifest from the bundled layout',
    entryLoad.ok
      ? entryLoad.manifest.components.map((entry) => entry.id).join(', ')
      : entryLoad.reason
  )
  if (entryLoad.ok) {
    check(
      entryLoad.manifest.components.every((entry) => {
        const builtComponent = built.manifest.components.find((c) => c.id === entry.id)
        return builtComponent !== undefined && builtComponent.digestSha256 === entry.digestSha256
      }),
      'the entry-loaded manifest digests equal the packaging lane resolutions'
    )
  }
}

async function proof1LaunchRecordIdentity(): Promise<void> {
  currentProof = 'proof-1-launch-record-identity'
  console.log('PROOF 1 launch-record identity against the bundled sidecar entry')
  const root = withRoot('launch')
  try {
    const { supervisor, sidecarDataDir } = makeSmoke(root)
    const started = await supervisor.start({
      componentId: 'dev-runtime-sidecar',
      idempotencyKey: 'smoke-1',
    })
    check(started.ok, 'sidecar start succeeds through the real adapter')
    if (!started.ok) return
    const launch = started.value
    // Readiness before any destructive action: the endpoint file is the
    // sidecar's own "handlers installed" marker.
    check(
      await eventually(() => readEndpointFile(sidecarDataDir) !== null),
      'sidecar reaches readiness (endpoint file published)'
    )
    const observed = observeIdentity(launch.identity.pid)
    check(observed !== null, 'the recorded PID is a live OS process', `pid ${launch.identity.pid}`)
    if (!observed) return
    check(
      observed.pidStartIdentity === launch.identity.pidStartIdentity,
      'launch record start identity equals the OS start identity (ps lstart)',
      launch.identity.pidStartIdentity
    )
    check(
      observed.executableIdentity === launch.identity.executableIdentity,
      'launch record executable identity equals the OS executable (ps comm)',
      launch.identity.executableIdentity
    )
    check(
      observed.processGroup !== undefined && observed.processGroup === launch.processGroup,
      'launch record process group equals the observed group (ps pgid)',
      launch.processGroup
    )
    const record = launchedRecord(root) as {
      identity: { pid: number; pidStartIdentity: string }
      processGroup: string
      generation: number
      componentId: string
    }
    check(record.identity.pid === launch.identity.pid, 'the durable journal holds the same launch')
    check(
      record.generation === 1 && record.componentId === 'dev-runtime-sidecar',
      'journal fields match the launch'
    )
    const snapshot = supervisor.snapshot().components.find((c) => c.id === 'dev-runtime-sidecar')
    check(
      snapshot?.state === 'running' && snapshot.launch?.identity.pid === launch.identity.pid,
      'snapshot reports the running launch'
    )
    const stopped = await supervisor.stop('dev-runtime-sidecar')
    check(stopped.ok, 'the real sidecar stops gracefully with an observed exit')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function proof2ObservedExit(): Promise<void> {
  currentProof = 'proof-2-observed-exit'
  console.log('PROOF 2 observed exit: a signal is never treated as an exit')
  const root = withRoot('exit')
  try {
    const { supervisor, childLog } = makeSmoke(root)
    const started = await supervisor.start({ componentId: 'smoke-graceful', idempotencyKey: 'g1' })
    if (!started.ok) {
      check(false, 'graceful component starts')
      return
    }
    const pid = started.value.identity.pid
    check(
      await eventually(() => readFileSync(childLog, 'utf8').includes('ready')),
      'component reaches readiness (handlers installed)'
    )
    const stopped = await supervisor.stop('smoke-graceful')
    check(stopped.ok, 'stop returns ok')
    if (stopped.ok) {
      check(
        stopped.value.exitDetail === 'signalled; exit observed',
        'exit confirmed by observation, not by the signal',
        stopped.value.exitDetail
      )
    }
    check(
      observeIdentity(pid) === null || (await eventually(() => gone(pid))),
      'ps no longer sees the stopped identity'
    )
    const exited = supervisor.audit().filter((event) => event.kind === 'exit')
    check(exited.length === 1, 'exactly one exit event was journaled, after observation')

    // An already-dead process: the stop confirms via observation and never
    // signals an unknown PID.
    const second = await supervisor.start({ componentId: 'smoke-graceful', idempotencyKey: 'g2' })
    if (!second.ok) {
      check(false, 'second generation starts')
      return
    }
    check(
      await eventually(() => readFileSync(childLog, 'utf8').split('ready').length >= 3),
      'second generation reaches readiness'
    )
    process.kill(second.value.identity.pid, 'SIGKILL')
    check(
      await eventually(() => gone(second.value.identity.pid)),
      'the out-of-band kill was fully observed (reaped)'
    )
    const afterDeath = await supervisor.stop('smoke-graceful')
    check(afterDeath.ok, 'stop of an already-dead process confirms through observation')
    if (afterDeath.ok) {
      check(
        afterDeath.value.exitDetail === 'already gone',
        'already-dead stop reports already gone without signalling',
        afterDeath.value.exitDetail
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function proof3SigkillEscalation(): Promise<void> {
  currentProof = 'proof-3-sigkill-escalation'
  console.log('PROOF 3 SIGKILL escalation for a SIGTERM-defying component')
  const root = withRoot('escalate')
  const childLog = join(root, 'child-signals.log')
  try {
    writeFileSync(childLog, '', { mode: 0o600 })
    const { supervisor } = makeSmoke(root)
    const started = await supervisor.start({ componentId: 'smoke-stubborn', idempotencyKey: 's1' })
    if (!started.ok) {
      check(false, 'stubborn component starts')
      return
    }
    const pid = started.value.identity.pid
    check(
      await eventually(() => readFileSync(childLog, 'utf8').includes('ready')),
      'stubborn component reaches readiness (SIGTERM handler installed)'
    )
    const stopped = await supervisor.stop('smoke-stubborn', { escalate: true })
    check(stopped.ok, 'escalated stop returns ok')
    if (stopped.ok) {
      check(
        stopped.value.exitDetail === 'signalled (SIGTERM + SIGKILL); exit observed',
        'the stop escalated inside the bounded window and observed the death',
        stopped.value.exitDetail
      )
    }
    check(
      await eventually(() => readFileSync(childLog, 'utf8').includes('SIGTERM')),
      'child testimony: SIGTERM was delivered and ignored before escalation'
    )
    check(
      await eventually(() => gone(pid)),
      'the SIGKILL ended the process and the exit was observed'
    )
    const signals = supervisor
      .audit()
      .filter((event) => event.kind === 'signal' && event.detail.startsWith('SIG'))
      .map((event) => event.detail)
    check(
      JSON.stringify(signals) === JSON.stringify(['SIGTERM', 'SIGKILL']),
      'audit shows SIGTERM then SIGKILL in order',
      JSON.stringify(signals)
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function proof4ReconcileAfterRestart(): Promise<void> {
  currentProof = 'proof-4-reconcile-after-restart'
  console.log('PROOF 4 reconcile after supervisor restart (adoption, refusal, forgery)')
  const root = withRoot('reconcile')
  try {
    const { supervisor: first, childLog } = makeSmoke(root)
    const started = await first.start({ componentId: 'smoke-graceful', idempotencyKey: 'r1' })
    if (!started.ok) {
      check(false, 'component starts under the first supervisor')
      return
    }
    const processRecordId = started.value.processRecordId
    const pid = started.value.identity.pid
    check(
      await eventually(() => readFileSync(childLog, 'utf8').includes('ready')),
      'component reaches readiness before the restart adoption'
    )

    // A fresh supervisor (the app restarted) adopts the still-running launch.
    const { supervisor: revived } = makeSmoke(root)
    await revived.reconcile()
    const adopted = revived.snapshot().components.find((c) => c.id === 'smoke-graceful')
    check(
      adopted?.state === 'running' &&
        adopted.launch?.identity.pid === pid &&
        adopted.generation === 1,
      'a fresh supervisor adopts the still-running persisted launch',
      `pid ${pid} generation ${adopted?.generation}`
    )
    check(observeIdentity(pid) !== null, 'the adopted process was untouched by adoption')

    // The adopted process dies out-of-band; a third supervisor must refuse
    // adoption, journal an expected exit, and leave nothing dangling.
    process.kill(pid, 'SIGKILL')
    check(await eventually(() => gone(pid)), 'the adopted process was observed gone (reaped)')
    const third = makeSmoke(root).supervisor
    await third.reconcile()
    const refused = third.snapshot().components.find((c) => c.id === 'smoke-graceful')
    check(
      refused?.state === 'idle',
      'a dead persisted launch is not adopted',
      `state ${refused?.state}`
    )
    const journal = readFileSync(join(root, 'records', RECORDS_FILE), 'utf8')
    check(
      journal.includes(processRecordId) &&
        journal.includes('not observable after supervisor restart'),
      'the unadoptable launch was journaled exited (expected), never left dangling'
    )

    // A forged record naming a foreign live process fails the real-OS recheck:
    // never adopted, never signalled, foreign process survives.
    const foreign = Bun.spawn(['/bin/sleep', '30'], { stdout: 'ignore', stderr: 'ignore' })
    try {
      const foreignObserved = observeIdentity(foreign.pid)
      if (!foreignObserved) {
        check(false, 'foreign process is observable')
        return
      }
      const records = createRecordStore(join(root, 'records'))
      records.append({
        kind: 'launched',
        at: new Date().toISOString(),
        componentId: 'smoke-graceful',
        generation: 9,
        processRecordId: 'forged-record',
        identity: {
          pid: foreign.pid,
          pidStartIdentity: 'forged-start-identity',
          executableIdentity: foreignObserved.executableIdentity,
        },
        processGroup: foreignObserved.processGroup ?? 'forged-pgid',
      })
      const fourth = makeSmoke(root).supervisor
      await fourth.reconcile()
      const forged = fourth.snapshot().components.find((c) => c.id === 'smoke-graceful')
      check(
        forged?.state === 'idle',
        'a forged launch fails the identity recheck and is not adopted'
      )
      check(
        observeIdentity(foreign.pid) !== null,
        'the foreign process was never signalled and survives'
      )
    } finally {
      foreign.kill(9)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main(): Promise<number> {
  if (process.platform !== 'darwin') {
    console.error('supervision-smoke: darwin-only (ps lstart/pgid identity semantics)')
    return 2
  }
  const startedAt = new Date().toISOString()
  // Mode resolution: an explicit --app-bundle wins; otherwise the lane
  // auto-detects the Electrobun output. A missing bundle is a labeled dev
  // fallback, never packaged evidence.
  const explicitBundle = argValue('--app-bundle')
  const artifactPath = argValue('--artifact')
  const appBundle =
    explicitBundle ??
    findAppBundle(join(HERE, '..', 'build')) ??
    findAppBundle(join(HERE, '..', '..', '..', 'apps', 'desktop', 'shell', 'build'))
  if (appBundle) {
    try {
      const packaged = resolvePackagedComponents(appBundle)
      mode = { name: 'packaged', appBundle, packaged }
      // Absorb the OS's one-time first-exec verification of the freshly
      // linked bundled binaries before any timed readiness proof.
      const warm = Bun.spawnSync([appBundle + '/Contents/MacOS/bun', '--version'])
      if (warm.exitCode !== 0) throw new Error('the bundled Bun runtime failed to execute')
    } catch (error) {
      console.error(
        'supervision-smoke: the app bundle was found but its packaged manifest failed resolution:',
        error instanceof Error ? error.message : error
      )
      return 2
    }
  } else {
    mode = { name: 'dev-fallback', appBundle: null, packaged: null }
  }
  console.log(
    `MODE: ${mode.name}${mode.appBundle ? ` (${mode.appBundle})` : ' (dev stand-in sidecar entry — not packaged evidence)'}`
  )

  if (mode.packaged) await proof0InstallLocationResolution(mode.packaged.identity)
  currentProof = 'proof-1-launch-record-identity'
  await proof1LaunchRecordIdentity()
  currentProof = 'proof-2-observed-exit'
  await proof2ObservedExit()
  currentProof = 'proof-3-sigkill-escalation'
  await proof3SigkillEscalation()
  currentProof = 'proof-4-reconcile-after-restart'
  await proof4ReconcileAfterRestart()

  if (artifactPath) {
    const artifact = {
      lane: 'supervision-smoke',
      spec: 'docs/specs/dev-runtime.md#local-stack-supervision',
      mode: mode.name,
      appBundle: mode.appBundle,
      packaged: mode.packaged
        ? {
            version: mode.packaged.identity.version,
            channel: mode.packaged.identity.channel,
            resolutions: mode.packaged.identity.resolutions,
          }
        : null,
      startedAt,
      finishedAt: new Date().toISOString(),
      bun: process.versions.bun,
      command: 'bun apps/desktop/shell/scripts/supervision-smoke.ts',
      totals: {
        checks: evidence.length,
        failed: failures.length,
      },
      evidence,
    }
    mkdirSync(dirname(artifactPath), { recursive: true })
    writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + '\n', { mode: 0o600 })
    console.log(`artifact: ${artifactPath}`)
  }

  if (failures.length > 0) {
    console.error(`SUPERVISION-SMOKE FAILED: ${failures.length} check(s) failed`)
    for (const failure of failures) console.error(`  - ${failure}`)
    return 1
  }
  console.log('SUPERVISION-SMOKE PASS')
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('SUPERVISION-SMOKE ERROR', error)
    process.exit(1)
  })
