// Packaged terminal replay lane (#396) as a bun test suite: shells out to the
// standalone script so the evidence lane stays runnable by hand and in CI
// with one command. Requires the Electrobun bundle (run `bun run
// test:packaged` first): the supervised sidecar is the packaged entry inside
// Adea-dev.app on the bundled Bun runtime — the suite skips loudly when the
// bundle has not been built. Run test files ONE AT A TIME in fresh worktrees
// (the PTY smoke deadlocks in full-suite parallel runs).
import { existsSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

const bundlePath = new URL(
  '../shell/build/dev-macos-arm64/Adea-dev.app/Contents/Resources/app/dev-runtime-sidecar/entry.js',
  import.meta.url
).pathname

// Loud skip when the bundle has not been built, as this file's header
// documents (fresh checkouts; the packaged lane builds it first).
describe.skipIf(process.platform !== 'darwin' || !existsSync(bundlePath))(
  'packaged terminal replay',
  () => {
    test('packaged sidecar boot, PTY session, durable checkpoint history across a host restart', async () => {
      expect(
        existsSync(bundlePath),
        'the packaged sidecar bundle is missing — run `bun run test:packaged` to build the .app first'
      ).toBe(true)
      const proc = Bun.spawnSync(
        [
          process.execPath,
          'run',
          new URL('../shell/scripts/packaged-terminal-smoke.ts', import.meta.url).pathname,
          '--app-bundle',
          new URL('../shell/build/dev-macos-arm64/Adea-dev.app', import.meta.url).pathname,
          '--artifact',
          'artifacts/packaged/terminal-replay.json',
        ],
        { stdout: 'pipe', stderr: 'pipe', env: process.env }
      )
      const output = `${proc.stdout.toString()}${proc.stderr.toString()}`
      console.log(output)
      expect(proc.exitCode).toBe(0)
      expect(output).toContain('MODE: packaged')
      expect(output).toContain('PHASE restart')
      expect(output).toContain('PACKAGED-TERMINAL-REPLAY PASS')
      expect(output).not.toContain('FAIL:')
    }, 300_000)
  }
)
