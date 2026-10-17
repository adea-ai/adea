import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PRODUCTION_TARGET_HOSTS,
  assertLocalTestTargets,
  classifyDatabaseTarget,
  classifyHttpTarget,
  effectiveDatabaseTarget,
} from './test-target-guard.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const local = 'postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55432/agent_hq'
const ciHost = 'ep-quiet-pond-123456.us-east-2.aws.neon.tech'
const ciUrl = `postgresql://adea_dev_app:secret@${ciHost}/neondb?sslmode=require`
const productionHost = 'ep-prod-654321.us-east-2.aws.neon.tech'
const productionLike = `postgresql://owner:secret@${productionHost}/neondb`
// What the create-branch step emits for the current pull request.
const branchEnv = { GITHUB_ACTIONS: 'true', ADEA_CI_BRANCH_HOSTS: ciHost }
const pooledHost = 'ep-quiet-pond-123456-pooler.us-east-2.aws.neon.tech'

describe('test target classification', () => {
  test('loopback hosts are local', () => {
    for (const url of [
      local,
      'postgresql://u:p@localhost:5432/db',
      'postgresql://u:p@[::1]:5432/db',
      'postgresql://u:p@db.localhost/db',
      'postgresql://u:p@LOCALHOST,127.0.0.1:5433/db',
    ]) {
      expect(classifyDatabaseTarget(url, {})).toBe('local')
    }
  })

  test('the CI Neon branch is ephemeral only for the hosts the create-branch step emitted', () => {
    expect(classifyDatabaseTarget(ciUrl, branchEnv)).toBe('ci-ephemeral')
    expect(
      classifyDatabaseTarget(ciUrl.replace('adea_dev_app', 'adea_dev_migration'), branchEnv)
    ).toBe('ci-ephemeral')
    // The pooled host is listed alongside the direct one.
    expect(
      classifyDatabaseTarget(ciUrl.replace(ciHost, pooledHost), {
        ...branchEnv,
        ADEA_CI_BRANCH_HOSTS: `${ciHost},${pooledHost}`,
      })
    ).toBe('ci-ephemeral')
    // Same URL from a developer shell, any other role, or a host the step did not emit.
    expect(classifyDatabaseTarget(ciUrl, { ADEA_CI_BRANCH_HOSTS: ciHost })).toBe('remote')
    expect(classifyDatabaseTarget(ciUrl, { GITHUB_ACTIONS: 'true' })).toBe('remote')
    expect(classifyDatabaseTarget(ciUrl.replace('adea_dev_app', 'owner'), branchEnv)).toBe('remote')
    expect(classifyDatabaseTarget(`postgresql://adea_dev_app:s@db.example.com/x`, branchEnv)).toBe(
      'remote'
    )
  })

  test('a production host with the same CI role and GitHub Actions is still remote', () => {
    // The old rule (GITHUB_ACTIONS + *.neon.tech + role name) accepted this.
    const sameRole = `postgresql://adea_dev_app:secret@${productionHost}/neondb?sslmode=require`
    expect(classifyDatabaseTarget(sameRole, { GITHUB_ACTIONS: 'true' })).toBe('remote')
    expect(classifyDatabaseTarget(sameRole, branchEnv)).toBe('remote')
    // One listed host does not vouch for an unlisted one in a multi-host URL.
    expect(
      classifyDatabaseTarget(
        `postgresql://adea_dev_app:s@${ciHost},${productionHost}/neondb`,
        branchEnv
      )
    ).toBe('remote')
    // A configured production host is production even if the branch list names it.
    expect(
      classifyDatabaseTarget(sameRole, {
        ...branchEnv,
        ADEA_CI_BRANCH_HOSTS: `${ciHost},${productionHost}`,
        ADEA_PRODUCTION_TARGET_HOSTS: productionHost,
      })
    ).toBe('production')
  })

  test('anything that does not parse as a local database is remote', () => {
    for (const url of ['', 'not a url', 'https://127.0.0.1/db', 'postgresql://u:p@10.0.0.5/db']) {
      expect(classifyDatabaseTarget(url, {})).toBe('remote')
    }
  })

  test('http targets are local only on loopback, and production hosts are never accepted', () => {
    expect(classifyHttpTarget('http://localhost:3000', {})).toBe('local')
    expect(classifyHttpTarget('http://127.0.0.1:8799/', {})).toBe('local')
    expect(classifyHttpTarget('https://example.com', {})).toBe('remote')
    expect(classifyHttpTarget('http://localhost.evil.example', {})).toBe('remote')
    expect(classifyHttpTarget('nope', {})).toBe('remote')
    for (const host of PRODUCTION_TARGET_HOSTS) {
      expect(classifyHttpTarget(`https://${host}/`, {})).toBe('production')
    }
    expect(classifyHttpTarget('https://adea.dev', {})).toBe('production')
  })
})

// The driver does not read a URL the way its text suggests; the guard follows
// the driver (postgres.js 3.4.9 src/index.js `parseUrl`/`parseOptions`).
describe('database URL host resolution', () => {
  const socketUrl = 'postgresql:///db?host=/var/run/postgresql'

  test('a socket-looking hostless URL falls back to PGHOST, so it is only as local as PGHOST', () => {
    expect(effectiveDatabaseTarget(socketUrl, { PGHOST: 'db.example.com' })?.hosts).toEqual([
      'db.example.com',
    ])
    expect(classifyDatabaseTarget(socketUrl, { PGHOST: 'db.example.com' })).toBe('remote')
    expect(classifyDatabaseTarget(socketUrl, { PGHOST: productionHost })).toBe('remote')
    // Even with a loopback PGHOST the `host` query is not transport, so the
    // URL is ambiguous and refused rather than trusted.
    expect(classifyDatabaseTarget(socketUrl, { PGHOST: '127.0.0.1' })).toBe('remote')
    expect(classifyDatabaseTarget(socketUrl, {})).toBe('remote')
  })

  test('a hostless URL is judged by PGHOST, then localhost', () => {
    expect(classifyDatabaseTarget('postgresql:///db', {})).toBe('local')
    expect(classifyDatabaseTarget('postgresql:///db', { PGHOST: 'localhost' })).toBe('local')
    expect(classifyDatabaseTarget('postgresql:///db', { PGHOST: '/var/run/postgresql' })).toBe(
      'local'
    )
    expect(classifyDatabaseTarget('postgresql:///db', { PGHOST: 'db.example.com' })).toBe('remote')
    expect(classifyDatabaseTarget('postgresql:///db', { PGHOST: 'localhost,db.example.com' })).toBe(
      'remote'
    )
  })

  test('host and hostaddr query parameters are ambiguous even next to a loopback host', () => {
    for (const url of [
      'postgresql://u:p@localhost/db?host=db.example.com',
      'postgresql://u:p@localhost/db?hostaddr=10.0.0.5',
      'postgresql://u:p@127.0.0.1/db?host=/var/run/postgresql',
    ]) {
      expect(effectiveDatabaseTarget(url, {})?.ambiguous).toBe(true)
      expect(classifyDatabaseTarget(url, {})).toBe('remote')
    }
  })

  test('a percent-encoded authority is a literal host name, not a socket directory', () => {
    const url = 'postgresql://u:p@%2Fvar%2Frun%2Fpostgresql/db'
    expect(classifyDatabaseTarget(url, {})).toBe('remote')
  })

  test('the guard resolves hosts the way postgres.js does, without connecting', () => {
    const require = createRequire(join(root, 'packages/db/package.json'))
    type Client = { options: { host: string[] }; end: (o: { timeout: number }) => Promise<void> }
    const loaded = require('postgres') as
      | ((url: string, options?: Record<string, unknown>) => Client)
      | { default: (url: string, options?: Record<string, unknown>) => Client }
    const postgres = typeof loaded === 'function' ? loaded : loaded.default
    const urls = [
      local,
      socketUrl,
      'postgresql:///db',
      'postgresql://u:p@localhost/db?host=db.example.com',
      'postgresql://u:p@localhost,db.example.com/db',
      'postgresql://u:p@LOCALHOST:5433,Db.Example.com:5434/db',
      'postgresql://u:p@%2Fvar%2Frun%2Fpostgresql/db',
      ciUrl,
      productionLike,
    ]
    const saved = process.env.PGHOST
    try {
      for (const pghost of [undefined, 'db.example.com', '127.0.0.1']) {
        if (pghost === undefined) delete process.env.PGHOST
        else process.env.PGHOST = pghost
        for (const url of urls) {
          // Constructing the client resolves its options; nothing connects
          // until a query runs, and none does.
          const client = postgres(url, { max: 1 })
          const driverHosts = client.options.host.map((host) => host.toLowerCase())
          void client.end({ timeout: 0 })
          expect(effectiveDatabaseTarget(url, { PGHOST: pghost })?.hosts).toEqual(driverHosts)
        }
      }
    } finally {
      if (saved === undefined) delete process.env.PGHOST
      else process.env.PGHOST = saved
    }
  })
})

describe('assertLocalTestTargets', () => {
  test('accepts unset and local targets', () => {
    expect(() => assertLocalTestTargets({})).not.toThrow()
    expect(() =>
      assertLocalTestTargets({
        DATABASE_URL: local,
        DATABASE_URL_UNPOOLED: local,
        DATABASE_MIGRATION_URL: local,
        PERF_BASE_URL: 'http://localhost:3000',
        ADEA_ACCEPTANCE_URL: 'http://127.0.0.1:8787',
        NEON_AUTH_BASE_URL: 'http://127.0.0.1:8787/auth',
        CONTROL_PLANE_ORIGIN: 'http://localhost:8080',
      })
    ).not.toThrow()
  })

  test('accepts the CI branch from Actions when the step emitted its hosts', () => {
    expect(() =>
      assertLocalTestTargets({
        ...branchEnv,
        DATABASE_URL: ciUrl,
        DATABASE_URL_UNPOOLED: ciUrl,
        DATABASE_MIGRATION_URL: ciUrl.replace('adea_dev_app', 'adea_dev_migration'),
      })
    ).not.toThrow()
  })

  test('refuses a production host that carries the CI role, from Actions', () => {
    const sameRole = `postgresql://adea_dev_app:secret@${productionHost}/neondb?sslmode=require`
    expect(() =>
      assertLocalTestTargets({ GITHUB_ACTIONS: 'true', DATABASE_URL: sameRole })
    ).toThrow(productionHost)
    expect(() => assertLocalTestTargets({ ...branchEnv, DATABASE_URL: sameRole })).toThrow(
      productionHost
    )
  })

  test('refuses a remote target in every variable, naming it without its credentials', () => {
    for (const name of [
      'DATABASE_URL',
      'DATABASE_URL_UNPOOLED',
      'DATABASE_MIGRATION_URL',
      'MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL',
    ]) {
      let message = ''
      try {
        assertLocalTestTargets({ [name]: productionLike })
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).toContain(name)
      expect(message).toContain(productionHost)
      expect(message).not.toContain('secret')
      expect(message).not.toContain('owner')
    }
  })

  test('refuses a purported socket URL when PGHOST is remote, without connecting', () => {
    const env = {
      DATABASE_URL: 'postgresql:///db?host=/var/run/postgresql',
      PGHOST: 'db.example.com',
    }
    let message = ''
    try {
      assertLocalTestTargets(env)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('DATABASE_URL')
    expect(message).toContain('db.example.com via PGHOST')
    expect(message).toContain('ambiguous')
    // Naming the host does not make an ambiguous URL acceptable.
    expect(() =>
      assertLocalTestTargets({ ...env, ADEA_ALLOW_REMOTE_TEST_TARGET: 'db.example.com' })
    ).toThrow('DATABASE_URL')
    // The same hostless URL without the ambiguous query is allowed when PGHOST is named.
    expect(() =>
      assertLocalTestTargets({
        DATABASE_URL: 'postgresql:///db',
        PGHOST: 'db.example.com',
        ADEA_ALLOW_REMOTE_TEST_TARGET: 'db.example.com',
      })
    ).not.toThrow()
    expect(() =>
      assertLocalTestTargets({ DATABASE_URL: 'postgresql:///db', PGHOST: 'db.example.com' })
    ).toThrow('db.example.com via PGHOST')
  })

  test('guards the http and auth probe targets', () => {
    for (const name of [
      'PERF_BASE_URL',
      'ADEA_ACCEPTANCE_URL',
      'NEON_AUTH_BASE_URL',
      'CONTROL_PLANE_ORIGIN',
    ]) {
      expect(() => assertLocalTestTargets({ [name]: 'https://preview.example.com' })).toThrow(name)
      expect(() => assertLocalTestTargets({ [name]: 'https://adea.dev/' })).toThrow(
        'production host adea.dev'
      )
    }
  })

  test('production hosts have no override', () => {
    for (const host of PRODUCTION_TARGET_HOSTS) {
      for (const name of ['PERF_BASE_URL', 'ADEA_ACCEPTANCE_URL', 'NEON_AUTH_BASE_URL']) {
        expect(() =>
          assertLocalTestTargets({
            [name]: `https://${host}/`,
            ADEA_ALLOW_REMOTE_TEST_TARGET: host,
            ADEA_CI_AUTH_HOSTS: host,
            GITHUB_ACTIONS: 'true',
          })
        ).toThrow('no override')
      }
    }
    expect(() =>
      assertLocalTestTargets({
        DATABASE_URL: productionLike,
        ADEA_PRODUCTION_TARGET_HOSTS: productionHost,
        ADEA_ALLOW_REMOTE_TEST_TARGET: productionHost,
      })
    ).toThrow('no override')
  })

  test('the Neon Auth endpoint is accepted only at the host the workflow emitted', () => {
    const auth = 'https://ep-auth-1.neonauth.us-east-2.aws.neon.tech/neondb/auth'
    expect(() =>
      assertLocalTestTargets({
        GITHUB_ACTIONS: 'true',
        ADEA_CI_AUTH_HOSTS: 'ep-auth-1.neonauth.us-east-2.aws.neon.tech',
        NEON_AUTH_BASE_URL: auth,
      })
    ).not.toThrow()
    expect(() =>
      assertLocalTestTargets({ GITHUB_ACTIONS: 'true', NEON_AUTH_BASE_URL: auth })
    ).toThrow('NEON_AUTH_BASE_URL')
    expect(() =>
      assertLocalTestTargets({
        ADEA_CI_AUTH_HOSTS: 'ep-auth-1.neonauth.us-east-2.aws.neon.tech',
        NEON_AUTH_BASE_URL: auth,
      })
    ).toThrow('NEON_AUTH_BASE_URL')
    // The emitted host list is specific to the auth variable.
    expect(() =>
      assertLocalTestTargets({
        GITHUB_ACTIONS: 'true',
        ADEA_CI_AUTH_HOSTS: 'ep-auth-1.neonauth.us-east-2.aws.neon.tech',
        ADEA_ACCEPTANCE_URL: auth,
      })
    ).toThrow('ADEA_ACCEPTANCE_URL')
  })

  test('a remote target is allowed only by naming its exact host', () => {
    const env = { DATABASE_URL: productionLike }
    const host = productionHost
    expect(() =>
      assertLocalTestTargets({ ...env, ADEA_ALLOW_REMOTE_TEST_TARGET: host })
    ).not.toThrow()
    expect(() =>
      assertLocalTestTargets({
        ...env,
        ADEA_ALLOW_REMOTE_TEST_TARGET: `x.example, ${host.toUpperCase()}`,
      })
    ).not.toThrow()
    for (const allow of ['', 'true', '1', 'neon.tech', '*', 'ep-prod-654321']) {
      expect(() =>
        assertLocalTestTargets({ ...env, ADEA_ALLOW_REMOTE_TEST_TARGET: allow })
      ).toThrow()
    }
    expect(() =>
      assertLocalTestTargets({
        ADEA_ACCEPTANCE_URL: 'https://pr-12.preview.example.com',
        ADEA_ALLOW_REMOTE_TEST_TARGET: 'pr-12.preview.example.com',
      })
    ).not.toThrow()
  })
})

// The CI hosts the guard trusts are written by the workflow, so run the
// workflow's own scripts (no network, fake inputs) and feed what they emit to
// the guard.
describe('the Neon workflow binds the guard to the branch it created', () => {
  const workflow = Bun.YAML.parse(
    readFileSync(join(root, '.github/workflows/neon_workflow.yml'), 'utf8')
  ) as {
    jobs: Record<string, { steps: { name?: string; run?: string }[] }>
  }
  const script = (name: string) => {
    const run = workflow.jobs.neon_proof!.steps.find((step) => step.name === name)?.run ?? ''
    const body = /<<'NODE'\n([\s\S]*?)\n\s*NODE\s*$/.exec(run)?.[1]
    if (!body) throw new Error(`no node script in step: ${name}`)
    return body
      .split('\n')
      .map((line) => line.replace(/^ {10}/, ''))
      .join('\n')
  }

  function runStep(name: string, env: Record<string, string>, githubEnv: string) {
    // The auth step awaits a fetch; stand a stub in for it so nothing leaves the machine.
    const code =
      'globalThis.fetch = async () => ({ ok: true, json: async () => ({ keys: [] }) });\n' +
      `(async () => {\n${script(name)}\n})().catch((e) => { console.error(e); process.exit(1) })`
    const result = spawnSync('node', ['-e', code], {
      env: { PATH: process.env.PATH ?? '', ...env, GITHUB_ENV: githubEnv },
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
  }

  function emitted(): Record<string, string> {
    const directory = mkdtempSync(join(tmpdir(), 'adea-github-env-'))
    const githubEnv = join(directory, 'env')
    try {
      writeFileSync(githubEnv, '')
      runStep(
        'Build restricted database URLs',
        {
          DATABASE_HOST: ciHost,
          DATABASE_HOST_POOLED: pooledHost,
          DATABASE_APP_PASSWORD: 'app-secret',
          DATABASE_MIGRATION_PASSWORD: 'migration-secret',
        },
        githubEnv
      )
      runStep(
        'Verify isolated Neon Auth endpoint',
        { NEON_AUTH_BASE_URL: 'https://ep-auth-1.neonauth.us-east-2.aws.neon.tech/neondb/auth' },
        githubEnv
      )
      const entries: Record<string, string> = {}
      for (const line of readFileSync(githubEnv, 'utf8').split('\n')) {
        const at = line.indexOf('=')
        if (at > 0) entries[line.slice(0, at)] = line.slice(at + 1)
      }
      return entries
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }

  test('the emitted environment passes the guard, and only for those hosts', () => {
    const env = { ...emitted(), GITHUB_ACTIONS: 'true' }
    expect(env.ADEA_CI_BRANCH_HOSTS).toBe(`${ciHost},${pooledHost}`)
    expect(env.ADEA_CI_AUTH_HOSTS).toBe('ep-auth-1.neonauth.us-east-2.aws.neon.tech')
    for (const name of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'DATABASE_MIGRATION_URL']) {
      expect(classifyDatabaseTarget(env[name]!, env)).toBe('ci-ephemeral')
    }
    expect(() =>
      assertLocalTestTargets({
        ...env,
        NEON_AUTH_BASE_URL: 'https://ep-auth-1.neonauth.us-east-2.aws.neon.tech/neondb/auth',
      })
    ).not.toThrow()
    expect(() => assertLocalTestTargets(env)).not.toThrow()

    // The same roles at a production host, in the same Actions environment.
    const hijacked = { ...env, DATABASE_URL: env.DATABASE_URL!.replace(pooledHost, productionHost) }
    expect(hijacked.DATABASE_URL).toContain(productionHost)
    expect(() => assertLocalTestTargets(hijacked)).toThrow(productionHost)
    expect(() =>
      assertLocalTestTargets({ ...env, NEON_AUTH_BASE_URL: 'https://adea.dev/auth' })
    ).toThrow('production host adea.dev')
  })
})

// The guard only protects lanes that load it, so the entry points are pinned.
describe('lanes that load the guard', () => {
  test('bun test processes in database-backed packages preload it', async () => {
    for (const dir of ['packages/db', 'packages/auth', 'apps/web']) {
      const bunfig = await readFile(join(root, dir, 'bunfig.toml'), 'utf8')
      expect(bunfig).toContain('[test]')
      expect(bunfig).toContain('preload = ["../../scripts/test-target-preload.ts"]')
    }
    const rootBunfig = await readFile(join(root, 'bunfig.toml'), 'utf8')
    expect(rootBunfig).toContain('preload = ["./scripts/test-target-preload.ts"]')
  })

  test('the Playwright config checks its targets before it reads them', async () => {
    const config = await readFile(join(root, 'playwright.config.ts'), 'utf8')
    expect(config).toContain("from './scripts/test-target-guard.mjs'")
    expect(config.indexOf('assertLocalTestTargets()')).toBeGreaterThan(-1)
    expect(config.indexOf('assertLocalTestTargets()')).toBeLessThan(
      config.indexOf('process.env.PERF_BASE_URL')
    )
  })

  test('every probe that reads a database or acceptance target checks it first', async () => {
    const probes: [string, string, string][] = [
      ['scripts/database-health.mjs', './test-target-guard.mjs', 'process.env.DATABASE_URL'],
      ['scripts/test-integration.mjs', './test-target-guard.mjs', 'process.env.DATABASE_URL'],
      ['scripts/e2e-setup.mjs', './test-target-guard.mjs', 'process.env.DATABASE_URL'],
      [
        'scripts/measure-web-performance.mjs',
        './test-target-guard.mjs',
        'process.env.DATABASE_URL',
      ],
      ...['acceptance-hosted', 'acceptance-gates', 'acceptance-sign-in'].map(
        (name): [string, string, string] => [
          `apps/web/start/${name}.mjs`,
          '../../../scripts/test-target-guard.mjs',
          'process.env.ADEA_ACCEPTANCE_URL',
        ]
      ),
    ]
    for (const [file, specifier, read] of probes) {
      const source = await readFile(join(root, file), 'utf8')
      expect(source).toContain(`from '${specifier}'`)
      const check = source.indexOf('assertLocalTestTargets()')
      expect(check).toBeGreaterThan(-1)
      expect(check).toBeLessThan(source.indexOf(read))
    }
  })

  test('the Worker production origins are all on the never-allowed list', async () => {
    const config = await readFile(join(root, 'apps/web/cloudflare.config.ts'), 'utf8')
    const productionBlock = config.slice(config.indexOf('export function productionEnv'))
    for (const origin of productionBlock.match(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}/g) ?? []) {
      const host = new URL(origin).hostname
      if (host.endsWith('.invalid')) continue
      expect(PRODUCTION_TARGET_HOSTS).toContain(host)
    }
  })
})
