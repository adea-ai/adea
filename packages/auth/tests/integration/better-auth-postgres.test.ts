import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { getMigrations } from 'better-auth/db/migration'
import { Pool } from 'pg'

import {
  createBetterAuthServerAdapter,
  handleBetterAuthRequest,
} from '../../src/better-auth-server'
import { createBetterAuthService } from '../../src/server'
import { createRecordingAuthDelivery } from '../../src/delivery'

const databaseUrl = process.env.AUTH_POSTGRES_TEST_URL
const origin = 'http://127.0.0.1:8787'
const secret = 'disposable-postgres-integration-secret-long-enough'

let adminPool: Pool | undefined
let service: ReturnType<typeof createBetterAuthService> | undefined
let schema: string | undefined

function cookiesFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0]!)
    .join('; ')
}

async function cleanup() {
  await service?.close()
  service = undefined
  if (adminPool && schema) {
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  }
  await adminPool?.end()
  adminPool = undefined
}

describe.skipIf(!databaseUrl)('self-hosted Better Auth service (PostgreSQL)', () => {
  beforeAll(async () => {
    const baseUrl = new URL(databaseUrl!)
    if (!['localhost', '127.0.0.1', '::1'].includes(baseUrl.hostname)) {
      throw new Error('AUTH_POSTGRES_TEST_URL must use a loopback host and a disposable database')
    }

    schema = `auth_test_${crypto.randomUUID().replaceAll('-', '')}`
    adminPool = new Pool({ connectionString: databaseUrl })
    try {
      await adminPool.query(`CREATE SCHEMA "${schema}"`)

      const isolatedUrl = new URL(databaseUrl!)
      isolatedUrl.searchParams.set('options', `-c search_path=${schema}`)
      const recorder = createRecordingAuthDelivery()
      service = createBetterAuthService(
        {
          AUTH_BASE_URL: origin,
          AUTH_DATABASE_URL: isolatedUrl.toString(),
          AUTH_EMAIL_VERIFICATION_REQUIRED: 'false',
          AUTH_SECRET: secret,
          AUTH_SECURE_COOKIES: 'false',
          AUTH_TRUSTED_ORIGINS: origin,
        },
        recorder.delivery
      )

      const options = (service.auth as unknown as { options: Parameters<typeof getMigrations>[0] })
        .options
      const migrations = await getMigrations(options)
      expect(migrations.toBeCreated.map(({ table }) => table)).toEqual(
        expect.arrayContaining(['account', 'session', 'user', 'verification'])
      )
      await migrations.runMigrations()
    } catch (error) {
      await cleanup()
      throw error
    }
  }, 30_000)

  afterAll(cleanup)

  test('migrates an isolated schema, persists signup/session, and revokes the session', async () => {
    const email = `postgres-${crypto.randomUUID()}@example.test`
    const response = await handleBetterAuthRequest(
      service!.auth,
      'POST',
      new Request(`${origin}/api/auth/sign-up/email`, {
        body: JSON.stringify({
          email,
          name: 'Postgres Operator',
          password: 'test password long enough',
        }),
        headers: { 'content-type': 'application/json', origin },
        method: 'POST',
      }),
      service!.config
    )
    expect(response.status).toBe(200)

    const cookie = cookiesFrom(response)
    expect(cookie).not.toBe('')
    const headers = new Headers({ cookie, origin })
    const adapter = createBetterAuthServerAdapter(service!.auth, headers)
    const session = await adapter.getSession()
    expect(session?.profile.displayName).toBe('Postgres Operator')
    // Keep the unverified-email policy intact even though this disposable test
    // config disables verification to exercise the authenticated session path.
    expect(session?.profile.email).toBeUndefined()

    const persisted = await adminPool!.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM "${schema}"."session" AS s
       JOIN "${schema}"."user" AS u ON u.id = s."userId"
       WHERE u.email = $1`,
      [email]
    )
    expect(persisted.rows[0]?.count).toBe(1)

    await adapter.revokeSession(session!.session.id)
    expect(await adapter.refreshSession()).toBeNull()

    const afterRevoke = await adminPool!.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM "${schema}"."session" AS s
       JOIN "${schema}"."user" AS u ON u.id = s."userId"
       WHERE u.email = $1`,
      [email]
    )
    expect(afterRevoke.rows[0]?.count).toBe(0)
  }, 30_000)
})
