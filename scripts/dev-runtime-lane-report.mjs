import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Retained summary for a named Dev Runtime validation lane. M12 evidence
 * requires each named command to end with a machine-readable summary under a
 * git-ignored artifacts directory; the lane prints the path on success and on
 * failure so CI and local runs leave the same breadcrumb.
 */
export async function writeLaneSummary(lane, { command, status, startedAt, details = {} }) {
  const dir = path.join(root, 'artifacts', 'dev-runtime')
  await mkdir(dir, { recursive: true })
  const summaryPath = path.join(dir, `${lane}-summary.json`)
  const summary = {
    lane,
    command,
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Math.max(0, Date.now() - startedAt.getTime()),
    details,
  }
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
  console.log(`${lane} lane ${status}; summary artifact: ${path.relative(root, summaryPath)}`)
  return summaryPath
}
