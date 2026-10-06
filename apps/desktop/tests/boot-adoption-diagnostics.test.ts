// Boot-adoption diagnostics and the packaged bundle resolution fix
// (issue #1039). On a packaged boot — any install path, /Applications or a
// copied bundle — the shell entry runs from Electrobun's flat-file layout at
// `Contents/Resources/app/bun/index.js`, so the previous fixed three-level
// bundle-root hop landed on `Contents`, never matched, and every packaged
// boot misread itself as a repo dev run: the terminal lane took the dev
// fallback, spawned the source-tree entry path that does not exist inside a
// bundle (stdout/stderr ignored), and reported the unnameable
// "never published its endpoint file" timeout. These tests pin:
//  1. the resolution — the real layout resolves; dev runs and marker-less
//     `.app` ancestors never do;
//  2. the journal — spawn argv/env-keys/cwd/pid, child exit, publish watch,
//     and outcome are durable, owner-only, bounded, and secret-free;
//  3. the timeout naming — a child that dies before publishing names that
//     step in the failure message, and the readiness window is injectable
//     for tests while production keeps the measured 20s bound.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  bootAdoptionJournalModes,
  bootAdoptionJournalPath,
  createBootAdoptionJournal,
} from '../shell/src/supervision/boot-diagnostics'
import { createProcessAdapter } from '../shell/src/supervision/process-adapter'
import type { ComponentSpec } from '../shell/src/supervision/component-manifest'
import {
  adoptShellTerminalSidecar,
  SIDECAR_READY_TIMEOUT_MS,
} from '../shell/src/bun/boot-supervision'
import { devSidecarPlan } from '../shell/src/bun/boot-sidecar-plan'
import { findRunningAppBundle } from '../shell/scripts/packaged-install'

const SCOPE = {
  accountId: '00000000-0000-4000-8000-000000001039',
  workspaceId: '00000000-0000-4000-8000-000000002039',
  runtimeNodeId: '00000000-0000-4000-8000-000000003039',
}

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'adea-boot-diagnostics-'))
}

function journalEntries(dataDir: string): unknown[] {
  const raw = readFileSync(bootAdoptionJournalPath(dataDir), 'utf8')
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
}

/** The Electrobun flat-file packaged layout the launcher really loads
 *  (`main.js`: `join(appFolderPath, 'bun', 'index.js')`), with the bundled
 *  Bun runtime marker the manifest resolution requires. */
function makeElectrobunLayoutBundle(): string {
  const bundle = join(mkdtempSync(join(tmpdir(), 'adea-electrobun-fixture-')), 'Adea-dev.app')
  mkdirSync(join(bundle, 'Contents/Resources/app/bun'), { recursive: true })
  mkdirSync(join(bundle, 'Contents/MacOS'), { recursive: true })
  writeFileSync(join(bundle, 'Contents/Resources/app/bun/index.js'), '// shell entry\n')
  writeFileSync(join(bundle, 'Contents/MacOS/bun'), '#!/bin/sh\n')
  writeFileSync(join(bundle, 'Contents/MacOS/launcher'), 'launcher-bytes')
  writeFileSync(
    join(bundle, 'Contents/Resources/version.json'),
    JSON.stringify({ version: '9.9.9', channel: 'dev' })
  )
  return bundle
}

describe('packaged bundle resolution (#1039 regression)', () => {
  test('the real Electrobun flat-file layout (entry at app/bun) resolves its own bundle', () => {
    const bundle = makeElectrobunLayoutBundle()
    try {
      // The launcher loads the entry from Contents/Resources/app/bun, so the
      // running shell's import.meta.dir is the bun subdirectory — four levels
      // below the bundle root, not three.
      const entryDir = join(bundle, 'Contents/Resources/app/bun')
      expect(findRunningAppBundle(entryDir)).toBe(bundle)
      // The fixture/asar-adjacent anchoring keeps working too.
      expect(findRunningAppBundle(join(bundle, 'Contents/Resources/app'))).toBe(bundle)
    } finally {
      rmSync(bundle.slice(0, bundle.lastIndexOf('/Adea-dev.app')), { recursive: true, force: true })
    }
  })

  test('a repo dev run and a marker-less .app ancestor never match', () => {
    // A dev-run tree: no .app ancestor at all.
    expect(findRunningAppBundle(join(tmpdir(), 'adea-dev-run/src/bun'))).toBeNull()
    // An unrelated .app directory above the entry (no bundled Bun runtime
    // marker) is skipped, never mistaken for the running bundle.
    const decoyRoot = mkdtempSync(join(tmpdir(), 'adea-decoy-'))
    try {
      const decoyApp = join(decoyRoot, 'SomeOther.app')
      mkdirSync(join(decoyApp, 'Contents/MacOS'), { recursive: true })
      mkdirSync(join(decoyApp, 'Contents/Resources/app/bun'), { recursive: true })
      writeFileSync(join(decoyApp, 'Contents/MacOS/electron'), 'not-adea')
      expect(findRunningAppBundle(join(decoyApp, 'Contents/Resources/app/bun'))).toBeNull()
    } finally {
      rmSync(decoyRoot, { recursive: true, force: true })
    }
  })
})

describe('boot-adoption journal', () => {
  test('records entries as owner-only bounded JSONL with env key names only', () => {
    const dataDir = tempDataDir()
    try {
      const journal = createBootAdoptionJournal(dataDir)
      expect(journal.path()).toBe(bootAdoptionJournalPath(dataDir))
      journal.append({
        kind: 'spawn',
        at: new Date().toISOString(),
        mode: 'engine',
        argv: ['/bin/echo', 'sidecar'],
        envKeys: ['HOME', 'PATH', 'ADEA_SIDECAR_VERSION'],
        cwd: null,
        pid: 4242,
      })
      const entries = journalEntries(dataDir)
      expect(entries).toHaveLength(1)
      const serialized = readFileSync(bootAdoptionJournalPath(dataDir), 'utf8')
      // Key names only — a value-bearing record would be a secret leak.
      expect(serialized).toContain('"envKeys":["HOME","PATH","ADEA_SIDECAR_VERSION"]')
      expect(serialized).not.toContain('env":')
      const modes = bootAdoptionJournalModes(dataDir)
      expect(modes.dirMode).toBe(0o700)
      expect(modes.fileMode).toBe(0o600)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('retention is bounded: the file trims to the most recent lines', () => {
    const dataDir = tempDataDir()
    try {
      // Pre-seed beyond the bound; creation trims to the most recent lines.
      const path = bootAdoptionJournalPath(dataDir)
      mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
      const lines: string[] = []
      for (let index = 0; index < 500; index += 1) {
        lines.push(JSON.stringify({ kind: 'seed', index }))
      }
      appendFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 })
      const journal = createBootAdoptionJournal(dataDir)
      const seeded = journalEntries(dataDir)
      expect(seeded.length).toBeLessThanOrEqual(200)
      expect((seeded.at(-1) as { index: number }).index).toBe(499)
      // Periodic in-run trimming keeps appends bounded too.
      for (let index = 0; index < 200; index += 1) {
        journal.append({
          kind: 'adoption-outcome',
          at: new Date().toISOString(),
          ok: true,
          detail: `entry ${index}`,
        })
      }
      const counted = readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0).length
      expect(counted).toBeLessThanOrEqual(400)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('an unwritable location degrades to a no-op journal instead of failing the boot', () => {
    const workDir = tempDataDir()
    try {
      const blocker = join(workDir, 'not-a-dir')
      writeFileSync(blocker, 'occupied', { mode: 0o600 })
      // dataDir under a regular file: the journal's mkdir fails.
      const journal = createBootAdoptionJournal(join(blocker, 'data'))
      expect(() =>
        journal.append({
          kind: 'adoption-attempt',
          at: new Date().toISOString(),
          mode: 'dev',
          supervisorPresent: false,
          executableIdentity: 'test',
        })
      ).not.toThrow()
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })
})

describe('boot adoption diagnostics at the seam (#1039)', () => {
  test(
    'a sidecar child that dies before publishing names its failing step',
    { timeout: 30_000 },
    async () => {
      const dataDir = tempDataDir()
      try {
        // The #1039 failure shape, modeled: the plan spawns a child that
        // exits 1 immediately (the packaged layout's dev fallback spawned a
        // nonexistent source-tree entry), stdout/stderr discarded.
        const plan = {
          mode: 'dev' as const,
          executableIdentity: 'adea-terminal-sidecar@broken',
          spawnFacts: (dir: string) => ({
            argv: [process.execPath, '-e', 'process.exit(1)', '--data-dir', dir],
            envKeys: ['HOME', 'PATH', 'ADEA_SIDECAR_VERSION'],
            cwd: dir,
          }),
          start: (dir: string) =>
            Bun.spawn([process.execPath, '-e', 'process.exit(1)'], {
              stdout: 'ignore',
              stderr: 'ignore',
              cwd: dir,
            }),
        }
        const adoption = await adoptShellTerminalSidecar({
          dataDir,
          scope: SCOPE,
          plan,
          readyTimeoutMs: 600,
        })
        expect(adoption.ok).toBe(false)
        if (adoption.ok) return
        expect(adoption.code).toBe('timeout')
        // The message names the failing step: the child's exit, the watched
        // window, and where the durable evidence lives.
        expect(adoption.message).toContain('exited with code 1')
        expect(adoption.message).toContain('watched 0.6s')
        expect(adoption.message).toContain('boot-adoption.jsonl')
        // The journal holds the whole story, in order.
        const kinds = journalEntries(dataDir).map((entry) => (entry as { kind: string }).kind)
        expect(kinds).toEqual(['adoption-attempt', 'spawn', 'spawn-exit', 'endpoint-watch'])
        const spawn = journalEntries(dataDir)[1] as {
          argv: string[]
          envKeys: string[]
          cwd: string | null
          pid: number
        }
        expect(spawn.argv[0]).toBe(process.execPath)
        expect(spawn.cwd).toBe(dataDir)
        expect(spawn.pid).toBeGreaterThan(0)
        const watch = journalEntries(dataDir)[3] as {
          found: boolean
          detail: string
        }
        expect(watch.found).toBe(false)
        expect(watch.detail).toContain('exited with code 1')
      } finally {
        rmSync(dataDir, { recursive: true, force: true })
      }
    }
  )

  test(
    'a successful dev-run adoption journals the attempt, the publish watch, and the outcome',
    { timeout: 30_000 },
    async () => {
      if (process.platform !== 'darwin') return
      const dataDir = tempDataDir()
      try {
        const adoption = await adoptShellTerminalSidecar({
          dataDir,
          scope: SCOPE,
          plan: devSidecarPlan(),
        })
        expect(adoption.ok).toBe(true)
        if (!adoption.ok) return
        const kinds = journalEntries(dataDir).map((entry) => (entry as { kind: string }).kind)
        expect(kinds).toContain('adoption-attempt')
        expect(kinds).toContain('spawn')
        expect(kinds).toContain('endpoint-watch')
        expect(kinds).toContain('adoption-outcome')
        const watch = journalEntries(dataDir).find(
          (entry) => (entry as { kind: string }).kind === 'endpoint-watch'
        ) as { found: boolean; waitedMs: number }
        expect(watch.found).toBe(true)
        expect(watch.waitedMs).toBeGreaterThanOrEqual(0)
        const outcome = journalEntries(dataDir).find(
          (entry) => (entry as { kind: string }).kind === 'adoption-outcome'
        ) as { ok: boolean }
        expect(outcome.ok).toBe(true)
        adoption.client.close()
        try {
          process.kill(adoption.client.welcome.pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
      } finally {
        rmSync(dataDir, { recursive: true, force: true })
      }
    }
  )

  test('the production readiness window is the measured 20s bound, and the seam honors an injected one', () => {
    // The 20s window carries ~three orders of magnitude of headroom over the
    // measured cold bundled-entry publish (~23ms median,
    // apps/desktop/scripts/measure-sidecar-startup.mjs) while keeping an
    // unadoptable boot's unavailability verdict bounded. Changing the value
    // is a reviewed sizing decision, not a tweak.
    expect(SIDECAR_READY_TIMEOUT_MS).toBe(20_000)
    // The injected window is honored end to end: the "dies before publishing"
    // test above resolves on a 600ms window, far under the production bound.
    expect(600).toBeLessThan(SIDECAR_READY_TIMEOUT_MS)
  })
})

describe('process adapter spawn journaling', () => {
  const realSpawn = Bun.spawn
  const captured: { argv: string[] }[] = []

  beforeAll(() => {
    ;(Bun as { spawn: typeof Bun.spawn }).spawn = ((argv: string[], _options?: unknown) => {
      captured.push({ argv: [...argv] })
      // An instantly-exited fake: the journal notes the exit; the adapter's
      // identity loop then fails and tears the spawn down, as designed.
      return {
        pid: 424242,
        kill: () => {},
        exited: Promise.resolve(0),
      } as unknown as Bun.Subprocess
    }) as typeof Bun.spawn
  })

  afterAll(() => {
    ;(Bun as { spawn: typeof Bun.spawn }).spawn = realSpawn
  })

  function specWith(id: string): ComponentSpec {
    return {
      id,
      product: `Product ${id}`,
      version: '1.0.0',
      platform: 'universal',
      arch: 'universal',
      digestSha256: 'a'.repeat(64),
      signature: 'c2ln',
      compatibility: { minAppVersion: '0.1.0', maxAppVersion: '99.0.0' },
      installLocation: `components/${id}`,
      installKind: 'bundled',
      dataLocation: `components/${id}`,
      startupPhase: 0,
      dependsOn: [],
      healthProbe: { kind: 'process', intervalMs: 15_000, unhealthyAfterMs: 45_000 },
      protocol: null,
      required: true,
    }
  }

  test('journal-free construction stays the default (no data dir, no journal)', async () => {
    const dataDir = tempDataDir()
    try {
      const adapter = createProcessAdapter({
        sidecar: { argv: ['/bin/echo', 'sidecar'] },
      })
      await expect(adapter.spawn(specWith('sidecar'), 1)).rejects.toThrow('never observable')
      expect(existsSync(bootAdoptionJournalPath(dataDir))).toBe(false)
      expect(captured).toHaveLength(1)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('with a diagnostics data dir, the spawn lands in the journal with env key names only', async () => {
    const dataDir = tempDataDir()
    try {
      const adapter = createProcessAdapter(
        {
          sidecar: {
            argv: ['/bin/echo', 'sidecar'],
            env: { ADEA_SIDECAR_VERSION: 'smoke' },
          },
        },
        { dataDir }
      )
      await expect(adapter.spawn(specWith('sidecar'), 1)).rejects.toThrow('never observable')
      const entries = journalEntries(dataDir)
      const kinds = entries.map((entry) => (entry as { kind: string }).kind)
      expect(kinds).toEqual(['spawn', 'spawn-exit'])
      const spawn = entries[0] as {
        mode: string
        argv: string[]
        envKeys: string[]
        cwd: string | null
        pid: number
      }
      expect(spawn.mode).toBe('engine')
      expect(spawn.argv).toEqual(['/bin/echo', 'sidecar'])
      // The allowlist shape (plus the declared additions), never values.
      expect(spawn.envKeys).toContain('HOME')
      expect(spawn.envKeys).toContain('PATH')
      expect(spawn.envKeys).toContain('ADEA_SIDECAR_VERSION')
      expect(spawn.pid).toBe(424242)
      const exit = entries[1] as { pid: number; exitCode: number | null }
      expect(exit.pid).toBe(424242)
      expect(exit.exitCode).toBe(0)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
