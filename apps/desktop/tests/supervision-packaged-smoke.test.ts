// Packaged supervision smoke lane (M10 #185/#34), gated exactly like the
// terminal PTY smoke: darwin on the repository-pinned Bun line, explicit
// per-test timeout, serial body. The suite shells out to the standalone
// script so the evidence lane is runnable by hand and in CI with one command;
// every proof reads real OS state (`ps`) or the child's own signal log.
//
// The script auto-detects the Electrobun bundle: with one present it runs in
// packaged mode — install-location resolution (PROOF 0) plus the sidecar
// started from the bundled layout on the bundled Bun runtime — and labels a
// missing bundle as an explicit dev fallback that is not packaged evidence.
import { existsSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

const bundleEntry = new URL(
  '../shell/build/dev-macos-arm64/Adea-dev.app/Contents/Resources/app/dev-runtime-sidecar/entry.js',
  import.meta.url
).pathname

describe.skipIf(process.platform !== 'darwin')('packaged supervision smoke', () => {
  test('launch-record identity, observed exit, SIGKILL escalation, and reconcile-after-restart on real processes', async () => {
    const proc = Bun.spawnSync(
      [
        process.execPath,
        'run',
        new URL('../shell/scripts/supervision-smoke.ts', import.meta.url).pathname,
      ],
      { stdout: 'pipe', stderr: 'pipe', env: process.env }
    )
    const output = `${proc.stdout.toString()}${proc.stderr.toString()}`
    // Keep the evidence visible in failure output.
    console.log(output)
    expect(proc.exitCode).toBe(0)
    if (existsSync(bundleEntry)) {
      // Packaged mode: the bundled layout must feed the component manifest.
      expect(output).toContain('MODE: packaged')
      expect(output).toContain('PROOF 0 install-location resolution')
      expect(output).not.toContain('dev stand-in sidecar entry')
    }
    expect(output).toContain('PROOF 1 launch-record identity')
    expect(output).toContain('PROOF 2 observed exit')
    expect(output).toContain('PROOF 3 SIGKILL escalation')
    expect(output).toContain('PROOF 4 reconcile after supervisor restart')
    expect(output).toContain('SUPERVISION-SMOKE PASS')
    expect(output).not.toContain('FAIL:')
  }, 240_000)
})
