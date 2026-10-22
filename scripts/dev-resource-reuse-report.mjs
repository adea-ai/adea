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
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  diskTelemetry,
  eligibilityReport,
  inventoryOwnedResources,
  planWorktreeReuse,
  preservationProof,
  REGENERABLE_PROOF,
  regenerableKind,
  unknownIgnoredPaths,
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

/**
 * The ignored paths of a checkout.
 *
 * `git status --porcelain` does not list them, so a checkout that holds an
 * ignored receipt is indistinguishable from one that holds nothing. They are
 * read here, and the ones that are not proven regenerable output are reported
 * as content the checkout holds.
 *
 * The untracked files are listed explicitly: a repository that sets
 * `status.showUntrackedFiles=no` would otherwise hide ordinary untracked work
 * from the local-work check, and the checkout would look clean.
 */
function ignoredPaths(path) {
  // The ignored paths are read collapsed, one entry per ignored directory or
  // file: the per-file listing of a checkout with a dependency tree is not
  // usable, and the collapsed listing still names every ignored path.
  const result = git(['status', '--porcelain', '--ignored=matching', '--untracked-files=all'], path)
  if (!result.ok) return null
  return parseIgnoredPaths(result.stdout)
}

/**
 * The ignored paths in one porcelain listing.
 *
 * Only the `!!` entries are ignored paths. The listing also carries the
 * modified and untracked entries, and those are local work, not ignored
 * content: reading one as the other would report a dirty checkout as holding
 * an unknown artifact.
 */
export function parseIgnoredPaths(stdout) {
  return String(stdout)
    .split('\n')
    .filter((line) => line.startsWith('!! '))
    .map((line) => line.slice('!! '.length).trim())
    .filter((line) => line !== '')
}

/**
 * The tracked files of a repository.
 *
 * The proof for an ignored path is about tracked tooling, so the tracked tree
 * is the evidence. A path's name is not.
 */
function trackedFiles(repo) {
  const result = git(['ls-files'], repo)
  if (!result.ok) return new Set()
  return new Set(result.stdout.split('\n').filter((line) => line !== ''))
}

/**
 * The nearest tracked package manifest above a path, and the scripts it declares.
 */
function packageProducer(worktreePath, relative, tracked) {
  const segments = relative.split('/')
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const directory = segments.slice(0, index).join('/')
    const manifest = directory === '' ? 'package.json' : `${directory}/package.json`
    if (!tracked.has(manifest)) continue
    try {
      const parsed = JSON.parse(readFileSync(join(worktreePath, manifest), 'utf8'))
      return { manifest, scripts: parsed?.scripts ?? {} }
    } catch {
      return { manifest, scripts: {} }
    }
  }
  return null
}

/**
 * The proof that an ignored path is regenerable output, or null when the
 * repository does not prove it.
 *
 * The proof is the tracked tooling that produces the path. A name is not a
 * proof: `.wrangler` holds local persisted state that nothing rebuilds, and a
 * build output may hold an overlay that no rebuild reproduces, so the producer
 * has to be there and the tracked sources have to be the committed ones.
 */
export function proofForIgnoredPath(entry, { tracked, trackedClean, worktreePath }) {
  const kind = regenerableKind(entry)
  if (kind === null) return null
  if (!trackedClean) return null
  if (kind === REGENERABLE_PROOF.dependencyTree) {
    return tracked.has('bun.lock') ? kind : null
  }
  if (kind === REGENERABLE_PROOF.generatedFile) {
    return tracked.has('apps/web/wrangler.jsonc') ? kind : null
  }
  if (kind === REGENERABLE_PROOF.syncedAssets) {
    return tracked.has('scripts/sync-assets.mjs') ? kind : null
  }
  if (kind === REGENERABLE_PROOF.pinnedRuntime) {
    return tracked.has('scripts/setup-source-contract-tests.mjs') ? kind : null
  }
  const relative = String(entry).replace(/\/+$/u, '')
  const producer = packageProducer(worktreePath, relative, tracked)
  if (!producer) return null
  const scripts = producer.scripts ?? {}
  if (scripts.build || scripts.typecheck) return kind
  return null
}

/**
 * The lease records of a directory, with the evidence that could not be read.
 *
 * A record that does not parse, or that is not yet valid, is not an absence: it
 * is evidence whose owner is unknown. A scan that fails is the same: nothing is
 * known, so everything is protected. None of it is discarded before the
 * decision.
 */
export function readLeaseEvidence(directory, { now = Date.now() } = {}) {
  let leases = []
  let unreadable = []
  let scanError = null
  try {
    const scanned = scanLeases(directory)
    leases = scanned.leases
    unreadable = scanned.unreadable
  } catch (error) {
    scanError = (error?.message ?? String(error)).trim()
    leases = []
    unreadable = []
  }
  // A record whose own timestamps are in the future is not yet a claim about
  // this world: it is evidence whose owner is unknown, and it protects what it
  // may name.
  const future = leases
    .filter((lease) => isFutureLease(lease, now))
    .map((lease) => lease.runId ?? 'unknown')
  return { leases, unreadable, future, scanError }
}

/** Whether a lease record claims a time this host has not reached yet. */
export function isFutureLease(lease, now = Date.now()) {
  const skew = 60_000
  for (const field of ['createdAt', 'updatedAt']) {
    const value = lease?.[field]
    if (typeof value === 'number' && Number.isFinite(value) && value > now + skew) return true
  }
  return false
}

/** The size of a directory in bytes, or null when it cannot be read. */
function directoryBytes(path) {
  const result = spawnSync('du', ['-sk', path], { encoding: 'utf8', timeout: 60_000 })
  if (result.error || result.status !== 0) return null
  const kilobytes = Number.parseInt(result.stdout.trim(), 10)
  return Number.isFinite(kilobytes) ? kilobytes * 1024 : null
}

/**
 * Refreshes the remote-tracking refs and reports what actually happened.
 *
 * A fetch that fails is not a fetch that succeeded quietly: the report says
 * so, and the origin stays unverified so that nothing is judged fresh.
 */
function fetchOrigin(repo) {
  const result = spawnSync('git', ['fetch', '--quiet', 'origin'], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 120_000,
  })
  if (result.error) {
    return { requested: true, ok: false, error: result.error.message }
  }
  if (result.status !== 0) {
    return {
      requested: true,
      ok: false,
      error: (result.stderr || result.stdout || 'the fetch failed').trim(),
    }
  }
  return { requested: true, ok: true, error: null }
}

/**
 * The registered worktrees of one repository, with the facts a reuse decision
 * needs: the head, whether the checkout carries local work, whether it
 * carries ignored artifacts that are not known build output, whether the
 * fetched origin ref contains the head, and whether the commits are published.
 *
 * A fact that cannot be read is reported as the pessimistic answer, so an
 * unreadable checkout is refused rather than reused.
 */
export function worktreesOf(repo, { refresh = false } = {}) {
  // The origin freshness check is only as fresh as the last fetch. Refreshing
  // is opt-in, because it writes remote-tracking refs; without it the report
  // uses the last fetched state and refuses anything it cannot prove.
  const fetch = refresh ? fetchOrigin(repo) : { requested: false, ok: false, error: null }
  const listed = git(['worktree', 'list', '--porcelain'], repo)
  if (!listed.ok) return { worktrees: [], fetch }
  const tracked = trackedFiles(repo)
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
  const worktrees = entries
    .filter((entry) => entry.path && entry.path !== repo)
    .map((entry) => {
      // The untracked files are listed explicitly: a repository that turns
      // `status.showUntrackedFiles` off would otherwise hide ordinary untracked
      // work, and the checkout would look clean when it is not.
      const status = git(['status', '--porcelain', '--untracked-files=all'], entry.path)
      const localChanges = status.ok ? status.stdout !== '' : true
      const ignored = ignoredPaths(entry.path)
      const branch = entry.branch ?? null
      const origin = branch
        ? git(['rev-parse', '--verify', `refs/remotes/origin/${branch}`], repo)
        : { ok: false, stdout: '' }
      const containsHead =
        origin.ok && entry.head
          ? git(['merge-base', '--is-ancestor', entry.head, `refs/remotes/origin/${branch}`], repo)
              .ok
          : false
      // A remote-tracking ref can outlive the branch it points at: the branch
      // may have been deleted, or the fetch may not carry it. The remote is
      // asked what it holds now, and a branch the remote does not have is not
      // current authority for anything.
      const remoteBranch =
        branch && fetch.ok
          ? git(['ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`], repo)
          : { ok: false, stdout: '' }
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
      // The proof for each ignored path: the tracked tooling that produces it,
      // and the committed sources it would be produced from.
      const proofs = {}
      for (const entryPath of ignored ?? []) {
        const proof = proofForIgnoredPath(entryPath, {
          tracked,
          trackedClean: !localChanges,
          worktreePath: entry.path,
        })
        if (proof) proofs[entryPath] = proof
      }
      return {
        path: entry.path,
        head: entry.head ?? null,
        branch,
        localChanges,
        // An unreadable ignored list is not an empty one: it is content this
        // report cannot account for, so the checkout is not free.
        ignoredUnknown: ignored === null ? [] : unknownIgnoredPaths(ignored, proofs),
        ignoredUnreadable: ignored === null,
        ignoredProofs: proofs,
        published,
        // A failed fetch leaves the local refs stale, so the origin is not
        // verified and nothing may be judged fresh. A branch the remote does
        // not hold is the same: the local ref is stale, not authority.
        origin: {
          fresh: fetch.ok && origin.ok && remoteBranch.ok,
          containsHead: fetch.ok && remoteBranch.ok && containsHead,
          remoteBranchPresent: remoteBranch.ok,
        },
        sizeBytes: directoryBytes(entry.path),
      }
    })
  return { worktrees, fetch }
}

/**
 * The plan for every checkout, with the verified origin facts carried into it.
 *
 * The origin travels with the checkout, so the planner sees what the runner
 * actually observed instead of assuming it.
 */
export function planWorktrees(worktrees = [], leases = [], options = {}) {
  const unreadableLeases = Array.isArray(options.unreadableLeases) ? options.unreadableLeases : []
  const leaseScanFailed = options.leaseScanFailed === true
  return worktrees.map((worktree) => ({
    ...worktree,
    plan: planWorktreeReuse({
      worktree,
      origin: worktree.origin,
      leases,
      unreadableLeases,
      leaseScanFailed,
    }),
  }))
}

/**
 * The report, from what the runner observed.
 *
 * Every read that failed is carried into the decision: a lease record that
 * could not be read, a lease scan that failed, an ignored list that could not
 * be read, and a remote branch the remote does not hold. Each of them protects
 * what it may name, and the report says which.
 */
export function collectReport({
  repo = null,
  leaseDir = null,
  refresh = false,
  now = null,
  dockerResources: resources = [],
  runId = null,
} = {}) {
  const directory = leaseDir ?? leaseDirectory(process.env)
  const evidence = readLeaseEvidence(directory)
  // The records that could not be read, and the records that are not yet valid,
  // are evidence of an unknown owner. They protect everything they may name.
  const unreadableLeases = [...evidence.unreadable, ...evidence.future]
  const inventory = inventoryOwnedResources({
    runId,
    leases: evidence.leases,
    unreadableLeases,
    dockerResources: resources,
    identity: null,
  })
  const { worktrees, fetch } = repo
    ? worktreesOf(repo, { refresh })
    : { worktrees: [], fetch: { requested: false, ok: false, error: null } }
  const plans = planWorktrees(worktrees, evidence.leases, {
    unreadableLeases,
    leaseScanFailed: evidence.scanError !== null,
  })
  const report = eligibilityReport({
    resources: inventory.resources,
    worktrees: plans,
    disk: diskTelemetry({ worktrees }),
    now: now ?? new Date().toISOString(),
  })
  report.leaseDirectory = directory
  report.leases = evidence.leases.length
  // The unreadable records are preserved and named: their ownership is unknown,
  // so nothing may be reclaimed on their account.
  report.unreadableLeaseRecords = evidence.unreadable
  report.futureLeaseRecords = evidence.future
  report.leaseScanError = evidence.scanError
  report.repository = repo
  // What the reuse decision was made from, and what it could not see. The
  // lease records are the only ownership this report knows; a checkout held by
  // a session or a task outside the lease model is invisible here, so an
  // eligible checkout is not a clearance to remove it.
  report.ownershipSources = ['lease']
  report.ownershipBoundary =
    'the reuse decision is made from the lease records alone; a checkout held by an owner outside the lease model is not visible here, so an eligible checkout is not a clearance to remove it'
  // What the fetch actually did, not what was asked of it. A fetch that was
  // not requested refreshed nothing, and a fetch that failed left the local
  // refs stale, so neither is reported as a refresh.
  report.originRefreshed = fetch.requested && fetch.ok
  report.fetchRequested = fetch.requested
  report.fetchError = fetch.error
  report.preservation = preservationProof({
    resources: report.resources,
    worktrees: report.worktrees,
  })
  return { report, fetch }
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
  const { report, fetch } = collectReport({
    repo: args.repo,
    leaseDir: args.leaseDir,
    refresh: args.fetch,
    dockerResources: dockerResources(),
    runId: process.env.ADEA_INTEGRATION_RUN_ID ?? null,
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
  // A refresh that was asked for and did not happen leaves the origin
  // unverified, so the report says nothing is fresh. It fails closed, and it
  // says so in its exit status.
  if (fetch.requested && !fetch.ok) process.exitCode = 1
  // A lease directory that could not be read leaves the ownership unknown, so
  // nothing may be reclaimed on its account. It fails closed, and it says so.
  if (report.leaseScanError) process.exitCode = 1
}

if (import.meta.main) main()
