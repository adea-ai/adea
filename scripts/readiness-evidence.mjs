// M18 #1224 readiness evidence: inventory checks and reproducible measurements.
//
// The inventory (docs/plans/m18-readiness-inventory.json) names every explicit
// accessibility, performance, cost and operations criterion in the PRD, the TDD,
// ADR-0010 and issue #1224, with the method that can measure it. This module
// measures what it can and records the rest honestly:
//
//   - presence probes search the git tree at main and at exact candidate heads.
//     They count identifiers; they do not prove behavior.
//   - bundle results come from the client bundle report that
//     `bun run --cwd apps/web start:check-bundle` prints, compared with the
//     ceilings in scripts/client-bundle-budgets.mjs.
//   - axe results summarize the artifact written by
//     scripts/audit-a11y-dev-view.mjs.
//   - unit results run the named test files (only with --run-unit).
//   - recorded results come from a JSON file of runs made by hand (for example,
//     the Playwright E2E run), each with its command and exit code.
//   - unavailable, not-measured and not-claimed criteria stay that way. No
//     status is derived for them, and none is inferred from another criterion.
//
// Usage:
//   node scripts/readiness-evidence.mjs check
//   node scripts/readiness-evidence.mjs measure --main <rev> [--candidate <pr>=<rev>]...
//     [--bundle <report.json>] [--axe <artifact.json>] [--recorded <runs.json>]
//     [--run-unit] [--out <file>]

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLIENT_BUNDLE_BUDGETS } from './client-bundle-budgets.mjs'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const INVENTORY_PATH = resolve(ROOT, 'docs/plans/m18-readiness-inventory.json')
export const MEASUREMENTS_PATH = resolve(ROOT, 'docs/plans/m18-readiness-measurements.json')

export const CATEGORIES = ['accessibility', 'performance', 'cost', 'operations']
const PREFIX_CATEGORY = {
  ACC: 'accessibility',
  PERF: 'performance',
  COST: 'cost',
  OPS: 'operations',
}
const METHOD_KINDS = [
  'axe',
  'e2e',
  'bundle',
  'unit',
  'presence',
  'recorded-run',
  'not-measured',
  'unavailable',
  'not-claimed',
]
const NEEDS_REASON = ['not-measured', 'unavailable', 'not-claimed']
const TEST_FILE = /(\.test\.[cm]?[jt]sx?$)|(^|\/)(tests?|e2e)\//

/** Structural checks on the inventory. Returns an array of error strings. */
export function inventoryErrors(
  inventory,
  { fileExists = (path) => existsSync(resolve(ROOT, path)) } = {}
) {
  const errors = []
  if (inventory?.schemaVersion !== 1) errors.push('schemaVersion must be 1')
  const probes = inventory?.probes ?? {}
  for (const [name, probe] of Object.entries(probes)) {
    const hasPaths = Array.isArray(probe.paths) && probe.paths.length > 0
    if (probe.pathPattern !== undefined) {
      if (typeof probe.pathPattern !== 'string' || probe.pathPattern === '')
        errors.push(`probe ${name} needs a pathPattern`)
      if (!hasPaths) errors.push(`probe ${name} needs paths for pathPattern`)
    } else {
      if (typeof probe.pattern !== 'string' || probe.pattern === '')
        errors.push(`probe ${name} needs a pattern`)
      if (!hasPaths) errors.push(`probe ${name} needs paths`)
    }
  }
  const ids = new Set()
  for (const criterion of inventory?.criteria ?? []) {
    const id = criterion.id
    const where = typeof id === 'string' ? id : '(no id)'
    if (typeof id !== 'string' || !/^(ACC|PERF|COST|OPS)-\d{2}$/.test(id))
      errors.push(`${where}: invalid id`)
    if (ids.has(id)) errors.push(`${where}: duplicate id`)
    ids.add(id)
    const prefix = typeof id === 'string' ? id.split('-')[0] : ''
    if (criterion.category !== PREFIX_CATEGORY[prefix])
      errors.push(`${where}: category must match its id prefix`)
    if (!CATEGORIES.includes(criterion.category)) errors.push(`${where}: unknown category`)
    if (typeof criterion.source !== 'string' || criterion.source === '')
      errors.push(`${where}: source is required`)
    if (typeof criterion.criterion !== 'string' || criterion.criterion === '')
      errors.push(`${where}: criterion text is required`)
    const method = criterion.method ?? {}
    if (!METHOD_KINDS.includes(method.kind)) {
      errors.push(`${where}: unknown method kind ${method.kind}`)
      continue
    }
    if (
      NEEDS_REASON.includes(method.kind) &&
      !(typeof method.reason === 'string' && method.reason.trim())
    )
      errors.push(`${where}: ${method.kind} needs a reason`)
    if (method.kind === 'presence') {
      if (!Array.isArray(method.probes) || method.probes.length === 0)
        errors.push(`${where}: presence needs probes`)
      for (const name of method.probes ?? [])
        if (!probes[name]) errors.push(`${where}: unknown probe ${name}`)
    }
    if (method.kind === 'bundle') {
      if (!Array.isArray(method.keys) || method.keys.length === 0)
        errors.push(`${where}: bundle needs keys`)
      for (const key of method.keys ?? [])
        if (!bundleBudget(key)) errors.push(`${where}: unknown bundle key ${key}`)
    }
    if (method.kind === 'unit') {
      if (!Array.isArray(method.files) || method.files.length === 0)
        errors.push(`${where}: unit needs files`)
      for (const file of method.files ?? [])
        if (!fileExists(file)) errors.push(`${where}: unit file ${file} does not exist`)
    }
  }
  return errors
}

/** The ceiling for a bundle key such as `total`, `startup` or `views.chat`. */
export function bundleBudget(key) {
  if (key === 'total') return CLIENT_BUNDLE_BUDGETS.total
  if (key === 'startup') return CLIENT_BUNDLE_BUDGETS.startup
  if (key.startsWith('views.')) return CLIENT_BUNDLE_BUDGETS.views?.[key.slice('views.'.length)]
  return undefined
}

/** Compare a client bundle report with the ceilings. `report` is check-client's JSON output. */
export function evaluateBundle(report, keys) {
  return keys.map((key) => {
    const budget = bundleBudget(key)
    const measured =
      key === 'total'
        ? {
            rawBytes: report.clientJavaScriptBytes,
            gzipBytes: report.clientJavaScriptGzipBytes,
            fileCount: report.clientJavaScriptFiles,
          }
        : key === 'startup'
          ? report.startup
          : report.views?.[key.slice('views.'.length)]
    if (!measured || !budget)
      return { key, status: 'not-run', reason: 'key missing from the bundle report' }
    const checks = {
      rawBytes: { measured: measured.rawBytes, limit: budget.rawBytes },
      gzipBytes: { measured: measured.gzipBytes, limit: budget.gzipBytes },
    }
    if (budget.fileCount !== undefined)
      checks.fileCount = { measured: measured.fileCount, limit: budget.fileCount }
    const failing = Object.entries(checks)
      .filter(([, { measured: value, limit }]) => value > limit)
      .map(([name]) => name)
    const headroom = Object.fromEntries(
      Object.entries(checks).map(([name, { measured: value, limit }]) => [name, limit - value])
    )
    return { key, status: failing.length ? 'fail' : 'pass', checks, headroom, failing }
  })
}

/** Summarize the axe artifact written by scripts/audit-a11y-dev-view.mjs. */
export function summarizeAxe(artifact) {
  const surfaces = Array.isArray(artifact?.surfaces) ? artifact.surfaces : []
  const totals = { critical: 0, serious: 0, moderate: 0, minor: 0 }
  for (const surface of surfaces)
    for (const impact of Object.keys(totals)) totals[impact] += surface.counts?.[impact] ?? 0
  const status =
    surfaces.length === 0 ? 'not-run' : totals.critical + totals.serious === 0 ? 'pass' : 'fail'
  return {
    status,
    surfaces: surfaces.map((surface) => ({
      surface: surface.surface,
      violationRules: surface.violationCount ?? surface.violations?.length ?? 0,
      counts: surface.counts ?? {},
    })),
    totals,
  }
}

export function resolveRevision(revision, cwd = ROOT) {
  const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], {
    cwd,
    encoding: 'utf8',
  })
  if (result.status !== 0)
    throw new Error(`revision ${revision} is not in the local object store; fetch it first`)
  return result.stdout.trim()
}

/** Files at a revision matching a probe. Returns repo paths, sorted. */
export function probeFiles(revision, probe, cwd = ROOT) {
  const sha = resolveRevision(revision, cwd)
  let files
  if (probe.pathPattern) {
    const listed = spawnSync('git', ['ls-tree', '-r', '--name-only', sha, '--', ...probe.paths], {
      cwd,
      encoding: 'utf8',
    })
    if (listed.status !== 0) throw new Error(`git ls-tree failed at ${sha}`)
    files = listed.stdout
      .split('\n')
      .filter(Boolean)
      .filter((path) => new RegExp(probe.pathPattern, 'i').test(path))
  } else {
    const args = ['grep', '-l', '-I', '-E', '-e', probe.pattern]
    if (probe.ignoreCase) args.push('-i')
    args.push(sha, '--', ...probe.paths)
    const grep = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    if (grep.status !== 0 && grep.status !== 1)
      throw new Error(`git grep failed at ${sha}: ${grep.stderr}`)
    files = grep.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(sha.length + 1))
  }
  if (probe.testFilesOnly) files = files.filter((path) => TEST_FILE.test(path))
  return [...new Set(files)].toSorted()
}

/** Run the named unit test files in the working tree. */
export function runUnit(files) {
  const started = Date.now()
  const run = spawnSync('bun', ['test', ...files], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  const count = (label) =>
    Number(output.match(new RegExp(`^\\s*(\\d+) ${label}\\b`, 'm'))?.[1] ?? 0)
  return {
    status: run.status === 0 ? 'pass' : 'fail',
    exitCode: run.status,
    pass: count('pass'),
    fail: count('fail'),
    seconds: Math.round((Date.now() - started) / 100) / 10,
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Build the measurement record. `options` carries the revisions and any
 * artifacts the caller already produced. Missing artifacts stay `not-run`.
 */
export function buildMeasurements(inventory, options) {
  const {
    mainRevision,
    candidates = {},
    bundleReport,
    axeArtifact,
    recorded = {},
    unitRuns = {},
  } = options
  const revisions = { main: resolveRevision(mainRevision) }
  for (const [pr, rev] of Object.entries(candidates)) revisions[`pr-${pr}`] = resolveRevision(rev)
  const probeCache = new Map()
  const presence = (probeName, revisionKey) => {
    const cacheKey = `${probeName}@${revisionKey}`
    if (!probeCache.has(cacheKey)) {
      const probe = inventory.probes[probeName]
      const files = probeFiles(revisions[revisionKey], probe)
      probeCache.set(cacheKey, {
        probe: probeName,
        revision: revisions[revisionKey],
        count: files.length,
        files: files.slice(0, 10),
      })
    }
    return probeCache.get(cacheKey)
  }
  const results = inventory.criteria.map((criterion) => {
    const method = criterion.method
    const base = { id: criterion.id, category: criterion.category, kind: method.kind }
    switch (method.kind) {
      case 'presence': {
        const onMain = method.probes.map((name) => presence(name, 'main'))
        const onCandidates = Object.keys(candidates).map((pr) => ({
          pr: Number(pr),
          probes: method.probes.map((name) => presence(name, `pr-${pr}`)),
        }))
        return {
          ...base,
          status: onMain.some((entry) => entry.count > 0) ? 'present' : 'absent',
          main: onMain,
          candidates: onCandidates,
          ...(recorded[criterion.id] ? { recorded: recorded[criterion.id] } : {}),
        }
      }
      case 'bundle': {
        if (!bundleReport)
          return { ...base, status: 'not-run', reason: 'no bundle report supplied' }
        const keys = evaluateBundle(bundleReport, method.keys)
        const status = keys.every((entry) => entry.status === 'pass') ? 'pass' : 'fail'
        return { ...base, status, keys }
      }
      case 'axe': {
        if (axeArtifact) return { ...base, ...summarizeAxe(axeArtifact) }
        if (recorded[criterion.id]) return { ...base, ...recorded[criterion.id] }
        return { ...base, status: 'not-run', reason: 'no axe artifact or recorded run supplied' }
      }
      case 'unit': {
        const run = unitRuns[criterion.id]
        if (!run) return { ...base, status: 'not-run', reason: 'run with --run-unit' }
        // A passing run that covers only part of the criterion is partial, not pass.
        if (method.limit && run.status === 'pass')
          return { ...base, ...run, status: 'partial', scopeLimit: method.limit }
        return { ...base, ...run }
      }
      case 'e2e':
      case 'recorded-run': {
        const record = recorded[criterion.id]
        if (!record) return { ...base, status: 'not-run', reason: 'no recorded run supplied' }
        return { ...base, ...record }
      }
      case 'not-measured':
      case 'unavailable':
      case 'not-claimed':
        return { ...base, status: method.kind, reason: method.reason }
      default:
        throw new Error(`unhandled method ${method.kind}`)
    }
  })
  return {
    schemaVersion: 1,
    issue: inventory.issue,
    inventorySha256: sha256(INVENTORY_PATH),
    revisions,
    probes: Object.keys(inventory.probes),
    results,
  }
}

function argValues(argv, name) {
  const values = []
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === name) values.push(argv[i + 1])
  return values
}

function argValue(argv, name) {
  return argValues(argv, name)[0]
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(ROOT, path), 'utf8'))
}

async function main(argv) {
  const [command] = argv
  const inventory = readJson(INVENTORY_PATH.slice(ROOT.length + 1))
  if (command === 'check') {
    const errors = inventoryErrors(inventory)
    if (errors.length) {
      for (const error of errors) console.error(error)
      process.exit(1)
    }
    console.log(
      `inventory ok: ${inventory.criteria.length} criteria, ${Object.keys(inventory.probes).length} probes`
    )
    return
  }
  if (command === 'measure') {
    const errors = inventoryErrors(inventory)
    if (errors.length) throw new Error(`inventory invalid: ${errors.join('; ')}`)
    const mainRevision = argValue(argv, '--main')
    if (!mainRevision) throw new Error('measure needs --main <rev>')
    const candidates = {}
    for (const pair of argValues(argv, '--candidate')) {
      const [pr, rev] = pair.split('=')
      candidates[pr] = rev
    }
    const bundlePath = argValue(argv, '--bundle')
    const axePath = argValue(argv, '--axe')
    const recordedPath = argValue(argv, '--recorded')
    const unitRuns = {}
    if (argv.includes('--run-unit')) {
      for (const criterion of inventory.criteria) {
        if (criterion.method.kind === 'unit')
          unitRuns[criterion.id] = runUnit(criterion.method.files)
      }
    }
    const measurements = buildMeasurements(inventory, {
      mainRevision,
      candidates,
      bundleReport: bundlePath ? readJson(bundlePath) : undefined,
      axeArtifact: axePath ? readJson(axePath) : undefined,
      recorded: recordedPath ? readJson(recordedPath) : {},
      unitRuns,
    })
    const out = argValue(argv, '--out') ?? MEASUREMENTS_PATH.slice(ROOT.length + 1)
    writeFileSync(resolve(ROOT, out), `${JSON.stringify(measurements, null, 2)}\n`)
    console.log(`wrote ${out}: ${measurements.results.length} criteria`)
    return
  }
  console.error('usage: readiness-evidence.mjs check | measure --main <rev> [options]')
  process.exit(2)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2))
}
