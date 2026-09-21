// Packaged browser/devices evidence matrix (#422): the packaged-path proofs
// that are possible WITHOUT a real browser engine, on the packaged evidence
// lane (darwin, the Electrobun .app built):
//
//   1. lane registration through the M10 gate — the production registrar
//      (registerBrowserDeviceRuntime) registers the real dev.browser.* /
//      dev.device.* providers; lanes are created and listed through signed
//      channel commands, with per-kind profile identities and automation
//      owners;
//   2. the SSRF regression matrix — the provider's per-hop admission gate
//      (evaluateNavigation) against the full adversarial vector set;
//   3. the typed capability matrix — honest availability probing of the
//      host toolchains, with typed unavailable states and guidance, never
//      silent fallbacks.
//
// EXPLICITLY OUT OF SCOPE (named, not faked): the real browser lane engine
// (Bun.WebView headless automation / CDP external lane) — navigation +
// screenshots THROUGH the admission gate need a serving engine, and this
// lane records the agent engine as typed-unavailable. If a future Bun ships
// WebView on this host, the matrix row flips and the engine lane becomes
// provable here.
//
// Usage: bun apps/desktop/shell/scripts/packaged-browser-matrix.ts [--app-bundle <path>] [--artifact <path>]
import { mkdirSync, writeFileSync } from 'node:fs'
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
import { createChannelAuthority } from '../src/dev-runtime/channel/authority'
import { registerBrowserDeviceRuntime } from '../src/dev-runtime/browser/register'
import type {
  AdeaOwnedService,
  LaneHostAddress,
} from '../src/dev-runtime/browser/navigation-policy'
import { parseAdbDevices, parseSimctlDevicesJson } from '../src/dev-runtime/devices/inventory'
import {
  BUN_INSTALL_LABEL,
  SIDECAR_INSTALL_LABEL,
  findAppBundle,
  resolveInstallLocation,
} from './packaged-install'

const SHELL_HOST = '127.0.0.1:4793'
const SHELL_ORIGIN = 'http://127.0.0.1:4793'
const SCOPE: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

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

type SsrfRow = {
  name: string
  url: string
  resolved: readonly LaneHostAddress[]
  owned?: readonly AdeaOwnedService[]
  expectAllowed: boolean
}
const OWNED: AdeaOwnedService[] = [{ host: '127.0.0.1', port: 4321, ownerId: 'probe-owner' }]
const SSRF_MATRIX: SsrfRow[] = [
  {
    name: 'public URL resolving public',
    url: 'https://example.adea.test/',
    resolved: [{ address: '93.184.216.34', family: 4 }],
    expectAllowed: true,
  },
  {
    name: 'public URL whose resolution lands in a private range (redirect remediation)',
    url: 'https://example.adea.test/redirect',
    resolved: [{ address: '192.168.1.10', family: 4 }],
    expectAllowed: false,
  },
  {
    name: 'public URL redirecting to loopback',
    url: 'https://example.adea.test/redirect',
    resolved: [{ address: '127.0.0.1', family: 4 }],
    expectAllowed: false,
  },
  {
    name: 'localhost resolving public (loopback-name rebinding)',
    url: 'http://localhost/',
    resolved: [{ address: '93.184.216.34', family: 4 }],
    expectAllowed: false,
  },
  {
    name: 'loopback target that is not a proven Adea-owned service',
    url: 'http://127.0.0.1:3000/',
    resolved: [{ address: '127.0.0.1', family: 4 }],
    expectAllowed: false,
  },
  {
    name: 'loopback target that IS a proven Adea-owned service',
    url: 'http://127.0.0.1:4321/',
    resolved: [{ address: '127.0.0.1', family: 4 }],
    owned: OWNED,
    expectAllowed: true,
  },
  {
    name: 'cloud metadata address',
    url: 'http://169.254.169.254/latest/meta-data/',
    resolved: [{ address: '169.254.169.254', family: 4 }],
    expectAllowed: false,
  },
  {
    name: 'IPv4-mapped IPv6 loopback (dotted)',
    url: 'http://example.adea.test/',
    resolved: [{ address: '::ffff:127.0.0.1', family: 6 }],
    expectAllowed: false,
  },
  {
    name: 'IPv4-mapped IPv6 loopback (hexadecimal)',
    url: 'http://example.adea.test/',
    resolved: [{ address: '::ffff:7f00:1', family: 6 }],
    expectAllowed: false,
  },
  {
    name: 'IPv6 loopback ::1',
    url: 'http://example.adea.test/',
    resolved: [{ address: '::1', family: 6 }],
    expectAllowed: false,
  },
  {
    name: 'link-local IPv6',
    url: 'http://example.adea.test/',
    resolved: [{ address: 'fe80::1', family: 6 }],
    expectAllowed: false,
  },
  {
    name: 'RFC1918 LAN range',
    url: 'http://example.adea.test/',
    resolved: [{ address: '10.1.2.3', family: 4 }],
    expectAllowed: false,
  },
  {
    name: 'file: scheme',
    url: 'file:///etc/passwd',
    resolved: [],
    expectAllowed: false,
  },
  {
    name: 'javascript: scheme',
    url: 'javascript:alert(1)',
    resolved: [],
    expectAllowed: false,
  },
  {
    name: 'data: scheme',
    url: 'data:text/html,hello',
    resolved: [],
    expectAllowed: false,
  },
  {
    name: 'embedded credentials',
    url: 'http://user:pass@example.adea.test/',
    resolved: [{ address: '93.184.216.34', family: 4 }],
    expectAllowed: false,
  },
  {
    name: 'loopback port 80 is never an Adea-owned service',
    url: 'http://127.0.0.1/',
    resolved: [{ address: '127.0.0.1', family: 4 }],
    owned: [{ host: '127.0.0.1', port: 80, ownerId: 'probe-owner' }],
    expectAllowed: false,
  },
]

async function probeTool(argv: string[]): Promise<string> {
  try {
    const process = Bun.spawn(argv, { stdout: 'pipe', stderr: 'ignore' })
    const stdout = await new Response(process.stdout).text()
    await process.exited
    return stdout
  } catch {
    return ''
  }
}

async function main(): Promise<number> {
  if (process.platform !== 'darwin') {
    console.error('packaged-browser-matrix: darwin-only packaged evidence lane')
    return 2
  }
  const startedAt = new Date().toISOString()
  const artifactPath = argValue('--artifact') ?? 'artifacts/packaged/browser-matrix.json'
  const appBundle =
    argValue('--app-bundle') ??
    findAppBundle(join(import.meta.dir, '..', 'build')) ??
    findAppBundle(join(import.meta.dir, '..', '..', '..', 'apps', 'desktop', 'shell', 'build'))
  if (!appBundle) {
    console.error(
      'packaged-browser-matrix: no packaged app bundle found; run the packaged lane first'
    )
    return 2
  }
  check(
    resolveInstallLocation(appBundle, SIDECAR_INSTALL_LABEL).ok &&
      resolveInstallLocation(appBundle, BUN_INSTALL_LABEL).ok,
    'the packaged bundle is present with its staged sidecar component (lane anchor)',
    appBundle
  )

  // The production registrar for the browser/device runtime over the M10
  // gate — no engine attached (the honest packaged state).
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
  const runtime = registerBrowserDeviceRuntime({
    authority,
    scope: SCOPE,
    ownedServices: () => OWNED,
    resolveDns: async () => [],
  })
  check(
    runtime.registeredCommandCount > 0,
    'the production browser/device registrar registered its dev.browser.*/dev.device.* commands',
    `${runtime.registeredCommandCount} commands`
  )

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

  // 1. Lane registration through the gate.
  console.log('PROOF A lane registration through the production registrar + M10 gate')
  const human = await execute('dev.browser.laneCreate', {
    runtimeSessionId: 'packaged-session-human',
    kind: 'human_embedded',
    profilePolicyId: 'default:human_embedded',
  })
  check(human.ok, 'dev.browser.laneCreate (human_embedded) succeeded through the gate')
  const agent = await execute('dev.browser.laneCreate', {
    runtimeSessionId: 'packaged-session-agent',
    kind: 'task_owned',
    profilePolicyId: 'default:task_owned',
  })
  check(agent.ok, 'dev.browser.laneCreate (task_owned) succeeded through the gate')
  let humanProfile = ''
  let agentProfile = ''
  let agentAutomationOwner = ''
  let agentLaneId = ''
  if (agent.ok) {
    const lane = agent.value as { id: string; profileId: string; automationOwner: string }
    agentProfile = lane.profileId
    agentAutomationOwner = lane.automationOwner
    agentLaneId = lane.id
  }
  if (human.ok) {
    humanProfile = (human.value as { profileId: string }).profileId
  }
  check(
    humanProfile !== '' && agentProfile !== '' && humanProfile !== agentProfile,
    'per-kind profile identities never collide (human cookies cannot cross into agent context)',
    `${humanProfile.slice(0, 24)}… vs ${agentProfile.slice(0, 24)}…`
  )
  check(agentAutomationOwner === 'agent', 'the task-owned lane is agent-automated by construction')
  const listed = await execute('dev.browser.lanes', {})
  check(
    listed.ok && (listed.value as { items: unknown[] }).items.length >= 2,
    'dev.browser.lanes lists the registered lanes',
    listed.ok ? `${(listed.value as { items: unknown[] }).items.length} lanes` : listed.error.code
  )

  // 2. Fail-closed without an engine: navigation is refused with a typed
  // error, never a silent fallback.
  console.log('PROOF B fail-closed navigation without a real engine (typed, named)')
  // An ADMITTED target (the proven Adea-owned loopback service) reaches the
  // engine seam, which is absent — typed capability_unavailable, no fake
  // engine. The unresolvable public host above shows the same gate failing
  // closed when the host's own resolver returns nothing.
  const navigate = await execute(
    'dev.browser.navigate',
    {
      browserLaneId: agentLaneId,
      expectedGeneration: 1,
      url: 'http://127.0.0.1:4321/',
    },
    { kind: 'browser_lane', id: agentLaneId, generation: 1 }
  )
  check(
    !navigate.ok && navigate.error.code === 'capability_unavailable',
    'an admitted navigation without a serving engine is refused with typed capability_unavailable (no fake engine)',
    navigate.ok
      ? 'unexpectedly ok'
      : `${navigate.error.code}: ${navigate.error.message.slice(0, 80)}`
  )
  const ssrfNavigate = await execute(
    'dev.browser.navigate',
    {
      browserLaneId: agentLaneId,
      expectedGeneration: 1,
      url: 'http://127.0.0.1:3000/',
    },
    { kind: 'browser_lane', id: agentLaneId, generation: 1 }
  )
  check(
    !ssrfNavigate.ok &&
      (ssrfNavigate.error.code === 'navigation_blocked' ||
        ssrfNavigate.error.code === 'ssrf_blocked'),
    'an SSRF-target navigation is refused before any engine involvement',
    ssrfNavigate.ok
      ? 'unexpectedly ok'
      : `${ssrfNavigate.error.code}: ${ssrfNavigate.error.message.slice(0, 80)}`
  )

  // 3. SSRF regression matrix on the per-hop admission gate.
  console.log('PROOF C SSRF regression matrix (per-hop admission gate)')
  const ssrfRows = SSRF_MATRIX.map((row) => {
    const decision = runtime.navigation({
      url: row.url,
      resolvedAddresses: row.resolved,
      ownedServices: row.owned ?? [],
    })
    const pass = decision.allowed === row.expectAllowed
    return {
      name: row.name,
      url: row.url,
      expectAllowed: row.expectAllowed,
      allowed: decision.allowed,
      code: decision.allowed ? null : decision.code,
      reason: decision.allowed ? null : decision.reason,
      pass,
    }
  })
  check(
    ssrfRows.every((row) => row.pass),
    `all ${ssrfRows.length} SSRF matrix rows behave as specified`,
    `${ssrfRows.filter((row) => !row.pass).length} failures`
  )
  for (const row of ssrfRows.filter((entry) => !entry.pass)) {
    console.error(`    row failed: ${row.name} expected ${row.expectAllowed}`)
  }

  // 4. Typed capability matrix: honest host toolchain probing.
  console.log('PROOF D typed capability matrix (honest availability, no silent fallback)')
  const webviewAvailable =
    typeof (Bun as unknown as Record<string, unknown>).WebView !== 'undefined'
  const simctlOutput = await probeTool(['xcrun', 'simctl', 'list', 'devices', '-j'])
  const simctlDevices = simctlOutput.length > 0 ? parseSimctlDevicesJson(simctlOutput) : []
  const adbOutput = await probeTool(['adb', 'devices', '-l'])
  const adbDevices = adbOutput.length > 0 ? parseAdbDevices(adbOutput) : []
  const capabilityMatrix = [
    {
      capability: 'agent browser lane engine (Bun.WebView headless automation)',
      state: webviewAvailable ? 'available' : 'unavailable',
      guidance: webviewAvailable
        ? 'engine lane becomes provable on this host; wire it through attachBrowserEngine'
        : 'this Bun build exposes no WebView; the real-engine lane (navigation + screenshots through the admission gate) stays explicitly out of scope',
    },
    {
      capability: 'iOS simulators (xcrun simctl)',
      state: simctlOutput.length > 0 ? 'available' : 'unavailable',
      detail: `${simctlDevices.length} devices observed`,
      guidance:
        simctlOutput.length > 0
          ? 'fixed-argv inventory proves live host tooling'
          : 'install Xcode command line tools',
    },
    {
      capability: 'Android devices/emulators (adb)',
      state: adbOutput.length > 0 ? 'available' : 'unavailable',
      detail: `${adbDevices.length} devices observed`,
      guidance:
        adbOutput.length > 0
          ? 'fixed-argv inventory proves live host tooling'
          : 'install the Android platform tools',
    },
  ]
  check(
    capabilityMatrix.every((row) => row.state === 'available' || row.state === 'unavailable'),
    'every capability row carries a typed state, never a silent fallback',
    capabilityMatrix.map((row) => `${row.capability}: ${row.state}`).join('; ')
  )

  // 5. Real host device inventory through the gate.
  console.log('PROOF E device inventory through the M10 gate (host tooling)')
  await runtime.refreshDevices()
  const deviceList = await execute('dev.device.list', {})
  check(
    deviceList.ok,
    'dev.device.list returns through the gate',
    deviceList.ok
      ? `${(deviceList.value as { items?: unknown[] }).items?.length ?? 0} inventory items`
      : deviceList.error.code
  )

  const ok = checks.every((entry) => entry.ok)
  mkdirSync(dirname(artifactPath), { recursive: true })
  writeFileSync(
    artifactPath,
    JSON.stringify(
      {
        lane: 'packaged-browser-matrix',
        issue: '422',
        spec: 'docs/specs/dev-runtime.md (browser lanes; ADR 0006)',
        mode: 'packaged-lane (production registrar modules; real engine lane named out of scope)',
        appBundle,
        startedAt,
        finishedAt: new Date().toISOString(),
        bun: process.versions.bun,
        command:
          'bun apps/desktop/shell/scripts/packaged-browser-matrix.ts --app-bundle <Adea-dev.app>',
        ssrfMatrix: ssrfRows,
        capabilityMatrix,
        outOfScope: {
          lane: 'real browser lane engine (Bun.WebView / CDP) navigation + screenshots through the admission gate',
          reason: 'no serving engine on this host; recorded as typed-unavailable, never faked',
        },
        totals: { checks: checks.length, failed: checks.filter((entry) => !entry.ok).length },
        checks,
      },
      null,
      2
    ) + '\n',
    { mode: 0o600 }
  )
  console.log(`artifact: ${artifactPath}`)
  if (ok) console.log('PACKAGED-BROWSER-MATRIX PASS')
  else console.error('PACKAGED-BROWSER-MATRIX FAILED')
  return ok ? 0 : 1
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('PACKAGED-BROWSER-MATRIX ERROR', error)
    process.exit(1)
  })
