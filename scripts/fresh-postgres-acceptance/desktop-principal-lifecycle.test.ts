// The focused desktop principal lifecycle test.
//
// The real database execution of this phase belongs to the dedicated opt-in
// lane, `scripts/fresh-postgres-acceptance/run.mjs`. That lane validates the
// Docker target, pins its process to a local socket for its whole lifetime,
// isolates the child environment and provisions the disposable instance. This
// test only uses the instance that lane hands it: it never starts a container
// and never contacts a Docker daemon, so ordinary test discovery finds this
// file side-effect-free. The database journey is a named dedicated opt-in skip
// without the lane's instance, and the offline regressions always run.
//
// The cleanup of this file is fatal. Every owned connection is closed even
// when an earlier close fails, and a cleanup that fails fails the run.

import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

import { runCleanupSteps } from './acceptance-teardown.mjs'
import { assertProvisionedLoopback } from './policy.mjs'
import {
  canonicalUrl,
  createCanonicalDatabase,
  MIGRATION_ROLE,
  RUNTIME_ROLE,
} from '../../packages/db/tests/fixtures/canonical-boundary'
import {
  cleanupScratchDatabase,
  throwScratchFailures,
} from '../../packages/db/tests/integration/migration-history-preflight-scratch'
import { createBetterAuthService } from '../../packages/auth/src/server'
import { createRecordingAuthDelivery } from '../../packages/auth/src/delivery'
import { applyAuthSchema } from '../../packages/auth/src/schema-init'
import {
  assertIdentityMeasurements,
  deriveIdentityDeltas,
  pkceChallenge,
  runDesktopPrincipalLifecycle,
  type DesktopPrincipalLifecycleReceipt,
  type IdentityMeasurements,
} from './desktop-principal-lifecycle'

const dbRequire = createRequire(new URL('../../packages/db/package.json', import.meta.url))
type PostgresFactory = typeof import('postgres').default
const loadedPostgres = dbRequire('postgres') as PostgresFactory | { default: PostgresFactory }
const postgres: PostgresFactory =
  typeof loadedPostgres === 'function' ? loadedPostgres : loadedPostgres.default

const root = resolve(import.meta.dir, '../..')
const providerSchema = 'auth_acceptance'

/**
 * The instance the dedicated lane provisioned. It is absent in ordinary test
 * discovery, and the file then reaches no container and no database.
 */
const provisioner = process.env.MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL

const authEnvironment = (url: string) => ({
  AUTH_BASE_URL: 'https://r3.example.test',
  AUTH_DATABASE_URL: url,
  AUTH_EMAIL_VERIFICATION_REQUIRED: 'true',
  AUTH_SECURE_COOKIES: 'true',
  AUTH_TRUSTED_ORIGINS: 'https://r3.example.test',
  AUTH_SECRET: 'synthetic-r3-desktop-secret-at-least-thirty-two-chars',
})

function withProviderSchema(value: string) {
  const url = new URL(value)
  url.searchParams.set('options', `-c search_path=${providerSchema}`)
  return url.toString()
}

describe('the desktop principal lifecycle phase', () => {
  test.skipIf(!provisioner)(
    'dedicated opt-in: a fresh provider identity maps to one application user, and the exchange persists it',
    async () => {
      // The lane's instance is the only target, and it is the exact
      // provisioner-owned loopback target the policy allows.
      const target = assertProvisionedLoopback(provisioner)
      const name = `r3_desktop_${randomUUID().replaceAll('-', '')}`
      const urlFor = (database: string) => {
        const url = new URL(target)
        url.pathname = `/${database}`
        return url.toString()
      }
      const migrationUrl = canonicalUrl(target, name, MIGRATION_ROLE)
      const runtimeUrl = canonicalUrl(target, name, RUNTIME_ROLE)

      let admin: ReturnType<typeof postgres> | undefined
      let migration: ReturnType<typeof postgres> | undefined
      let providerSql: ReturnType<typeof postgres> | undefined
      let service: ReturnType<typeof createBetterAuthService> | undefined
      let receipt: DesktopPrincipalLifecycleReceipt | undefined
      let bodyError: unknown

      // Every owned resource is closed, in order, and every close is attempted
      // even when an earlier one fails.
      const closers = [
        async () => {
          await service?.close()
        },
        async () => {
          await providerSql?.end()
        },
        async () => {
          await migration?.end()
        },
        async () => {
          if (admin) await cleanupScratchDatabase(admin, name)
        },
        async () => {
          await admin?.end()
        },
      ]

      try {
        admin = postgres(target, { max: 1, onnotice: () => {} })
        await createCanonicalDatabase(admin, urlFor, name)

        const migrated = spawnSync(
          'bun',
          [
            '--no-env-file',
            '--conditions=react-server',
            'run',
            'packages/db/src/verify-migrations.ts',
          ],
          {
            cwd: root,
            env: {
              PATH: process.env.PATH ?? '',
              TMPDIR: process.env.TMPDIR ?? '',
              LANG: process.env.LANG ?? '',
              DATABASE_MIGRATION_URL: migrationUrl,
            },
            encoding: 'utf8',
            timeout: 300_000,
            killSignal: 'SIGKILL',
          }
        )
        if (migrated.error || migrated.status !== 0) {
          throw new Error('the migration history could not be applied to the scratch database')
        }

        migration = postgres(migrationUrl, { max: 1, onnotice: () => {} })
        await migration.unsafe(`CREATE SCHEMA ${providerSchema} AUTHORIZATION ${MIGRATION_ROLE}`)
        await migration.unsafe(`GRANT USAGE ON SCHEMA ${providerSchema} TO ${RUNTIME_ROLE}`)

        const applied = await applyAuthSchema({
          ...authEnvironment(withProviderSchema(migrationUrl)),
          AUTH_MIGRATION_DATABASE_URL: withProviderSchema(migrationUrl),
        })
        expect(applied.applied).toBe(true)
        expect(applied.after).toEqual({ add: [], create: [] })

        const recorder = createRecordingAuthDelivery()
        service = createBetterAuthService(
          authEnvironment(withProviderSchema(runtimeUrl)),
          recorder.delivery
        )
        providerSql = postgres(withProviderSchema(runtimeUrl), { max: 1, onnotice: () => {} })
        receipt = await runDesktopPrincipalLifecycle({
          applicationDatabaseUrl: runtimeUrl,
          providerSchema,
          providerSql,
          recorder,
          service,
        })
      } catch (error) {
        bodyError = error
      }

      const cleanupErrors = await runCleanupSteps(closers)
      // A cleanup that failed is fatal, and it is reported together with the
      // failure of the body when both happened.
      throwScratchFailures(bodyError !== undefined, bodyError, cleanupErrors)

      expect(receipt?.status).toBe('passed')
      expect(receipt?.provider).toBe('better-auth')
      // The counts are measured, not assumed: three fresh identities, three
      // provider accounts, three application users and no orphan user.
      expect(receipt?.accounts).toBe(3)
      expect(receipt?.mappedUsers).toBe(3)
      expect(receipt?.orphanUsers).toBe(0)
      expect(receipt?.desktopSessions).toBe(1)
      expect(receipt?.exchanges).toBe(1)
      expect(receipt?.refused).toEqual({ origin: 1, pkce: 1, replay: 1 })
    },
    600_000
  )

  test('computes the S256 PKCE challenge', () => {
    // The RFC 7636 vector: the verifier "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    // has the challenge "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM".
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    )
  })

  test('the phase uses the production composition, not a mock identity mapping', () => {
    const source = readFileSync(resolve(import.meta.dir, 'desktop-principal-lifecycle.ts'), 'utf8')
    for (const production of [
      'resolveOrProvisionDesktopPrincipal',
      'findUserPrincipalsByAuthIdentity',
      'createUserWithAuthIdentity',
      'setUserDisplayNameIfMissing',
      'createDesktopAuthorizationCodeBroker',
      'createDesktopSessionService',
      'consumeDesktopAuthorizationCode',
      'saveDesktopAuthorizationCode',
      'createDesktopSessionRecord',
      'resolveDesktopSessionRecord',
      'rotateDesktopSessionRecord',
      'revokeDesktopSessionRecord',
      'createBetterAuthServerAdapter',
      'handleBetterAuthRequest',
    ]) {
      expect(source).toContain(production)
    }
    // The phase must not carry its own identity mapping or its own session
    // store: the production functions are the only source of both.
    expect(source).not.toContain('function findUserPrincipals(')
    expect(source).not.toContain('function provision(')
    expect(source).not.toContain('const identities = new Map')
  })
})

/** A measurement with no rows yet, adjusted by the given overrides. */
const counts = (overrides: Partial<IdentityMeasurements> = {}): IdentityMeasurements => ({
  applicationUsers: 0,
  orphanUsers: 0,
  providerAccounts: 0,
  ...overrides,
})

describe('the measured identity counts', () => {
  test('the deltas are derived from the measured rows', () => {
    const derived = deriveIdentityDeltas(
      counts({ applicationUsers: 2, providerAccounts: 2 }),
      counts({ applicationUsers: 5, orphanUsers: 0, providerAccounts: 5 })
    )
    expect(derived).toEqual({ applicationUsers: 3, orphanUsers: 0, providerAccounts: 3 })
  })

  test('three identities require three accounts and three users', () => {
    expect(() =>
      assertIdentityMeasurements(
        counts({ applicationUsers: 3, orphanUsers: 0, providerAccounts: 3 }),
        { identities: 3 }
      )
    ).not.toThrow()
  })

  test('a missing provider account is a failure', () => {
    expect(() =>
      assertIdentityMeasurements(
        counts({ applicationUsers: 3, orphanUsers: 0, providerAccounts: 2 }),
        { identities: 3 }
      )
    ).toThrow(/provider accounts/)
  })

  test('a missing application user is a failure', () => {
    expect(() =>
      assertIdentityMeasurements(
        counts({ applicationUsers: 2, orphanUsers: 0, providerAccounts: 3 }),
        { identities: 3 }
      )
    ).toThrow(/application users/)
  })

  test('an orphan user left by a losing concurrent insert is a failure', () => {
    expect(() =>
      assertIdentityMeasurements(
        counts({ applicationUsers: 4, orphanUsers: 1, providerAccounts: 3 }),
        { identities: 3 }
      )
    ).toThrow(/without a provider identity/)
  })
})
