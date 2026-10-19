// The focused desktop principal lifecycle test.
//
// It starts its own disposable PostgreSQL instance, provisions the canonical
// roles through the repository's canonical boundary fixture, applies the
// migration history, initializes the provider schema through the merged auth
// schema initializer, and then runs the desktop principal lifecycle phase
// against that real instance.
//
// The test signals nothing, reaches no hosted database and keeps no identity
// state in memory: every assertion is made against a row in the disposable
// database.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

import { startCaptureProvisioning } from '../capture-provisioning.mjs'
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
  pkceChallenge,
  runDesktopPrincipalLifecycle,
  type DesktopPrincipalLifecycleReceipt,
} from './desktop-principal-lifecycle'

const dbRequire = createRequire(new URL('../../packages/db/package.json', import.meta.url))
type PostgresFactory = typeof import('postgres').default
const loadedPostgres = dbRequire('postgres') as PostgresFactory | { default: PostgresFactory }
const postgres: PostgresFactory =
  typeof loadedPostgres === 'function' ? loadedPostgres : loadedPostgres.default

const root = resolve(import.meta.dir, '../..')
const providerSchema = 'auth_acceptance'

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
  let handle: ReturnType<typeof startCaptureProvisioning> | null = null
  let admin: ReturnType<typeof postgres> | undefined
  let receipt: DesktopPrincipalLifecycleReceipt | undefined
  let failure: unknown
  let cleanupErrors: unknown[] = []
  const name = `r3_desktop_${randomUUID().replaceAll('-', '')}`

  beforeAll(async () => {
    try {
      handle = startCaptureProvisioning()
      expect(handle).not.toBeNull()
      expect(handle?.databaseUrl).toBeTruthy()
      const provisioner = handle!.databaseUrl!
      const urlFor = (database: string) => {
        const url = new URL(provisioner)
        url.pathname = `/${database}`
        return url.toString()
      }
      const migrationUrl = canonicalUrl(provisioner, name, MIGRATION_ROLE)
      const runtimeUrl = canonicalUrl(provisioner, name, RUNTIME_ROLE)

      admin = postgres(provisioner, { max: 1, onnotice: () => {} })
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

      const migration = postgres(migrationUrl, { max: 1, onnotice: () => {} })
      await migration.unsafe(`CREATE SCHEMA ${providerSchema} AUTHORIZATION ${MIGRATION_ROLE}`)
      await migration.unsafe(`GRANT USAGE ON SCHEMA ${providerSchema} TO ${RUNTIME_ROLE}`)
      await migration.end()

      const applied = await applyAuthSchema({
        ...authEnvironment(withProviderSchema(migrationUrl)),
        AUTH_MIGRATION_DATABASE_URL: withProviderSchema(migrationUrl),
      })
      expect(applied.applied).toBe(true)
      expect(applied.after).toEqual({ add: [], create: [] })

      const recorder = createRecordingAuthDelivery()
      const service = createBetterAuthService(
        authEnvironment(withProviderSchema(runtimeUrl)),
        recorder.delivery
      )
      const providerSql = postgres(withProviderSchema(runtimeUrl), { max: 1, onnotice: () => {} })
      try {
        receipt = await runDesktopPrincipalLifecycle({
          applicationDatabaseUrl: runtimeUrl,
          providerSchema,
          providerSql,
          recorder,
          service,
        })
      } finally {
        await providerSql.end()
        await service.close()
      }
    } catch (error) {
      failure = error
    }
  }, 600_000)

  afterAll(async () => {
    for (const close of [
      async () => {
        if (admin && handle) await cleanupScratchDatabase(admin, name)
      },
      async () => admin?.end(),
      async () => handle?.stop(),
    ]) {
      try {
        await close()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
  }, 120_000)

  test('maps a fresh provider identity to one application user and exchanges it', () => {
    throwScratchFailures(failure, failure, cleanupErrors)
    expect(receipt?.status).toBe('passed')
    expect(receipt?.provider).toBe('better-auth')
    expect(receipt?.accounts).toBe(2)
    expect(receipt?.mappedUsers).toBe(2)
    expect(receipt?.desktopSessions).toBe(1)
    expect(receipt?.exchanges).toBe(1)
    expect(receipt?.refused).toEqual({ origin: 1, pkce: 1, replay: 1 })
  })

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
