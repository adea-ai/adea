import { describe, expect, test } from 'bun:test'

import {
  CONTROL_PLANE_IDENTIFIER_PATTERN,
  isControlPlaneIdentifier,
  mintControlPlaneIdentifier,
} from '../../src/control-plane-identifiers'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function decodeTime(identifier: string): number {
  let value = 0
  for (const character of identifier.slice(4, 14)) value = value * 32 + CROCKFORD.indexOf(character)
  return value
}

describe('Control Plane identifier minting', () => {
  test('matches the Control Plane grammar for every prefix', () => {
    for (const prefix of ['wsp', 'prj', 'rnr', 'tsk', 'agt'] as const) {
      for (let index = 0; index < 200; index += 1) {
        const identifier = mintControlPlaneIdentifier(prefix)
        expect(identifier).toMatch(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`, 'u'))
        expect(CONTROL_PLANE_IDENTIFIER_PATTERN.test(identifier)).toBeTrue()
        expect(isControlPlaneIdentifier(prefix, identifier)).toBeTrue()
      }
    }
  })

  test('encodes the millisecond timestamp as a ULID prefix', () => {
    const now = Date.UTC(2026, 9, 6, 12, 0, 0, 123)
    expect(decodeTime(mintControlPlaneIdentifier('wsp', now))).toBe(now)
    expect(mintControlPlaneIdentifier('wsp', 0).slice(4, 14)).toBe('0000000000')
  })

  test('is unique across many mints in the same millisecond', () => {
    const now = Date.now()
    const values = new Set(
      Array.from({ length: 10_000 }, () => mintControlPlaneIdentifier('prj', now))
    )
    expect(values.size).toBe(10_000)
  })

  test('rejects a mismatched prefix and non-Crockford characters', () => {
    const workspace = mintControlPlaneIdentifier('wsp')
    expect(isControlPlaneIdentifier('prj', workspace)).toBeFalse()
    expect(isControlPlaneIdentifier('wsp', `${workspace.slice(0, -1)}U`)).toBeFalse()
    expect(isControlPlaneIdentifier('wsp', workspace.toLowerCase())).toBeFalse()
    expect(isControlPlaneIdentifier('wsp', undefined)).toBeFalse()
  })
})

function databaseWithRows(...results: unknown[][]) {
  const reads: { table: unknown; predicate?: unknown; limit?: number }[] = []
  const updates: { table: unknown; values?: unknown; predicate?: unknown }[] = []
  const database = {
    select: () => ({
      from: (table: unknown) => {
        const read = { table } as (typeof reads)[number]
        reads.push(read)
        return {
          where: (predicate: unknown) => {
            read.predicate = predicate
            return {
              limit: async (limit: number) => {
                read.limit = limit
                return results.shift() ?? []
              },
            }
          },
        }
      },
    }),
    update: (table: unknown) => {
      const update = { table } as (typeof updates)[number]
      updates.push(update)
      return {
        set: (values: unknown) => {
          update.values = values
          return {
            where: (predicate: unknown) => {
              update.predicate = predicate
              return { returning: async () => results.shift() ?? [] }
            },
          }
        },
      }
    },
  }
  return {
    database: database as unknown as import('../../src/connection').AgentHqDatabase,
    reads,
    updates,
  }
}

describe('Control Plane scope lookup with a recording database', () => {
  test('returns only valid mapped scopes, with deletion and project ownership predicates', async () => {
    const { controlPlaneScopeIds } = await import('../../src/control-plane-identifiers')
    const { PgDialect } = await import('drizzle-orm/pg-core')
    const workspaceId = mintControlPlaneIdentifier('wsp', 0)
    const projectId = mintControlPlaneIdentifier('prj', 0)
    const fixture = databaseWithRows(
      [{ controlPlaneWorkspaceId: workspaceId }],
      [{ controlPlaneProjectId: projectId }]
    )
    const scope = await controlPlaneScopeIds(fixture.database, {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
    })
    expect(scope).toEqual({ workspaceId, projectId })
    expect(Object.isFrozen(scope)).toBe(true)
    expect(fixture.reads.map((read) => read.limit)).toEqual([1, 1])
    const dialect = new PgDialect()
    const queries = fixture.reads.map((read) => dialect.sqlToQuery(read.predicate as never))
    expect(queries[0]?.sql).toContain('"deleted_at" is null')
    expect(queries[0]?.sql).toContain('"deletion_requested_at" is null')
    expect(queries[0]?.params).toEqual(['workspace-1'])
    expect(queries[1]?.sql).toContain('"deleted_at" is null')
    expect(queries[1]?.params).toEqual(['project-1', 'workspace-1'])
    const workspaceOnly = databaseWithRows([{ controlPlaneWorkspaceId: workspaceId }])
    expect(
      await controlPlaneScopeIds(workspaceOnly.database, { workspaceId: 'workspace-1' })
    ).toEqual({ workspaceId })
    expect(workspaceOnly.reads).toHaveLength(1)
  })

  test('missing or malformed mappings fail closed without a second scope read', async () => {
    const { controlPlaneScopeIds } = await import('../../src/control-plane-identifiers')
    for (const rows of [
      [],
      [{ controlPlaneWorkspaceId: null }],
      [{ controlPlaneWorkspaceId: mintControlPlaneIdentifier('prj') }],
    ]) {
      const fixture = databaseWithRows(rows)
      expect(
        await controlPlaneScopeIds(fixture.database, {
          workspaceId: 'workspace-1',
          projectId: 'project-1',
        })
      ).toBeNull()
      expect(fixture.reads).toHaveLength(1)
    }
    for (const rows of [
      [],
      [{ controlPlaneProjectId: null }],
      [{ controlPlaneProjectId: mintControlPlaneIdentifier('wsp') }],
    ]) {
      const fixture = databaseWithRows(
        [{ controlPlaneWorkspaceId: mintControlPlaneIdentifier('wsp') }],
        rows
      )
      expect(
        await controlPlaneScopeIds(fixture.database, {
          workspaceId: 'workspace-1',
          projectId: 'project-1',
        })
      ).toBeNull()
      expect(fixture.reads).toHaveLength(2)
    }
  })

  test('external ownership marking is conditional on a live workspace and refuses no-op writes', async () => {
    const { markWorkspaceControlPlaneUsed } = await import('../../src/control-plane-identifiers')
    const { PgDialect } = await import('drizzle-orm/pg-core')
    const fixture = databaseWithRows([{ id: 'workspace-1' }])
    await markWorkspaceControlPlaneUsed(fixture.database, 'workspace-1')
    expect(fixture.updates).toHaveLength(1)
    expect(fixture.updates[0]?.values).toEqual({ controlPlaneUsedAt: expect.any(Date) })
    const query = new PgDialect().sqlToQuery(fixture.updates[0]?.predicate as never)
    expect(query.params).toEqual(['workspace-1'])
    expect(query.sql).toContain('"deletion_requested_at" is null')
    expect(query.sql).toContain('"deleted_at" is null')
    await expect(
      markWorkspaceControlPlaneUsed(databaseWithRows([]).database, 'workspace-1')
    ).rejects.toThrow('Workspace unavailable')
  })
})
