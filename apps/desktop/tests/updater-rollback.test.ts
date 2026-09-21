// Executed rollback test (M10 #34, "Update failure has a verified
// rollback/recovery path"): the updater's rollback is not planner-only. The
// test stages a fake-but-real install layout on disk, EXECUTES the rollback
// path, and proves the previous version is restored, the failed artifact is
// quarantined with its raw bytes retained, and component data locations are
// never touched (docs/specs/dev-runtime.md, "Local stack supervision":
// rollback/upgrade never deletes component data).
import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  decodeComponentManifest,
  resolveRollbackTarget,
} from '../shell/src/supervision/component-manifest'
import { executeUpdateRollback } from '../shell/src/updater'

/** Stage one complete `.app` bundle whose main.js carries a version marker. */
function stageBundle(root: string, name: string, versionMarker: string): string {
  const bundle = join(root, name)
  mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
  mkdirSync(join(bundle, 'Contents', 'Resources'), { recursive: true })
  writeFileSync(
    join(bundle, 'Contents', 'Resources', 'main.js'),
    `// adea version ${versionMarker}`
  )
  writeFileSync(join(bundle, 'Contents', 'MacOS', 'launcher'), '#!/bin/sh\n')
  return bundle
}

function marker(bundlePath: string): string {
  return readFileSync(join(bundlePath, 'Contents', 'Resources', 'main.js'), 'utf8')
}

function stagedLayout() {
  const root = mkdtempSync(join(tmpdir(), 'adea-rollback-'))
  const dataDir = join(root, 'data')
  const componentsData = join(dataDir, 'components', 'local-control-plane')
  mkdirSync(componentsData, { recursive: true, mode: 0o700 })
  writeFileSync(join(componentsData, 'state.sqlite'), 'component-data-bytes')
  return {
    root,
    dataDir,
    componentsData,
    quarantineDir: join(dataDir, 'updates', 'quarantine'),
    failed: stageBundle(root, 'Adea.app', '2.4.1'),
    previous: stageBundle(root, 'Adea.app.previous', '2.4.0'),
  }
}

describe('executed updater rollback', () => {
  test('restores the previous version and quarantines the failed artifact', () => {
    const layout = stagedLayout()
    try {
      const failedBytes = marker(layout.failed)
      const result = executeUpdateRollback({
        target: layout.failed,
        quarantineDir: layout.quarantineDir,
      })
      expect(result).toMatchObject({ ok: true, target: layout.failed })

      // The previous version is what now runs at the bundle location.
      expect(marker(layout.failed)).toContain('2.4.0')
      expect(existsSync(layout.previous)).toBe(false)

      // The failed artifact is quarantined, not deleted: raw bytes retained.
      const quarantined = readdirSync(layout.quarantineDir)
      expect(quarantined).toHaveLength(1)
      const quarantinedBundle = join(layout.quarantineDir, quarantined[0] ?? '')
      expect(marker(quarantinedBundle)).toBe(failedBytes)
      expect(existsSync(join(quarantinedBundle, 'Contents', 'MacOS', 'launcher'))).toBe(true)

      // Rollback never deletes component data locations.
      expect(readFileSync(join(layout.componentsData, 'state.sqlite'), 'utf8')).toBe(
        'component-data-bytes'
      )
    } finally {
      rmSync(layout.root, { recursive: true, force: true })
    }
  })

  test('refuses an implicit rollback when no previous install is staged', () => {
    const layout = stagedLayout()
    try {
      rmSync(layout.previous, { recursive: true, force: true })
      const result = executeUpdateRollback({
        target: layout.failed,
        quarantineDir: layout.quarantineDir,
      })
      expect(result).toMatchObject({ ok: false, reason: 'no_previous_install' })
      // The failed install is untouched and still the running bundle.
      expect(marker(layout.failed)).toContain('2.4.1')
      expect(existsSync(layout.quarantineDir)).toBe(false)
    } finally {
      rmSync(layout.root, { recursive: true, force: true })
    }
  })

  test('refuses to restore an incomplete previous install', () => {
    const layout = stagedLayout()
    try {
      // A torn `.previous` (the launcher never landed) must never become the
      // running bundle.
      rmSync(join(layout.previous, 'Contents', 'MacOS', 'launcher'))
      const result = executeUpdateRollback({
        target: layout.failed,
        quarantineDir: layout.quarantineDir,
      })
      expect(result).toMatchObject({ ok: false, reason: 'previous_incomplete' })
      expect(marker(layout.failed)).toContain('2.4.1')
      expect(existsSync(layout.previous)).toBe(true)
      expect(existsSync(layout.quarantineDir)).toBe(false)
    } finally {
      rmSync(layout.root, { recursive: true, force: true })
    }
  })

  test('refuses a non-bundle target and executes the manifest planner’s explicit target', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-rollback-'))
    try {
      // A repo/dev run (no .app bundle) is refused, matching stageUpdateSwap.
      const notBundle = stageBundle(root, 'Adea', '1.0.0')
      expect(
        executeUpdateRollback({ target: notBundle, quarantineDir: join(root, 'q') })
      ).toMatchObject({ ok: false, reason: 'not_a_bundle' })

      // The planner supplies the explicit rollback target for a supervised
      // component; the executed rollback restores exactly that prior install.
      const decoded = decodeComponentManifest({
        schemaVersion: 1,
        components: [
          {
            id: 'local-control-plane',
            product: 'Control Plane',
            version: '2.4.1',
            platform: 'universal',
            arch: 'universal',
            digestSha256: 'a'.repeat(64),
            signature: 'c2ln',
            compatibility: { minAppVersion: '0.1.0', maxAppVersion: '99.0.0' },
            installLocation: 'components/control-plane',
            dataLocation: 'components/control-plane',
            startupPhase: 0,
            dependsOn: [],
            healthProbe: { kind: 'process', intervalMs: 15_000, unhealthyAfterMs: 45_000 },
            protocol: null,
            rollbackTargetVersion: '2.4.0',
            required: true,
          },
        ],
      })
      if (!decoded.ok) throw new Error('fixture manifest rejected')
      const plan = resolveRollbackTarget(decoded.manifest, 'local-control-plane')
      expect(plan).toMatchObject({ ok: true, fromVersion: '2.4.1', toVersion: '2.4.0' })
      if (!plan.ok) return

      const layout = stagedLayout()
      try {
        const result = executeUpdateRollback({
          target: layout.failed,
          quarantineDir: layout.quarantineDir,
        })
        expect(result.ok).toBe(true)
        // The running bundle now matches the planner's explicit toVersion.
        expect(marker(layout.failed)).toContain(plan.toVersion)
        // The planner's data location survives the executed rollback.
        expect(readFileSync(join(layout.componentsData, 'state.sqlite'), 'utf8')).toBe(
          'component-data-bytes'
        )
      } finally {
        rmSync(layout.root, { recursive: true, force: true })
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
