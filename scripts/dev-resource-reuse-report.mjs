#!/usr/bin/env bun
// The dry-run eligibility report for safe development-resource reuse and cleanup
// (adea-ai/adea#1567).
//
// It reads what is there and writes what may be done. It removes nothing.
//
//   bun scripts/dev-resource-reuse-report.mjs --report /tmp/eligibility.json
//   bun scripts/dev-resource-reuse-report.mjs --repo /path/to/repo
//
// Every read is bounded and every read that fails yields a protected item with
// the failure as its reason: a report that cannot see something must never
// claim that something may be removed.

import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

import {
  diskTelemetry,
  eligibilityReport,
  inventoryOwnedResources,
  planWorktreeReuse,
  preservationProof,
} from './dev-resource-reuse.mjs'
import { RESOURCE_KIND, leaseDirectory, scanLeases } from './integration-resource-lease.mjs'

/** Reads one Docker listing. A failed read is an empty listing, never a guess. */
function dockerLines(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000 })
  if (result.error || result.status !== 0) return []
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/**
 * The Docker resources the host can see, with the project label that is the
 * ownership proof. A resource whose label cannot be read is reported without a
 * label, which protects it.
 */
function dockerResources() {
  const resources = []
  for (const line of dockerLines([
    'ps',
    '-a',
    '--format',
    '{{.Names}}\t{{.Label "com.docker.compose.project"}}',
  ])) {
    const [name, label] = line.split('\t')
    resources.push({ kind: RESOURCE_KIND.container, name: name ?? null, label: label || null })
  }
  for (const line of dockerLines([
    'volume',
    'ls',
    '--format',
    '{{.Name}}\t{{.Label "com.docker.compose.project"}}',
  ])) {
    const [name, label] = line.split('\t')
    resources.push({ kind: RESOURCE_KIND.volume, name: name ?? null, label: label || null })
  }
  return resources
}

/** Reads one Git fact. A failed read is `ok: false`, never a guess. */
function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000 })
  if (result.error || result.status !== 0) return { ok: false, stdout: '' }
  return { ok: true, stdout: result.stdout.trim() }
}

/** The size of a directory in bytes, or null when it cannot be read. */
function directoryBytes(path) {
  const result = spawnSync('du', ['-sk', path], { encoding: 'utf8', timeout: 60_000 })
  if (result.error || result.status !== 0) return null
  const kilobytes = Number.parseInt(result.stdout.trim(), 10)
  return Number.isFinite(kilobytes) ? kilobytes * 1024 : null
}

/**
 * The registered worktrees of one repository, with the facts a reuse decision
 * needs: the head, whether the checkout carries local work, whether the
 * fetched origin ref contains the head, and whether the commits are published.
 *
 * A fact that cannot be read is reported as the pessimistic answer, so an
 * unreadable checkout is refused rather than reused.
 */
function worktreesOf(repo, { refresh = false } = {}) {
  // The origin freshness check is only as fresh as the last fetch. Refreshing
  // is opt-in, because it writes remote-tracking refs; without it the report
  // uses the last fetched state and refuses anything it cannot prove.
  if (refresh) {
    spawnSync('git', ['fetch', '--quiet', 'origin'], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 120_000,
    })
  }
  const listed = git(['worktree', 'list', '--porcelain'], repo)
  if (!listed.ok) return []
  const entries = []
  let current = null
  for (const line of listed.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length) }
      entries.push(current)
    } else if (line.startsWith('HEAD ') && current) {
      current.head = line.slice('HEAD '.length)
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).replace('refs/heads/', '')
    } else if (line.startsWith('detached') && current) {
      current.detached = true
    }
  }
  return entries
    .filter((entry) => entry.path && entry.path !== repo)
    .map((entry) => {
      const status = git(['status', '--porcelain'], entry.path)
      const localChanges = status.ok ? status.stdout !== '' : true
      const branch = entry.branch ?? null
      const origin = branch
        ? git(['rev-parse', '--verify', `refs/remotes/origin/${branch}`], repo)
        : { ok: false, stdout: '' }
      const containsHead =
        origin.ok && entry.head
          ? git(['merge-base', '--is-ancestor', entry.head, `refs/remotes/origin/${branch}`], repo)
              .ok
          : false
      const published = entry.head
        ? git(
            [
              'for-each-ref',
              '--contains',
              entry.head,
              '--format=%(refname:short)',
              'refs/remotes/',
            ],
            repo
          ).stdout !== ''
        : false
      return {
        path: entry.path,
        head: entry.head ?? null,
        branch,
        localChanges,
        published,
        origin: { fresh: origin.ok, containsHead },
        sizeBytes: directoryBytes(entry.path),
      }
    })
}

function parseArgs(argv) {
  const args = { report: null, repo: null, leaseDir: null, fetch: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--report') args.report = argv[++index]
    else if (flag === '--repo') args.repo = argv[++index]
    else if (flag === '--lease-dir') args.leaseDir = argv[++index]
    else if (flag === '--fetch') args.fetch = true
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const directory = args.leaseDir ?? leaseDirectory(process.env)
  let leases = []
  let unreadableLeases = []
  try {
    const scanned = scanLeases(directory)
    leases = scanned.leases
    // A record that does not parse into a lease is not an absence: it is
    // evidence whose ownership is unknown, and it is reported as such.
    unreadableLeases = scanned.unreadable
  } catch {
    leases = []
  }
  const resources = inventoryOwnedResources({
    runId: process.env.ADEA_INTEGRATION_RUN_ID ?? null,
    leases,
    dockerResources: dockerResources(),
    identity: null,
  })
  const worktrees = args.repo ? worktreesOf(args.repo, { refresh: args.fetch }) : []
  const plans = worktrees.map((worktree) => ({
    ...worktree,
    plan: planWorktreeReuse({ worktree, leases }),
  }))
  const report = eligibilityReport({
    resources: resources.resources,
    worktrees: plans,
    disk: diskTelemetry({ worktrees }),
    now: new Date().toISOString(),
  })
  report.leaseDirectory = directory
  report.leases = leases.length
  // The unreadable records are preserved and named: their ownership is unknown,
  // so nothing may be reclaimed on their account.
  report.unreadableLeaseRecords = unreadableLeases
  report.repository = args.repo
  report.originRefreshed = args.fetch
  report.preservation = preservationProof({
    resources: report.resources,
    worktrees: report.worktrees,
  })
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  if (args.report) {
    writeFileSync(args.report, serialized)
    process.stdout.write(
      `wrote ${args.report}: ${report.summary.eligibleResources} eligible resource(s), ` +
        `${report.summary.eligibleWorktrees} reusable checkout(s), ` +
        `${report.summary.preserved} preserved\n`
    )
  } else {
    process.stdout.write(serialized)
  }
  // The report is the output. Nothing is removed here, and nothing may be.
  if (!report.preservation.ok) process.exitCode = 1
}

main()
