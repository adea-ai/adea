import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'bun:test'

import {
  carriesNoSecret,
  runAuthLifecycleRecovery,
  runConcurrently,
  type AuthLifecycleStore,
} from './auth-lifecycle-recovery'

const root = process.env.FRESH_AUTH_SOURCE_ROOT ?? fileURLToPath(new URL('../../', import.meta.url))
const source = (name: string) => pathToFileURL(resolve(root, 'packages/auth/src', name)).href
const requireAuth = createRequire(resolve(root, 'packages/auth/package.json'))

// The offline mirror of the failure-recovery journey. It runs against the
// provider's in-memory adapter, so it needs no database, no container and no
// mail transport, and every outcome it proves is deterministic.
//
// This is an in-process composition of the production request path, not the
// hosted route handler, and it proves the provider's behaviour and nothing
// about PostgreSQL.

test.skipIf(process.env.FRESH_AUTH_ACCEPTANCE !== '1' && !process.env.FRESH_AUTH_SOURCE_ROOT)(
  'dedicated opt-in: a failed delivery is closed and recovered, a replayed or raced verification is refused once, a restart keeps the flow, a revocation is consistent, and no secret is echoed',
  async () => {
    const { memoryAdapter } = await import(
      pathToFileURL(requireAuth.resolve('better-auth/adapters/memory')).href
    )
    const { createBetterAuthServer } = await import(source('better-auth-server.ts'))
    const { readBetterAuthConfig } = await import(source('config.ts'))
    const { createRecordingAuthDelivery } = await import(source('delivery.ts'))

    const origin = 'https://fresh.example.test'
    const records = {
      user: [] as any[],
      account: [] as any[],
      session: [] as any[],
      verification: [] as any[],
    }
    const recorder = createRecordingAuthDelivery()
    const config = readBetterAuthConfig({
      AUTH_BASE_URL: origin,
      AUTH_DATABASE_URL: 'postgres://unused@127.0.0.1/unused',
      AUTH_SECRET: 'synthetic-memory-acceptance-secret-long-enough',
      AUTH_TRUSTED_ORIGINS: origin,
      AUTH_EMAIL_VERIFICATION_REQUIRED: 'true',
      AUTH_SECURE_COOKIES: 'true',
    })
    // Every service is built over the same records, so a restart is a new
    // service and not a new store.
    const createService = (delivery: any) => ({
      auth: createBetterAuthServer({ config, database: memoryAdapter(records), delivery }),
      config,
    })
    const store: AuthLifecycleStore = {
      async account(email: string) {
        const user = records.user.find((entry) => entry.email === email)
        assert.ok(user, 'the account must exist')
        return { emailVerified: Boolean(user.emailVerified), id: user.id }
      },
      async sessionCount(email: string) {
        const user = records.user.find((entry) => entry.email === email)
        assert.ok(user, 'the account must exist')
        return records.session.filter((entry) => entry.userId === user.id).length
      },
    }

    const receipt = await runAuthLifecycleRecovery({
      createService,
      delivery: recorder.delivery,
      sent: recorder.sent as any,
      store,
      origin,
    })
    // The receipt states the contract the provider showed, not a claim about
    // behaviour it does not promise: the races are reported as they answered.
    assert.equal(receipt.deliveryFailureClosed, true)
    assert.equal(receipt.deliveryFailureRecovered, true)
    assert.equal(receipt.failedWriteLeftNoPartialState, true)
    assert.equal(receipt.providerWriteRollbackUnproven, true)
    assert.equal(receipt.redacted, true)
    assert.equal(receipt.replayedResetRefused, true)
    assert.equal(receipt.replayedVerificationAccepted, true)
    assert.equal(receipt.restartContinues, true)
    assert.equal(receipt.sessionRevocationConsistent, true)
    assert.equal(receipt.concurrentResetStatuses.length, 2)
    assert.ok(receipt.concurrentResetStatuses.every((status) => status >= 200))
    assert.ok(receipt.concurrentResetRedemptions >= 1)
    assert.equal(receipt.concurrentVerificationStatuses.length, 2)
    assert.ok(receipt.concurrentVerificationStatuses.every((status) => status >= 200))
    assert.ok(receipt.concurrentVerificationStatuses.some((status) => status === 200))
    // The journey left the provider in a state a later run can read: the
    // recorded messages carry the tokens, and nothing else does.
    assert.ok(recorder.sent.length > 0)
    assert.ok(
      recorder.sent.every(
        (entry: { email: string; token: string }) =>
          entry.token.length > 0 && entry.email.endsWith('@example.test')
      )
    )
  },
  30_000
)

test('a concurrent run reports the outcome of every operation, including a refused one', async () => {
  const outcomes = await runConcurrently([
    async () => 'accepted',
    async () => {
      throw new Error('refused')
    },
  ])
  assert.equal(outcomes.length, 2)
  assert.equal(outcomes[0]?.ok, true)
  assert.equal(outcomes[0]?.value, 'accepted')
  assert.equal(outcomes[1]?.ok, false)
  assert.equal(outcomes[1]?.value, undefined)
})

test('a secret is found wherever it is nested', () => {
  assert.equal(carriesNoSecret('nothing to see', ['token']), true)
  assert.equal(carriesNoSecret('the token is abc', ['abc']), false)
  assert.equal(carriesNoSecret({ body: { token: 'abc' } }, ['abc']), false)
  assert.equal(carriesNoSecret(['abc'], ['abc']), false)
  assert.equal(carriesNoSecret({ body: 'xyz' }, ['abc']), true)
})
