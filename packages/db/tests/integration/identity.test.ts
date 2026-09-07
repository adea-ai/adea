import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { count, eq } from 'drizzle-orm'

import { createDatabase, type DatabaseConnection } from '../../src/connection'
import {
  createUserWithAuthIdentity,
  findUserPrincipalsByAuthIdentity,
  revokeAuthIdentity,
} from '../../src/identity'
import { users } from '../../src/schema'

const connectionUrl = process.env.DATABASE_URL

describe.skipIf(!connectionUrl)('identity mapping integration', () => {
  let connection: DatabaseConnection

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })

  afterAll(async () => {
    await connection.close()
  })

  test('creates one stable user, looks it up, revokes it, and rejects duplicates', async () => {
    const [{ value: initialUserCount }] = await connection.db.select({ value: count() }).from(users)
    const identity = {
      provider: 'neon',
      subject: `subject-${crypto.randomUUID()}`,
    }
    const principal = await createUserWithAuthIdentity(connection.db, {
      identity,
      profile: { displayName: 'Operator' },
    })

    expect(await findUserPrincipalsByAuthIdentity(connection.db, identity)).toEqual([principal])
    expect(
      await connection.db.select().from(users).where(eq(users.id, principal.userId))
    ).toHaveLength(1)

    await expect(
      createUserWithAuthIdentity(connection.db, {
        identity,
        profile: { displayName: 'Duplicate' },
      })
    ).rejects.toThrow()
    expect(await findUserPrincipalsByAuthIdentity(connection.db, identity)).toEqual([principal])
    const [{ value: afterDuplicateCount }] = await connection.db
      .select({ value: count() })
      .from(users)
    expect(afterDuplicateCount).toBe(initialUserCount + 1)

    expect(await revokeAuthIdentity(connection.db, identity)).toBe(true)
    expect(await findUserPrincipalsByAuthIdentity(connection.db, identity)).toEqual([])
    expect(await revokeAuthIdentity(connection.db, identity)).toBe(false)

    await connection.db.delete(users).where(eq(users.id, principal.userId))
  })

  test('allows only one winner in a concurrent provider identity race', async () => {
    const [{ value: initialUserCount }] = await connection.db.select({ value: count() }).from(users)
    const identity = {
      provider: 'neon',
      subject: `concurrent-${crypto.randomUUID()}`,
    }

    const attempts = await Promise.allSettled([
      createUserWithAuthIdentity(connection.db, { identity }),
      createUserWithAuthIdentity(connection.db, { identity }),
    ])

    expect(attempts.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected'])
    const [principal] = await findUserPrincipalsByAuthIdentity(connection.db, identity)
    expect(principal).toBeDefined()
    const [{ value: finalUserCount }] = await connection.db.select({ value: count() }).from(users)
    expect(finalUserCount).toBe(initialUserCount + 1)

    if (principal) await connection.db.delete(users).where(eq(users.id, principal.userId))
  })
})
