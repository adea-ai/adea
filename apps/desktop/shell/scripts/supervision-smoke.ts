// Packaged supervision smoke (M10 #185/#34): proves the supervision engine's
// rules against REAL processes on the packaged app path — the same lane the
// terminal PTY smoke uses (repository-pinned Bun, macOS-gated).
//
// Seven proofs, each one an acceptance behavior of `docs/specs/dev-runtime.md`
// ("Local stack supervision"):
//   0. install-location resolution (packaged mode) — every packaged `bundled`
//      component's manifest label resolves to a real bundled artifact inside
//      the .app (containment + existence + SHA-256 digest), the
//      `managed-data-dir` component (managed Pi) carries the driver's
//      build-time pin with a truthful-absence data-dir resolution, the
//      sidecar command is built from the bundled layout: the packaged sidecar
//      entry executed by the bundled Bun runtime, and the production shell
//      entry's own manifest loader resolves the same components from the
//      bundled entry directory — the exact boot path the composition feeds;
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
//      signals — a forged record whose identity fails the real-OS recheck;
//   5. live supervision events under a scripted crash storm (#185 follow-up)
//      — every crash, auto-restart, and crash-loop verdict surfaces as a
//      typed `SupervisionEvent` on the attached sink, the per-component
//      per-kind emission bound holds under a storm faster than the restart
//      policy (coalesced counts surface on later events), and the durable
//      journal plus audit ring record every crash regardless of the live
//      bound;
//   6. managed-Pi component registration (#185 follow-up) — the manifest
//      component matches the driver's pinned version and digest, the health
//      probe is the process probe over the engine's launch, a fresh data dir
//      resolves the install label as truthfully ABSENT, a real driver
//      install flips the resolution to digest-matching present, and escape
//      labels are refused by the same containment treatment as the bundle.
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
  MANAGED_PI_COMPONENT_ID,
  MANAGED_PI_INSTALL_LABEL,
  managedPiComponentSpec,
  resolveDataDirInstall,
  resolveManagedPiInstall,
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
import {
  createSupervisor,
  SUPERVISION_EVENT_MAX_PER_KIND,
  SUPERVISION_EVENT_WINDOW_MS,
  type Supervisor,
  type SupervisionEvent,
} from '../src/supervision/supervisor'
import { readEndpointFile } from '../src/dev-runtime/terminal/sidecar/endpoint-file'
import {
  MANAGED_PI_PINNED_ARCHIVE_SHA256,
  MANAGED_PI_PINNED_VERSION,
  createManagedPiDriver,
} from '../src/dev-runtime/harness/managed-pi-driver'
import type { DevScope } from '../src/dev-runtime/authority'

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
      // The managed Pi is a manifest component in both modes: its spec is
      // static (the driver's build-time pin), independent of any bundle.
      managedPiComponentSpec(),
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

function makeSmoke(
  root: string,
  options?: { onEvent?: (event: SupervisionEvent) => void }
): {
  supervisor: Supervisor
  sidecarDataDir: string
  childLog: string
  /** Advances the smoke clock — the same one the engine's emission window
   *  and grace windows measure with (proof 5's deterministic window slide). */
  advanceClock: (ms: number) => void
} {
  const sidecarDataDir = join(root, 'sidecar-data')
  const childLog = join(root, 'child-signals.log')
  // The #185 timer-flake policy (issue follow-up, 2026-09-18): the engine's
  // timing seams are injected explicitly, never left on defaults. The smoke
  // clock is a monotonic wall clock that advances only through the injected
  // probe delay, so every grace window (`stopGraceMs`/`killGraceMs`) is
  // measured on the same clock the engine audits with, in bounded probe
  // ticks — no proof depends on the engine's internal setTimeout default or
  // on a sleep count sized for an idle machine. The same clock drives the
  // event-emission window, so proof 5's storm bound is deterministic.
  let smokeNow = Date.now()
  const supervisor = createSupervisor({
    manifest: smokeManifest(mode.appBundle),
    adapter: createProcessAdapter(commandsFor(sidecarDataDir, childLog, mode.appBundle)),
    records: createRecordStore(join(root, 'records')),
    now: () => smokeNow,
    stopGraceMs: STOP_GRACE_MS,
    killGraceMs: KILL_GRACE_MS,
    terminationProbeDelayMs: PROBE_DELAY_MS,
    ...(options?.onEvent ? { onEvent: options.onEvent } : {}),
    delay: async (ms) => {
      await new Promise<void>((resolve) => setTimeout(resolve, ms))
      smokeNow += ms
    },
  })
  return {
    supervisor,
    sidecarDataDir,
    childLog,
    advanceClock: (ms) => {
      smokeNow += ms
    },
  }
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
    if (component.installKind === 'managed-data-dir') {
      // The managed Pi is not a bundled artifact: its install location
      // resolves against the data root with truthful-absence semantics, so
      // here it only has to carry a contained data-dir label (deep proof in
      // proof 6).
      check(
        !component.installLocation.startsWith('/') && !component.installLocation.includes('..'),
        `the managed-data-dir install label is relative and contained: ${component.id}`,
        component.installLocation
      )
      continue
    }
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

/** PROOF 5 (#185 follow-up): live supervision events under a scripted crash
 *  storm. The smoke-graceful component is crashed out-of-band five times (the
 *  engine's own restart-policy budget) and then the operator hammers restarts
 *  faster than the policy allows. Every crash, auto-restart, and crash-loop
 *  verdict must surface as a typed `SupervisionEvent` on the attached sink,
 *  the per-component per-kind emission bound must hold under the storm
 *  (coalesced counts ride later events), and the durable journal plus audit
 *  ring must record every crash regardless of the live bound. The clock is
 *  the smoke's injected one — advanced only by explicit ticks and the probe
 *  delay — so the whole storm falls inside one emission window and the bound
 *  trips deterministically. */
async function proof5LiveEventsCrashStorm(): Promise<void> {
  currentProof = 'proof-5-live-events-crash-storm'
  console.log('PROOF 5 live supervision events bounded under a scripted crash storm')
  const root = withRoot('events')
  try {
    const events: SupervisionEvent[] = []
    const { supervisor, childLog, advanceClock } = makeSmoke(root, {
      onEvent: (event) => events.push(event),
    })
    const started = await supervisor.start({
      componentId: 'smoke-graceful',
      idempotencyKey: 'storm',
    })
    if (!started.ok) {
      check(false, 'storm component starts')
      return
    }
    check(
      await eventually(() => readFileSync(childLog, 'utf8').includes('ready')),
      'storm component reaches readiness (event sink attached before boot)'
    )
    let pid = started.value.identity.pid
    let readyCount = 1

    // Phase 1 — engine-native storm: five out-of-band crashes, each observed
    // (reaped) and then reported, so the engine journals the exit,
    // auto-restarts, and trips crash_loop on the fifth.
    let verdict = 'restarted'
    for (let crash = 1; crash <= 5 && verdict !== 'crash_loop'; crash += 1) {
      process.kill(pid, 'SIGKILL')
      if (!(await eventually(() => gone(pid)))) {
        check(false, `crash ${crash} was observed gone (reaped)`)
        return
      }
      const reported = await supervisor.reportUnexpectedExit('smoke-graceful')
      if (!reported.ok) {
        check(false, `crash ${crash} report succeeded`, reported.message)
        return
      }
      verdict = reported.value
      if (verdict === 'restarted') {
        const launch = supervisor
          .snapshot()
          .components.find((c) => c.id === 'smoke-graceful')?.launch
        if (!launch) {
          check(false, `crash ${crash} auto-restart holds a launch`)
          return
        }
        pid = launch.identity.pid
        readyCount += 1
        if (
          !(await eventually(
            () => readFileSync(childLog, 'utf8').split('ready').length >= readyCount + 1
          ))
        ) {
          check(false, `crash ${crash} replacement reaches readiness`)
          return
        }
      }
    }
    check(verdict === 'crash_loop', 'the fifth crash tripped the crash_loop verdict')

    // Phase 2 — operator hammer, faster than the restart policy: each
    // restart out of crash_loop grants one fresh supervised run; an
    // out-of-band kill plus report crashes it straight back. This emission
    // cadence exceeds the per-kind bound, which is exactly what the bound
    // caps; no readiness wait is needed (the kill is SIGKILL). The clock
    // ticks 1ms per cycle — a fresh restart idempotency key, still deep
    // inside the 60s emission window.
    for (let cycle = 1; cycle <= 4; cycle += 1) {
      advanceClock(1)
      const restarted = await supervisor.restart('smoke-graceful')
      if (!restarted.ok) {
        check(false, `operator cycle ${cycle} restarted`, restarted.message)
        return
      }
      pid = restarted.value.identity.pid
      process.kill(pid, 'SIGKILL')
      if (!(await eventually(() => gone(pid)))) {
        check(false, `operator cycle ${cycle} crash was observed gone (reaped)`)
        return
      }
      const reported = await supervisor.reportUnexpectedExit('smoke-graceful')
      if (!reported.ok) {
        check(false, `operator cycle ${cycle} report succeeded`, reported.message)
        return
      }
      check(
        reported.value === 'crash_loop',
        `operator cycle ${cycle} re-entered crash_loop (one fresh supervised run)`
      )
    }

    // Phase 3 — the trailing window slide: a suppressed count rides the
    // component and kind's NEXT emitted event, so the proof slides the
    // emission window on the injected clock and runs one more restart-crash
    // cycle to surface the counters the storm left pending.
    advanceClock(SUPERVISION_EVENT_WINDOW_MS + 1)
    const fresh = await supervisor.restart('smoke-graceful')
    if (!fresh.ok) {
      check(false, 'the trailing operator restart succeeded', fresh.message)
      return
    }
    pid = fresh.value.identity.pid
    process.kill(pid, 'SIGKILL')
    if (!(await eventually(() => gone(pid)))) {
      check(false, 'the trailing crash was observed gone (reaped)')
      return
    }
    const trailing = await supervisor.reportUnexpectedExit('smoke-graceful')
    if (!trailing.ok) {
      check(false, 'the trailing crash report succeeded', trailing.message)
      return
    }
    check(
      trailing.value === 'crash_loop',
      'the trailing crash re-entered crash_loop (one fresh supervised run)'
    )

    // The live bound: at most SUPERVISION_EVENT_MAX_PER_KIND emissions per
    // component and kind inside the storm window.
    const exits = events.filter((event) => event.kind === 'exit')
    const starts = events.filter((event) => event.kind === 'start')
    const crashLoops = events.filter((event) => event.kind === 'crash_loop')
    check(
      [exits.length, starts.length, crashLoops.length].every(
        (count) => count <= SUPERVISION_EVENT_MAX_PER_KIND + 1
      ),
      'the per-kind live-event bound held under the storm',
      `exit ${exits.length}, start ${starts.length}, crash_loop ${crashLoops.length} (window cap ${SUPERVISION_EVENT_MAX_PER_KIND} + the trailing post-window emission)`
    )
    const suppressedTotal = events.reduce((sum, event) => sum + event.suppressed, 0)
    check(
      suppressedTotal > 0,
      'coalescing engaged under the storm: suppressed counts surfaced on later events',
      `${suppressedTotal} coalesced`
    )
    // The event shape: typed kinds, engine-authored secret-free fields only.
    check(
      events.every(
        (event) =>
          event.componentId === 'smoke-graceful' &&
          typeof event.generation === 'number' &&
          !Number.isNaN(Date.parse(event.at)) &&
          event.suppressed >= 0
      ),
      'every emitted event carries the typed componentId/generation/at/suppressed fields'
    )
    // Coalescing closure: emitted plus surfaced-suppressed per kind equals
    // the engine-native totals — ten crash exits, ten launches (the initial
    // one, four auto-restarts, four operator restarts, the trailing
    // operator restart), six crash-loop verdicts.
    const suppressedSum = (kind: SupervisionEvent['kind']) =>
      events
        .filter((event) => event.kind === kind)
        .reduce((sum, event) => sum + event.suppressed, 0)
    check(
      exits.length + suppressedSum('exit') === 10 &&
        starts.length + suppressedSum('start') === 10 &&
        crashLoops.length + suppressedSum('crash_loop') === 6,
      'every engine observation is emitted or counted as coalesced (10 starts, 10 exits, 6 crash loops)',
      `start ${starts.length}+${suppressedSum('start')}, exit ${exits.length}+${suppressedSum('exit')}, crash_loop ${crashLoops.length}+${suppressedSum('crash_loop')}`
    )
    // The durable truth is unaffected by the live bound: all ten unexpected
    // exits are journaled and audited, and the storm rests in crash_loop.
    const journal = readFileSync(join(root, 'records', RECORDS_FILE), 'utf8')
    const journaledCrashes = journal
      .split('\n')
      .filter((line) => line.includes('"expected":false')).length
    check(
      journaledCrashes === 10,
      'the durable journal holds every crash exit regardless of the live bound',
      `${journaledCrashes} journaled unexpected exits`
    )
    check(
      supervisor.audit().filter((event) => event.kind === 'exit').length === 10 &&
        supervisor.snapshot().components.find((c) => c.id === 'smoke-graceful')?.state ===
          'crash_loop',
      'the audit ring holds every exit and the component rests in crash_loop'
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** PROOF 6 (#185 follow-up): the managed Pi as a packaged manifest component.
 *  The component matches the driver's build-time pin, the engine holds and
 *  reports it, a fresh data dir resolves the install label as truthfully
 *  ABSENT, a REAL driver install (injected source, same digest pin) flips the
 *  resolution to present with the pinned digest, and escape labels are
 *  refused by the same containment treatment the bundle gets. */
async function proof6ManagedPiComponent(): Promise<void> {
  currentProof = 'proof-6-managed-pi-component'
  console.log('PROOF 6 managed-Pi component registration with truthful absence')
  const component = smokeManifest(mode.appBundle).components.find(
    (entry) => entry.id === MANAGED_PI_COMPONENT_ID
  )
  check(component !== undefined, 'the manifest carries the managed-pi component')
  if (!component) return
  check(
    component.installKind === 'managed-data-dir' &&
      component.version === MANAGED_PI_PINNED_VERSION &&
      component.digestSha256 === MANAGED_PI_PINNED_ARCHIVE_SHA256,
    'the managed-pi component carries the driver build-time pin (version + archive digest)',
    `${component.version} ${component.digestSha256.slice(0, 16)}…`
  )
  check(
    component.healthProbe.kind === 'process' &&
      component.protocol === null &&
      component.required === false,
    'the probe is the process probe over the engine launch; no adoption protocol; never gates readiness'
  )
  const root = withRoot('managed-pi')
  try {
    const { supervisor } = makeSmoke(root)
    const held = supervisor
      .snapshot()
      .components.find((entry) => entry.id === MANAGED_PI_COMPONENT_ID)
    check(
      held?.state === 'idle' && held.manifest.version === MANAGED_PI_PINNED_VERSION,
      'the engine holds the managed-pi component and reports its pinned version'
    )

    // Truthful absence: a fresh data dir has no managed installation, and
    // the resolution says exactly that — typed, contained, never fabricated.
    const dataDir = join(root, 'data')
    const absentResolution = resolveManagedPiInstall(dataDir)
    check(
      absentResolution.ok &&
        absentResolution.absent === true &&
        absentResolution.absolutePath === resolvePath(join(dataDir, MANAGED_PI_INSTALL_LABEL)),
      'a fresh data dir resolves the managed Pi as truthfully absent at the pinned label',
      absentResolution.ok && absentResolution.absent
        ? absentResolution.reason
        : 'unexpected resolution'
    )

    // A REAL driver install (injected source; the digest pin still verifies
    // every byte) flips the resolution to present with the pinned digest.
    // Install ownership stays with the driver; the engine surface only
    // observes the result.
    const scope: DevScope = {
      accountId: 'smoke-account',
      workspaceId: 'smoke-workspace',
      runtimeNodeId: 'smoke-node',
    }
    const driver = createManagedPiDriver({
      scope,
      dataDir,
      resolvePinnedArchive: () =>
        Promise.resolve(new TextEncoder().encode('adea-managed-pi-placeholder-archive-v1')),
    })
    const status = await driver.ensureInstalled()
    check(
      status.state === 'ready' && status.resolvedVersion === MANAGED_PI_PINNED_VERSION,
      'the driver installed the pinned managed Pi into the data dir'
    )
    const installed = resolveManagedPiInstall(dataDir)
    check(
      installed.ok &&
        installed.absent === false &&
        installed.digestMatchesPin &&
        installed.digestSha256 === MANAGED_PI_PINNED_ARCHIVE_SHA256,
      'the install flips the resolution to present with the pinned digest',
      installed.ok && !installed.absent ? installed.digestSha256.slice(0, 16) + '…' : ''
    )

    // The same containment treatment as the bundle: escapes are refused.
    const escape = resolveDataDirInstall(dataDir, '../escape')
    check(!escape.ok, 'an escaping data-dir label is refused by containment')

    // In packaged mode the engine's command for the component points at the
    // pinned data-dir path (its spawn observes the install result, typed
    // `spawn_failed` before any install — the driver owns install).
    if (mode.appBundle) {
      const command = resolvePackagedComponents(mode.appBundle).commands(dataDir)[
        MANAGED_PI_COMPONENT_ID
      ]
      check(
        command !== undefined &&
          command.argv[0] === resolvePath(join(dataDir, MANAGED_PI_INSTALL_LABEL)),
        'the packaged command argv points at the pinned managed-Pi install path',
        String(command?.argv[0])
      )
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
  currentProof = 'proof-5-live-events-crash-storm'
  await proof5LiveEventsCrashStorm()
  currentProof = 'proof-6-managed-pi-component'
  await proof6ManagedPiComponent()

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
