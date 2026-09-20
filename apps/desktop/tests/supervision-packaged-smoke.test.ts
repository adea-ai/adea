// Packaged supervision smoke lane (M10 #185/#34), gated exactly like the
// terminal PTY smoke: darwin on the repository-pinned Bun line, explicit
// per-test timeout, serial body. The suite shells out to the standalone
// script so the evidence lane is runnable by hand and in CI with one command;
// every proof reads real OS state (`ps`) or the child's own signal log.
//
// The script documents its own boundary in the header: this is NOT a full
// Electrobun-bundled application run — the supervised `dev-runtime-sidecar`
// component is the real bundled sidecar entry, and the missing piece for a
// complete packaged run is the bundled app binary plus the packaging lane's
// install-location resolution. Nothing is faked to close that gap here.
import { describe, expect, test } from 'bun:test'

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
    expect(output).toContain('PROOF 1 launch-record identity')
    expect(output).toContain('PROOF 2 observed exit')
    expect(output).toContain('PROOF 3 SIGKILL escalation')
    expect(output).toContain('PROOF 4 reconcile after supervisor restart')
    expect(output).toContain('SUPERVISION-SMOKE PASS')
    expect(output).not.toContain('FAIL:')
  }, 180_000)
})
