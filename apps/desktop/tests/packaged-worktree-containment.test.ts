// Packaged worktree containment lane (#397) as a bun test suite: template
// materialization and digest-tamper refusal through the production registrar,
// driven by signed dev.worktree.* commands. Requires the Electrobun bundle
// (run `bun run test:packaged` first). Run test files ONE AT A TIME in fresh
// worktrees.
import { existsSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

const bundlePath = new URL(
  '../shell/build/dev-macos-arm64/Adea-dev.app/Contents/Resources/app/dev-runtime-sidecar/entry.js',
  import.meta.url
).pathname

// Loud skip when the bundle has not been built (fresh checkouts; the
// packaged lane builds it first), matching the file's documented contract.
describe.skipIf(process.platform !== 'darwin' || !existsSync(bundlePath))(
  'packaged worktree containment',
  () => {
    test('registrar create, template materialization, digest-tamper refusal, generation fencing', async () => {
      expect(
        existsSync(bundlePath),
        'the packaged sidecar bundle is missing — run `bun run test:packaged` to build the .app first'
      ).toBe(true)
      const proc = Bun.spawnSync(
        [
          process.execPath,
          'run',
          new URL('../shell/scripts/packaged-worktree-smoke.ts', import.meta.url).pathname,
          '--app-bundle',
          new URL('../shell/build/dev-macos-arm64/Adea-dev.app', import.meta.url).pathname,
          '--artifact',
          'artifacts/packaged/worktree-containment.json',
        ],
        { stdout: 'pipe', stderr: 'pipe', env: process.env }
      )
      const output = `${proc.stdout.toString()}${proc.stderr.toString()}`
      console.log(output)
      expect(proc.exitCode).toBe(0)
      expect(output).toContain('PROOF 1 dev.worktree.create')
      expect(output).toContain('PROOF 3 digest-tamper refusal')
      expect(output).toContain('identity_mismatch')
      expect(output).toContain('PACKAGED-WORKTREE-CONTAINMENT PASS')
      expect(output).not.toContain('FAIL:')
    }, 240_000)
  }
)
