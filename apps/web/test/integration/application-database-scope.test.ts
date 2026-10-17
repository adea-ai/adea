// Proves the per-request database client contract of applicationDatabase().
// database.ts is a server-only module, so this runs in the integration lane
// with the react-server condition (no connection is opened: postgres-js
// connects lazily):
//
//   bun test --conditions=react-server apps/web/test/integration/application-database-scope.test.ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  openRequestScope,
  registerRequestCleanup,
  withRequestScope,
} from '../../src/server/request-scope'

describe('applicationDatabase', () => {
  const original = process.env.DATABASE_URL
  beforeEach(() => {
    // postgres-js connects lazily, so no server is needed to build a client.
    process.env.DATABASE_URL = 'postgresql://app:secret@127.0.0.1:1/agent_hq'
  })
  afterEach(() => {
    if (original === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = original
  })

  test('is built once per request and never shared across requests', async () => {
    const { applicationDatabase } = await import('../../src/server/database')
    const inRequest = await withRequestScope(() => {
      const first = applicationDatabase()
      const second = applicationDatabase()
      expect(second).toBe(first)
      return first
    })
    const nextRequest = await withRequestScope(() => applicationDatabase())
    expect(nextRequest).not.toBe(inRequest)
  })

  test('outside a request scope every call opens its own client', async () => {
    const { applicationDatabase } = await import('../../src/server/database')
    expect(applicationDatabase()).not.toBe(applicationDatabase())
  })

  test('two concurrent requests do not share a client', async () => {
    const { applicationDatabase } = await import('../../src/server/database')
    const [a, b] = await Promise.all([
      withRequestScope(async () => {
        const database = applicationDatabase()
        await Promise.resolve()
        expect(applicationDatabase()).toBe(database)
        return database
      }),
      withRequestScope(async () => {
        const database = applicationDatabase()
        await Promise.resolve()
        expect(applicationDatabase()).toBe(database)
        return database
      }),
    ])
    expect(a).not.toBe(b)
  })

  test('a streaming request keeps its client until the stream is released', async () => {
    const { applicationDatabase } = await import('../../src/server/database')
    const scope = openRequestScope()
    let closes = 0
    const holds: Array<() => void> = []
    let database: unknown
    await scope
      .run(async () => {
        database = applicationDatabase()
        registerRequestCleanup(() => {
          closes += 1
        })
        holds.push(scope.retain())
      })
      .finally(() => scope.end())
    expect(closes).toBe(0)
    // Later work in the same stream reuses the same client.
    await scope.run(async () => {
      expect(applicationDatabase()).toBe(database)
    })
    holds[0]!()
    await Promise.resolve()
    expect(closes).toBe(1)
  })
})
