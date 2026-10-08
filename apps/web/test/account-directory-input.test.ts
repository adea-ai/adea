import { describe, expect, test } from 'bun:test'

import {
  parseAccountDirectoryPageQuery,
  parseAccountResourceId,
} from '../src/server/account-directory-input'

function query(search: string) {
  return parseAccountDirectoryPageQuery(new URL(`https://adea.test/api${search}`).searchParams)
}

describe('account directory request boundary', () => {
  test('accepts exact bounded page queries', () => {
    expect(query('')).toEqual({})
    expect(query('?limit=50')).toEqual({ limit: 50 })
    expect(query('?limit=1&after=abc_ABC-123&includeArchived=true')).toEqual({
      after: 'abc_ABC-123',
      includeArchived: true,
      limit: 1,
    })
    expect(query('?includeArchived=false')).toEqual({ includeArchived: false })
  })

  test('rejects out-of-range limits, hostile cursors, and ambiguous markers', () => {
    expect(query('?limit=0')).toBeNull()
    expect(query('?limit=101')).toBeNull()
    expect(query('?limit=-1')).toBeNull()
    expect(query('?limit=50.5')).toBeNull()
    expect(query('?limit=')).toBeNull()
    expect(query(`?after=${'A'.repeat(1025)}`)).toBeNull()
    expect(query('?after=not%20base64url')).toBeNull()
    expect(query('?includeArchived=1')).toBeNull()
    expect(query('?workspaceId=10000000-0000-4000-8000-000000000001')).toBeNull()
    expect(query('?limit=50&extra=1')).toBeNull()
  })

  test('accepts only stable resource ids for deep-link lookups', () => {
    expect(parseAccountResourceId('10000000-0000-4000-8000-000000000001')).toBe(
      '10000000-0000-4000-8000-000000000001'
    )
    expect(parseAccountResourceId('00000000-0000-0000-0000-000000000000')).toBeNull()
    expect(parseAccountResourceId('../../etc/passwd')).toBeNull()
    expect(parseAccountResourceId(undefined)).toBeNull()
  })
})
