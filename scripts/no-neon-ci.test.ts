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
 * The historical record of the retired provider stays in this repository (the
 * cutover checklist keeps its preservation section, and this file's own
 * history keeps the removal). A record is not a dependency: nothing in CI
 * reads, provisions or requires the provider.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

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
 * The one vendor identifier the CI surface still names, and why.
 *
 * `NEON_AUTH_BASE_URL` is the legacy Neon Auth binding the product still
 * reads (`packages/auth/src/config.ts`). The test-target guard refuses a
 * hosted endpoint for it, so a test can never reach a hosted legacy auth
 * service. Refusing a value is not a dependency on the value: nothing in CI
 * supplies it, and the provider is not required for any lane to run.
 */
const REFUSALS: { file: string; token: string }[] = [
  { file: 'scripts/test-target-guard.mjs', token: 'NEON_AUTH_BASE_URL' },
  { file: 'scripts/test-target-guard.test.ts', token: 'NEON_AUTH_BASE_URL' },
]

/** The workflows, read as one path and one text each. */
function workflowFiles(): { path: string; text: string }[] {
  const directory = resolve(root, '.github/workflows')
  return readdirSync(directory)
    .filter((entry) => entry.endsWith('.yml') || entry.endsWith('.yaml'))
    .toSorted()
    .map((entry) => ({
      path: relative(root, join(directory, entry)),
      text: readFileSync(join(directory, entry), 'utf8'),
    }))
}

/**
 * The database CI scripts: the ones that configure, guard or prove a
 * database connection. The product's own files are not in this list; a
 * deployment binding or a preview-isolation rule belongs to the lane that
 * owns the product configuration.
 *
 * Two files are deliberately outside the list: this scanner and the pull-
 * request proof's own test both name the provider in order to assert its
 * absence, so they are the absence assertions, not a dependency.
 */
const DATABASE_CI_SCRIPTS = [
  'scripts/database-config.mjs',
  'scripts/database-health.mjs',
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
      const allowed = REFUSALS.filter((refusal) => refusal.file === path).map((r) => r.token)
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

  test('the database configuration script has no provider-specific host rule', () => {
    const config = read('scripts/database-config.mjs')
    expect(config).not.toContain('neon.tech')
    // The pooled and unpooled pair still has to name one environment.
    expect(config).toContain('normalizedPoolerHost')
    expect(config).toContain('Pooled and unpooled connections must target the same environment')
  })
})
