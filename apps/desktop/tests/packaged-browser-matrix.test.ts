// Packaged browser/devices evidence matrix (#422) as a bun test suite: lane
// registration through the M10 gate, the SSRF regression matrix, and the
// typed capability matrix — the packaged-path proofs possible WITHOUT a real
// browser engine (the real-engine lane stays explicitly out of scope; see
// the script header). Requires the Electrobun bundle (run `bun run
// test:packaged` first). Run test files ONE AT A TIME in fresh worktrees.
import { existsSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

const bundlePath = new URL(
  '../shell/build/dev-macos-arm64/Adea-dev.app/Contents/Resources/app/dev-runtime-sidecar/entry.js',
  import.meta.url
).pathname

// Loud skip when the bundle has not been built (fresh checkouts; the
// packaged lane builds it first), matching the file's documented contract.
describe.skipIf(process.platform !== 'darwin' || !existsSync(bundlePath))(
  'packaged browser/devices matrix',
  () => {
    test('lane registration, SSRF regression matrix, typed capability matrix on the packaged path', async () => {
      expect(
        existsSync(bundlePath),
        'the packaged sidecar bundle is missing — run `bun run test:packaged` to build the .app first'
      ).toBe(true)
      const proc = Bun.spawnSync(
        [
          process.execPath,
          'run',
          new URL('../shell/scripts/packaged-browser-matrix.ts', import.meta.url).pathname,
          '--app-bundle',
          new URL('../shell/build/dev-macos-arm64/Adea-dev.app', import.meta.url).pathname,
          '--artifact',
          'artifacts/packaged/browser-matrix.json',
        ],
        { stdout: 'pipe', stderr: 'pipe', env: process.env }
      )
      const output = `${proc.stdout.toString()}${proc.stderr.toString()}`
      console.log(output)
      expect(proc.exitCode).toBe(0)
      expect(output).toContain('SSRF regression matrix')
      expect(output).toContain('typed capability matrix')
      expect(output).toContain('PACKAGED-BROWSER-MATRIX PASS')
      expect(output).not.toContain('FAIL:')
    }, 240_000)
  }
)
