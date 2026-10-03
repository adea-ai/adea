// dev.browser.* provider preconditions behind the M10 gate: scope identity,
// generation binding, SSRF policy enforcement with diagnostics, and typed
// unavailability when no lane engine is attached.
import { describe, expect, test } from 'bun:test'

import type { DevCommand } from '../../../packages/types/src/dev-runtime'
import { devOperationDefinitions } from '../../../packages/types/src/dev-runtime'

import { createBrowserLaneRegistry } from '../shell/src/dev-runtime/browser/lane-registry'
import { createScreenshotStore } from '../shell/src/dev-runtime/browser/screenshots'
import {
  browserProviderError,
  createBrowserProviders,
} from '../shell/src/dev-runtime/browser/providers'

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
} as const
const otherScope = { ...scope, workspaceId: '00000000-0000-4000-8000-000000000099' } as const
const sessionId = '00000000-0000-4000-8000-0000000000b1'

function harness(
  overrides: { cookieSourceHomeDir?: () => string; engine?: Record<string, unknown> } = {}
) {
  const lanes = createBrowserLaneRegistry()
  const diagnosticsMap = new Map()
  const { providers, diagnosticsFor } = createBrowserProviders({
    lanes,
    diagnostics: diagnosticsMap,
    ...(overrides.cookieSourceHomeDir
      ? { cookieSourceHomeDir: overrides.cookieSourceHomeDir }
      : {}),
    ...(overrides.engine ? { engine: overrides.engine } : {}),
    resolveDns: async (hostname) =>
      hostname === 'example.test'
        ? [{ address: '93.184.216.34', family: 4 }]
        : hostname === 'localhost'
          ? [{ address: '127.0.0.1', family: 4 }]
          : [],
    ownedServices: () => [{ host: '127.0.0.1', port: 5173, ownerId: 'launch-1' }],
    screenshotRecorder: {
      record: (input) => {
        const store = createScreenshotStore({ scope })
        return store.record({
          bytes: input.bytes,
          format: input.format,
          width: input.width,
          height: input.height,
          provenance: { ...input.provenance, origin: 'http://localhost:5173/' },
        })
      },
    },
  })
  return { lanes, providers, diagnosticsMap, diagnosticsFor }
}

/** Minimal engine seam: `dev.browser.annotate` only reaches `screenshot`. */
const screenshotOnlyEngine = {
  screenshot: async () => ({ bytes: new Uint8Array([1, 2, 3, 4]), width: 1280, height: 720 }),
}

function command(
  operation: keyof typeof devOperationDefinitions,
  body: Record<string, unknown>,
  overrides: Partial<Pick<DevCommand, 'scope' | 'resource'>> = {}
): DevCommand {
  const definition = devOperationDefinitions[operation]
  return {
    schemaVersion: 1,
    operation,
    requestId: '00000000-0000-4000-8000-000000000004',
    nonce: 'dGhpcy1ub25jZS1oYXMtYXQtbGVhc3QtMTI4LWJpdHM',
    issuedAt: '2026-09-15T12:00:00.000Z',
    expiresAt: '2026-09-15T12:01:00.000Z',
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
    ...overrides,
  }
}

describe('browser providers', () => {
  test('laneCreate then lanes lists the lane inside the caller scope only', async () => {
    const { providers, lanes } = harness()
    const lane = (await providers['dev.browser.laneCreate']!(
      command('dev.browser.laneCreate', {
        runtimeSessionId: sessionId,
        kind: 'task_owned',
      })
    )) as { id: string; automationOwner: string }
    expect(lane.automationOwner).toBe('agent')
    const page = (await providers['dev.browser.lanes']!(command('dev.browser.lanes', {}))) as {
      items: { id: string }[]
    }
    expect(page.items.map((item) => item.id)).toContain(lane.id)
    // A different workspace sees none of them.
    const foreign = (await providers['dev.browser.lanes']!(
      command('dev.browser.lanes', {}, { scope: otherScope })
    )) as { items: unknown[] }
    expect(foreign.items).toEqual([])
    void lanes
  })

  test('navigation runs the SSRF policy and records refusals as policy diagnostics', async () => {
    const { providers, lanes, diagnosticsMap } = harness()
    const lane = (await providers['dev.browser.laneCreate']!(
      command('dev.browser.laneCreate', {
        runtimeSessionId: sessionId,
        kind: 'task_owned',
      })
    )) as { id: string; generation: number }
    // Loopback port that is not a proven Adea-owned service: refused.
    await expect(
      providers['dev.browser.navigate']!(
        command('dev.browser.navigate', {
          browserLaneId: lane.id,
          expectedGeneration: lane.generation,
          url: 'http://127.0.0.1:9999/',
        })
      )
    ).rejects.toMatchObject({ code: 'ssrf_blocked' })
    const recorded = diagnosticsMap.get(lane.id)
    expect(recorded).toBeDefined()
    // An owned preview service passes policy; without an engine it stays
    // typed-unavailable rather than claiming a navigation happened.
    await expect(
      providers['dev.browser.navigate']!(
        command('dev.browser.navigate', {
          browserLaneId: lane.id,
          expectedGeneration: lane.generation,
          url: 'http://localhost:5173/',
        })
      )
    ).rejects.toMatchObject({ code: 'capability_unavailable' })
    void lanes
  })

  test('stale generation and scope crossover fail closed', async () => {
    const { providers } = harness()
    const lane = (await providers['dev.browser.laneCreate']!(
      command('dev.browser.laneCreate', {
        runtimeSessionId: sessionId,
        kind: 'user_context',
      })
    )) as { id: string; generation: number }
    await expect(
      providers['dev.browser.takeover']!(
        command('dev.browser.takeover', {
          browserLaneId: lane.id,
          expectedGeneration: lane.generation + 7,
        })
      )
    ).rejects.toMatchObject({ code: 'stale_generation' })
    await expect(
      providers['dev.browser.takeover']!(
        command(
          'dev.browser.takeover',
          { browserLaneId: lane.id, expectedGeneration: lane.generation },
          { scope: otherScope }
        )
      )
    ).rejects.toMatchObject({ code: 'profile_scope_denied' })
  })

  test('takeover → release round-trip bumps generations and suspends agent input', async () => {
    const { providers } = harness()
    const lane = (await providers['dev.browser.laneCreate']!(
      command('dev.browser.laneCreate', {
        runtimeSessionId: sessionId,
        kind: 'task_owned',
      })
    )) as { id: string; generation: number }
    const takeover = (await providers['dev.browser.takeover']!(
      command('dev.browser.takeover', {
        browserLaneId: lane.id,
        expectedGeneration: lane.generation,
      })
    )) as { automationOwner: string; generation: number }
    expect(takeover.automationOwner).toBe('human_takeover')
    expect(takeover.generation).toBe(lane.generation + 1)
    const released = (await providers['dev.browser.release']!(
      command('dev.browser.release', {
        browserLaneId: lane.id,
        expectedGeneration: takeover.generation,
      })
    )) as { automationOwner: string; generation: number; state: string }
    expect(released.automationOwner).toBe('agent')
    expect(released.state).toBe('ready')
  })

  test('engine-dependent operations are typed-unavailable without an engine', async () => {
    const { providers } = harness()
    const lane = (await providers['dev.browser.laneCreate']!(
      command('dev.browser.laneCreate', { runtimeSessionId: sessionId, kind: 'task_owned' })
    )) as { id: string; generation: number }
    for (const operation of ['dev.browser.attach', 'dev.browser.input'] as const) {
      await expect(
        providers[operation]!(
          command(operation, {
            browserLaneId: lane.id,
            expectedGeneration: lane.generation,
            direction: operation === 'dev.browser.attach' ? 'read' : 'write',
          })
        )
      ).rejects.toMatchObject({ code: 'capability_unavailable' })
    }
  })

  test('browserProviderError maps lane errors onto the typed DevError codes', () => {
    const mapped = browserProviderError(new Error('boom'))
    expect(mapped.code).toBe('invalid_state')
  })
})

// #718: the annotate operation captures the frame host-side at submit time.
describe('browser annotate (#718)', () => {
  async function annotateLane(overrides: { engine?: Record<string, unknown> } = {}) {
    const harnessResult = harness(overrides)
    const lane = (await harnessResult.providers['dev.browser.laneCreate']!(
      command('dev.browser.laneCreate', { runtimeSessionId: sessionId, kind: 'task_owned' })
    )) as { id: string; generation: number }
    return { ...harnessResult, lane }
  }

  test('a rect annotation echoes normalized geometry and binds the captured screenshot', async () => {
    const { providers, lane } = await annotateLane({ engine: screenshotOnlyEngine })
    const result = (await providers['dev.browser.annotate']!(
      command('dev.browser.annotate', {
        browserLaneId: lane.id,
        expectedGeneration: lane.generation,
        targetId: 'target-1',
        annotation: { targetId: 'target-1', kind: 'rect', x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      })
    )) as {
      targetId: string
      kind: string
      x: number
      y: number
      width: number
      height: number
      id: string
      screenshotId: string
      createdAt: string
    }
    expect(result).toMatchObject({
      targetId: 'target-1',
      kind: 'rect',
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.4,
    })
    expect(result.id).toBeTruthy()
    expect(result.screenshotId).toBeTruthy()
    expect(result.createdAt).toBeTruthy()
  })

  test('a text annotation carries bounded note text through the same binding', async () => {
    const { providers, lane } = await annotateLane({ engine: screenshotOnlyEngine })
    const result = (await providers['dev.browser.annotate']!(
      command('dev.browser.annotate', {
        browserLaneId: lane.id,
        expectedGeneration: lane.generation,
        targetId: 'target-1',
        annotation: { targetId: 'target-1', kind: 'text', x: 0.25, y: 0.5, text: 'overlap here' },
      })
    )) as { kind: string; text?: string; screenshotId: string }
    expect(result.kind).toBe('text')
    expect(result.text).toBe('overlap here')
    expect(result.screenshotId).toBeTruthy()
  })

  test('malformed annotations fail closed before any capture', async () => {
    const { providers, lane } = await annotateLane({ engine: screenshotOnlyEngine })
    const base = {
      browserLaneId: lane.id,
      expectedGeneration: lane.generation,
      targetId: 'target-1',
    }
    await expect(
      providers['dev.browser.annotate']!(
        command('dev.browser.annotate', {
          ...base,
          annotation: { targetId: 'target-1', kind: 'rect', x: 0.1, y: 0.2 },
        })
      )
    ).rejects.toMatchObject({ code: 'invalid_state' })
    await expect(
      providers['dev.browser.annotate']!(
        command('dev.browser.annotate', {
          ...base,
          annotation: { targetId: 'target-1', kind: 'point', x: 1.5, y: 0.2 },
        })
      )
    ).rejects.toMatchObject({ code: 'invalid_state' })
    await expect(
      providers['dev.browser.annotate']!(
        command('dev.browser.annotate', {
          ...base,
          annotation: { targetId: 'target-1', kind: 'text', x: 0.1, y: 0.2 },
        })
      )
    ).rejects.toMatchObject({ code: 'invalid_state' })
    await expect(
      providers['dev.browser.annotate']!(
        command('dev.browser.annotate', {
          ...base,
          expectedGeneration: lane.generation + 1,
          annotation: { targetId: 'target-1', kind: 'point', x: 0.1, y: 0.2 },
        })
      )
    ).rejects.toMatchObject({ code: 'stale_generation' })
  })

  test('without an engine the capture is typed-unavailable, never fabricated', async () => {
    const { providers, lane } = await annotateLane()
    await expect(
      providers['dev.browser.annotate']!(
        command('dev.browser.annotate', {
          browserLaneId: lane.id,
          expectedGeneration: lane.generation,
          targetId: 'target-1',
          annotation: { targetId: 'target-1', kind: 'point', x: 0.1, y: 0.2 },
        })
      )
    ).rejects.toMatchObject({ code: 'capability_unavailable' })
  })
})

// #610: the native cookie-source layer is reachable through the gate. Detection
// is a host fact, so this drives the real provider with a scripted home — and
// checks the wire shape carries no path.
describe('cookie sources (#610)', () => {
  test('lists detected sources with typed availability and no host paths on the wire', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const home = mkdtempSync(join(tmpdir(), 'adea-cookie-op-'))
    try {
      const chromeRoot = join(home, 'Library/Application Support/Google/Chrome/Default')
      mkdirSync(chromeRoot, { recursive: true })
      writeFileSync(join(chromeRoot, 'Cookies'), 'sqlite-ish')
      mkdirSync(join(home, 'Library/Cookies'), { recursive: true })
      writeFileSync(join(home, 'Library/Cookies/Cookies.binarycookies'), 'cook')

      const { providers } = harness({ cookieSourceHomeDir: () => home })
      const page = (await providers['dev.browser.cookieSources']!(
        command('dev.browser.cookieSources', {})
      )) as { items: Array<Record<string, unknown>>; total: number }

      expect(page.total).toBe(2)
      expect(page.items.map((item) => item.id).toSorted()).toEqual([
        'chrome:Default',
        'safari:legacy',
      ])
      // Typed availability: the unparseable browser is a row, not an absence.
      expect(page.items.find((item) => item.id === 'safari:legacy')).toMatchObject({
        kind: 'safari',
        availability: 'unsupported_format',
      })
      expect(page.items.find((item) => item.id === 'chrome:Default')).toMatchObject({
        kind: 'chrome',
        availability: 'available',
      })
      // No store path (or any home path) crosses the wire.
      expect(JSON.stringify(page)).not.toContain(home)
      expect(JSON.stringify(page)).not.toContain('Cookies.binarycookies')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
