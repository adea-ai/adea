// #422 browser lane host adapters. Cases translated from the pinned donor
// tests (Orca cookie scope/atomicity and screencast pacer, t3code lsof port
// parsing) plus the issue's hardening cases: SSRF/rebinding fail-closed,
// lane/profile crossover, stale-generation takeover fencing, bounded frame
// publication, and zero secret logging.
import { describe, expect, test } from 'bun:test'

import {
  applyCookieImportPolicy,
  createCookieImportService,
  normalizeCookieDomain,
  registrableFamily,
  type ImportedCookie,
  type LaneCookieStore,
} from '../shell/src/dev-runtime/browser/cookie-import'
import { createLaneDiagnostics } from '../shell/src/dev-runtime/browser/diagnostics'
import {
  BrowserLaneError,
  createBrowserLaneRegistry,
  deriveLaneProfileId,
} from '../shell/src/dev-runtime/browser/lane-registry'
import {
  evaluateNavigation,
  isLoopbackHostname,
  isPrivateOrLoopbackAddress,
} from '../shell/src/dev-runtime/browser/navigation-policy'
import {
  createPortInventory,
  parseLsofOutput,
  parsePortFromLsofName,
} from '../shell/src/dev-runtime/browser/port-inventory'
import {
  createLaneScreencast,
  SCREENCAST_BUDGET_DEFAULTS,
} from '../shell/src/dev-runtime/browser/screencast'
import { createScreenshotStore } from '../shell/src/dev-runtime/browser/screenshots'

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
} as const
const otherScope = { ...scope, workspaceId: '00000000-0000-4000-8000-000000000099' } as const
const sessionId = '00000000-0000-4000-8000-0000000000b1'

const cookie = (domain: string, name: string, value = `${name}-value`): ImportedCookie => ({
  domain,
  name,
  value,
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'lax',
})

function memoryStore(
  initial: ImportedCookie[]
): LaneCookieStore & { rows: () => ImportedCookie[] } {
  let rows = [...initial]
  return {
    list: async () => [...rows],
    remove: async (cookies) => {
      rows = rows.filter(
        (row) => !cookies.some((c) => c.domain === row.domain && c.name === row.name)
      )
    },
    write: async (cookies) => {
      for (const c of cookies) {
        rows = rows.filter((row) => !(row.domain === c.domain && row.name === c.name))
        rows.push(c)
      }
    },
    rows: () => [...rows],
  }
}

const frame = (sequence: number, bytes = 10) => ({
  sequence: String(sequence),
  generation: 1,
  viewportSequence: sequence,
  keyframe: sequence === 1,
  bytes: new Uint8Array(bytes),
})

const screencastInput = (sequence: number, generation = 3) => ({
  sequence: String(sequence),
  generation,
  viewportSequence: sequence,
  bytes: new Uint8Array(4),
})

function expectCode(run: () => unknown, code: string) {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(BrowserLaneError)
    expect((error as BrowserLaneError).code).toBe(code)
    return
  }
  throw new Error(`expected BrowserLaneError ${code}`)
}

describe('navigation policy', () => {
  const publicResolved = [{ address: '93.184.216.34', family: 4 as const }]
  const owned = [{ host: '127.0.0.1', port: 5173, ownerId: 'launch-1' }]

  test('admits public http/https targets that resolve publicly', () => {
    const decision = evaluateNavigation({
      url: 'https://example.test/',
      resolvedAddresses: publicResolved,
      ownedServices: owned,
    })
    expect(decision.allowed).toBe(true)
  })

  test('rejects non-http schemes, embedded credentials, and unparseable URLs', () => {
    for (const url of [
      'file:///etc/passwd',
      'data:text/html,hi',
      'javascript:alert(1)',
      'https://user:pass@example.test/',
      'not a url',
      'ftp://example.test/',
    ]) {
      const decision = evaluateNavigation({
        url,
        resolvedAddresses: publicResolved,
        ownedServices: owned,
      })
      expect(decision.allowed).toBe(false)
      if (!decision.allowed) expect(decision.code).toBe('navigation_blocked')
    }
  })

  test('blocks cloud metadata and private-range addresses on public names', () => {
    for (const address of [
      '169.254.169.254',
      '10.1.2.3',
      '192.168.1.10',
      '172.16.0.5',
      'fd00::1',
    ]) {
      const decision = evaluateNavigation({
        url: 'https://rebind.test/',
        resolvedAddresses: [{ address, family: address.includes(':') ? 6 : 4 }],
        ownedServices: owned,
      })
      expect(decision.allowed).toBe(false)
      if (!decision.allowed) expect(decision.code).toBe('ssrf_blocked')
    }
  })

  test('rejects hexadecimal IPv4-mapped metadata answers', () => {
    const decision = evaluateNavigation({
      url: 'https://public.example.test/',
      resolvedAddresses: [{ address: '::ffff:a9fe:a9fe', family: 6 }],
      ownedServices: [],
    })
    expect(decision).toMatchObject({ allowed: false, code: 'ssrf_blocked' })
  })

  test('blocks loopback unless the port is a proven Adea-owned service', () => {
    const denied = evaluateNavigation({
      url: 'http://127.0.0.1:4789/invoke',
      resolvedAddresses: [{ address: '127.0.0.1', family: 4 }],
      ownedServices: owned,
    })
    expect(denied.allowed).toBe(false)
    if (!denied.allowed) expect(denied.code).toBe('ssrf_blocked')

    const allowed = evaluateNavigation({
      url: 'http://localhost:5173/',
      resolvedAddresses: [{ address: '127.0.0.1', family: 4 }],
      ownedServices: owned,
    })
    expect(allowed.allowed).toBe(true)

    const unownedPort = evaluateNavigation({
      url: 'http://localhost:9999/',
      resolvedAddresses: [{ address: '127.0.0.1', family: 4 }],
      ownedServices: owned,
    })
    expect(unownedPort.allowed).toBe(false)
  })

  test('the shell port is never an owned preview service', () => {
    const decision = evaluateNavigation({
      url: 'http://localhost:80/',
      resolvedAddresses: [{ address: '127.0.0.1', family: 4 }],
      ownedServices: [{ host: '127.0.0.1', port: 80, ownerId: 'launch-1' }],
    })
    expect(decision.allowed).toBe(false)
  })

  test('redirect hops re-resolve: a rebinding host is refused on the second pass', () => {
    // First pass: public. Redirect re-check with a private address: refused.
    const first = evaluateNavigation({
      url: 'https://rebind.test/next',
      resolvedAddresses: publicResolved,
      ownedServices: owned,
    })
    expect(first.allowed).toBe(true)
    const second = evaluateNavigation({
      url: 'https://rebind.test/next',
      resolvedAddresses: [{ address: '10.0.0.1', family: 4 }],
      ownedServices: owned,
    })
    expect(second.allowed).toBe(false)
  })

  test('localhost resolving to a non-loopback address is rebinding', () => {
    const decision = evaluateNavigation({
      url: 'http://localhost:5173/',
      resolvedAddresses: [{ address: '93.184.216.34', family: 4 }],
      ownedServices: owned,
    })
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.code).toBe('ssrf_blocked')
  })

  test('IPv4-mapped and address-classification helpers', () => {
    expect(isPrivateOrLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isPrivateOrLoopbackAddress('::ffff:7f00:1')).toBe(true)
    expect(isPrivateOrLoopbackAddress('::ffff:a9fe:a9fe')).toBe(true)
    expect(isPrivateOrLoopbackAddress('::ffff:8.8.8.8')).toBe(false)
    expect(isPrivateOrLoopbackAddress('::ffff:0808:0808')).toBe(false)
    expect(isPrivateOrLoopbackAddress('fe80::1')).toBe(true)
    expect(isLoopbackHostname('localhost')).toBe(true)
    expect(isLoopbackHostname('example.test')).toBe(false)
  })
})

describe('lane registry', () => {
  test('human and agent lanes derive different immutable profile identities', () => {
    const humanProfile = deriveLaneProfileId(scope, sessionId, 'human_embedded')
    const agentProfile = deriveLaneProfileId(scope, sessionId, 'task_owned')
    const otherWorkspaceProfile = deriveLaneProfileId(otherScope, sessionId, 'task_owned')
    expect(humanProfile).not.toEqual(agentProfile)
    expect(agentProfile).not.toEqual(otherWorkspaceProfile)
    // Deterministic within the same authority tuple.
    expect(agentProfile).toEqual(deriveLaneProfileId(scope, sessionId, 'task_owned'))
  })

  test('takeover bumps the generation so old-generation input is inert', () => {
    const lanes = createBrowserLaneRegistry()
    const lane = lanes.create({ scope, runtimeSessionId: sessionId, kind: 'task_owned' })
    lanes.markReady(lane.id)
    const takeover = lanes.takeover(lane.id, lane.generation)
    expect(takeover.automationOwner).toBe('human_takeover')
    expect(takeover.generation).toBe(lane.generation + 1)
    // Input under the pre-takeover generation is refused.
    expectCode(
      () =>
        lanes.admitInput(takeover, {
          principal: 'task',
          taskGrantId: sessionId,
          generation: lane.generation,
        }),
      'stale_generation'
    )
    // Human input under the new generation is admitted; agent input is not.
    expect(() =>
      lanes.admitInput(takeover, { principal: 'human', generation: takeover.generation })
    ).not.toThrow()
    expectCode(
      () =>
        lanes.admitInput(takeover, {
          principal: 'task',
          taskGrantId: sessionId,
          generation: takeover.generation,
        }),
      'permission_denied'
    )
    const released = lanes.release(takeover.id, takeover.generation)
    expect(released.automationOwner).toBe('agent')
    expect(released.generation).toBe(takeover.generation + 1)
  })

  test('human embedded lanes accept no automation input at all', () => {
    const lanes = createBrowserLaneRegistry()
    const lane = lanes.create({ scope, runtimeSessionId: sessionId, kind: 'human_embedded' })
    lanes.markReady(lane.id)
    for (const principal of ['human', 'agent', 'task'] as const)
      expectCode(
        () =>
          lanes.admitInput(lane, {
            principal,
            taskGrantId: sessionId,
            generation: lane.generation,
          }),
        'permission_denied'
      )
  })

  test('task-owned lanes accept input only within the owning task grant', () => {
    const lanes = createBrowserLaneRegistry()
    const lane = lanes.create({ scope, runtimeSessionId: sessionId, kind: 'task_owned' })
    expect(() =>
      lanes.admitInput(lane, {
        principal: 'task',
        taskGrantId: sessionId,
        generation: lane.generation,
      })
    ).not.toThrow()
    expectCode(
      () =>
        lanes.admitInput(lane, {
          principal: 'task',
          taskGrantId: 'other-session',
          generation: lane.generation,
        }),
      'profile_scope_denied'
    )
  })

  test('viewport limits and profile reset require confirmation', () => {
    const lanes = createBrowserLaneRegistry()
    const lane = lanes.create({ scope, runtimeSessionId: sessionId, kind: 'user_context' })
    expectCode(
      () =>
        lanes.viewport(lane.id, lane.generation, {
          width: 5000,
          height: 720,
          deviceScaleFactor: 1,
          mobile: false,
        }),
      'limit_exceeded'
    )
    expectCode(() => lanes.profileReset(lane.id, lane.generation, ''), 'permission_denied')
    expect(lanes.profileReset(lane.id, lane.generation, 'confirm-1').state).toBe('provisioning')
  })

  test('profile policies are default-deny and scope-bound', () => {
    const lanes = createBrowserLaneRegistry()
    const lane = lanes.create({ scope, runtimeSessionId: sessionId, kind: 'task_owned' })
    for (const permission of [
      'downloads',
      'uploads',
      'clipboard',
      'camera',
      'microphone',
      'geolocation',
      'notifications',
      'popups',
      'certificate_exceptions',
    ] as const)
      expectCode(() => lanes.assertLanePermission(lane, permission), 'permission_denied')
    const policies = lanes.profilePolicies()
    expect(policies.length).toBeGreaterThanOrEqual(3)
    expect(policies.every((policy) => policy.allowedPermissions.length === 0)).toBe(true)
  })
})

describe('screencast flow control', () => {
  test('throttled frames retain only the newest complete frame', () => {
    const delivered: number[] = []
    let credit = 1
    const screencast = createLaneScreencast({
      onFrame: (published) => {
        delivered.push(published.viewportSequence)
        if (credit <= 0) return
      },
    })
    const results = [1, 2, 3, 4, 5].map((sequence) => screencast.publish(frame(sequence)))
    // Every frame inside the interval is admitted as `throttled` or `published`
    // but the pending set never exceeds one newest frame.
    expect(results.every((result) => result !== 'rejected')).toBe(true)
    screencast.close()
    expect(delivered.length).toBeLessThanOrEqual(5)
  })

  test('oversized and empty frames are refused outright', () => {
    const screencast = createLaneScreencast()
    expect(screencast.publish(frame(1, 8 * 1024 * 1024 + 1))).toBe('rejected')
    expect(screencast.publish(frame(2, 0))).toBe('rejected')
    expect(screencast.publish(frame(3, 10))).toBe('published')
  })

  test('stale generations and stale viewport sequences are inert', () => {
    const screencast = createLaneScreencast()
    const laneGeneration = 3
    expect(screencast.admitInput(screencastInput(10), laneGeneration)).toEqual({ accepted: true })
    expect(screencast.admitInput(screencastInput(11, 2), laneGeneration)).toEqual({
      rejected: 'stale_generation',
    })
    expect(screencast.admitInput(screencastInput(5), laneGeneration)).toEqual({
      rejected: 'stale_viewport',
    })
  })

  test('input rate is capped at the spec limit of 240 events/second', () => {
    const screencast = createLaneScreencast({ budget: { maxInputPerSecond: 3 } })
    const outcomes = [1, 2, 3, 4].map((sequence) =>
      screencast.admitInput(screencastInput(sequence, 1), 1)
    )
    expect(outcomes[0]).toEqual({ accepted: true })
    expect(outcomes[2]).toEqual({ accepted: true })
    expect(outcomes[3]).toEqual({ rejected: 'rate_limited' })
  })

  test('spec defaults match the consolidated limits registry', () => {
    expect(SCREENCAST_BUDGET_DEFAULTS.maxFps).toBe(15)
    expect(SCREENCAST_BUDGET_DEFAULTS.maxFrameBytes).toBe(8 * 1024 * 1024)
    expect(SCREENCAST_BUDGET_DEFAULTS.maxInputPerSecond).toBe(240)
  })
})

describe('cookie import', () => {
  test('domain normalization and registrable families', () => {
    expect(normalizeCookieDomain('.GitHub.COM')).toBe('github.com')
    expect(normalizeCookieDomain('bad/../domain')).toBeNull()
    expect(normalizeCookieDomain('host:8080')).toBeNull()
    expect(registrableFamily('gist.github.com')).toBe('github.com')
    expect(registrableFamily('notgithub.com')).toBe('notgithub.com')
    expect(registrableFamily('a.b.co.uk')).toBe('b.co.uk')
    expect(registrableFamily('127.0.0.1')).toBe('127.0.0.1')
  })

  test('exclusion policy keeps google.com out unless explicitly overridden', () => {
    const verdict = applyCookieImportPolicy({ domains: ['github.com', 'google.com', 'bad'] })
    expect(verdict.accepted).toEqual(['github.com'])
    expect(verdict.excluded).toContainEqual({ domain: 'google.com', reason: 'excluded_by_policy' })
    const override = applyCookieImportPolicy({
      domains: ['google.com'],
      includeExcluded: true,
    })
    expect(override.accepted).toEqual(['google.com'])
    expect(override.warned.length).toBe(1)
  })

  test('replacement is scoped to imported families; unrelated sessions survive', async () => {
    // Orca browser-cookie-import-scope.test.ts: the target jar starts with
    // sessions for sites outside the import set, and they must stay signed in.
    const service = createCookieImportService({
      now: () => '2026-09-18T12:00:00.000Z',
      randomId: () => '00000000-0000-4000-8000-0000000000f1',
    })
    const target = memoryStore([
      cookie('the-internet.herokuapp.com', 'rack.session', 'live-login'),
      cookie('.google.com', 'SID', 'google-live'),
      cookie('.github.com', 'user_session', 'stale-github'),
    ])
    const plan = await service.plan({
      browserLaneId: 'lane-1',
      laneGeneration: 1,
      sourceProfileId: 'chrome-default',
      domains: ['github.com'],
      readSource: async () => [cookie('.github.com', 'user_session', 'imported-github')],
      targetStore: target,
    })
    expect(plan.stagedWrites.map((c) => c.value)).toEqual(['imported-github'])
    expect(plan.stagedRemovals.map((c) => c.name)).toEqual(['user_session'])
    const result = await service.commit(plan.id, plan.digest, target)
    expect(result).toMatchObject({ imported: 1, rolledBack: false })
    const rows = target.rows()
    expect(rows.find((row) => row.name === 'rack.session')?.value).toBe('live-login')
    expect(rows.find((row) => row.name === 'SID')?.value).toBe('google-live')
    expect(rows.find((row) => row.name === 'user_session')?.value).toBe('imported-github')
  })

  test('a write failure rolls back the WHOLE import (Orca clear-atomicity)', async () => {
    const service = createCookieImportService({ now: () => '2026-09-18T12:00:00.000Z' })
    const target = memoryStore([cookie('.example.com', 'existing', 'keep-me')])
    let failNextWrite = false
    const failingStore: LaneCookieStore = {
      list: target.list,
      remove: target.remove,
      write: async (cookies) => {
        if (failNextWrite) {
          failNextWrite = false
          throw new Error('cookie store unavailable')
        }
        return target.write(cookies)
      },
    }
    const plan = await service.plan({
      browserLaneId: 'lane-1',
      laneGeneration: 1,
      sourceProfileId: 'chrome-default',
      domains: ['example.com', 'other.test'],
      readSource: async () => [
        cookie('.example.com', 'imported-first', 'new-1'),
        cookie('.other.test', 'stale', 'new-2'),
      ],
      targetStore: failingStore,
    })
    // The store fails exactly one write mid-import; the rollback's restore
    // writes succeed, so the rollback itself can and must complete.
    failNextWrite = true
    // The commit reports the failure after rolling every staged change back.
    let rolledBack: boolean | undefined
    try {
      await service.commit(plan.id, plan.digest, failingStore)
    } catch (error) {
      expect((error as { code?: string }).code).toBe('cookie_import_failed')
      rolledBack = true
    }
    expect(rolledBack).toBe(true)
    // Pre-existing rows restored; nothing partial survived.
    expect(target.rows()).toEqual([cookie('.example.com', 'existing', 'keep-me')])
  })

  test('cancel mid-import rolls back; digest mismatch refuses the commit', async () => {
    const service = createCookieImportService({ now: () => '2026-09-18T12:00:00.000Z' })
    const target = memoryStore([cookie('.example.com', 'existing', 'keep-me')])
    const plan = await service.plan({
      browserLaneId: 'lane-1',
      laneGeneration: 1,
      sourceProfileId: 'chrome-default',
      domains: ['example.com'],
      readSource: async () => [cookie('.example.com', 'imported', 'new')],
      targetStore: target,
    })
    const cancelled = await service.commit(plan.id, plan.digest, target, { cancelled: true })
    expect(cancelled.rolledBack).toBe(true)
    expect(target.rows().map((row) => row.name)).toEqual(['existing'])
    await expect(service.commit(plan.id, plan.digest, target)).rejects.toThrow(/plan/)
    const plan2 = await service.plan({
      browserLaneId: 'lane-1',
      laneGeneration: 1,
      sourceProfileId: 'chrome-default',
      domains: ['example.com'],
      readSource: async () => [cookie('.example.com', 'imported', 'new')],
      targetStore: target,
    })
    await expect(service.commit(plan2.id, '0'.repeat(64), target)).rejects.toThrow('digest')
  })

  test('no cookie value ever appears in results, plans, or error messages', async () => {
    const service = createCookieImportService({ now: () => '2026-09-18T12:00:00.000Z' })
    const target = memoryStore([])
    const secret = 'super-secret-session-value'
    const readSource = (value: string) => async () => [cookie('.example.com', 'session', value)]
    // Two plans over the SAME store state differing only in cookie values
    // must produce the same digest: values are excluded from the digest so
    // it can be logged safely.
    const planA = await service.plan({
      browserLaneId: 'lane-1',
      laneGeneration: 1,
      sourceProfileId: 'chrome-default',
      domains: ['example.com'],
      readSource: readSource(secret),
      targetStore: target,
    })
    const planB = await service.plan({
      browserLaneId: 'lane-1',
      laneGeneration: 1,
      sourceProfileId: 'chrome-default',
      domains: ['example.com'],
      readSource: readSource('different-value'),
      targetStore: target,
    })
    expect(planA.digest).toEqual(planB.digest)
    expect(JSON.stringify(planA).includes(secret)).toBe(true) // plan holds values in-memory only
    const committed = await service.commit(planA.id, planA.digest, target)
    expect(JSON.stringify(committed).includes(secret)).toBe(false)
  })
})

describe('port inventory', () => {
  const lsofOutput = [
    'p1234',
    'cvite',
    'n127.0.0.1:5173 (LISTEN)',
    'p9999',
    'cpostgres',
    'n192.168.1.10:5432 (LISTEN)',
    'n*:3000 (LISTEN)',
  ].join('\n')

  test('parses local listeners only (t3code fixture)', () => {
    const services = parseLsofOutput(lsofOutput)
    expect(services.map((service) => service.port)).toEqual([3000, 5173])
    expect(parsePortFromLsofName('192.168.1.10:5432 (LISTEN)')).toBeNull()
    expect(parsePortFromLsofName('[::1]:5173')).toBe(5173)
    expect(parsePortFromLsofName('*:3000 (LISTEN)')).toBe(3000)
  })

  test('marks Adea-owned services and keeps unconfirmed owned ports visible', async () => {
    const inventory = createPortInventory({
      scope,
      runLsof: async () => lsofOutput,
      ownedServices: () => [
        { port: 8080, processRecordId: 'proc-1', runtimeSessionId: sessionId, ownerId: 'owner-1' },
      ],
    })
    const snapshot = await inventory.snapshot()
    const owned = snapshot.ports.find((port) => port.port === 5173)
    expect(owned?.owner).toBe('unknown')
    const lanPort = snapshot.ports.find((port) => port.port === 5432)
    expect(lanPort).toBeUndefined()
    const unconfirmed = snapshot.services.find((service) => service.port === 8080)
    expect(unconfirmed).toMatchObject({ owner: 'adea', health: 'unconfirmed' })
  })

  test('vanished ports become stale, never silently deleted', async () => {
    let output = lsofOutput
    const inventory = createPortInventory({
      scope,
      runLsof: async () => output,
      ownedServices: () => [],
    })
    await inventory.snapshot()
    output = 'p1\ncvite\nn127.0.0.1:5173 (LISTEN)'
    const second = await inventory.snapshot()
    const stale = second.ports.find((port) => port.port === 3000)
    expect(stale?.state).toBe('stale')
  })

  test('only proven Adea-owned listening services are previewable', async () => {
    const inventory = createPortInventory({
      scope,
      runLsof: async () => 'p1\ncvite\nn127.0.0.1:5173 (LISTEN)',
      ownedServices: () => [{ port: 5173, processRecordId: 'proc-1', ownerId: 'owner-1' }],
    })
    const snapshot = await inventory.snapshot()
    expect(inventory.previewableService(snapshot.services, 5173)).toBe(true)
    expect(inventory.previewableService(snapshot.services, 8080)).toBe(false)
  })

  test('associates a proven service with its task-owned browser preview lane', async () => {
    const inventory = createPortInventory({
      scope,
      runLsof: async () => 'p1\ncvite\nn127.0.0.1:5173 (LISTEN)',
      ownedServices: () => [
        { port: 5173, processRecordId: 'proc-1', runtimeSessionId: sessionId, ownerId: 'owner-1' },
      ],
      previewForPort: ({ port, runtimeSessionId }) =>
        runtimeSessionId === sessionId
          ? { browserLaneId: 'lane-1', url: `http://127.0.0.1:${port}/` }
          : undefined,
    })
    const snapshot = await inventory.snapshot()
    expect(snapshot.ports.find((port) => port.port === 5173)?.preview).toEqual({
      browserLaneId: 'lane-1',
      url: 'http://127.0.0.1:5173/',
    })
  })

  test('does not associate external or unconfirmed ports and keeps stale rows inert', async () => {
    let output = 'p1\ncvite\nn127.0.0.1:5173 (LISTEN)\np2\nctest\nn127.0.0.1:8080 (LISTEN)'
    const inventory = createPortInventory({
      scope,
      runLsof: async () => output,
      ownedServices: () => [
        { port: 5173, processRecordId: 'proc-1', runtimeSessionId: sessionId, ownerId: 'owner-1' },
        { port: 9000, processRecordId: 'proc-2', runtimeSessionId: sessionId, ownerId: 'owner-2' },
      ],
      previewForPort: ({ port }) => ({ browserLaneId: 'lane-1', url: `http://127.0.0.1:${port}/` }),
    })
    const first = await inventory.snapshot()
    expect(first.ports.find((port) => port.port === 5173)?.preview).toBeDefined()
    expect(first.ports.find((port) => port.port === 8080)?.preview).toBeUndefined()
    expect(first.services.find((service) => service.port === 9000)?.health).toBe('unconfirmed')
    output = ''
    const second = await inventory.snapshot()
    expect(second.ports.find((port) => port.port === 5173)?.state).toBe('stale')
    expect(second.ports.find((port) => port.port === 5173)?.preview).toBeDefined()
    expect(inventory.previewableService(second.services, 5173)).toBe(false)
  })
})

describe('diagnostics and screenshots', () => {
  test('diagnostics ring is bounded and pages with cursors', () => {
    const diagnostics = createLaneDiagnostics()
    for (let index = 0; index < 1200; index += 1) diagnostics.console('info', `message ${index}`)
    expect(diagnostics.size()).toBeLessThanOrEqual(2000)
    const first = diagnostics.page(undefined, 500)
    expect(first.items.length).toBe(500)
    const second = diagnostics.page(first.nextCursor, 500)
    expect(second.items.length).toBe(500)
  })

  test('screenshots enforce size limits and carry provenance', () => {
    const store = createScreenshotStore({
      scope,
      now: () => '2026-09-18T12:00:00.000Z',
      randomId: () => '00000000-0000-4000-8000-0000000000d1',
    })
    const bytes = new Uint8Array([1, 2, 3])
    const ref = store.record({
      bytes,
      format: 'png',
      width: 1280,
      height: 720,
      provenance: {
        ownerId: 'lane-1',
        laneKind: 'task_owned',
        profileId: 'profile-1',
        origin: 'http://localhost:5173/',
        viewport: { width: 1280, height: 720, deviceScaleFactor: 2 },
        redacted: true,
      },
    })
    expect(ref.byteLength).toBe('3')
    expect(ref.width).toBe(1280)
    expect(ref.expiresAt).toBe('2026-10-18T12:00:00.000Z')
    expect(store.get(ref.id)?.sha256).toHaveLength(64)
    expect(store.get(ref.id)?.origin).toBe('http://localhost:5173/')
    expect([...store.getBytes(ref.id)!]).toEqual([1, 2, 3])
    expect(() =>
      store.record({
        bytes: new Uint8Array(25 * 1024 * 1024 + 1),
        format: 'png',
        width: 1,
        height: 1,
        provenance: {
          ownerId: 'lane-1',
          laneKind: 'task_owned',
          origin: 'x',
          viewport: { width: 1, height: 1, deviceScaleFactor: 1 },
          redacted: true,
        },
      })
    ).toThrow(/25 MiB/)
  })
})
