import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Cache tooling has no production database dependency.
const root = resolve(import.meta.dirname, '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

/** The files this lane owns. Every one of them is read, so a renamed file cannot slip past the guard. */
const scope = [
  'scripts/vp-local-run.mjs',
  'scripts/vp-local-run.test.ts',
  'scripts/vp-r2-cache.mjs',
  'scripts/vp-r2-cache.cbor.mjs',
  'scripts/vp-r2-cache-fixtures.mjs',
  'scripts/vp-r2-cache-replay.mjs',
  'scripts/vp-r2-cache-transfer.mjs',
  'scripts/vp-r2-cache-transfer-fixtures.mjs',
  'scripts/vite-plus-proof.mjs',
  'scripts/orch-graph.mjs',
  'scripts/orch-toolchain.mjs',
  '.github/workflows/task-cache-qualification.yml',
  '.github/workflows/vite-plus-proof.yml',
]

/** The two workflows the cache lane runs in GitHub Actions. */
const cacheWorkflows = [
  '.github/workflows/task-cache-qualification.yml',
  '.github/workflows/vite-plus-proof.yml',
]

const manifest = JSON.parse(read('package.json')) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  scripts?: Record<string, string>
}

describe('the admitted caching and tooling scope', () => {
  test('every file the guard names is still there', () => {
    for (const path of scope)
      expect({ path, exists: existsSync(join(root, path)) }).toEqual({ path, exists: true })
  })

  test('no file in the scope names a database service at all', () => {
    // The cache lane's own transport is a Cloudflare R2 transport, not a database. A database name in this scope
    // would be a coupling to a target this repository is leaving.
    for (const path of scope) {
      const found = read(path).match(/postgres|hyperdrive|DATABASE_URL/gi) ?? []
      expect({ path, found: found.length }).toEqual({ path, found: 0 })
    }
  })

  test('the cache workflows use no repository secret and no service credential', () => {
    for (const path of cacheWorkflows) {
      expect({ path, secrets: /secrets\./.test(read(path)) }).toEqual({ path, secrets: false })
    }
  })
})

describe('the shared R2 transport stays off and local', () => {
  test('nothing in the manifest turns the transport on', () => {
    const scripts = Object.values(manifest.scripts ?? {}).join('\n')
    expect(scripts).not.toContain('ADEA_VP_R2_CACHE_ENABLED')
    expect(scripts).not.toContain('VP_REMOTE_CACHE')
  })

  test('no workflow turns the transport on', () => {
    const directory = join(root, '.github', 'workflows')
    for (const file of readdirSync(directory).filter((name) => name.endsWith('.yml'))) {
      const text = readFileSync(join(directory, file), 'utf8')
      expect({ file, enabled: text.includes('ADEA_VP_R2_CACHE_ENABLED') }).toEqual({
        file,
        enabled: false,
      })
    }
  })

  test("the transport's fallback is the caller's own local cache, not another service", () => {
    const transport = read('scripts/vp-r2-cache.mjs')
    // Every refusal is a result with a fallback flag, and the caller keeps what it has locally.
    expect(transport).toContain('fallback: true')
    expect(transport).toContain('keeps its local cache')
  })
})
