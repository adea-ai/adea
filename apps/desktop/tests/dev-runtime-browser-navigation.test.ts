// Provider-controlled navigation policy enforcement (remediation gate):
// every network hop — the initial URL and every redirect target — passes the
// provider's admission gate with fresh DNS, and an engine-reported final URL
// is verified against the provider's admitted-hop ledger. The fake engine
// here follows redirects ONLY through the gate, mirroring how a real engine
// must (CDP request interception); a bypassing engine is also exercised.
import { describe, expect, test } from 'bun:test'

import type { DevCommand } from '../../../packages/types/src/dev-runtime'
import { devOperationDefinitions } from '../../../packages/types/src/dev-runtime'

import {
  createBrowserLaneRegistry,
  type BrowserLaneRecord,
} from '../shell/src/dev-runtime/browser/lane-registry'
import type { LaneDiagnostics } from '../shell/src/dev-runtime/browser/diagnostics'
import {
  DevCommandProviderError,
  createBrowserProviders,
  type LaneEngine,
  type LaneHostAddress,
  type LaneNavigationHooks,
} from '../shell/src/dev-runtime/browser/providers'

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
} as const
const sessionId = '00000000-0000-4000-8000-0000000000b1'

/** Mutable DNS answers so tests can rebind a hostname between hops. */
type DnsAnswers = Map<string, LaneHostAddress[]>

const PUBLIC = [{ address: '93.184.216.34', family: 4 as const }]

function harness(dns: DnsAnswers, engine?: LaneEngine) {
  const lanes = createBrowserLaneRegistry()
  const diagnosticsMap = new Map<string, LaneDiagnostics>()
  const runtime = createBrowserProviders({
    lanes,
    diagnostics: diagnosticsMap,
    resolveDns: async (hostname) => dns.get(hostname) ?? [],
    ownedServices: () => [{ host: '127.0.0.1', port: 5173, ownerId: 'launch-1' }],
    screenshotRecorder: {
      record: () => {
        throw new Error('screenshots are not part of the navigation suite')
      },
    },
    ...(engine ? { engine } : {}),
  })
  return {
    lanes,
    providers: runtime.providers,
    runtime,
    diagnosticsMap,
    diagnosticsFor: runtime.diagnosticsFor,
  }
}

function command(
  operation: keyof typeof devOperationDefinitions,
  body: Record<string, unknown>
): DevCommand {
  const definition = devOperationDefinitions[operation]
  return {
    schemaVersion: 1,
    operation,
    requestId: '00000000-0000-4000-8000-000000000004',
    nonce: 'dGhpcy1ub25jZS1oYXMtYXQtbGVhc3QtMTI4LWJpdHM',
    issuedAt: '2026-09-19T12:00:00.000Z',
    expiresAt: '2026-09-19T12:01:00.000Z',
    scope,
    capabilities: definition.capabilities,
    ...(definition.resource
      ? {
          resource: {
            kind: definition.resource.kind,
            id: String(body[definition.resource.idField]),
            generation: Number(body.expectedGeneration ?? 1),
          },
        }
      : {}),
    body,
  }
}

async function makeLane(
  providers: ReturnType<typeof createBrowserProviders>['providers']
): Promise<BrowserLaneRecord> {
  return (await providers['dev.browser.laneCreate']!(
    command('dev.browser.laneCreate', { runtimeSessionId: sessionId, kind: 'task_owned' })
  )) as BrowserLaneRecord
}

type RedirectTable = Readonly<Record<string, string | undefined>>

/**
 * A fake lane engine that mirrors the mandatory real-engine behavior: it
 * connects to a URL only AFTER the gate admitted it, records the pinned
 * addresses per hop, follows the scripted redirect table, and reports where
 * it landed (`lieAboutFinalUrl` simulates a misbehaving engine).
 */
function gateFollowingEngine(options: {
  redirects: RedirectTable
  statuses?: Readonly<Record<string, number>>
  lieAboutFinalUrl?: string
  /** Skips the gate entirely — a contract-violating engine. */
  bypassGate?: boolean
}) {
  const connections: string[] = []
  const pinnedPerHop: LaneHostAddress[][] = []
  const gateCalls: string[] = []
  const engine: LaneEngine = {
    targets: () => [],
    screenshot: async () => ({ bytes: new Uint8Array([1]), width: 1, height: 1 }),
    inspect: async () => ({}),
    async navigate(_lane, url, hooks: LaneNavigationHooks) {
      const hops: { url: string; status: number }[] = []
      let current = url
      for (let guard = 0; guard < 32; guard += 1) {
        if (!options.bypassGate) {
          gateCalls.push(current)
          const admission = await hooks.admitHop(current)
          if (!admission.allowed)
            throw new DevCommandProviderError(admission.code, admission.reason)
          if (admission.allowed) pinnedPerHop.push([...admission.pinnedAddresses])
        }
        connections.push(current)
        const status = options.statuses?.[current] ?? 200
        const location = options.redirects[current]
        hops.push({ url: current, status })
        if (!location) {
          return {
            targetId: 'target-1',
            finalUrl: options.lieAboutFinalUrl ?? current,
            status,
            hops,
          }
        }
        current = location
      }
      throw new DevCommandProviderError('navigation_blocked', 'fake engine guard tripped')
    },
  }
  return { engine, connections, pinnedPerHop, gateCalls }
}

describe('per-hop SSRF enforcement (redirect remediation)', () => {
  test('a public URL redirecting to 127.0.0.1 is refused before the engine connects', async () => {
    const dns: DnsAnswers = new Map([
      ['public.test', PUBLIC],
      ['127.0.0.1', [{ address: '127.0.0.1', family: 4 }]],
    ])
    const fake = gateFollowingEngine({
      redirects: { 'http://public.test/': 'http://127.0.0.1:9999/' },
    })
    const h = harness(dns, fake.engine)
    const lane = await makeLane(h.providers)
    const error = await h.providers['dev.browser.navigate']!(
      command('dev.browser.navigate', {
        browserLaneId: lane.id,
        expectedGeneration: lane.generation,
        url: 'http://public.test/',
      })
    ).catch((caught: DevCommandProviderError) => caught)
    expect(error).toBeInstanceOf(DevCommandProviderError)
    expect((error as DevCommandProviderError).code).toBe('ssrf_blocked')
    // The engine never connected to the refused hop.
    expect(fake.connections).toEqual(['http://public.test/'])
    // The lane is not stranded: the transient navigating state rolled back.
    expect(h.lanes.get(lane.id).state).toBe('ready')
    expect(h.diagnosticsMap.get(lane.id)?.size()).toBeGreaterThan(0)
  })

  test('a redirect to hexadecimal IPv4-mapped IPv6 loopback is refused', async () => {
    const dns: DnsAnswers = new Map([['public.test', PUBLIC]])
    const fake = gateFollowingEngine({
      redirects: { 'http://public.test/': 'http://[::ffff:7f00:1]:8080/' },
    })
    const h = harness(dns, fake.engine)
    const lane = await makeLane(h.providers)
    await expect(
      h.providers['dev.browser.navigate']!(
        command('dev.browser.navigate', {
          browserLaneId: lane.id,
          expectedGeneration: lane.generation,
          url: 'http://public.test/',
        })
      )
    ).rejects.toMatchObject({ code: 'ssrf_blocked' })
    expect(fake.connections).toEqual(['http://public.test/'])
  })

  test('a redirect to the cloud metadata address is refused', async () => {
    const dns: DnsAnswers = new Map([
      ['public.test', PUBLIC],
      ['169.254.169.254', [{ address: '169.254.169.254', family: 4 }]],
    ])
    const fake = gateFollowingEngine({
      redirects: { 'http://public.test/': 'http://169.254.169.254/latest/meta-data/' },
    })
    const h = harness(dns, fake.engine)
    const lane = await makeLane(h.providers)
    await expect(
      h.providers['dev.browser.navigate']!(
        command('dev.browser.navigate', {
          browserLaneId: lane.id,
          expectedGeneration: lane.generation,
          url: 'http://public.test/',
        })
      )
    ).rejects.toMatchObject({ code: 'ssrf_blocked' })
    expect(fake.connections).toEqual(['http://public.test/'])
  })

  test('DNS rebinding between hops is refused on the second pass', async () => {
    const PRIVATE = [{ address: '10.0.0.5', family: 4 as const }]
    // The first two resolutions serve the initial hop (pre-pass + the
    // engine's one allowed re-gate); the redirect hop re-resolves private.
    let resolutions = 0
    const fake = gateFollowingEngine({
      redirects: { 'http://cdn.test/a': 'http://cdn.test/b' },
    })
    const lanes = createBrowserLaneRegistry()
    const diagnosticsMap = new Map<string, LaneDiagnostics>()
    const runtime = createBrowserProviders({
      lanes,
      diagnostics: diagnosticsMap,
      resolveDns: async () => {
        resolutions += 1
        return resolutions <= 2 ? PUBLIC : PRIVATE
      },
      ownedServices: () => [],
      screenshotRecorder: {
        record: () => {
          throw new Error('screenshots are not part of the navigation suite')
        },
      },
      engine: fake.engine,
    })
    const lane = (await runtime.providers['dev.browser.laneCreate']!(
      command('dev.browser.laneCreate', { runtimeSessionId: sessionId, kind: 'task_owned' })
    )) as BrowserLaneRecord
    await expect(
      runtime.providers['dev.browser.navigate']!(
        command('dev.browser.navigate', {
          browserLaneId: lane.id,
          expectedGeneration: lane.generation,
          url: 'http://cdn.test/a',
        })
      )
    ).rejects.toMatchObject({ code: 'ssrf_blocked' })
    expect(fake.connections).toEqual(['http://cdn.test/a'])
    expect(lanes.get(lane.id).state).toBe('ready')
  })

  test('a clean redirect chain lands on the LAST provider-admitted URL, not the requested one', async () => {
    const dns: DnsAnswers = new Map([
      ['a.test', PUBLIC],
      ['b.test', [{ address: '93.184.216.35', family: 4 }]],
      ['c.test', [{ address: '93.184.216.36', family: 4 }]],
    ])
    const fake = gateFollowingEngine({
      redirects: {
        'http://a.test/': 'http://b.test/mid',
        'http://b.test/mid': 'http://c.test/final',
      },
      statuses: { 'http://a.test/': 302, 'http://b.test/mid': 301 },
    })
    const h = harness(dns, fake.engine)
    const lane = await makeLane(h.providers)
    const reply = (await h.providers['dev.browser.navigate']!(
      command('dev.browser.navigate', {
        browserLaneId: lane.id,
        expectedGeneration: lane.generation,
        url: 'http://a.test/',
      })
    )) as { finalUrl: string; status: number }
    expect(reply.finalUrl).toBe('http://c.test/final')
    expect(reply.status).toBe(200)
    expect(fake.connections).toEqual(['http://a.test/', 'http://b.test/mid', 'http://c.test/final'])
    // Each hop was pinned to that hop's fresh resolution.
    expect(fake.pinnedPerHop[0]).toEqual(PUBLIC)
    expect(fake.pinnedPerHop[1]).toEqual([{ address: '93.184.216.35', family: 4 }])
    expect(fake.pinnedPerHop[2]).toEqual([{ address: '93.184.216.36', family: 4 }])
    expect(h.lanes.get(lane.id).state).toBe('ready')
  })

  test('an engine-reported final URL that policy never admitted fails closed', async () => {
    const dns: DnsAnswers = new Map([
      ['public.test', PUBLIC],
      ['evil.test', PUBLIC],
    ])
    const fake = gateFollowingEngine({
      redirects: {},
      // The engine claims it stayed on the admitted URL but "landed" on an
      // never-admitted one — e.g. it followed a redirect without the gate.
      lieAboutFinalUrl: 'http://evil.test/secret',
    })
    const h = harness(dns, fake.engine)
    const lane = await makeLane(h.providers)
    await expect(
      h.providers['dev.browser.navigate']!(
        command('dev.browser.navigate', {
          browserLaneId: lane.id,
          expectedGeneration: lane.generation,
          url: 'http://public.test/',
        })
      )
    ).rejects.toMatchObject({ code: 'ssrf_blocked' })
    // A lying engine can no longer be trusted: the lane is crashed.
    expect(h.lanes.get(lane.id).state).toBe('crashed')
    const messages = h.diagnosticsMap
      .get(lane.id)
      ?.page()
      .items.map((entry) => entry.message)
      .join('\n')
    expect(messages).toContain('violated navigation policy')
  })

  test('an engine that bypasses the gate fails closed when it lands anywhere else', async () => {
    const dns: DnsAnswers = new Map([
      ['public.test', PUBLIC],
      ['evil.test', PUBLIC],
    ])
    // No gate calls at all, and the engine "lands" on a never-admitted URL:
    // exactly what a malicious or broken engine would do mid-redirect.
    const fake = gateFollowingEngine({
      redirects: {},
      bypassGate: true,
      lieAboutFinalUrl: 'http://evil.test/secret',
    })
    const h = harness(dns, fake.engine)
    const lane = await makeLane(h.providers)
    await expect(
      h.providers['dev.browser.navigate']!(
        command('dev.browser.navigate', {
          browserLaneId: lane.id,
          expectedGeneration: lane.generation,
          url: 'http://public.test/',
        })
      )
    ).rejects.toMatchObject({ code: 'ssrf_blocked' })
    expect(fake.connections).toContain('http://public.test/')
    expect(h.lanes.get(lane.id).state).toBe('crashed')
  })

  test('a gate-free engine landing on the pre-admitted initial URL still cannot escape policy', async () => {
    const dns: DnsAnswers = new Map([['public.test', PUBLIC]])
    // The initial URL was already admitted (and DNS-pinned) by the provider's
    // pre-pass, so a redundant-gate engine landing there reports a truthful
    // final URL — the reply's finalUrl is the provider-admitted one either way.
    const fake = gateFollowingEngine({ redirects: {}, bypassGate: true })
    const h = harness(dns, fake.engine)
    const lane = await makeLane(h.providers)
    const reply = (await h.providers['dev.browser.navigate']!(
      command('dev.browser.navigate', {
        browserLaneId: lane.id,
        expectedGeneration: lane.generation,
        url: 'http://public.test/',
      })
    )) as { finalUrl: string }
    expect(reply.finalUrl).toBe('http://public.test/')
    expect(h.lanes.get(lane.id).state).toBe('ready')
  })

  test('redirect loops are refused by the provider, not just the engine', async () => {
    const dns: DnsAnswers = new Map([['a.test', PUBLIC]])
    const fake = gateFollowingEngine({
      redirects: { 'http://a.test/loop': 'http://a.test/loop' },
    })
    const h = harness(dns, fake.engine)
    const lane = await makeLane(h.providers)
    const error = await h.providers['dev.browser.navigate']!(
      command('dev.browser.navigate', {
        browserLaneId: lane.id,
        expectedGeneration: lane.generation,
        url: 'http://a.test/loop',
      })
    ).catch((caught: DevCommandProviderError) => caught)
    expect((error as DevCommandProviderError).code).toBe('navigation_blocked')
    expect((error as DevCommandProviderError).message).toContain('redirect loop')
    expect(h.lanes.get(lane.id).state).toBe('ready')
  })

  test('redirect chains longer than the hop ceiling are refused', async () => {
    const dns: DnsAnswers = new Map()
    const redirects: Record<string, string> = {}
    for (let index = 0; index < 14; index += 1) {
      dns.set(`hop${index}.test`, PUBLIC)
      redirects[`http://hop${index}.test/`] = `http://hop${index + 1}.test/`
    }
    const fake = gateFollowingEngine({ redirects })
    const h = harness(dns, fake.engine)
    const lane = await makeLane(h.providers)
    const error = await h.providers['dev.browser.navigate']!(
      command('dev.browser.navigate', {
        browserLaneId: lane.id,
        expectedGeneration: lane.generation,
        url: 'http://hop0.test/',
      })
    ).catch((caught: DevCommandProviderError) => caught)
    expect((error as DevCommandProviderError).code).toBe('navigation_blocked')
    expect((error as DevCommandProviderError).message).toContain('redirect limit')
    // The ceiling held: no more than 10 hops were ever admitted/connected.
    expect(fake.connections.length).toBeLessThanOrEqual(10)
    expect(h.lanes.get(lane.id).state).toBe('ready')
  })
})

describe('lane lifecycle transitions', () => {
  test('first navigation completes provisioning; navigating returns to ready', async () => {
    const dns: DnsAnswers = new Map([['a.test', PUBLIC]])
    const fake = gateFollowingEngine({ redirects: {} })
    const h = harness(dns, fake.engine)
    const lane = await makeLane(h.providers)
    expect(h.lanes.get(lane.id).state).toBe('provisioning')
    await h.providers['dev.browser.navigate']!(
      command('dev.browser.navigate', {
        browserLaneId: lane.id,
        expectedGeneration: lane.generation,
        url: 'http://a.test/',
      })
    )
    const after = h.lanes.get(lane.id)
    expect(after.state).toBe('ready')
    expect(after.generation).toBe(lane.generation)
    // A second navigation round-trips ready → navigating → ready.
    await h.providers['dev.browser.navigate']!(
      command('dev.browser.navigate', {
        browserLaneId: lane.id,
        expectedGeneration: after.generation,
        url: 'http://a.test/again',
      })
    )
    expect(h.lanes.get(lane.id).state).toBe('ready')
  })

  test('an unavailable engine rolls navigating back so the lane can retry', async () => {
    const dns: DnsAnswers = new Map([['a.test', PUBLIC]])
    const h = harness(dns)
    const lane = await makeLane(h.providers)
    await expect(
      h.providers['dev.browser.navigate']!(
        command('dev.browser.navigate', {
          browserLaneId: lane.id,
          expectedGeneration: lane.generation,
          url: 'http://a.test/',
        })
      )
    ).rejects.toMatchObject({ code: 'capability_unavailable' })
    expect(h.lanes.get(lane.id).state).toBe('ready')
    // And the retry path works once an engine is installed via the
    // registrar's composition seam.
    const fake = gateFollowingEngine({ redirects: {} })
    h.runtime.setEngine(fake.engine)
    const attached = h.lanes.get(lane.id)
    await h.providers['dev.browser.navigate']!(
      command('dev.browser.navigate', {
        browserLaneId: lane.id,
        expectedGeneration: attached.generation,
        url: 'http://a.test/',
      })
    )
    expect(h.lanes.get(lane.id).state).toBe('ready')
  })

  test('a crashed lane recovers through navigation instead of stranding', () => {
    const registry = createBrowserLaneRegistry()
    const lane = registry.create({
      scope,
      runtimeSessionId: sessionId,
      kind: 'task_owned',
    })
    const ready = registry.markReady(lane.id)
    const crashed = registry.markCrashed(ready.id)
    expect(crashed.state).toBe('crashed')
    // Navigating a crashed lane enters recovering (crashed → recovering),
    // and completing the navigation readies it — recovery never strands.
    const recovering = registry.navigate(crashed.id)
    expect(recovering.state).toBe('recovering')
    expect(registry.markReady(recovering.id).state).toBe('ready')
    // An explicitly recovering lane may also re-enter navigating.
    const crashedAgain = registry.markCrashed(registry.get(lane.id).id)
    const recoveringAgain = registry.navigate(crashedAgain.id)
    expect(recoveringAgain.state).toBe('recovering')
    expect(registry.navigate(recoveringAgain.id).state).toBe('navigating')
  })

  test('navigating while suspended under takeover is refused', () => {
    const registry = createBrowserLaneRegistry()
    const lane = registry.create({ scope, runtimeSessionId: sessionId, kind: 'task_owned' })
    const ready = registry.markReady(lane.id)
    const takeover = registry.takeover(ready.id, ready.generation)
    expect(takeover.state).toBe('suspended')
    expect(() => registry.navigate(takeover.id)).toThrow(/suspended under human takeover/)
    const released = registry.release(takeover.id, takeover.generation)
    expect(() => {
      registry.navigate(released.id)
      registry.navigate(released.id)
    }).toThrow(/already navigating/)
  })

  test('stale generation fails before any state mutation', async () => {
    const dns: DnsAnswers = new Map([['a.test', PUBLIC]])
    const fake = gateFollowingEngine({ redirects: {} })
    const h = harness(dns, fake.engine)
    const lane = await makeLane(h.providers)
    await expect(
      h.providers['dev.browser.navigate']!(
        command('dev.browser.navigate', {
          browserLaneId: lane.id,
          expectedGeneration: lane.generation + 5,
          url: 'http://a.test/',
        })
      )
    ).rejects.toMatchObject({ code: 'stale_generation' })
    // Nothing mutated: the lane is still untouched in provisioning.
    expect(h.lanes.get(lane.id).state).toBe('provisioning')
    expect(h.lanes.get(lane.id).generation).toBe(lane.generation)
  })
})
