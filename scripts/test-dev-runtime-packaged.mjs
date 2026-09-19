// Named M12 packaged lane (#426): builds the desktop shell through Electrobun
// — the single-UI client first, then the Bun main process with bundled CEF —
// and records a retained summary artifact. Exits nonzero when the build fails.
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { writeLaneSummary } from './dev-runtime-lane-report.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const startedAt = new Date()
const command = 'bun run test:packaged'

// Electrobun stages the .app bundle under the shell build directory.
async function findAppBundle(dir, depth = 0) {
  if (depth > 6) return null
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
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
      const found = await findAppBundle(path.join(dir, entry.name), depth + 1)
      if (found) return found
    }
  }
  return null
}

const build = spawnSync('bun', ['run', '--cwd', 'apps/desktop', 'shell:build'], {
  stdio: 'inherit',
  env: process.env,
})
const status = build.status === 0 ? 'passed' : 'failed'
const bundle =
  status === 'passed' ? await findAppBundle(path.join(root, 'apps/desktop/shell/build')) : null
await writeLaneSummary('packaged', {
  command,
  status,
  startedAt,
  details: {
    exitCode: build.status ?? 1,
    bundle: bundle ? path.relative(root, bundle) : null,
  },
})
process.exit(build.status ?? 1)
