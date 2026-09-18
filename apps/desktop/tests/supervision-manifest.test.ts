// The bundled component manifest (M10 #185): exact version/platform/digest,
// compatibility window, install/data locations, startup order, health probe,
// and rollback target for every supervised local component. The Dev Runtime
// sidecar registers with the supervision lifecycle this manifest feeds.
import { describe, expect, test } from 'bun:test'

import {
  decodeComponentManifest,
  evaluateCompatibility,
  resolveRollbackTarget,
  requiredComponents,
  startupPlan,
  type ComponentManifest,
} from '../shell/src/supervision/component-manifest'

function componentSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'local-control-plane',
    product: 'Adea Control Plane (local)',
    version: '1.2.3',
    platform: 'darwin',
    arch: 'arm64',
    digestSha256: 'a'.repeat(64),
    signature: 'c2ln',
    compatibility: { minAppVersion: '0.26.0', maxAppVersion: '0.27.0' },
    installLocation: 'Contents/Resources/components/control-plane',
    dataLocation: 'components/control-plane',
    startupPhase: 0,
    dependsOn: [],
    healthProbe: { kind: 'endpoint', intervalMs: 15_000, unhealthyAfterMs: 45_000 },
    protocol: { name: 'control-plane.local', major: 1, minor: 0 },
    rollbackTargetVersion: '1.2.2',
    required: true,
    ...overrides,
  }
}

function manifestWith(...components: Array<Record<string, unknown>>): unknown {
  return { schemaVersion: 1, components: components.map((c) => componentSpec(c)) }
}

const HOST = { platform: 'darwin', arch: 'arm64', appVersion: '0.26.19' }

describe('component manifest decode', () => {
  test('decodes a version-1 manifest with control plane, pi, optional cortana, and sidecar', () => {
    const decoded = decodeComponentManifest(
      manifestWith(
        {},
        {
          id: 'managed-pi',
          product: 'Managed Pi',
          startupPhase: 1,
          dependsOn: ['local-control-plane'],
          protocol: { name: 'pi.local', major: 2, minor: 1 },
          rollbackTargetVersion: null,
        },
        {
          id: 'cortana',
          product: 'Cortana',
          startupPhase: 2,
          dependsOn: ['local-control-plane'],
          required: false,
          rollbackTargetVersion: null,
        },
        {
          id: 'dev-runtime-sidecar',
          product: 'Dev Runtime terminal sidecar',
          startupPhase: 3,
          dependsOn: [],
          healthProbe: { kind: 'process', intervalMs: 15_000, unhealthyAfterMs: 45_000 },
          protocol: { name: 'adea.sidecar.terminal', major: 1, minor: 0 },
          rollbackTargetVersion: null,
        }
      )
    )
    expect(decoded.ok).toBe(true)
    if (decoded.ok) {
      expect(decoded.manifest.schemaVersion).toBe(1)
      expect(decoded.manifest.components).toHaveLength(4)
      const sidecar = decoded.manifest.components[3]
      expect(sidecar.id).toBe('dev-runtime-sidecar')
      expect(sidecar.protocol).toEqual({ name: 'adea.sidecar.terminal', major: 1, minor: 0 })
    }
  })

  test('rejects an unknown schema version as unsupported_version instead of guessing', () => {
    const raw = manifestWith() as { schemaVersion: number }
    raw.schemaVersion = 2
    expect(decodeComponentManifest(raw)).toMatchObject({ ok: false, reason: 'unsupported_version' })
  })

  test.each([
    ['not an object', [1, 2, 3]],
    ['components missing', { schemaVersion: 1 }],
    ['duplicate ids', manifestWith({}, {})],
    ['dangling dependency', manifestWith({ id: 'managed-pi', dependsOn: ['local-control-plane'] })],
    ['short digest', manifestWith({ digestSha256: 'a'.repeat(63) })],
    ['non-hex digest', manifestWith({ digestSha256: 'z'.repeat(64) })],
    ['self dependency', manifestWith({ dependsOn: ['local-control-plane'] })],
    [
      'probe unhealthy before interval',
      manifestWith({
        healthProbe: { kind: 'endpoint', intervalMs: 45_000, unhealthyAfterMs: 15_000 },
      }),
    ],
    [
      'unknown probe kind',
      manifestWith({ healthProbe: { kind: 'tcp', intervalMs: 15_000, unhealthyAfterMs: 45_000 } }),
    ],
    ['unknown platform', manifestWith({ platform: 'sunos' })],
    ['non-integer startup phase', manifestWith({ startupPhase: 1.5 })],
  ])('rejects %s as corrupt_state', (_name, raw) => {
    expect(decodeComponentManifest(raw)).toEqual({ ok: false, reason: 'corrupt_state' })
  })
})

describe('component compatibility', () => {
  test('accepts a matching platform/arch inside the app version window', () => {
    const decoded = decodeComponentManifest(manifestWith({}))
    expect(decoded.ok).toBe(true)
    if (decoded.ok) {
      const result = evaluateCompatibility(decoded.manifest, HOST)
      expect(result.incompatible).toEqual([])
      expect(result.compatible.map((c) => c.id)).toEqual(['local-control-plane'])
    }
  })

  test('universal platform/arch components match any host', () => {
    const decoded = decodeComponentManifest(
      manifestWith({ platform: 'universal', arch: 'universal' })
    )
    expect(decoded.ok).toBe(true)
    if (decoded.ok) {
      const result = evaluateCompatibility(decoded.manifest, {
        platform: 'linux',
        arch: 'x64',
        appVersion: '0.26.19',
      })
      expect(result.incompatible).toEqual([])
    }
  })

  test('refuses platform, arch, and version-window mismatches with actionable reasons', () => {
    const decoded = decodeComponentManifest(
      manifestWith(
        { id: 'a', platform: 'darwin', arch: 'arm64' },
        { id: 'b', platform: 'universal', arch: 'x64' },
        { id: 'c', compatibility: { minAppVersion: '0.27.0', maxAppVersion: '0.28.0' } },
        { id: 'd', compatibility: { minAppVersion: '0.20.0', maxAppVersion: '0.25.0' } }
      )
    )
    expect(decoded.ok).toBe(true)
    if (decoded.ok) {
      const result = evaluateCompatibility(decoded.manifest, HOST)
      expect(result.incompatible.map((i) => [i.component.id, i.reason])).toEqual([
        ['b', 'arch'],
        ['c', 'version_window'],
        ['d', 'version_window'],
      ])
    }
  })
})

describe('startup ordering', () => {
  const decoded = decodeComponentManifest(
    manifestWith(
      {},
      { id: 'cortana', startupPhase: 2, dependsOn: ['local-control-plane'], required: false },
      { id: 'managed-pi', startupPhase: 1, dependsOn: ['local-control-plane'] },
      { id: 'dev-runtime-sidecar', startupPhase: 3 }
    )
  ) as { ok: true; manifest: ComponentManifest }

  test('orders components by declared phase and dependencies, optional ones included', () => {
    expect(startupPlan(decoded.manifest)).toEqual({
      ok: true,
      phases: [['local-control-plane'], ['managed-pi'], ['cortana'], ['dev-runtime-sidecar']],
    })
  })

  test('refuses a dependency cycle instead of deadlocking at boot', () => {
    const cyclic = decodeComponentManifest(
      manifestWith({ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] })
    )
    expect(cyclic.ok).toBe(true)
    if (cyclic.ok) {
      expect(startupPlan(cyclic.manifest)).toMatchObject({ ok: false, reason: 'invalid_state' })
    }
  })
})

describe('baseline readiness and rollback', () => {
  const decoded = decodeComponentManifest(
    manifestWith({}, { id: 'cortana', required: false, rollbackTargetVersion: null })
  ) as { ok: true; manifest: ComponentManifest }

  test('optional components never gate baseline readiness', () => {
    expect(requiredComponents(decoded.manifest).map((c) => c.id)).toEqual(['local-control-plane'])
  })

  test('rollback resolves the explicit target and preserves the data location', () => {
    const rollback = resolveRollbackTarget(decoded.manifest, 'local-control-plane')
    expect(rollback).toEqual({
      ok: true,
      componentId: 'local-control-plane',
      fromVersion: '1.2.3',
      toVersion: '1.2.2',
      dataLocation: 'components/control-plane',
    })
  })

  test('a component without an explicit rollback target refuses to roll back implicitly', () => {
    expect(resolveRollbackTarget(decoded.manifest, 'cortana')).toMatchObject({
      ok: false,
      reason: 'no_rollback_target',
    })
  })

  test('an unknown component id is not_found', () => {
    expect(resolveRollbackTarget(decoded.manifest, 'nope')).toMatchObject({
      ok: false,
      reason: 'not_found',
    })
  })
})
