// Named M12 packaged lane (#426, extended by the M12 packaged-evidence wave):
// builds the desktop shell through Electrobun — the single-UI client first,
// then the Bun main process with bundled CEF and the STAGED terminal sidecar
// component — and runs the packaged macOS evidence suite against the real
// bundled layout, recording retained artifacts under git-ignored
// artifacts/packaged/. Exits nonzero when the build or any packaged proof
// fails.
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { writeLaneSummary } from './dev-runtime-lane-report.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const startedAt = new Date()
const command = 'bun run test:packaged'
const shellScripts = path.join(root, 'apps/desktop/shell/scripts')

// Electrobun stages the .app bundle under the shell build directory.
function findAppBundle(dir, depth = 0) {
  if (depth > 6) return null
  // The packaged lane targets the DEV channel build. A stable-channel
  // Adea.app (auto-update artefact) may also live under build/ — it lacks
  // the bundled dev-runtime sidecar, so it must never be picked by accident.
  const preferred = path.join(dir, 'dev-macos-arm64', 'Adea-dev.app')
  if (require('node:fs').existsSync(preferred)) return preferred
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.endsWith('.app')) {
      return path.join(dir, entry.name)
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = findAppBundle(path.join(dir, entry.name), depth + 1)
      if (found) return found
    }
  }
  return null
}

// The single-UI client must exist before the shell bundles it; the shell
// build (apps/desktop/scripts/shell.mjs) also bundles the Dev Runtime
// terminal sidecar into Contents/Resources/app/dev-runtime-sidecar.
const build = spawnSync('bun', ['run', '--cwd', 'apps/desktop', 'shell:build'], {
  stdio: 'inherit',
  env: process.env,
})
const bundle =
  build.status === 0 ? findAppBundle(path.join(root, 'apps/desktop/shell/build')) : null
if (build.status !== 0 || !bundle) {
  await writeLaneSummary('packaged', {
    command,
    status: 'failed',
    startedAt,
    details: {
      exitCode: build.status ?? 1,
      bundle: bundle ? path.relative(root, bundle) : null,
      error: 'the Electrobun build did not produce an app bundle',
    },
  })
  process.exit(build.status ?? 1)
}

// Packaged proofs against the REAL bundled layout. `required` proofs fail
// the lane; the transport-defect probe is a finding recorder — its nonzero
// exit means "defect no longer reproduces", which downgrades to a warning
// telling the owner to extend the terminal replay lane.
const proofs = [
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

const results = []
const warnings = []
for (const proof of proofs) {
  process.stdout.write(`\n=== packaged proof: ${proof.name} ===\n`)
  const run = spawnSync('bun', [path.join(shellScripts, proof.script), ...proof.args], {
    stdio: 'inherit',
    env: process.env,
    timeout: 600_000,
  })
  const exitCode = run.status ?? (run.signal === 'SIGTERM' ? 124 : 1)
  const timedOut = run.signal === 'SIGTERM'
  const passed = exitCode === 0
  results.push({ name: proof.name, exitCode, artifact: proof.artifact, passed, timedOut })
  if (!passed && proof.required) {
    await writeLaneSummary('packaged', {
      command,
      status: 'failed',
      startedAt,
      details: {
        bundle: path.relative(root, bundle),
        proofs: results,
        warnings,
      },
    })
    process.exit(exitCode || 1)
  }
  if (!passed && !proof.required) {
    warnings.push(
      `${proof.name}: exited ${exitCode} — the transport defect no longer reproduces; ` +
        'extend packaged-terminal-smoke.ts to prove the below-ring durable bridge replay'
    )
  }
}

await writeLaneSummary('packaged', {
  command,
  status: 'passed',
  startedAt,
  details: {
    bundle: path.relative(root, bundle),
    proofs: results,
    warnings,
    artifacts: proofs.map((proof) => proof.artifact),
  },
})
process.exit(0)
