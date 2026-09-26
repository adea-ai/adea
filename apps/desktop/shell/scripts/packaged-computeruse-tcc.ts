// Packaged computer-use TCC evidence (#472): the real-OS macOS acceptance
// that fixture-only lanes cannot close. Run on the packaged evidence lane
// (darwin, the Electrobun .app built) against the REAL #471 permission
// substrate and the production computer-use registrar over the M10 gate:
//
//   PROOF A — packaged anchor: the bundle is present with its staged
//             components, and its code identity is recorded (a rebuilt
//             bundle is a fresh TCC identity, which is what makes the
//             first-run permission state observable).
//   PROOF B — real macOS TCC probes in two execution contexts: the proof
//             process (host-toolchain attribution) and a child running on
//             the bundle's own packaged Bun runtime. Every row is classified
//             by the production service into a typed state; nothing is
//             guessed, defaulted, or read from fixtures.
//   PROOF C — every dev.computeruse.* operation through the signed M10 gate
//             against the REAL observed snapshot: capabilities mirror the
//             probe (never a silent empty success), consent returns the
//             typed permission decision (issued when granted, refused with
//             remediation otherwise), input refuses without live consent.
//   PROOF D — the permissions-page guidance: the exact frozen System
//             Settings deep links and the remediation object a denial
//             refusal carries (denied → open_settings → the Accessibility
//             pane), derived from the REAL gate.
//   PROOF E — grant-then-revoke within one interaction at the gate: an
//             issued consent dies at the next interaction after takeover,
//             Escape (release) returns authority, and a permission state
//             that moves off a consent's digest refuses the next admission
//             (fixture-driven flip through the #471 seam — real TCC
//             toggling is not scriptable; recorded as such, never faked).
//
// HONESTY BOUNDARY (recorded, not hidden): this script never performs real
// keyboard synthesis — the engine seam carries a recording stand-in, so no
// frame is ever admitted with a live host engine — and it never toggles
// System Settings TCC. Whether macOS attributed a probe to the app bundle or
// to the launching toolchain is NOT provable headlessly; both contexts are
// recorded verbatim and the evidence document states exactly that.
//
// Usage: bun apps/desktop/shell/scripts/packaged-computeruse-tcc.ts [--app-bundle <path>] [--artifact <path>]
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { join } from 'node:path'
import { createHmac, randomUUID } from 'node:crypto'

import {
  devCommandProofMessage,
  devOperationDefinitions,
  type DevCommand,
  type DevReply,
  type Scope,
} from '../../../../packages/types/src/dev-runtime'
import type { MacPermissionsSnapshot } from '../../../../packages/types/src/desktop-permissions'
import { createChannelAuthority } from '../src/dev-runtime/channel/authority'
import {
  createHostCommandRunner,
  createMacPermissionService,
  SETTINGS_PANES,
  type HostCommandOutcome,
  type HostCommandRunner,
} from '../src/desktop-permissions'
import { registerComputerUseRuntime } from '../src/dev-runtime/computeruse/register'
import { createOwnerApprovalVerifier, type OwnerApproval } from '../src/dev-runtime/authority'
import {
  COMPUTER_USE_CONSENT_ACTION,
  PERMISSION_FRESHNESS_MS,
} from '../src/dev-runtime/computeruse/consent-gate'
import type {
  ComputerUseEngine,
  ComputerUseInputEvent,
} from '../src/dev-runtime/computeruse/engine'
import {
  BUN_INSTALL_LABEL,
  findAppBundle,
  readPackagedIdentity,
  resolveInstallLocation,
  SIDECAR_INSTALL_LABEL,
} from './packaged-install'

const SHELL_HOST = '127.0.0.1:4793'
const SHELL_ORIGIN = 'http://127.0.0.1:4793'
const SCOPE: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
/** The #471 probe deadline; the bundle-child runner mirrors it. */
const PROBE_DEADLINE_MS = 3_000
/**
 * The evidence service's probe deadline. Host load can push the probe latency
 * to the shipped 3 s deadline, which classifies the honest `not_determined`;
 * the extended deadline separates TCC state from host load (a genuinely open
 * prompt still times out into `not_determined`).
 */
const PROBE_DEADLINE_MS_EXTENDED = 10_000

type Check = { check: string; ok: boolean; detail?: string }
const checks: Check[] = []

function check(ok: boolean, description: string, detail?: string): boolean {
  checks.push({ check: description, ok, ...(detail !== undefined ? { detail } : {}) })
  if (ok) console.log(`  ok: ${description}${detail ? ` — ${detail}` : ''}`)
  else console.error(`  FAIL: ${description}${detail ? ` — ${detail}` : ''}`)
  return ok
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function accessibilityOf(snapshot: MacPermissionsSnapshot): string {
  return (
    snapshot.permissions.find((entry) => entry.id === 'accessibility')?.state ??
    'row-missing-from-snapshot'
  )
}

/** The typed error code of a gate reply ('ok' when the reply succeeded). */
function errorCode(reply: DevReply): string {
  return reply.ok ? 'ok' : reply.error.code
}

/** The capability-row state the input row must carry for a probed state. */
function mirrorStateFor(probeState: string): string {
  return probeState === 'granted'
    ? 'available'
    : probeState === 'denied'
      ? 'denied'
      : probeState === 'not_determined'
        ? 'not_determined'
        : 'unavailable'
}

/** The exact host outcome the macOS Accessibility gate produces for a
 *  refused input-tool probe (the text the production classifier matches). */
const ASSISTIVE_DENIED_OUTCOME: HostCommandOutcome = {
  exitCode: 1,
  stdout: '',
  stderr: 'execution error: osascript is not allowed assistive access. (-1719)',
  timedOut: false,
  spawnFailed: false,
}
const GRANTED_OUTCOME: HostCommandOutcome = {
  exitCode: 0,
  stdout: '93',
  stderr: '',
  timedOut: false,
  spawnFailed: false,
}

/**
 * A runner that executes the fixed probe argv on the bundle's packaged Bun
 * runtime (Contents/MacOS/bun), mirroring the production probe deadline.
 * The classification stays in the production service; only the execution
 * context changes.
 */
function bundleBunRunner(bunPath: string): HostCommandRunner {
  const shim = `
    // Under "bun -e <code>", Bun.argv is [bunPath, ...forwarded args] — the
    // probe argv starts at index 1.
    const outcome = Bun.spawnSync(Bun.argv.slice(1), {
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: ${PROBE_DEADLINE_MS},
    });
    console.log(JSON.stringify({
      exitCode: outcome.exitCode,
      stdout: outcome.stdout.toString(),
      stderr: outcome.stderr.toString(),
      timedOut: outcome.signalCode === 'SIGTERM',
      spawnFailed: false,
    }));`
  return async (argv) => {
    const run = Bun.spawnSync([bunPath, '-e', shim, ...argv], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: PROBE_DEADLINE_MS + 5_000,
    })
    if (run.exitCode !== 0) {
      return { exitCode: null, stdout: '', stderr: '', timedOut: false, spawnFailed: true }
    }
    try {
      return JSON.parse(run.stdout.toString()) as HostCommandOutcome
    } catch {
      return { exitCode: null, stdout: '', stderr: '', timedOut: false, spawnFailed: true }
    }
  }
}

/** Recording engine stand-in: keeps the admitted-frame path honest without
 *  ever synthesizing real input (CI and packaged lanes never perform real
 *  input; the real host engine stays unattached for the whole proof). */
function recordingEngine(): ComputerUseEngine & { injected: ComputerUseInputEvent[] } {
  const injected: ComputerUseInputEvent[] = []
  return {
    injected,
    async injectInput(event: ComputerUseInputEvent) {
      injected.push(event)
    },
    async capture(): Promise<never> {
      throw new Error('capture stays typed-unavailable in this lane')
    },
    async readAccessibilityTree(): Promise<never> {
      throw new Error('ax_tree stays typed-unavailable in this lane')
    },
  }
}

async function main(): Promise<number> {
  if (process.platform !== 'darwin') {
    console.error('packaged-computeruse-tcc: darwin-only packaged evidence lane')
    return 2
  }
  const startedAt = new Date().toISOString()
  const artifactPath = argValue('--artifact') ?? 'artifacts/packaged/computeruse-tcc.json'
  const appBundle =
    argValue('--app-bundle') ??
    findAppBundle(join(import.meta.dir, '..', 'build')) ??
    findAppBundle(join(import.meta.dir, '..', '..', '..', 'apps', 'desktop', 'shell', 'build'))
  if (!appBundle) {
    console.error(
      'packaged-computeruse-tcc: no packaged app bundle found; run the packaged lane first'
    )
    return 2
  }
  const bundleIdentity = readPackagedIdentity(appBundle)

  const writeArtifact = (extra: Record<string, unknown> = {}): void => {
    mkdirSync(dirname(artifactPath), { recursive: true })
    writeFileSync(
      artifactPath,
      JSON.stringify(
        {
          lane: 'packaged-computeruse-tcc',
          issue: '472',
          spec: 'docs/specs/dev-runtime.md ("Computer use lanes"; "macOS permissions onboarding")',
          mode: 'packaged lane (production registrar + real #471 probes; input engine is a recording stand-in)',
          appBundle,
          packaged: { version: bundleIdentity.version, channel: bundleIdentity.channel },
          startedAt,
          finishedAt: new Date().toISOString(),
          bun: process.versions.bun,
          command:
            'bun apps/desktop/shell/scripts/packaged-computeruse-tcc.ts --app-bundle <Adea-dev.app>',
          ...extra,
          totals: { checks: checks.length, failed: checks.filter((entry) => !entry.ok).length },
          checks,
        },
        null,
        2
      ) + '\n',
      { mode: 0o600 }
    )
    console.log(`artifact: ${artifactPath}`)
  }

  // PROOF A — packaged anchor and code identity.
  console.log('PROOF A packaged anchor and code identity')
  const bunInstall = resolveInstallLocation(appBundle, BUN_INSTALL_LABEL)
  const sidecarInstall = resolveInstallLocation(appBundle, SIDECAR_INSTALL_LABEL)
  check(
    bunInstall.ok && sidecarInstall.ok,
    'the packaged bundle is present with its staged components (lane anchor)',
    appBundle
  )
  // A freshly rebuilt bundle has a fresh code identity: this Electrobun dev
  // bundle is ad-hoc/linker-signed with no sealed resources, so TCC has no
  // stable identity to bind a grant to — every rebuild is a first-run app.
  // The observed identity is recorded, never assumed.
  const codesign = Bun.spawnSync(['codesign', '-dvv', appBundle], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
  })
  const codesignText = `${codesign.stdout.toString()}${codesign.stderr.toString()}`
  const signature = codesignText.match(/Signature=([^\n]+)/)?.[1]?.trim() ?? 'unreadable'
  const codeFlags = codesignText.match(/flags=0x[0-9a-f]+\([^)]*\)/)?.[0] ?? 'unreadable'
  check(
    signature !== 'unreadable',
    'the rebuilt bundle code identity was observed for the record (fresh TCC identity)',
    `signature=${signature}, ${codeFlags}`
  )
  const bundledBunPath = bunInstall.ok ? bunInstall.absolutePath : ''

  // Absorb the OS's one-time first-exec verification of the freshly linked
  // bundled binary before any timed probe.
  const warm = Bun.spawnSync([bundledBunPath, '--version'], { timeout: 30_000 })
  check(
    warm.exitCode === 0,
    'the packaged Bun runtime executes on this host',
    `exit ${String(warm.exitCode)}`
  )

  // PROOF B — real macOS TCC probes in two execution contexts.
  console.log('PROOF B real #471 TCC probes (proof-process and bundle-child contexts)')
  // The shipped 3 s deadline is recorded verbatim first: on a loaded host the
  // probe latency can sit at that deadline and the classifier answers the
  // honest `not_determined` ("prompt still open"). The evidence service then
  // uses a 10 s deadline — a documented seam parameter — so the decision
  // probes measure the TCC state, not host load; a genuinely open prompt
  // still times out into `not_determined`.
  const defaultDeadlineService = createMacPermissionService({ run: createHostCommandRunner() })
  const defaultDeadlineSnapshot = await defaultDeadlineService.snapshot({ force: true })
  check(
    defaultDeadlineSnapshot.permissions.every((row) =>
      ['granted', 'denied', 'not_determined', 'unavailable'].includes(row.state)
    ),
    'the shipped 3 s-deadline probes classify into typed states (recorded verbatim)',
    defaultDeadlineSnapshot.permissions.map((row) => `${row.id}=${row.state}`).join(', ')
  )
  const proofService = createMacPermissionService({
    run: createHostCommandRunner({ timeoutMs: PROBE_DEADLINE_MS_EXTENDED }),
  })
  const proofSnapshot = await proofService.snapshot({ force: true })
  check(
    proofSnapshot.hostPlatform === 'macos' && proofSnapshot.permissions.length === 5,
    'the proof-process snapshot reports every permission row with a typed state',
    proofSnapshot.permissions.map((row) => `${row.id}=${row.state}`).join(', ')
  )
  check(
    proofSnapshot.permissions.every((row) =>
      ['granted', 'denied', 'not_determined', 'unavailable'].includes(row.state)
    ),
    'no probe row is guessed or defaulted (typed states only)'
  )
  let bundleSnapshot: MacPermissionsSnapshot | null = null
  if (bundledBunPath !== '') {
    const bundleService = createMacPermissionService({ run: bundleBunRunner(bundledBunPath) })
    bundleSnapshot = await bundleService.snapshot({ force: true })
    check(
      bundleSnapshot.permissions.every((row) =>
        ['granted', 'denied', 'not_determined', 'unavailable'].includes(row.state)
      ),
      'the bundle-child probes classify into typed states through the production service',
      bundleSnapshot.permissions.map((row) => `${row.id}=${row.state}`).join(', ')
    )
  }

  // PROOF C — every dev.computeruse.* operation through the signed M10 gate.
  console.log('PROOF C dev.computeruse.* through the production registrar + M10 gate')
  const authority = createChannelAuthority({ shellHost: SHELL_HOST, shellOrigin: SHELL_ORIGIN })
  const handshakeReply = authority.handshake(
    {
      schemaVersion: 1,
      method: 'dev.runtime.handshake.v1',
      requestId: randomUUID(),
      bootstrap: authority.issueLaunchBootstrap(),
      supportedProtocolVersions: ['1'],
      nonce: Buffer.from(randomUUID()).toString('base64url'),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    },
    { trusted: true }
  )
  if (!handshakeReply.ok) throw new Error('handshake failed')
  const identity = {
    channelId: handshakeReply.channelId,
    clientCredentialId: handshakeReply.clientCredentialId,
  }
  const secret = Buffer.from(handshakeReply.clientSecret, 'base64url')
  const engine = recordingEngine()
  // The consent gate consumes a real owner approval, so the packaged lane
  // records an issuance for the owner confirmation it presents — the same
  // durable, scope-bound, single-use authority the shell composes.
  const approvalStore = mkdtempSync(join(tmpdir(), 'adea-packaged-computeruse-approvals-'))
  const approvalVerifier = createOwnerApprovalVerifier({ dataDir: approvalStore })
  const runtime = registerComputerUseRuntime({
    authority,
    approvalVerifier,
    scope: SCOPE,
    macPermissions: proofService,
    engine,
    platform: 'darwin',
  })
  check(
    runtime.registeredCommandCount === 9,
    'the production computer-use registrar registered its dev.computeruse.* commands',
    `${runtime.registeredCommandCount} commands`
  )

  /** Records a fresh, single-use owner approval and returns its reference. */
  function ownerConfirmation(): string {
    const approval: OwnerApproval = {
      method: 'owner_dialog',
      reference: `packaged-owner-confirmation-${randomUUID()}`,
      scope: SCOPE,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    approvalVerifier.recordIssuance(approval, SCOPE, COMPUTER_USE_CONSENT_ACTION)
    return approval.reference
  }

  function execute(
    operation: keyof typeof devOperationDefinitions,
    body: Record<string, unknown>,
    resource?: { kind: string; id: string; generation: number }
  ): Promise<DevReply> {
    const command: DevCommand = {
      schemaVersion: 1,
      operation,
      requestId: randomUUID(),
      nonce: Buffer.from(randomUUID()).toString('base64url'),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      scope: SCOPE,
      capabilities: [...devOperationDefinitions[operation].capabilities],
      ...(resource !== undefined ? { resource } : {}),
      body,
    }
    return authority.execute(
      {
        channelId: identity.channelId,
        clientCredentialId: identity.clientCredentialId,
        command,
        proof: createHmac('sha256', secret)
          .update(
            devCommandProofMessage({
              channelId: identity.channelId,
              clientCredentialId: identity.clientCredentialId,
              command,
            }),
            'utf8'
          )
          .digest('base64url'),
      },
      { trusted: true }
    )
  }

  // capabilities: the report through the gate mirrors the real snapshot. The
  // report runs its own fresh probes, and a loaded host can oscillate between
  // granted and not_determined round-to-round (osascript latency vs the probe
  // deadline — both honest typed readings). The mirror assertion is therefore
  // windowed: every report reading must be the typed mapping of a probe state
  // the host actually showed in the same window — the report may never claim
  // a state the probe did not show (never guesses).
  const capabilitiesReply = await execute('dev.computeruse.capabilities', {})
  const gatedReport = capabilitiesReply.ok
    ? (capabilitiesReply.value as {
        hostPlatform: string
        capabilities: { id: string; state: string }[]
      })
    : null
  check(
    capabilitiesReply.ok &&
      gatedReport !== null &&
      gatedReport.hostPlatform === 'macos' &&
      gatedReport.capabilities.length === 3,
    'dev.computeruse.capabilities returns the typed report (never a silent empty success)',
    gatedReport
      ? gatedReport.capabilities.map((row) => `${row.id}=${row.state}`).join(', ')
      : errorCode(capabilitiesReply)
  )
  const observedProbeStates = new Set<string>()
  const observedReportStates = new Set<string>()
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const probeState = accessibilityOf(await proofService.snapshot({ force: true }))
    const reportReply = await execute('dev.computeruse.capabilities', {})
    const gatedInputRow = reportReply.ok
      ? ((
          reportReply.value as {
            capabilities: { id: string; state: string }[]
          }
        ).capabilities.find((row) => row.id === 'input') ?? null)
      : null
    observedProbeStates.add(probeState)
    observedReportStates.add(String(gatedInputRow?.state ?? errorCode(reportReply)))
  }
  const mappedProbeStates = new Set([...observedProbeStates].map(mirrorStateFor))
  const mirrored = [...observedReportStates].every((state) => mappedProbeStates.has(state))
  const mirrorDetail =
    `probes=${[...observedProbeStates].toSorted().join('|')}, ` +
    `reports=${[...observedReportStates].toSorted().join('|')}`
  check(
    mirrored,
    'the input capability row mirrors the REAL accessibility probe state (never a state the probe did not show)',
    mirrorDetail
  )
  check(
    gatedReport?.capabilities.find((row) => row.id === 'capture')?.state === 'unavailable',
    'capture stays typed-unavailable (native helper deferred), never stubbed'
  )

  // Lane lifecycle through the gate.
  const laneReply = await execute('dev.computeruse.laneCreate', {
    runtimeSessionId: 'packaged-computeruse-tcc',
  })
  const lane = laneReply.ok
    ? (laneReply.value as { id: string; state: string; generation: number })
    : null
  check(
    laneReply.ok && lane !== null && lane.state === 'idle' && lane.generation === 1,
    'dev.computeruse.laneCreate opens a session-scoped idle lane',
    lane ? `generation ${lane.generation}` : errorCode(laneReply)
  )
  if (lane === null) {
    writeArtifact()
    return 1
  }
  const lanesReply = await execute('dev.computeruse.lanes', {
    runtimeSessionId: 'packaged-computeruse-tcc',
  })
  check(
    lanesReply.ok && (lanesReply.value as { items: unknown[] }).items.length === 1,
    'dev.computeruse.lanes lists the session lane'
  )

  // Consent: the typed permission decision against the REAL snapshot. The
  // gate re-probes freshly at issue time, and a host probe that answers
  // `not_determined` under load is an honest typed state — so the assertion
  // is symmetric (issued ⟺ the adjacent snapshot proves granted; refused ⟺
  // the typed code matches the probed state) and a probe that straddles a
  // state boundary between two adjacent probe runs retries, bounded.
  let consentReply: DevReply | null = null
  let consentIssued = false
  let issuedConsentId = ''
  let consentDetail = ''
  for (let attempt = 1; attempt <= 3 && consentReply === null; attempt += 1) {
    const before = accessibilityOf(await proofService.snapshot({ force: true }))
    const generation = runtime.lanes.get(lane.id).generation
    const reply = await execute(
      'dev.computeruse.consent',
      {
        computerUseLaneId: lane.id,
        expectedGeneration: generation,
        confirmationId: ownerConfirmation(),
      },
      { kind: 'computeruse_lane', id: lane.id, generation }
    )
    const after = accessibilityOf(await proofService.snapshot({ force: true }))
    if (reply.ok) {
      // An issued record must be backed by a proven grant at rest.
      if (after === 'granted') {
        consentReply = reply
        consentIssued = true
        issuedConsentId = (reply.value as { consentId: string }).consentId
        consentDetail = 'single-use record bound to the next generation'
      }
    } else {
      const refusalCode = errorCode(reply)
      const typedForState = (state: string): boolean =>
        state === 'denied' || state === 'not_determined'
          ? refusalCode === 'permission_denied'
          : state === 'unavailable'
            ? refusalCode === 'capability_unavailable'
            : false // granted must issue, never refuse
      // The refusal is honest when either adjacent probe explains it.
      if (typedForState(before) || typedForState(after)) {
        consentReply = reply
        consentDetail = `${refusalCode}: ${reply.error.message.slice(0, 80)}`
      }
    }
    // Mixed/straddled readings: loop (bounded) without recording a check.
  }
  if (consentReply === null) {
    check(
      false,
      'the real accessibility probe stayed within one typed state across three bounded consent attempts'
    )
  } else if (consentIssued) {
    check(
      true,
      'with the accessibility probe granted, an owner-confirmed consent ISSUES through the gate',
      consentDetail
    )
    const activated = runtime.lanes.get(lane.id)
    check(activated.state === 'granted', 'the lane activates to granted at the next generation')
  } else if (consentReply !== null) {
    check(
      !consentReply.ok,
      'without a proven accessibility grant, consent refuses with the typed state (never silent success)',
      consentDetail
    )
  }

  // Input without a live consent record refuses.
  const currentGeneration = runtime.lanes.get(lane.id).generation
  const forgedInput = await execute(
    'dev.computeruse.input',
    {
      computerUseLaneId: lane.id,
      expectedGeneration: currentGeneration,
      consentId: 'no-such-consent-record',
      direction: 'write',
    },
    { kind: 'computeruse_lane', id: lane.id, generation: currentGeneration }
  )
  check(
    !forgedInput.ok,
    'dev.computeruse.input without a live consent record refuses (fail-closed)',
    errorCode(forgedInput)
  )

  // Read-direction attach mints a typed grant (the capture stream closes
  // incompatible at the gateway until the native helper lands).
  const attachGeneration = runtime.lanes.get(lane.id).generation
  const attachReply = await execute(
    'dev.computeruse.attach',
    {
      computerUseLaneId: lane.id,
      expectedGeneration: attachGeneration,
      direction: 'read',
    },
    { kind: 'computeruse_lane', id: lane.id, generation: attachGeneration }
  )
  const attachGrant = attachReply.ok
    ? (attachReply.value as { direction: string; protocol: string })
    : null
  check(
    attachGrant !== null &&
      attachGrant.direction === 'read' &&
      attachGrant.protocol === 'desktop-frames-v1',
    'dev.computeruse.attach mints a read-direction desktop-frames-v1 grant',
    attachGrant ? `${attachGrant.direction}/${attachGrant.protocol}` : errorCode(attachReply)
  )

  // PROOF D — permissions-page guidance.
  console.log('PROOF D permissions-page guidance (frozen deep links + remediation)')
  check(
    proofService
      .settingsUrl('accessibility')
      .startsWith('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'),
    'denied accessibility routes to the exact Accessibility Settings pane',
    proofService.settingsUrl('accessibility')
  )
  check(
    SETTINGS_PANES.screen_recording.startsWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    ),
    'screen recording guidance names the exact ScreenCapture pane'
  )
  // The remediation object a denial refusal carries, derived from the REAL
  // gate by asking it to issue against the Accessibility refusal outcome
  // through the #471 runner seam (real TCC toggling is not scriptable).
  let denialObject: {
    code: string
    remediation?: { action: string; parameters?: Record<string, string> }
  } | null = null
  {
    const deniedService = createMacPermissionService({
      run: async () => ASSISTIVE_DENIED_OUTCOME,
    })
    const deniedRuntime = registerComputerUseRuntime({
      authority: { registerCommandProvider() {}, registerStreamProvider() {} } as never,
      approvalVerifier,
      scope: SCOPE,
      macPermissions: deniedService,
      engine,
      platform: 'darwin',
    })
    const deniedLane = deniedRuntime.lanes.create({
      scope: SCOPE,
      runtimeSessionId: 'denial-matrix',
    })
    try {
      await deniedRuntime.gate.issue({
        scope: SCOPE,
        lane: { id: deniedLane.id, runtimeSessionId: deniedLane.runtimeSessionId, generation: 1 },
        confirmationId: ownerConfirmation(),
      })
    } catch (error) {
      denialObject = error as {
        code: string
        remediation?: { action: string; parameters?: Record<string, string> }
      }
    }
  }
  check(
    denialObject !== null &&
      denialObject.code === 'permission_denied' &&
      denialObject.remediation?.action === 'open_settings' &&
      denialObject.remediation.parameters?.permissionId === 'accessibility',
    'a denied accessibility refusal carries the open_settings remediation for the right pane'
  )

  // PROOF E — grant-then-revoke within one interaction.
  console.log('PROOF E grant-then-revoke flips authority within one interaction')
  if (consentIssued && issuedConsentId !== '') {
    const mintGeneration = runtime.lanes.get(lane.id).generation
    const inputGrant = await execute(
      'dev.computeruse.input',
      {
        computerUseLaneId: lane.id,
        expectedGeneration: mintGeneration,
        consentId: issuedConsentId,
        direction: 'write',
      },
      { kind: 'computeruse_lane', id: lane.id, generation: mintGeneration }
    )
    check(
      inputGrant.ok,
      'the consumed consent minted its single-use write grant at the active generation'
    )
    // Revoke: takeover drops the consent records synchronously. The very
    // next mint interaction is refused.
    const takeoverGeneration = runtime.lanes.get(lane.id).generation
    const takeover = await execute(
      'dev.computeruse.takeover',
      { computerUseLaneId: lane.id, expectedGeneration: takeoverGeneration },
      { kind: 'computeruse_lane', id: lane.id, generation: takeoverGeneration }
    )
    check(takeover.ok, 'dev.computeruse.takeover suspends agent input instantly')
    const nextGeneration = runtime.lanes.get(lane.id).generation
    const lateMint = await execute(
      'dev.computeruse.input',
      {
        computerUseLaneId: lane.id,
        expectedGeneration: nextGeneration,
        consentId: 'replayed-consent-id',
        direction: 'write',
      },
      { kind: 'computeruse_lane', id: lane.id, generation: nextGeneration }
    )
    check(
      !lateMint.ok,
      'the FIRST interaction after revocation cannot re-mint input authority',
      errorCode(lateMint)
    )
    // Escape path: release returns authority; agent input stays gated on a
    // fresh owner confirmation.
    const releaseGeneration = runtime.lanes.get(lane.id).generation
    const release = await execute(
      'dev.computeruse.release',
      { computerUseLaneId: lane.id, expectedGeneration: releaseGeneration },
      { kind: 'computeruse_lane', id: lane.id, generation: releaseGeneration }
    )
    const released = release.ok
      ? (release.value as { automationOwner: string; state: string })
      : null
    check(
      released !== null && released.automationOwner === 'agent' && released.state === 'idle',
      'Escape (dev.computeruse.release) returns authority to the agent'
    )
  } else {
    // The real snapshot did not prove granted, so the flip is proven at the
    // gate level with the #471 runner seam: an issued consent refuses its
    // next admission once the recorded digest moves (one interaction).
    let deniedNow = false
    const flipRuntime = registerComputerUseRuntime({
      authority: { registerCommandProvider() {}, registerStreamProvider() {} } as never,
      approvalVerifier,
      scope: SCOPE,
      macPermissions: createMacPermissionService({
        run: async () => (deniedNow ? ASSISTIVE_DENIED_OUTCOME : GRANTED_OUTCOME),
      }),
      engine,
      platform: 'darwin',
    })
    const flipLane = flipRuntime.lanes.create({ scope: SCOPE, runtimeSessionId: 'flip-matrix' })
    const consent = await flipRuntime.gate.issue({
      scope: SCOPE,
      lane: { id: flipLane.id, runtimeSessionId: flipLane.runtimeSessionId, generation: 1 },
      confirmationId: ownerConfirmation(),
    })
    flipRuntime.gate.consume({
      consentId: consent.consentId,
      scope: SCOPE,
      laneId: flipLane.id,
      generation: 2,
    })
    await flipRuntime.gate.verifyFresh(consent.consentId)
    // The grant "revokes" (fixture-driven TCC flip): the next verification
    // interaction AFTER the freshness window refuses — the gate re-probes
    // exactly once the recorded window has elapsed.
    deniedNow = true
    await new Promise<void>((resolve) => setTimeout(resolve, PERMISSION_FRESHNESS_MS + 500))
    let refused = false
    let refusalMessage = ''
    try {
      await flipRuntime.gate.verifyFresh(consent.consentId)
    } catch (error) {
      refused = true
      refusalMessage = error instanceof Error ? error.message : String(error)
    }
    check(
      refused,
      'a permission state that moved off the consent digest refuses the next admission after the freshness window (one interaction)',
      refusalMessage.slice(0, 80)
    )
  }
  check(
    engine.injected.length === 0,
    'the recording engine stayed idle: this lane never synthesizes real input',
    `${engine.injected.length} events`
  )

  const ok = checks.every((entry) => entry.ok)
  writeArtifact({
    codeIdentity: { signature, flags: codeFlags },
    probes: {
      proofProcess: proofSnapshot.permissions,
      proofProcessShippedDeadline: defaultDeadlineSnapshot.permissions,
      bundleChild: bundleSnapshot?.permissions ?? null,
      attribution: 'not provable headlessly; both contexts recorded verbatim',
    },
    consentIssuedAgainstRealSnapshot: consentIssued,
  })
  if (!ok) console.error('PACKAGED-COMPUTERUSE-TCC FAILED')
  else console.log('PACKAGED-COMPUTERUSE-TCC PASS')
  return ok ? 0 : 1
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('PACKAGED-COMPUTERUSE-TCC ERROR', error)
    process.exit(1)
  })
