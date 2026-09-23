// Packaged browser/devices evidence matrix (#422, redesigned for #592): the
// packaged-path proofs on the packaged evidence lane (darwin, the Electrobun
// .app built), organized by ENGINE ERA so every row passes on both host
// classes — hosts whose Bun reports no WebView (the typed-unavailable era)
// and hosts whose Bun.WebView reports AVAILABLE (the live CDP engine era).
//
//   1. lane registration through the M10 gate — the production registrar
//      (registerBrowserDeviceRuntime) registers the real dev.browser.* /
//      dev.device.* providers; lanes are created and listed through signed
//      channel commands, with per-kind profile identities and automation
//      owners. (Era-agnostic.)
//   2. universal fail-closed rows — the human_embedded lane never reaches an
//      engine (typed `capability_unavailable`), and an SSRF-target navigation
//      is refused by the provider's admission gate BEFORE any engine
//      involvement, leaving the lane recoverable. (Era-agnostic: both hold
//      with the engine present or absent.)
//   3. real-engine rows — ONLY when Bun.WebView is available: lane
//      provisioning, admitHop-gated navigation (admitted multi-hop redirect,
//      per-hop refused redirect), screenshot publication with provenance,
//      frame publication through a real minted browser-frames-v1 grant
//      attached before the view exists, and crash → typed recovery (an
//      admitted-but-dead owned port yields `crash_loop` and the SAME lane
//      recovers to ready by navigating again). The proof spins up its own
//      loopback HTTP server as the proven Adea-owned service so an admitted
//      navigation actually serves, and it never leaves a lane crashed.
//   4. the SSRF regression matrix — the provider's per-hop admission gate
//      (evaluateNavigation) against the full adversarial vector set,
//      including the hexadecimal IPv4-mapped loopback forms. (Era-agnostic.)
//   5. the typed capability matrix — honest availability probing of the host
//      toolchains, with typed states and guidance, never silent fallbacks.
//      (Era-agnostic.)
//   6. the engine-seam row — with the engine seam cleared through the
//      composition root (`attachBrowserEngine(undefined)`), an admitted
//      navigation is refused with typed `capability_unavailable`: the
//      typed-unavailable contract of the engine-less era, held on every host.
//      Runs LAST so it cannot disturb the real-engine rows.
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
  type DevStreamGrant,
  type Scope,
} from '../../../../packages/types/src/dev-runtime'
import { createChannelAuthority } from '../src/dev-runtime/channel/authority'
import type { ChannelGateway, StreamProvider } from '../src/dev-runtime/channel/server'
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

function skip(description: string, reason: string): void {
  checks.push({ check: description, ok: true, detail: `skipped: ${reason}` })
  console.log(`  skip: ${description} — ${reason}`)
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

/** The engine era of this host's Bun: the matrix's conditioning axis (#592). */
function webViewAvailable(): boolean {
  return typeof (Bun as unknown as Record<string, unknown>).WebView !== 'undefined'
}

// The loopback services the proof speaks about. `served` is bound by the
// proof's own HTTP server (preferred port first, ephemeral fallback so a
// busy developer port never breaks the lane); `dead` is ADMITTED by policy
// but provably without a listener — the crash-recovery vector; `refused` is
// the loopback port that is never owned — the per-hop SSRF vector.
const SERVED_PREFERRED_PORT = 4321
const DEAD_OWNED_PORT = 4399
const REFUSED_LOOPBACK_PORT = 3000

type ProofServer = Readonly<{ port: number; requests: readonly string[]; stop(): void }>

const proofPage = (title: string): string =>
  `<!doctype html><html><head><title>${title}</title></head>` +
  `<body style="background:#ffffff;color:#111;font-size:12px">adea-browser-matrix ${title}</body></html>`

function startProofServer(): ProofServer {
  const requests: string[] = []
  const serve = (port: number): ReturnType<typeof Bun.serve> =>
    Bun.serve({
      port,
      hostname: '127.0.0.1',
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname !== '/favicon.ico') requests.push(url.pathname)
        if (url.pathname === '/redirect')
          return new Response(null, { status: 302, headers: { location: '/' } })
        if (url.pathname === '/redirect-ssrf')
          return new Response(null, {
            status: 302,
            headers: { location: `http://127.0.0.1:${REFUSED_LOOPBACK_PORT}/` },
          })
        return new Response(proofPage(url.pathname === '/' ? 'root' : 'probe'), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      },
    })
  let server: ReturnType<typeof Bun.serve>
  try {
    server = serve(SERVED_PREFERRED_PORT)
  } catch {
    // Preferred port busy on this host: fall back to an ephemeral port and
    // re-point the owned-service record before any policy evaluation.
    server = serve(0)
  }
  const boundPort = server.port
  if (typeof boundPort !== 'number')
    throw new Error('the proof server did not report its bound port')
  return { port: boundPort, requests, stop: () => server.stop(true) }
}

type SsrfRow = {
  name: string
  url: string
  resolved: readonly LaneHostAddress[]
  owned?: readonly AdeaOwnedService[]
  expectAllowed: boolean
}

// The #422 adversarial vector set, verbatim in expectation: per-hop loopback,
// metadata, and refusal cases, including both textual forms of IPv4-mapped
// IPv6 loopback (dotted and hexadecimal). Parameterized only by the bound
// served port of the proof's own loopback server.
function ssrfMatrix(
  ownedServices: readonly AdeaOwnedService[],
  servedPort: number
): readonly SsrfRow[] {
  return [
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
      url: `http://127.0.0.1:${REFUSED_LOOPBACK_PORT}/`,
      resolved: [{ address: '127.0.0.1', family: 4 }],
      expectAllowed: false,
    },
    {
      name: 'loopback target that IS a proven Adea-owned service',
      url: `http://127.0.0.1:${servedPort}/`,
      resolved: [{ address: '127.0.0.1', family: 4 }],
      owned: ownedServices,
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
    {
      name: 'owned loopback port is admitted even with no listener (policy admits; connectivity fails separately)',
      url: `http://127.0.0.1:${DEAD_OWNED_PORT}/`,
      resolved: [{ address: '127.0.0.1', family: 4 }],
      owned: ownedServices,
      expectAllowed: true,
    },
  ]
}

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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

  const engineEra = webViewAvailable() ? 'available' : 'unavailable'
  console.log(`engine era: Bun.WebView ${engineEra} on Bun ${process.versions.bun}`)

  // The proof's own loopback HTTP server is the proven Adea-owned service:
  // an admitted navigation must actually be servable, or the real-engine era
  // could never complete a navigation. The owned-service record is re-pointed
  // if the preferred port was busy, BEFORE any policy evaluation below.
  const proofServer = startProofServer()
  const ownedServices: AdeaOwnedService[] = [
    { host: '127.0.0.1', port: proofServer.port, ownerId: 'probe-owner' },
    { host: '127.0.0.1', port: DEAD_OWNED_PORT, ownerId: 'probe-owner' },
  ]
  const rootUrl = new URL(`http://127.0.0.1:${proofServer.port}/`).href
  try {
    // The production registrar for the browser/device runtime over the M10
    // gate — the real engine seam, present on every host. A gateway stub
    // captures the browser-frames-v1 handler so the frame-publication row can
    // attach a real minted grant without standing up the WebSocket layer.
    let browserFramesHandler: Parameters<ChannelGateway['registerStreamHandler']>[1] | undefined
    const gateway = {
      registerStreamHandler: (
        protocol: string,
        handler: (session: Parameters<StreamProvider>[0]) => void
      ) => {
        if (protocol === 'browser-frames-v1') browserFramesHandler = handler
      },
    } as unknown as ChannelGateway

    // DNS resolution seam: the provider re-resolves per admitted hop. The
    // proof counts invocations so per-hop re-resolution is observable.
    let dnsLookups = 0
    let dnsLookupsAt = 0
    const markDns = (): number => {
      dnsLookupsAt = dnsLookups
      return dnsLookupsAt
    }
    const resolveDns = async (_hostname: string): Promise<readonly LaneHostAddress[]> => {
      dnsLookups += 1
      return []
    }

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
      ownedServices: () => ownedServices,
      resolveDns,
      gateway,
      // Lane profiles stay inside the git-ignored artifact tree, never the
      // user's real Application Support.
      dataDir: join(dirname(artifactPath), 'browser-matrix-profiles'),
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
    const humanLaneId = human.ok ? (human.value as { id: string }).id : ''
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
    check(
      agentAutomationOwner === 'agent',
      'the task-owned lane is agent-automated by construction'
    )
    const listed = await execute('dev.browser.lanes', {})
    check(
      listed.ok && (listed.value as { items: unknown[] }).items.length >= 2,
      'dev.browser.lanes lists the registered lanes',
      listed.ok ? `${(listed.value as { items: unknown[] }).items.length} lanes` : listed.error.code
    )

    const agentResource = { kind: 'browser_lane', id: agentLaneId, generation: 1 }
    const laneStateOf = async (laneId: string): Promise<string> => {
      const reply = await execute('dev.browser.lanes', {})
      const items = reply.ok
        ? (reply.value as { items: { id: string; state: string }[] }).items
        : []
      return items.find((item) => item.id === laneId)?.state ?? 'unknown'
    }

    // 2. Universal fail-closed rows — the same on both engine eras.
    console.log('PROOF B universal fail-closed rows (typed, named, era-agnostic)')
    const humanNavigate = await execute(
      'dev.browser.navigate',
      {
        browserLaneId: humanLaneId,
        expectedGeneration: 1,
        url: rootUrl,
      },
      { kind: 'browser_lane', id: humanLaneId, generation: 1 }
    )
    check(
      !humanNavigate.ok && humanNavigate.error.code === 'capability_unavailable',
      'the human_embedded lane never reaches a lane engine (packaged CEF handle unexposed): typed capability_unavailable',
      humanNavigate.ok
        ? 'unexpectedly ok'
        : `${humanNavigate.error.code}: ${humanNavigate.error.message.slice(0, 80)}`
    )
    check(
      (await laneStateOf(humanLaneId)) === 'ready',
      'the refused human_embedded navigation rolled back to the recoverable ready state, never crashed'
    )
    const ssrfNavigate = await execute(
      'dev.browser.navigate',
      {
        browserLaneId: agentLaneId,
        expectedGeneration: 1,
        url: `http://127.0.0.1:${REFUSED_LOOPBACK_PORT}/`,
      },
      agentResource
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
    check(
      (await laneStateOf(agentLaneId)) === 'provisioning',
      'the pre-engine SSRF refusal never entered the navigating state (no crash, no fake progress)'
    )

    // 3. Real-engine rows — ONLY when Bun.WebView is available on this host.
    // Every row below drives the live Bun.WebView/CDP lane engine through the
    // M10 gate and returns the lane to a healthy state before it ends.
    console.log(
      engineEra === 'available'
        ? 'PROOF C real-engine rows (Bun.WebView/CDP lane engine on this host)'
        : 'PROOF C real-engine rows'
    )
    if (engineEra === 'available') {
      // C0. Lane provisioning + admitted navigation against the serving
      // loopback service.
      markDns()
      const servedRequestsAt = proofServer.requests.length
      const navigateRoot = await execute(
        'dev.browser.navigate',
        { browserLaneId: agentLaneId, expectedGeneration: 1, url: rootUrl },
        agentResource
      )
      const rootReply = navigateRoot.ok
        ? (navigateRoot.value as {
            finalUrl: string
            status?: number
            generation: number
            targetId: string
          })
        : undefined
      check(
        navigateRoot.ok && rootReply?.finalUrl === rootUrl && rootReply.status === 200,
        'an admitted navigation provisions the lane engine and lands on the provider-admitted URL',
        navigateRoot.ok
          ? `${rootReply?.finalUrl} status ${rootReply?.status} generation ${rootReply?.generation}`
          : `${navigateRoot.error.code}: ${navigateRoot.error.message.slice(0, 80)}`
      )
      check(
        (await laneStateOf(agentLaneId)) === 'ready',
        'the lane is ready after a successful admitted navigation (provisioning → navigating → ready)'
      )
      check(
        dnsLookups - dnsLookupsAt >= 1 && proofServer.requests.length > servedRequestsAt,
        'the admission gate resolved DNS itself and the engine connected to the admitted target',
        `${dnsLookups - dnsLookupsAt} resolver calls, server saw ${proofServer.requests.slice(servedRequestsAt).join(' ')}`
      )
      const targets = await execute(
        'dev.browser.targets',
        { browserLaneId: agentLaneId },
        agentResource
      )
      const pageTarget = targets.ok
        ? (targets.value as { items: { type: string; url: string; title: string }[] }).items.find(
            (item) => item.type === 'page'
          )
        : undefined
      check(
        targets.ok && pageTarget?.url === rootUrl && pageTarget.title.length > 0,
        'the live engine publishes the page target with the served URL and title',
        targets.ok ? `${pageTarget?.url} "${pageTarget?.title}"` : targets.error.code
      )

      // C1. admitHop per hop — an admitted redirect chain: BOTH hops are
      // admitted through the provider gate with fresh DNS, and the engine
      // lands on the last admitted URL.
      markDns()
      const redirectRequestsAt = proofServer.requests.length
      const navigateRedirect = await execute(
        'dev.browser.navigate',
        { browserLaneId: agentLaneId, expectedGeneration: 1, url: `${rootUrl}redirect` },
        agentResource
      )
      const redirectReply = navigateRedirect.ok
        ? (navigateRedirect.value as { finalUrl: string; status?: number })
        : undefined
      check(
        navigateRedirect.ok && redirectReply?.finalUrl === rootUrl && redirectReply.status === 200,
        'a redirect chain is admitted per hop through admitHop and lands on the last admitted URL',
        navigateRedirect.ok ? `final ${redirectReply?.finalUrl}` : navigateRedirect.error.code
      )
      check(
        proofServer.requests.slice(redirectRequestsAt).join(' ') === '/redirect /',
        'the engine connected to exactly the admitted hops in order (initial + redirect)',
        `server saw: ${proofServer.requests.slice(redirectRequestsAt).join(' ')}`
      )
      check(
        dnsLookups - dnsLookupsAt >= 2,
        'DNS is re-resolved per hop (initial + re-gate + redirect hop)',
        `${dnsLookups - dnsLookupsAt} resolver calls across the chain`
      )

      // C2. Frame publication (screenshot path): a real capture with the
      // provider-admitted origin as provenance, taken while the view sits on
      // the last admitted URL.
      const screenshot = await execute(
        'dev.browser.screenshot',
        { browserLaneId: agentLaneId, expectedGeneration: 1, format: 'png' },
        agentResource
      )
      const shot = screenshot.ok
        ? (screenshot.value as {
            id: string
            origin: string
            contentType: string
            byteLength: string
          })
        : undefined
      check(
        screenshot.ok &&
          shot?.contentType === 'image/png' &&
          Number(shot.byteLength) > 0 &&
          shot.origin === rootUrl,
        'a screenshot through the live engine carries real bytes and the provider-admitted origin as provenance',
        screenshot.ok
          ? `${shot?.contentType} ${shot?.byteLength}B origin ${shot?.origin}`
          : screenshot.error.code
      )

      // C3. admitHop per hop — a refused redirect: the FIRST hop is admitted
      // (the engine connects), the redirect target is loopback-but-unowned and
      // refused mid-flight; the lane must NOT crash.
      const refusedRequestsAt = proofServer.requests.length
      const navigateRefused = await execute(
        'dev.browser.navigate',
        { browserLaneId: agentLaneId, expectedGeneration: 1, url: `${rootUrl}redirect-ssrf` },
        agentResource
      )
      check(
        !navigateRefused.ok && navigateRefused.error.code === 'ssrf_blocked',
        'a redirect onto an unowned loopback target is refused mid-flight through admitHop (per-hop SSRF)',
        navigateRefused.ok
          ? 'unexpectedly ok'
          : `${navigateRefused.error.code}: ${navigateRefused.error.message.slice(0, 80)}`
      )
      check(
        proofServer.requests.slice(refusedRequestsAt).join(' ') === '/redirect-ssrf',
        'the engine never connected to the refused redirect target',
        `server saw: ${proofServer.requests.slice(refusedRequestsAt).join(' ')}`
      )
      check(
        (await laneStateOf(agentLaneId)) === 'ready',
        'a per-hop SSRF refusal leaves the lane recoverable (ready), never crashed'
      )

      // C4. Frame publication (stream path): a fresh lane, a REAL grant minted
      // through the gate, and the browser-frames-v1 handler attaching BEFORE
      // any view exists — the engine provisions the view at attach and the
      // first screencast frame flows to the session.
      const framesLane = await execute('dev.browser.laneCreate', {
        runtimeSessionId: 'packaged-session-frames',
        kind: 'task_owned',
        profilePolicyId: 'default:task_owned',
      })
      const framesLaneId = framesLane.ok ? (framesLane.value as { id: string }).id : ''
      check(framesLane.ok && framesLaneId !== '', 'the frames lane was created through the gate')
      const attachGrant = await execute(
        'dev.browser.attach',
        { browserLaneId: framesLaneId, expectedGeneration: 1, direction: 'read' },
        { kind: 'browser_lane', id: framesLaneId, generation: 1 }
      )
      const grant = attachGrant.ok ? (attachGrant.value as DevStreamGrant) : undefined
      check(
        attachGrant.ok &&
          grant?.resource.kind === 'browser_lane' &&
          grant.resource.id === framesLaneId &&
          grant.resource.generation === 1,
        'a browser-frames-v1 stream grant minted through the gate binds the lane resource and generation',
        attachGrant.ok ? `grant ${grant?.grantId}` : attachGrant.error.code
      )
      const receivedFrames: Record<string, unknown>[] = []
      const streamCloses: string[] = []
      if (grant && browserFramesHandler) {
        browserFramesHandler({
          grant,
          send: (frame: Record<string, unknown>) => receivedFrames.push(frame),
          close: (code: string, reason?: string) =>
            streamCloses.push(`${code}${reason ? `: ${reason}` : ''}`),
        } as unknown as Parameters<StreamProvider>[0])
        const deadline = Date.now() + 45_000
        while (receivedFrames.length === 0 && streamCloses.length === 0 && Date.now() < deadline)
          await sleep(100)
      }
      const firstFrame = receivedFrames[0] as
        | { type?: string; sequence?: string; bytes?: Uint8Array }
        | undefined
      check(
        firstFrame?.type === 'video' &&
          typeof firstFrame.sequence === 'string' &&
          (firstFrame.bytes?.byteLength ?? 0) > 0 &&
          streamCloses.length === 0,
        'attaching the frame stream provisions the view and publishes real screencast frames',
        firstFrame
          ? `frame type ${firstFrame.type} sequence ${firstFrame.sequence} ${firstFrame.bytes?.byteLength}B`
          : streamCloses.length > 0
            ? `stream closed: ${streamCloses.join('; ')}`
            : 'no frame within the deadline'
      )
      await execute(
        'dev.browser.laneClose',
        { browserLaneId: framesLaneId, expectedGeneration: 1 },
        { kind: 'browser_lane', id: framesLaneId, generation: 1 }
      )

      // C5. Crash → typed recovery: the dead owned port is ADMITTED by the
      // navigation policy (that row is in the SSRF matrix below), so the
      // engine accepts the hop and fails to connect — the lane crashes with
      // the typed crash_loop — and the SAME lane recovers by navigating again.
      const navigateDead = await execute(
        'dev.browser.navigate',
        {
          browserLaneId: agentLaneId,
          expectedGeneration: 1,
          url: `http://127.0.0.1:${DEAD_OWNED_PORT}/`,
        },
        agentResource
      )
      check(
        !navigateDead.ok && navigateDead.error.code === 'crash_loop',
        'an admitted-but-dead owned target crashes the lane with typed crash_loop (no silent fallback)',
        navigateDead.ok
          ? 'unexpectedly ok'
          : `${navigateDead.error.code}: ${navigateDead.error.message.slice(0, 80)}`
      )
      check(
        (await laneStateOf(agentLaneId)) === 'crashed',
        'the registry records the crashed state (crash is observable, not hidden)'
      )
      const recovery = await execute(
        'dev.browser.navigate',
        { browserLaneId: agentLaneId, expectedGeneration: 1, url: rootUrl },
        agentResource
      )
      check(
        recovery.ok && (recovery.value as { finalUrl: string }).finalUrl === rootUrl,
        'the crashed lane recovers by navigating again (crashed → recovering → ready)',
        recovery.ok
          ? `landed ${(recovery.value as { finalUrl: string }).finalUrl}`
          : recovery.error.code
      )
      check(
        (await laneStateOf(agentLaneId)) === 'ready',
        'the recovered lane is ready — the proof never leaves a lane crashed'
      )
    } else {
      skip(
        'real-engine rows (provisioning, admitHop navigation, frames, crash recovery)',
        'Bun.WebView unavailable on this host; the typed-unavailable contract holds via the engine-seam row'
      )
    }

    // Release the engine's live views before the seam row detaches the engine.
    for (const lane of [human, agent]) {
      if (!lane.ok) continue
      const laneId = (lane.value as { id: string }).id
      await execute(
        'dev.browser.laneClose',
        { browserLaneId: laneId, expectedGeneration: 1 },
        { kind: 'browser_lane', id: laneId, generation: 1 }
      )
    }

    // 4. SSRF regression matrix on the per-hop admission gate.
    console.log('PROOF D SSRF regression matrix (per-hop admission gate)')
    const ssrfRows = ssrfMatrix(ownedServices, proofServer.port).map((row) => {
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

    // 5. Typed capability matrix: honest host toolchain probing.
    console.log('PROOF E typed capability matrix (honest availability, no silent fallback)')
    const simctlOutput = await probeTool(['xcrun', 'simctl', 'list', 'devices', '-j'])
    const simctlDevices = simctlOutput.length > 0 ? parseSimctlDevicesJson(simctlOutput) : []
    const adbOutput = await probeTool(['adb', 'devices', '-l'])
    const adbDevices = adbOutput.length > 0 ? parseAdbDevices(adbOutput) : []
    const capabilityMatrix = [
      {
        capability: 'agent browser lane engine (Bun.WebView headless automation)',
        state: engineEra,
        detail: `engine era ${engineEra}`,
        guidance:
          engineEra === 'available'
            ? 'the real-engine rows above exercised the live CDP lane engine on this host'
            : 'this Bun build exposes no WebView; the engine-seam row below proves the typed-unavailable contract',
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

    // 6. Real host device inventory through the gate.
    console.log('PROOF F device inventory through the M10 gate (host tooling)')
    await runtime.refreshDevices()
    const deviceList = await execute('dev.device.list', {})
    check(
      deviceList.ok,
      'dev.device.list returns through the gate',
      deviceList.ok
        ? `${(deviceList.value as { items?: unknown[] }).items?.length ?? 0} inventory items`
        : deviceList.error.code
    )

    // 7. Engine-seam row (runs on BOTH eras, last): with the engine seam
    // cleared through the composition root, an admitted navigation is refused
    // with the typed capability_unavailable — the engine-less era contract.
    console.log('PROOF G engine seam cleared: typed-unavailable navigation contract')
    runtime.attachBrowserEngine(undefined)
    const seamLane = await execute('dev.browser.laneCreate', {
      runtimeSessionId: 'packaged-session-seam',
      kind: 'task_owned',
      profilePolicyId: 'default:task_owned',
    })
    const seamLaneId = seamLane.ok ? (seamLane.value as { id: string }).id : ''
    check(seamLane.ok && seamLaneId !== '', 'the seam-row lane was created through the gate')
    const seamNavigate = await execute(
      'dev.browser.navigate',
      { browserLaneId: seamLaneId, expectedGeneration: 1, url: rootUrl },
      { kind: 'browser_lane', id: seamLaneId, generation: 1 }
    )
    check(
      !seamNavigate.ok && seamNavigate.error.code === 'capability_unavailable',
      'an admitted navigation without an attached engine is refused with typed capability_unavailable (no fake engine)',
      seamNavigate.ok
        ? 'unexpectedly ok'
        : `${seamNavigate.error.code}: ${seamNavigate.error.message.slice(0, 80)}`
    )
    check(
      (await laneStateOf(seamLaneId)) === 'ready',
      'the typed-unavailable refusal leaves the lane recoverable (ready), never crashed'
    )
    const seamClose = await execute(
      'dev.browser.laneClose',
      { browserLaneId: seamLaneId, expectedGeneration: 1 },
      { kind: 'browser_lane', id: seamLaneId, generation: 1 }
    )
    check(seamClose.ok, 'the seam-row lane closed cleanly with no engine attached')

    const ok = checks.every((entry) => entry.ok)
    mkdirSync(dirname(artifactPath), { recursive: true })
    writeFileSync(
      artifactPath,
      JSON.stringify(
        {
          lane: 'packaged-browser-matrix',
          issues: ['422', '592'],
          spec: 'docs/specs/dev-runtime.md (browser lanes; ADR 0006)',
          mode: `packaged-lane (production registrar modules; engine era: ${engineEra})`,
          engineEra,
          appBundle,
          startedAt,
          finishedAt: new Date().toISOString(),
          bun: process.versions.bun,
          command:
            'bun apps/desktop/shell/scripts/packaged-browser-matrix.ts --app-bundle <Adea-dev.app>',
          proofServer: { port: proofServer.port, requests: proofServer.requests },
          ...(engineEra === 'available'
            ? {
                ssrfNavigation: {
                  deadOwnedPort: DEAD_OWNED_PORT,
                  refusedLoopbackPort: REFUSED_LOOPBACK_PORT,
                },
              }
            : {}),
          ssrfMatrix: ssrfRows,
          capabilityMatrix,
          outOfScope:
            engineEra === 'available'
              ? {}
              : {
                  lane: 'real browser lane engine (Bun.WebView / CDP) navigation + screenshots through the admission gate',
                  reason: 'no WebView on this Bun; recorded as typed-unavailable, never faked',
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
  } finally {
    proofServer.stop()
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('PACKAGED-BROWSER-MATRIX ERROR', error)
    process.exit(1)
  })
