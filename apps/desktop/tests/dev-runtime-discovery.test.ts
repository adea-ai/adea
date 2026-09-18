// M10 #30 substrate: local harness discovery and the RuntimeConnection
// inventory. These tests pin the discovery read model against the issue's
// failure matrix — success, empty, partial install, version mismatch,
// permission denial, disappeared runtime, and broken installs — plus the
// fail-closed rules: read never re-probes, diagnostics are classified and
// path-free, oversized metadata is dropped (never truncated silently), and
// discovery performs no persistent native configuration change.
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { DevAuthorityError } from '../shell/src/dev-runtime/authority'
import { createAuthorityAudit } from '../shell/src/dev-runtime/audit'
import {
  compareVersions,
  parseVersionOutput,
  resolveExecutable,
} from '../shell/src/dev-runtime/discovery/probe'
import { createLocalExecutableDiscoverySource } from '../shell/src/dev-runtime/discovery/source'
import {
  createRuntimeConnectionInventory,
  harnessInstallationOf,
} from '../shell/src/dev-runtime/discovery/inventory'
import { harnessFamilySpec, harnessFamilySpecs } from '../shell/src/dev-runtime/discovery/families'
import type {
  HarnessDiscoverySource,
  HarnessSourceReport,
} from '../shell/src/dev-runtime/discovery/types'

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
} as const
const otherScope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000099',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
} as const

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function tempDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'adea-discovery-'))
}

function fakeDevice(home: string, binaries: string[]): void {
  mkdirSync(join(home, 'bin'), { recursive: true })
  for (const name of binaries) {
    writeFileSync(join(home, 'bin', name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  }
}

function installAuthMarker(home: string, relative: string): void {
  const marker = join(home, relative)
  mkdirSync(dirname(marker), { recursive: true })
  writeFileSync(marker, 'not-read-by-discovery', { mode: 0o600 })
}

/** The canonical identity discovery reports for a file: macOS /var → /private/var. */
function identityOf(path: string): string {
  return realpathSync(path)
}

function fakeVersionProbe(
  versions: Record<string, string>,
  options: {
    failures?: Record<
      string,
      'version_probe_timeout' | 'version_probe_failed' | 'permission_denied'
    >
  } = {}
) {
  const calls: string[] = []
  const probe = (executable: string) => {
    calls.push(executable)
    const failure = options.failures?.[executable]
    if (failure) return { ok: false as const, code: failure }
    const version = versions[executable]
    const parsed = version === undefined ? null : parseVersionOutput(version)
    return parsed === null
      ? ({ ok: false as const, code: 'version_probe_failed' } as const)
      : ({ ok: true as const, version: parsed } as const)
  }
  return Object.assign(probe, { calls })
}

function fixedClock(startMs = 1_758_240_000_000) {
  let current = startMs
  return {
    clock: () => new Date(current),
    advance(ms: number): void {
      current += ms
    },
  }
}

function localSource(options: Parameters<typeof createLocalExecutableDiscoverySource>[0] = {}) {
  return createLocalExecutableDiscoverySource({
    specs: harnessFamilySpecs,
    ...options,
  })
}

function homeTreeDigest(home: string): string {
  const digest = createHash('sha256')
  function walk(directory: string): void {
    for (const name of readdirSorted(directory)) {
      const path = join(directory, name)
      const stat = statSync(path)
      digest.update(path.slice(home.length))
      if (stat.isDirectory()) walk(path)
      else digest.update(readFileSync(path))
    }
  }
  walk(home)
  return digest.digest('hex')
}

function readdirSorted(directory: string): string[] {
  return readdirSync(directory).toSorted()
}

function sourceFromReports(
  reports: Array<
    HarnessSourceReport | ((request: { scope: unknown; now: string }) => HarnessSourceReport)
  >,
  overrides: Partial<HarnessDiscoverySource> = {}
): HarnessDiscoverySource {
  let index = 0
  return {
    driverId: 'fake-driver',
    driverVersion: '9.9.9',
    transport: 'direct_local',
    ...overrides,
    discover(request) {
      const report = reports[Math.min(index, reports.length - 1)]!
      index += 1
      return Promise.resolve(typeof report === 'function' ? report(request) : report)
    },
  }
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    family: 'claude-code',
    displayName: 'Claude Code',
    provenance: 'user_managed' as const,
    executableIdentity: '/fake/claude',
    executableLabel: 'claude (path)',
    protocol: 'native' as const,
    acpAvailability: 'unavailable' as const,
    version: '2.0.1',
    auth: 'ready' as const,
    health: 'healthy' as const,
    capabilities: ['native', 'models'],
    sessionOperations: ['session.new'],
    entitlementHints: ['user_managed'],
    limitations: [],
    models: [],
    ...overrides,
  }
}

describe('harness family registry', () => {
  test('stays a closed supported set with detection metadata', () => {
    expect(harnessFamilySpecs.map((spec) => spec.family)).toEqual([
      'claude-code',
      'codex',
      'opencode',
      'pi',
    ])
    for (const spec of harnessFamilySpecs) {
      expect(spec.executableNames.length).toBeGreaterThan(0)
      expect(spec.versionArgv.length).toBeGreaterThan(0)
      expect(spec.requiredCapabilities.length).toBeGreaterThan(0)
    }
    expect(harnessFamilySpec('pi')?.authMarkers).toEqual([])
    expect(harnessFamilySpec('claude-code')?.displayName).toBe('Claude Code')
  })

  test('resolves executables in override, PATH, and known-location order', () => {
    const home = tempDirectory()
    try {
      const spec = harnessFamilySpec('claude-code')!
      const probe = {
        isRegularFile: (path: string) => existsSync(path),
        realPath: (path: string) => path,
      }
      expect(resolveExecutable({ spec, env: { HOME: home }, probe }).found).toBe(false)
      mkdirSync(join(home, '.claude', 'local'), { recursive: true })
      writeFileSync(join(home, '.claude', 'local', 'claude'), 'x')
      const known = resolveExecutable({ spec, env: { HOME: home, PATH: '/nowhere' }, probe })
      expect(known.found && known.label).toBe('claude (home)')
      mkdirSync(join(home, 'bin'), { recursive: true })
      writeFileSync(join(home, 'bin', 'claude'), 'x')
      const fromPath = resolveExecutable({
        spec,
        env: { HOME: home, PATH: `${home}/bin` },
        probe,
      })
      expect(fromPath.found && fromPath.label).toBe('claude (path)')
      const override = resolveExecutable({
        spec,
        env: {
          HOME: home,
          PATH: `${home}/bin`,
          ADEA_HARNESS_CLAUDE_CODE_EXECUTABLE: '/custom/claude',
        },
        probe: { isRegularFile: (path) => path === '/custom/claude', realPath: (path) => path },
      })
      expect(override.found && override.label).toBe('claude (override)')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('skips dangling-symlink candidates instead of adopting an unproven identity', () => {
    const home = tempDirectory()
    try {
      mkdirSync(join(home, 'bin'), { recursive: true })
      symlinkSync(join(home, 'missing-target'), join(home, 'bin', 'claude'))
      const spec = harnessFamilySpec('claude-code')!
      const probe = {
        // lstat-style truth: the link exists, but real path resolution fails.
        isRegularFile: (path: string) => path === join(home, 'bin', 'claude'),
        realPath: () => null,
      }
      expect(
        resolveExecutable({ spec, env: { HOME: home, PATH: `${home}/bin` }, probe }).found
      ).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('version probe parsing and comparison', () => {
  test('extracts the first dotted version token only', () => {
    expect(parseVersionOutput('2.0.1 (Claude Code)\nmore')).toBe('2.0.1')
    expect(parseVersionOutput('codex-cli 0.42.0')).toBe('0.42.0')
    expect(parseVersionOutput('no version here')).toBeNull()
    expect(parseVersionOutput('')).toBeNull()
  })

  test('compares dotted versions numerically', () => {
    expect(compareVersions('2.0.1', '2.0.0')).toBeGreaterThan(0)
    expect(compareVersions('1.9.9', '2.0.0')).toBeLessThan(0)
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0)
    expect(compareVersions('2.0', '2.0.0')).toBe(0)
  })
})

describe('local harness discovery', () => {
  test('discovers an installed harness with normalized fields and a stable identity', async () => {
    const home = tempDirectory()
    const dataDir = tempDirectory()
    try {
      fakeDevice(home, ['claude'])
      installAuthMarker(home, '.claude/.credentials.json')
      const { clock } = fixedClock()
      const versionProbe = fakeVersionProbe({
        [identityOf(join(home, 'bin', 'claude'))]: '2.0.1 (Claude Code)',
      })
      const inventory = createRuntimeConnectionInventory({
        dataDir,
        sources: [localSource({ env: { HOME: home, PATH: `${home}/bin` }, versionProbe })],
        clock,
      })

      const first = await inventory.discover(scope)
      expect(first.connections).toHaveLength(1)
      const entry = first.connections[0]!
      expect(entry.family).toBe('claude-code')
      expect(entry.driverId).toBe('local-executable')
      expect(entry.executableIdentity).toBe(identityOf(join(home, 'bin', 'claude')))
      // The label is redacted: it never carries the host path.
      expect(entry.executableLabel).toBe('claude (path)')
      expect(entry.executableLabel).not.toContain(home)
      expect(entry.protocol).toBe('native')
      expect(entry.version).toBe('2.0.1')
      expect(entry.auth).toBe('ready')
      expect(entry.health).toBe('healthy')
      expect(entry.provenance).toBe('user_managed')
      expect(entry.transport).toBe('direct_local')
      expect(entry.freshness).toBe('fresh')
      expect(entry.capabilities).toContain('native')
      expect(entry.sessionOperations).toContain('session.resume')
      expect(entry.id).toMatch(UUID_PATTERN)
      expect(entry.eligibility.eligible).toBe(true)
      expect(entry.eligibility.blockers).toEqual([])
      expect(first.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        'not_installed',
        'not_installed',
        'not_installed',
      ])

      // Rediscovery is idempotent on identity and bumps the generation.
      const second = await inventory.discover(scope)
      expect(second.connections[0]!.id).toBe(entry.id)
      expect(second.connections[0]!.generation).toBe(2)
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('reports the HarnessInstallation DTO key shape exactly', async () => {
    const home = tempDirectory()
    const dataDir = tempDirectory()
    try {
      fakeDevice(home, ['claude'])
      const { clock } = fixedClock()
      const inventory = createRuntimeConnectionInventory({
        dataDir,
        sources: [
          localSource({
            env: { HOME: home, PATH: `${home}/bin` },
            versionProbe: fakeVersionProbe({ [identityOf(join(home, 'bin', 'claude'))]: '2.0.1' }),
          }),
        ],
        clock,
      })
      const snapshot = await inventory.discover(scope)
      const installation = harnessInstallationOf(snapshot.connections[0]!)
      expect(Object.keys(installation).toSorted()).toEqual(
        [
          'id',
          'scope',
          'executableIdentity',
          'executableLabel',
          'protocol',
          'version',
          'auth',
          'health',
          'capabilities',
          'models',
          'observedAt',
          'generation',
        ].toSorted()
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('reports an empty device as an empty snapshot with classified diagnostics', async () => {
    const home = tempDirectory()
    const dataDir = tempDirectory()
    try {
      const { clock } = fixedClock()
      const inventory = createRuntimeConnectionInventory({
        dataDir,
        sources: [
          localSource({
            env: { HOME: home, PATH: `${home}/bin` },
            versionProbe: fakeVersionProbe({}),
          }),
        ],
        clock,
      })
      const discovered = await inventory.discover(scope)
      expect(discovered.connections).toEqual([])
      expect(discovered.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        'not_installed',
        'not_installed',
        'not_installed',
        'not_installed',
      ])
      expect(discovered.diagnostics.every((diagnostic) => !diagnostic.message.includes(home))).toBe(
        true
      )

      // A never-discovered inventory reads as an empty snapshot, not an error.
      const freshDir = tempDirectory()
      try {
        const fresh = createRuntimeConnectionInventory({
          dataDir: freshDir,
          sources: [],
          clock,
        })
        expect(fresh.read(scope).connections).toEqual([])
      } finally {
        rmSync(freshDir, { recursive: true, force: true })
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('reports partial installs truthfully', async () => {
    const home = tempDirectory()
    const dataDir = tempDirectory()
    try {
      fakeDevice(home, ['claude', 'codex'])
      const { clock } = fixedClock()
      const inventory = createRuntimeConnectionInventory({
        dataDir,
        sources: [
          localSource({
            env: { HOME: home, PATH: `${home}/bin` },
            versionProbe: fakeVersionProbe({
              [identityOf(join(home, 'bin', 'claude'))]: '2.0.1',
              [identityOf(join(home, 'bin', 'codex'))]: '0.42.0',
            }),
          }),
        ],
        clock,
      })
      const snapshot = await inventory.discover(scope)
      expect(snapshot.connections.map((entry) => entry.family).toSorted()).toEqual([
        'claude-code',
        'codex',
      ])
      expect(snapshot.diagnostics).toHaveLength(2)
      expect(snapshot.diagnostics.map((diagnostic) => diagnostic.family).toSorted()).toEqual([
        'opencode',
        'pi',
      ])
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('classifies version probe failures as degraded and timeouts distinctly', async () => {
    const home = tempDirectory()
    const dataDir = tempDirectory()
    try {
      fakeDevice(home, ['claude', 'codex'])
      const claudePath = join(home, 'bin', 'claude')
      const codexPath = join(home, 'bin', 'codex')
      const { clock } = fixedClock()
      const inventory = createRuntimeConnectionInventory({
        dataDir,
        sources: [
          localSource({
            env: { HOME: home, PATH: `${home}/bin` },
            versionProbe: fakeVersionProbe(
              {},
              {
                failures: {
                  [identityOf(claudePath)]: 'version_probe_failed',
                  [identityOf(codexPath)]: 'version_probe_timeout',
                },
              }
            ),
          }),
        ],
        clock,
      })
      const snapshot = await inventory.discover(scope)
      expect(snapshot.connections).toHaveLength(2)
      const claude = snapshot.connections.find((entry) => entry.family === 'claude-code')!
      const codex = snapshot.connections.find((entry) => entry.family === 'codex')!
      expect(claude.health).toBe('degraded')
      expect(claude.version).toBeUndefined()
      expect(codex.health).toBe('degraded')
      expect(snapshot.diagnostics.map((diagnostic) => diagnostic.code).toSorted()).toEqual([
        'not_installed',
        'not_installed',
        'version_probe_failed',
        'version_probe_timeout',
      ])
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('marks below-minimum versions ineligible instead of silently degraded', async () => {
    const home = tempDirectory()
    const dataDir = tempDirectory()
    try {
      fakeDevice(home, ['claude'])
      const { clock } = fixedClock()
      const pinned = { ...harnessFamilySpec('claude-code')!, minimumVersion: '3.0.0' }
      const inventory = createRuntimeConnectionInventory({
        dataDir,
        sources: [
          localSource({
            specs: [pinned],
            env: { HOME: home, PATH: `${home}/bin` },
            versionProbe: fakeVersionProbe({ [identityOf(join(home, 'bin', 'claude'))]: '2.0.1' }),
          }),
        ],
        clock,
      })
      const snapshot = await inventory.discover(scope)
      const entry = snapshot.connections[0]!
      expect(entry.version).toBe('2.0.1')
      expect(entry.health).toBe('healthy')
      expect(entry.eligibility.eligible).toBe(false)
      expect(entry.eligibility.blockers).toContainEqual({
        code: 'incompatible',
        message: 'installation version is not supported',
      })
      expect(snapshot.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        'incompatible_version'
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('classifies permission-denied auth markers without failing discovery', async () => {
    const home = tempDirectory()
    const dataDir = tempDirectory()
    try {
      fakeDevice(home, ['claude'])
      const { clock } = fixedClock()
      const deniedProbe = {
        isRegularFile: (path: string) => {
          if (path.includes('.claude')) {
            const error = new Error('permission denied') as NodeJS.ErrnoException
            error.code = 'EACCES'
            throw error
          }
          return existsSync(path)
        },
        realPath: (path: string) => path,
      }
      const inventory = createRuntimeConnectionInventory({
        dataDir,
        sources: [
          localSource({
            env: { HOME: home, PATH: `${home}/bin` },
            versionProbe: fakeVersionProbe({ [join(home, 'bin', 'claude')]: '2.0.1' }),
            probe: deniedProbe,
          }),
        ],
        clock,
      })
      const snapshot = await inventory.discover(scope)
      const entry = snapshot.connections[0]!
      expect(entry.auth).toBe('unknown')
      expect(entry.health).toBe('healthy')
      expect(snapshot.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        'permission_denied'
      )
      expect(entry.eligibility.eligible).toBe(false)
      expect(entry.eligibility.blockers[0]).toEqual({
        code: 'auth_required',
        message: 'harness authentication state is unverified',
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('user-managed Pi reports unknown auth and stays launch-blocked until verified', async () => {
    const home = tempDirectory()
    const dataDir = tempDirectory()
    try {
      fakeDevice(home, ['pi'])
      const { clock } = fixedClock()
      const inventory = createRuntimeConnectionInventory({
        dataDir,
        sources: [
          localSource({
            env: { HOME: home, PATH: `${home}/bin` },
            versionProbe: fakeVersionProbe({ [identityOf(join(home, 'bin', 'pi'))]: '1.2.3' }),
          }),
        ],
        clock,
      })
      const snapshot = await inventory.discover(scope)
      const entry = snapshot.connections[0]!
      expect(entry.family).toBe('pi')
      expect(entry.auth).toBe('unknown')
      expect(entry.eligibility.eligible).toBe(false)
      expect(entry.entitlementHints).toContain('user_managed')
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe('RuntimeConnection inventory', () => {
  test('read never re-probes and classifies stale observations on read', async () => {
    const home = tempDirectory()
    const dataDir = tempDirectory()
    const { clock, advance } = fixedClock()
    try {
      fakeDevice(home, ['claude'])
      const versionProbe = fakeVersionProbe({ [identityOf(join(home, 'bin', 'claude'))]: '2.0.1' })
      const inventory = createRuntimeConnectionInventory({
        dataDir,
        sources: [localSource({ env: { HOME: home, PATH: `${home}/bin` }, versionProbe })],
        clock,
        staleAfterMs: 1_000,
      })
      await inventory.discover(scope)
      const probeCount = versionProbe.calls.length

      const fresh = inventory.read(scope)
      expect(fresh.connections[0]!.freshness).toBe('fresh')
      expect(versionProbe.calls.length).toBe(probeCount)

      advance(2_000)
      const stale = inventory.read(scope)
      expect(stale.connections[0]!.freshness).toBe('stale')
      expect(stale.connections[0]!.eligibility.eligible).toBe(false)
      expect(stale.connections[0]!.eligibility.blockers).toContainEqual({
        code: 'unavailable',
        message: 'observation is stale; refresh discovery before launch',
      })
      expect(versionProbe.calls.length).toBe(probeCount)
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('reports disappeared runtimes on rediscovery without resurrecting them on read', async () => {
    const home = tempDirectory()
    const dataDir = tempDirectory()
    try {
      fakeDevice(home, ['claude'])
      const { clock } = fixedClock()
      const inventory = createRuntimeConnectionInventory({
        dataDir,
        sources: [
          localSource({
            env: { HOME: home, PATH: `${home}/bin` },
            versionProbe: fakeVersionProbe({ [identityOf(join(home, 'bin', 'claude'))]: '2.0.1' }),
          }),
        ],
        clock,
      })
      const first = await inventory.discover(scope)
      expect(first.connections).toHaveLength(1)

      // Read after the executable vanished still shows the last observation.
      rmSync(join(home, 'bin', 'claude'))
      expect(inventory.read(scope).connections).toHaveLength(1)

      const second = await inventory.discover(scope)
      expect(second.connections).toEqual([])
      expect(second.diagnostics.map((diagnostic) => diagnostic.code)).toContain('not_installed')
      expect(inventory.read(scope).connections).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('keeps scopes isolated and never wipes another scope during rediscovery', async () => {
    const dataDir = tempDirectory()
    try {
      const { clock } = fixedClock()
      const inventory = createRuntimeConnectionInventory({
        dataDir,
        sources: [sourceFromReports([{ connections: [candidate()], diagnostics: [] }])],
        clock,
      })
      await inventory.discover(scope)
      expect(inventory.read(otherScope).connections).toEqual([])
      await inventory.discover(otherScope)
      const scopeA = inventory.read(scope)
      const scopeB = inventory.read(otherScope)
      expect(scopeA.connections).toHaveLength(1)
      expect(scopeB.connections).toHaveLength(1)
      expect(scopeA.connections[0]!.id).not.toBe(scopeB.connections[0]!.id)
      expect(scopeA.diagnostics).toEqual([])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('aggregates managed-Pi and ACP-style sources and gives managed provenance precedence', async () => {
    const dataDir = tempDirectory()
    try {
      const { clock } = fixedClock()
      // M10 #31-style managed Pi source reporting the same executable identity
      // the local user-managed source would find.
      const managedPi = sourceFromReports(
        [
          {
            connections: [
              candidate({
                family: 'pi',
                displayName: 'Pi (managed)',
                provenance: 'managed',
                executableIdentity: '/fake/pi',
                auth: 'ready',
                entitlementHints: ['managed', 'adea_supervised'],
              }),
            ],
            diagnostics: [],
          },
        ],
        { driverId: 'managed-pi', driverVersion: '0.1.0' }
      )
      const userPi = sourceFromReports(
        [
          {
            connections: [
              candidate({
                family: 'pi',
                displayName: 'Pi',
                provenance: 'user_managed',
                auth: 'unknown',
                executableIdentity: '/fake/pi',
              }),
            ],
            diagnostics: [],
          },
        ],
        { driverId: 'local-executable' }
      )
      // M10 #32-style ACP source with negotiated availability and version.
      const acp = sourceFromReports(
        [
          {
            connections: [
              candidate({
                family: 'devin-acp',
                protocol: 'acp',
                acpAvailability: 'available',
                acpVersion: '1.2.0',
                executableIdentity: '/fake/devin',
                capabilities: ['acp', 'session.resume'],
              }),
            ],
            diagnostics: [],
          },
        ],
        { driverId: 'acp-driver' }
      )
      const inventory = createRuntimeConnectionInventory({
        dataDir,
        sources: [userPi, managedPi, acp],
        clock,
      })
      const snapshot = await inventory.discover(scope)
      expect(snapshot.connections).toHaveLength(2)
      const pi = snapshot.connections.find((entry) => entry.family === 'pi')!
      expect(pi.provenance).toBe('managed')
      expect(pi.driverId).toBe('managed-pi')
      expect(pi.displayName).toBe('Pi (managed)')
      const devin = snapshot.connections.find((entry) => entry.family === 'devin-acp')!
      expect(devin.protocol).toBe('acp')
      expect(devin.acpAvailability).toBe('available')
      expect(devin.acpVersion).toBe('1.2.0')
      expect(devin.transport).toBe('direct_local')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('applies scope capability policy to eligibility', async () => {
    const dataDir = tempDirectory()
    try {
      const { clock } = fixedClock()
      const inventory = createRuntimeConnectionInventory({
        dataDir,
        sources: [
          sourceFromReports([
            { connections: [candidate({ capabilities: ['native'] })], diagnostics: [] },
          ]),
        ],
        clock,
        requiredCapabilitiesFor: () => ['native', 'acp'],
      })
      const snapshot = await inventory.discover(scope)
      const entry = snapshot.connections[0]!
      expect(entry.eligibility.eligible).toBe(false)
      expect(entry.eligibility.blockers).toEqual([
        {
          code: 'capability_unavailable',
          message: 'required capabilities are not declared (count: 1)',
        },
      ])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('drops oversized candidate metadata with limit_exceeded instead of truncating silently', async () => {
    const dataDir = tempDirectory()
    try {
      const { clock } = fixedClock()
      const oversized = candidate({ executableLabel: 'x'.repeat(257) })
      const oversizedModels = candidate({
        models: Array.from({ length: 1_001 }, (_, index) => ({
          id: `m${index}`,
          displayName: 'm',
          capabilities: [],
        })),
      })
      const flood = Array.from({ length: 70 }, (_, index) =>
        candidate({ executableIdentity: `/fake/claude-${index}` })
      )
      const inventory = createRuntimeConnectionInventory({
        dataDir,
        sources: [
          sourceFromReports([{ connections: [oversized], diagnostics: [] }], {
            driverId: 'oversized',
          }),
          sourceFromReports([{ connections: [oversizedModels], diagnostics: [] }], {
            driverId: 'oversized-models',
          }),
          sourceFromReports([{ connections: flood, diagnostics: [] }], { driverId: 'flood' }),
        ],
        clock,
      })
      const snapshot = await inventory.discover(scope)
      expect(snapshot.connections).toHaveLength(64)
      const codes = snapshot.diagnostics.map((diagnostic) => diagnostic.code)
      expect(codes.filter((code) => code === 'limit_exceeded')).toHaveLength(3)
      expect(snapshot.diagnostics.every((diagnostic) => diagnostic.message.length <= 512)).toBe(
        true
      )
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('fails closed on a corrupt store and retains the unread file', () => {
    const dataDir = tempDirectory()
    try {
      const { clock } = fixedClock()
      const inventory = createRuntimeConnectionInventory({ dataDir, sources: [], clock })
      const storeFile = join(dataDir, 'dev-runtime', 'discovery', 'inventory.json')
      mkdirSync(join(dataDir, 'dev-runtime', 'discovery'), { recursive: true })
      writeFileSync(storeFile, 'not json at all')
      let code = ''
      try {
        inventory.read(scope)
      } catch (error) {
        code = (error as DevAuthorityError).code
      }
      expect(code).toBe('corrupt_state')
      // The unread input was retained for export/recovery, never deleted.
      const retained = readdirSorted(join(dataDir, 'dev-runtime', 'discovery')).some((name) =>
        name.startsWith('inventory.json.corrupt-')
      )
      expect(retained).toBe(true)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('performs no persistent native configuration change and writes path-free audit rows', async () => {
    const home = tempDirectory()
    const dataDir = tempDirectory()
    try {
      fakeDevice(home, ['claude', 'codex'])
      installAuthMarker(home, '.claude/.credentials.json')
      const before = homeTreeDigest(home)
      const auditFile = join(dataDir, 'audit.jsonl')
      const { clock } = fixedClock()
      const inventory = createRuntimeConnectionInventory({
        dataDir,
        sources: [
          localSource({
            env: { HOME: home, PATH: `${home}/bin` },
            versionProbe: fakeVersionProbe({
              [identityOf(join(home, 'bin', 'claude'))]: '2.0.1',
              [identityOf(join(home, 'bin', 'codex'))]: '0.42.0',
            }),
          }),
        ],
        clock,
        audit: createAuthorityAudit({ file: auditFile }),
      })
      await inventory.discover(scope)
      expect(homeTreeDigest(home)).toBe(before)

      const lines = readFileSync(auditFile, 'utf8').trim().split('\n')
      expect(lines).toHaveLength(1)
      const entry = JSON.parse(lines[0]!) as {
        action: string
        subjectId: string
        detail: Record<string, string>
      }
      expect(entry.action).toBe('discovery.completed')
      expect(entry.subjectId).toBe(scope.runtimeNodeId)
      expect(JSON.stringify(entry)).not.toContain(home)
      expect(entry.detail).toEqual({ connections: '2', diagnostics: '2', drivers: '1' })
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
