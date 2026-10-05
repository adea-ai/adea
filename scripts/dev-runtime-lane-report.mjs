import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Retained summary for a named validation lane. Evidence requirements ask each
 * named command to end with a machine-readable summary under a git-ignored
 * artifacts directory; the lane prints the path on success and on failure so CI
 * and local runs leave the same breadcrumb. `dir` defaults to the Dev Runtime
 * namespace and can be pointed at another lane family (e.g. `artifacts/perf`).
 *
 * `stamp` additionally writes `${lane}-summary-<stamp>.json`: the live path is
 * overwritten by every run of the lane, so a long acceptance run's record is
 * preserved under its own stamp instead of being clobbered by the next short
 * verification (#1037 — a 2-minute canary overwrote a finished 27-hour
 * acceptance summary before it was archived).
 */
export async function writeLaneSummary(
  lane,
  { command, status, startedAt, details = {}, dir = 'artifacts/dev-runtime', stamp }
) {
  const target = path.join(root, dir)
  await mkdir(target, { recursive: true })
  const summaryPath = path.join(target, `${lane}-summary.json`)
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
  if (stamp) {
    const stampedPath = path.join(target, `${lane}-summary-${stamp}.json`)
    await writeFile(stampedPath, `${JSON.stringify(summary, null, 2)}\n`)
    console.log(`${lane} lane stamped artifact: ${path.relative(root, stampedPath)}`)
  }
  return summaryPath
}
