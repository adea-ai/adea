/*
 * The CI surface has no database-vendor dependency.
 *
 * Railway is the sole production target, so the pull-request lanes prove a
 * disposable loopback PostgreSQL and nothing else: there is no hosted branch,
 * no provider API, no vendor secret and no vendor-specific environment
 * requirement left in the CI surface.
 *
 * This is the machine-checked proof of that. It scans the workflows, the CI
 * configuration, the release configuration and the database CI scripts for a
 * vendor identifier — an environment variable name, a host, an action — and
 * fails when one appears. The scan is deliberately about identifiers, not
 * prose: a refusal may name a legacy value, and a comment may explain why.
 *
 * The proof has a lifecycle. One path in the surface belongs to another lane
 * and still carries one provider identifier; that lane's pull request removes
 * it. The proof therefore holds in BOTH states: today, where that identifier
 * is recorded and allowed in exactly that path, and after that pull request
 * merges, where the surface names no provider at all. The combined state is
 * proved here over a disposable copy of the surface, so the proof does not
 * depend on the other lane's file and does not edit it.
 *
 * The historical record of the retired provider stays in this repository (the
 * cutover checklist keeps its preservation section, and this file's own
 * history keeps the removal). A record is not a dependency: nothing in CI
 * reads, provisions or requires the provider.
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')

/**
 * A vendor identifier in the CI surface: an environment variable name, a
 * provider host or an action from the provider's marketplace.
 */
const VENDOR_IDENTIFIERS = [
  /\bNEON[A-Z0-9_]*\b/,
  /\bneon\.tech\b/,
  /\bneonauth\b/i,
  /\bneondatabase\//,
  /console\.neon\.tech/,
]

/**
 * The provider identifiers the CI surface may name, and why each one may.
 *
 * A refusal is a refusal: the test-target guard refuses a hosted legacy auth
 * endpoint, so a test can never reach one. Nothing in CI supplies the value,
 * and no lane needs the provider to exist.
 *
 * A path another lane owns may carry the identifier that lane's pull request
 * removes. The record names the identifier exactly, so a NEW identifier in
 * that path is not covered by the record and fails here.
 */
const ALLOWANCES: {
  file: string
  identifiers: string[]
  reason: string
  pullRequest?: string
}[] = [
  {
    file: 'scripts/test-target-guard.mjs',
    identifiers: ['NEON_AUTH_BASE_URL'],
    reason: 'the guard refuses a hosted legacy auth endpoint; nothing in CI supplies it',
  },
  {
    file: 'scripts/test-target-guard.test.ts',
    identifiers: ['NEON_AUTH_BASE_URL'],
    reason: 'the guard refuses a hosted legacy auth endpoint; nothing in CI supplies it',
  },
  {
    file: 'scripts/database-config.mjs',
    identifiers: ['neon.tech'],
    reason:
      'the path belongs to another lane, whose pull request removes the provider-specific host rule',
    pullRequest: '#1515',
  },
]

/** The path another lane owns. Its identifier is recorded, not required. */
const OWNED_ELSEWHERE = ALLOWANCES.find((entry) => entry.pullRequest)!

/**
 * The database CI scripts: the ones that configure, guard or prove a
 * database connection. The product's own files are not in this list; a
 * deployment binding or a preview-isolation rule belongs to the lane that
 * owns the product configuration.
 *
 * Two files are deliberately outside the list: this scanner and the pull-
 * request proof's own test both name the provider in order to assert its
 * absence, so they are the absence assertions, not a dependency.
 *
 * `scripts/database-config.mjs` is outside the list too: the path belongs to
 * the efficiency lane, whose pull request removes the provider-specific host
 * rule and replaces it with a stronger, provider-neutral one. This lane does
 * not edit that file and does not claim it; the ownership is recorded below.
 */
const DATABASE_CI_SCRIPTS = [
  'scripts/database-health.mjs',
  'scripts/self-hosted-auth-lifecycle.ts',
  'scripts/test-integration.mjs',
  'scripts/test-suite-boundary.test.ts',
  'scripts/test-target-guard.mjs',
  'scripts/test-target-guard.test.ts',
]

/** The CI and release configuration files. */
const CONFIGURATION_FILES = [
  '.github/code-foundry.yml',
  'release-please-config.json',
  '.release-please-manifest.json',
  'package.json',
]

/** One file of the CI surface: its repository-relative path and its text. */
type SurfaceFile = { path: string; text: string }

/** The workflows, read as one path and one text each. */
function workflowFiles(from: string = root): SurfaceFile[] {
  const directory = resolve(from, '.github/workflows')
  return readdirSync(directory)
    .filter((entry) => entry.endsWith('.yml') || entry.endsWith('.yaml'))
    .toSorted()
    .map((entry) => ({
      path: relative(from, join(directory, entry)),
      text: readFileSync(join(directory, entry), 'utf8'),
    }))
}

/** The whole CI surface, read from a root. */
function surfaceFiles(from: string = root): SurfaceFile[] {
  const files = workflowFiles(from)
  for (const path of CONFIGURATION_FILES) {
    files.push({ path, text: readFileSync(resolve(from, path), 'utf8') })
  }
  for (const path of [...DATABASE_CI_SCRIPTS, OWNED_ELSEWHERE.file]) {
    files.push({ path, text: readFileSync(resolve(from, path), 'utf8') })
  }
  return files
}

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8')
}

/** Every vendor identifier a text names. */
function vendorIdentifiers(text: string): string[] {
  const found = new Set<string>()
  for (const pattern of VENDOR_IDENTIFIERS) {
    for (const match of text.matchAll(new RegExp(pattern, 'g'))) {
      found.add(match[0])
    }
  }
  return [...found].toSorted()
}

/** Every provider identifier a surface names, and the path it is in. */
function providerFindings(files: readonly SurfaceFile[]): {
  path: string
  identifiers: string[]
}[] {
  return files
    .map((file) => ({ path: file.path, identifiers: vendorIdentifiers(file.text) }))
    .filter((finding) => finding.identifiers.length > 0)
}

/**
 * The provider identifiers no record allows. Every one of them is a defect: a
 * new identifier fails here, in a path this lane owns and in a path another
 * lane owns alike.
 */
function unexpectedIdentifiers(files: readonly SurfaceFile[]): {
  path: string
  identifiers: string[]
}[] {
  const unexpected: { path: string; identifiers: string[] }[] = []
  for (const file of files) {
    const allowed = ALLOWANCES.find((entry) => entry.file === file.path)?.identifiers ?? []
    const identifiers = vendorIdentifiers(file.text).filter(
      (identifier) => !allowed.includes(identifier)
    )
    if (identifiers.length > 0) unexpected.push({ path: file.path, identifiers })
  }
  return unexpected
}

/**
 * The provider-specific host rule, removed the way the owning lane's change
 * removes it: the block that names the provider host suffix goes, and every
 * other rule stays. The scan reads text, so the copy models the combined state
 * exactly; the owning lane's own change is what makes its file compile.
 */
function withoutProviderRule(source: string): string {
  const identifier = OWNED_ELSEWHERE.identifiers[0]!
  const kept: string[] = []
  let depth = 0
  let removing = false
  for (const line of source.split('\n')) {
    if (!removing && line.includes(identifier)) {
      removing = true
      depth = 0
    }
    if (removing) {
      for (const character of line) {
        if (character === '{') depth += 1
        else if (character === '}') depth -= 1
      }
      if (depth <= 0) removing = false
      continue
    }
    kept.push(line)
  }
  return kept.join('\n')
}

/**
 * A disposable copy of the CI surface. The copy never touches the other
 * lane's file: it is a copy, and the only difference between the two copies
 * is whether the owned path still carries the provider-specific rule.
 */
function disposableSurface(options: { resolveOwnedPath: boolean }): string {
  const directory = mkdtempSync(join(tmpdir(), 'adea-no-neon-surface-'))
  for (const file of surfaceFiles(root)) {
    const target = join(directory, file.path)
    mkdirSync(dirname(target), { recursive: true })
    const text =
      options.resolveOwnedPath && file.path === OWNED_ELSEWHERE.file
        ? withoutProviderRule(file.text)
        : file.text
    writeFileSync(target, text)
  }
  return directory
}

describe('the CI surface has no database-vendor dependency', () => {
  test('no workflow names a provider identifier', () => {
    for (const { path, text } of workflowFiles()) {
      expect({ path, identifiers: vendorIdentifiers(text) }).toEqual({
        path,
        identifiers: [],
      })
    }
  })

  test('no workflow requests a provider secret or variable', () => {
    for (const { path, text } of workflowFiles()) {
      const secrets = [...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1])
      const vars = [...text.matchAll(/vars\.([A-Z0-9_]+)/g)].map((match) => match[1])
      const requested = [...new Set([...secrets, ...vars])].toSorted()
      expect({ path, requested }).toEqual({
        path,
        requested: requested.filter((name) => vendorIdentifiers(name).length === 0),
      })
    }
  })

  test('the CI configuration and the release configuration name no provider', () => {
    for (const path of CONFIGURATION_FILES) {
      expect({ path, identifiers: vendorIdentifiers(read(path)) }).toEqual({
        path,
        identifiers: [],
      })
    }
  })

  test('the database CI scripts name no provider, except the documented refusal', () => {
    for (const path of DATABASE_CI_SCRIPTS) {
      const allowed = ALLOWANCES.find((entry) => entry.file === path)?.identifiers ?? []
      const identifiers = vendorIdentifiers(read(path)).filter(
        (identifier) => !allowed.includes(identifier)
      )
      expect({ path, identifiers }).toEqual({ path, identifiers: [] })
    }
  })

  test('the documented refusal is still a refusal, and nothing supplies the variable', () => {
    const guard = read('scripts/test-target-guard.mjs')
    expect(guard).toContain("'NEON_AUTH_BASE_URL'")
    // The guard refuses a hosted endpoint for it: the variable is listed, and a
    // non-loopback value is refused.
    expect(guard).toContain('HTTP_TARGET_VARIABLES')
    for (const { path, text } of workflowFiles()) {
      expect(text).not.toContain('NEON_AUTH_BASE_URL')
      expect(path).toBeTruthy()
    }
  })

  test('the pull-request database proof is the only database lane, and it is local', () => {
    const workflows = workflowFiles()
    const database = workflows.find((entry) => entry.path.endsWith('database-proof.yml'))
    expect(database).toBeDefined()
    // The provider branch workflow is gone, not renamed around: nothing in the
    // CI surface creates a hosted branch any more.
    expect(workflows.map((entry) => entry.path)).not.toContain(
      '.github/workflows/neon_workflow.yml'
    )
    const parsed = Bun.YAML.parse(database!.text) as {
      jobs: Record<string, { name?: string; steps: { run?: string }[] }>
    }
    for (const job of Object.values(parsed.jobs)) {
      for (const step of job.steps) {
        expect(step.run ?? '').not.toContain('console.neon.tech')
      }
    }
  })

  test('no CI lane supplies a remote database host to the test-target guard', () => {
    // The guard used to accept a host list that a branch-creating step wrote.
    // Nothing writes one now, so the guard has no CI-provided allowlist and
    // every non-loopback database target is remote.
    const guard = read('scripts/test-target-guard.mjs')
    expect(guard).not.toContain('ADEA_CI_BRANCH_HOSTS')
    expect(guard).not.toContain('ADEA_CI_AUTH_HOSTS')
    expect(guard).not.toContain('ci-ephemeral')
    for (const { path, text } of workflowFiles()) {
      expect(text).not.toContain('ADEA_CI_BRANCH_HOSTS')
      expect(text).not.toContain('ADEA_CI_AUTH_HOSTS')
      expect(path).toBeTruthy()
    }
  })

  test('a developer may still name one exact remote host, and a production host never', () => {
    // The allowance is explicit, per run and chosen by a person. It was there
    // before this change and it is still there: what is gone is the CI-wide,
    // machine-driven path to a remote database.
    const guard = read('scripts/test-target-guard.mjs')
    expect(guard).toContain('ADEA_ALLOW_REMOTE_TEST_TARGET')
    expect(guard).toContain('production hosts are never accepted')
  })

  test('no provider identifier appears that no record allows', () => {
    // A path this lane owns may not name a provider, and a path another lane
    // owns may name only the identifier its record names. A new identifier
    // fails here either way.
    expect(unexpectedIdentifiers(surfaceFiles(root))).toEqual([])
  })

  test('the one provider path this lane does not own is recorded, not edited', () => {
    // The efficiency lane owns the database configuration script. This lane
    // does not edit it, so the identifier it still carries is a dependency of
    // that pull request, not of this one. The record names the identifier; the
    // proof does not require it to still be there.
    expect(OWNED_ELSEWHERE.pullRequest).toMatch(/^#\d+$/)
    expect(OWNED_ELSEWHERE.identifiers.length).toBeGreaterThan(0)
    expect(DATABASE_CI_SCRIPTS).not.toContain(OWNED_ELSEWHERE.file)
  })

  test('the combined state, with the owned path resolved, names no provider but the refusals', () => {
    // The state this repository reaches when the owning lane's pull request
    // merges. A disposable copy of the surface proves it without touching the
    // other lane's file.
    const copy = disposableSurface({ resolveOwnedPath: true })
    const findings = providerFindings(surfaceFiles(copy))
    expect(findings.map((finding) => finding.path).toSorted()).toEqual([
      'scripts/test-target-guard.mjs',
      'scripts/test-target-guard.test.ts',
    ])
    expect(unexpectedIdentifiers(surfaceFiles(copy))).toEqual([])
  })

  test('the scan is sensitive: the same copy without the removal is flagged', () => {
    // The combined-state proof is worth nothing if the scan cannot see the
    // identifier. This is the unremoved copy, and it is flagged.
    const copy = disposableSurface({ resolveOwnedPath: false })
    const findings = providerFindings(surfaceFiles(copy))
    expect(findings.find((finding) => finding.path === OWNED_ELSEWHERE.file)).toEqual({
      path: OWNED_ELSEWHERE.file,
      identifiers: OWNED_ELSEWHERE.identifiers.toSorted(),
    })
  })

  test('the integration runner supplies the auth database and proves the lifecycle', () => {
    // The self-hosted auth suite skips itself when the variable is absent, so
    // the runner hands the qualification a loopback URL and the qualification
    // sets the variable. A skipped run is refused, so the green line is never
    // the missing-variable skip.
    const runner = read('scripts/test-integration.mjs')
    expect(runner).toContain('proveSelfHostedAuthLifecycle')
    expect(runner).toContain('localAuthDatabaseUrl')
    expect(runner).toContain('the self-hosted auth lifecycle was not proven')
    expect(runner).toContain('the self-hosted auth lifecycle was proven')
    // The variable reaches the suite, and only the suite.
    const qualification = read('scripts/self-hosted-auth-lifecycle.ts')
    expect(qualification).toContain('AUTH_POSTGRES_TEST_URL')
  })
})
