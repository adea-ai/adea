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
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

import {
  REGENERABLE_PROOF,
  boundedLivenessProbe,
  diskTelemetry,
  eligibilityReport,
  inventoryOwnedResources,
  planWorktreeReuse,
  preservationProof,
  regenerableKind,
  unknownIgnoredPaths,
} from './dev-resource-reuse.mjs'
import {
  RESOURCE_KIND,
  leaseDirectory,
  processIsAlive,
  scanLeases,
} from './integration-resource-lease.mjs'

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
 * The content of one ignored path, with a digest over its bytes.
 *
 * The ignored listing collapses a directory to its name, so the files inside
 * it are never named by git. This walks the path itself and digests what it
 * finds: the digest is what a rebuild would have to reproduce, and the file
 * and byte counts say how much the checkout holds. A path too large to
 * inspect is reported as truncated, and a truncated path is never
 * reproducible - it is content the checkout holds.
 */
export function ignoredContent(worktreePath, entry, limits = {}) {
  const fileLimit = limits.fileLimit ?? 2000
  const byteLimit = limits.byteLimit ?? 32 * 1024 * 1024
  const root = join(worktreePath, entry)
  const files = []
  let bytes = 0
  let truncated = false
  const walk = (directory, prefix) => {
    if (truncated) return
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      truncated = true
      return
    }
    for (const item of entries) {
      if (truncated) return
      const relative = prefix === '' ? item.name : `${prefix}/${item.name}`
      const absolute = join(directory, item.name)
      let stats
      try {
        stats = lstatSync(absolute)
      } catch {
        truncated = true
        return
      }
      if (stats.isSymbolicLink()) {
        let target = ''
        try {
          target = readlinkSync(absolute)
        } catch {
          truncated = true
          return
        }
        files.push(`${relative}\0link\0${target}`)
        continue
      }
      if (stats.isDirectory()) {
        walk(absolute, relative)
        continue
      }
      if (!stats.isFile()) continue
      if (files.length >= fileLimit || bytes + stats.size > byteLimit) {
        truncated = true
        return
      }
      let content
      try {
        content = readFileSync(absolute)
      } catch {
        truncated = true
        return
      }
      bytes += content.length
      files.push(
        `${relative}\0file\0${stats.size}\0${createHash('sha256').update(content).digest('hex')}`
      )
    }
  }
  try {
    const stats = lstatSync(root)
    if (stats.isDirectory()) {
      walk(root, '')
    } else if (stats.isFile()) {
      const content = readFileSync(root)
      bytes = content.length
      files.push(`\0file\0${stats.size}\0${createHash('sha256').update(content).digest('hex')}`)
    } else {
      truncated = true
    }
  } catch {
    truncated = true
  }
  const digest = createHash('sha256').update(files.toSorted().join('\n')).digest('hex')
  return { digest, files: files.length, bytes, truncated }
}

/**
 * The proof that an ignored path's content may be reproduced.
 *
 * The proof is about the bytes. A path that holds nothing has nothing to
 * reproduce. A path whose digest equals the digest a rebuild in an isolated
 * copy produced is reproducible, byte for byte. Everything else - including
 * every path that merely looks like a build output, and every path whose
 * content could not be read in full - is content the checkout holds, and it
 * is preserved.
 */
export function proofForIgnoredPath(
  entry,
  { content = null, rebuildDigests = {}, trackedClean = true } = {}
) {
  if (!content || content.truncated) return null
  if (content.files === 0) return { kind: REGENERABLE_PROOF.empty, digest: content.digest }
  if (!trackedClean) return null
  const rebuilt = rebuildDigests?.[entry]
  if (typeof rebuilt === 'string' && rebuilt === content.digest) {
    return { kind: REGENERABLE_PROOF.contentMatch, digest: content.digest }
  }
  return null
}

/**
 * Whether the fetched ref is the remote's current commit.
 *
 * This is the binding the decision rests on. The fetched ref speaks for the
 * remote only while it is the commit the remote holds now: a ref that is
 * behind a branch that has since moved, and a branch the remote no longer
 * holds, are both a stale local fact rather than the remote's state.
 */
export function originIsBound(remoteSha, fetchedSha) {
  if (typeof remoteSha !== 'string' || remoteSha === '') return false
  if (typeof fetchedSha !== 'string' || fetchedSha === '') return false
  return remoteSha === fetchedSha
}

/**
 * The branch heads the remote holds now.
 *
 * This is the remote's own answer, taken from the remote rather than from the
 * local refs, and it is what the fetched ref is compared with. A branch the
 * remote does not hold is not there, and a branch it holds at another commit
 * is there at that commit.
 */
export function remoteBranchHeads(repo) {
  const result = git(['ls-remote', '--heads', 'origin'], repo)
  if (!result.ok) return null
  const heads = new Map()
  for (const line of result.stdout.split('\n')) {
    const [sha, ref] = line.split('\t')
    if (!sha || !ref) continue
    if (!ref.startsWith('refs/heads/')) continue
    heads.set(ref.slice('refs/heads/'.length), sha)
  }
  return heads
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
export function worktreesOf(repo, { refresh = false, rebuildDigests = {} } = {}) {
  // The origin freshness check is only as fresh as the last fetch. Refreshing
  // is opt-in, because it writes remote-tracking refs; without it the report
  // uses the last fetched state and refuses anything it cannot prove.
  const fetch = refresh ? fetchOrigin(repo) : { requested: false, ok: false, error: null }
  const listed = git(['worktree', 'list', '--porcelain'], repo)
  if (!listed.ok) return { worktrees: [], fetch }
  // The remote's current branch heads, asked once. This is the remote's own
  // state; the local refs are compared with it below, so a ref that is behind
  // the remote cannot stand in for it.
  const remoteHeads = fetch.ok ? remoteBranchHeads(repo) : null
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
      // The remote is asked what it holds, once, and the answer is the commit
      // the decision is made against. A remote-tracking ref can outlive the
      // branch it points at, and it can also be behind a branch that has since
      // moved, so the fetched ref is compared with what the remote says now:
      // only a ref that *is* the remote's current commit speaks for the remote.
      const remoteSha = branch && remoteHeads ? (remoteHeads.get(branch) ?? null) : null
      const fetched = branch
        ? git(['rev-parse', '--verify', `refs/remotes/origin/${branch}`], repo)
        : { ok: false, stdout: '' }
      const fetchedSha = fetched.ok ? fetched.stdout : null
      const bound = originIsBound(remoteSha, fetchedSha)
      const containsHead =
        bound && entry.head
          ? git(['merge-base', '--is-ancestor', entry.head, fetchedSha], repo).ok
          : false
      // The head is published when the remote's current commit contains it.
      // A head that only a stale local ref contains is not published by the
      // remote, and a head the remote's branch no longer contains was
      // rewritten away.
      const published = containsHead
      // The proof for each ignored path: its own bytes, and a rebuild that
      // reproduces them. The name and the presence of a build script are not
      // a proof, so they no longer grant one.
      const proofs = {}
      const contents = {}
      for (const entryPath of ignored ?? []) {
        const content = ignoredContent(entry.path, entryPath)
        contents[entryPath] = { ...content, looks: regenerableKind(entryPath) }
        const proof = proofForIgnoredPath(entryPath, {
          content,
          trackedClean: !localChanges,
          rebuildDigests,
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
        // What each ignored path holds, with the digest a rebuild would have to
        // reproduce. The content is named and measured, not assumed.
        ignoredContent: contents,
        published,
        // A failed fetch leaves the local refs stale, so the origin is not
        // verified and nothing may be judged fresh. A branch the remote does
        // not hold is the same: the local ref is stale, not authority. And a
        // ref that is not the remote's current commit is stale in the other
        // direction: the remote has moved since the fetch.
        origin: {
          fresh: fetch.ok && bound,
          containsHead,
          remoteBranchPresent: Boolean(remoteSha),
          remoteSha,
          fetchedSha,
          bound,
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
      isProcessAlive: options.isProcessAlive,
      host: options.host,
      probe: options.probe,
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
  host = hostname(),
  probe = processIsAlive,
  rebuildDigests = {},
} = {}) {
  const directory = leaseDir ?? leaseDirectory(process.env)
  const evidence = readLeaseEvidence(directory)
  // The records that could not be read, and the records that are not yet valid,
  // are evidence of an unknown owner. They protect everything they may name.
  const unreadableLeases = [...evidence.unreadable, ...evidence.future]
  // The liveness probe the model is given is bounded: it answers "the owner is
  // absent" only when the owner names this host, the probe ran, and no process
  // holds the recorded pid. Every other answer is "alive", because an owner
  // that cannot be shown to be absent protects what it may name.
  const isProcessAlive = boundedLivenessProbe({ host, probe })
  const inventory = inventoryOwnedResources({
    runId,
    leases: evidence.leases,
    unreadableLeases,
    dockerResources: resources,
    identity: null,
    isProcessAlive,
    host,
    probe,
  })
  const { worktrees, fetch } = repo
    ? worktreesOf(repo, { refresh, rebuildDigests })
    : { worktrees: [], fetch: { requested: false, ok: false, error: null } }
  const plans = planWorktrees(worktrees, evidence.leases, {
    unreadableLeases,
    leaseScanFailed: evidence.scanError !== null,
    isProcessAlive,
    host,
    probe,
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
