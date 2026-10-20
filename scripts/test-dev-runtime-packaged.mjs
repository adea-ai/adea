// Named M12 packaged lane (#426, extended by the M12 packaged-evidence wave):
// builds the desktop shell through Electrobun — the single-UI client first,
// then the Bun main process with bundled CEF and the STAGED terminal sidecar
// component — and runs the packaged macOS evidence suite against the real
// bundled layout, recording retained artifacts under git-ignored
// artifacts/packaged/. Exits nonzero when the build or any packaged proof
// fails.
//
// The executable body is `runPackagedLane`, and every side effect it has —
// the subprocess spawns, the filesystem the bundle selection reads, the lane
// summary it writes and its exit — is injected. The production path passes the
// real ones; a test passes fakes, so the failure and success paths can be
// exercised without a build, a bundle or an app. Nothing about the checks
// themselves is injectable: the real build command, the real fail-closed
// bundle selection and the real proof set are what run.
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { writeLaneSummary } from './dev-runtime-lane-report.mjs'
import {
  packagedLaneExitCode,
  selectDevAppBundle,
} from '../apps/desktop/shell/scripts/packaged-bundle-selection.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const startedAt = new Date()
const command = 'bun run test:packaged'
const shellScripts = path.join(root, 'apps/desktop/shell/scripts')

// The filesystem seams the bundle selection runs over: the names of the
// DIRECTORIES in a directory, and whether a path exists. An unreadable or
// absent directory simply lists as empty, which the selection treats as
// "no candidate" rather than as an error.
function listDirectories(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

// Packaged proofs against the REAL bundled layout. `required` proofs fail
// the lane; the transport-defect probe is a finding recorder — its nonzero
// exit means "defect no longer reproduces", which downgrades to a warning
// telling the owner to extend the terminal replay lane.
function packagedProofs(bundle) {
  return [
    {
      name: 'supervision-smoke',
      script: 'supervision-smoke.ts',
      artifact: 'artifacts/packaged/supervision-smoke.json',
      required: true,
      args: ['--app-bundle', bundle, '--artifact', 'artifacts/packaged/supervision-smoke.json'],
      expect: 'SUPERVISION-SMOKE PASS',
    },
    {
      name: 'terminal-replay',
      script: 'packaged-terminal-smoke.ts',
      artifact: 'artifacts/packaged/terminal-replay.json',
      required: true,
      args: ['--app-bundle', bundle, '--artifact', 'artifacts/packaged/terminal-replay.json'],
      expect: 'PACKAGED-TERMINAL-REPLAY PASS',
    },
    {
      name: 'transport-defect-probe',
      script: 'packaged-transport-defect-probe.ts',
      artifact: 'artifacts/packaged/terminal-transport-defect.json',
      required: false,
      args: [
        '--app-bundle',
        bundle,
        '--artifact',
        'artifacts/packaged/terminal-transport-defect.json',
      ],
      expect: 'TRANSPORT-DEFECT PROBE: defect reproduced',
    },
    {
      name: 'worktree-containment',
      script: 'packaged-worktree-smoke.ts',
      artifact: 'artifacts/packaged/worktree-containment.json',
      required: true,
      args: ['--app-bundle', bundle, '--artifact', 'artifacts/packaged/worktree-containment.json'],
      expect: 'PACKAGED-WORKTREE-CONTAINMENT PASS',
    },
    {
      name: 'browser-matrix',
      script: 'packaged-browser-matrix.ts',
      artifact: 'artifacts/packaged/browser-matrix.json',
      required: true,
      args: ['--app-bundle', bundle, '--artifact', 'artifacts/packaged/browser-matrix.json'],
      expect: 'PACKAGED-BROWSER-MATRIX PASS',
    },
  ]
}

/**
 * The lane's executable body.
 *
 * `deps` carries the side effects; every default is the production one, so the
 * production path is the same code with nothing injected. The build command,
 * the fail-closed bundle selection and the proof set are NOT injectable: the
 * lane always runs the real build and always proves against the real bundle.
 */
export async function runPackagedLane(deps = {}) {
  const {
    buildRoot = path.join(root, 'apps/desktop/shell/build'),
    exists = existsSync,
    exit = process.exit,
    listDirectory = listDirectories,
    spawn = spawnSync,
    startedAt: laneStartedAt = startedAt,
    writeSummary = writeLaneSummary,
  } = deps

  // The single-UI client must exist before the shell bundles it; the shell
  // build (apps/desktop/scripts/shell.mjs) also bundles the Dev Runtime
  // terminal sidecar into Contents/Resources/app/dev-runtime-sidecar.
  const build = spawn('bun', ['run', '--cwd', 'apps/desktop', 'shell:build'], {
    stdio: 'inherit',
    env: process.env,
  })
  // The lane drives the one bundle the repository pins as the development
  // target. A stable-only, wrong-architecture, wrong-layout or ambiguous build
  // root is REJECTED: the packaged proofs would then run against a bundle the
  // lane does not mean to prove.
  const selection =
    build.status === 0
      ? selectDevAppBundle({ buildRoot, exists, listDirectory })
      : { bundle: null, reason: 'build-failed' }
  const bundle = selection.bundle
  if (build.status !== 0 || !bundle) {
    // A build that SUCCEEDED but produced no usable bundle is a lane failure,
    // so the exit code is nonzero even though the build's own status was 0.
    const exitCode = packagedLaneExitCode({ buildStatus: build.status, bundle })
    await writeSummary('packaged', {
      command,
      status: 'failed',
      startedAt: laneStartedAt,
      details: {
        exitCode,
        bundle: bundle ? path.relative(root, bundle) : null,
        error:
          build.status !== 0
            ? 'the Electrobun build failed'
            : `the Electrobun build did not produce a usable dev app bundle (${selection.reason})`,
      },
    })
    // The production exit never returns; the return keeps a test's seam from
    // running the proofs after the lane has already failed.
    exit(exitCode)
    return
  }

  const results = []
  const warnings = []
  for (const proof of packagedProofs(bundle)) {
    process.stdout.write(`\n=== packaged proof: ${proof.name} ===\n`)
    const run = spawn('bun', [path.join(shellScripts, proof.script), ...proof.args], {
      stdio: 'inherit',
      env: process.env,
      timeout: 600_000,
    })
    const exitCode = run.status ?? (run.signal === 'SIGTERM' ? 124 : 1)
    const timedOut = run.signal === 'SIGTERM'
    const passed = exitCode === 0
    results.push({ name: proof.name, exitCode, artifact: proof.artifact, passed, timedOut })
    if (!passed && proof.required) {
      await writeSummary('packaged', {
        command,
        status: 'failed',
        startedAt: laneStartedAt,
        details: {
          bundle: path.relative(root, bundle),
          proofs: results,
          warnings,
        },
      })
      exit(exitCode || 1)
      return
    }
    if (!passed && !proof.required) {
      warnings.push(
        `${proof.name}: exited ${exitCode} — the transport defect no longer reproduces; ` +
          'the below-ring durable bridge replay is proven by the terminal-replay lane ' +
          '(bridge + whole-ring replay, then seeded retention-GC eviction with a ' +
          'deterministic resync anchor), so this probe stays only as a finding recorder'
      )
    }
  }

  await writeSummary('packaged', {
    command,
    status: 'passed',
    startedAt: laneStartedAt,
    details: {
      bundle: path.relative(root, bundle),
      proofs: results,
      warnings,
      artifacts: packagedProofs(bundle).map((proof) => proof.artifact),
    },
  })
  exit(0)
}

// The lane runs when this file is the program; importing it for a test must not
// start a build.
if (import.meta.main) {
  await runPackagedLane()
}
