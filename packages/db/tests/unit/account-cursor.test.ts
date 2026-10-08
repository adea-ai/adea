// Keyset-cursor contract for the account-wide directory and inbox (M11.03).
//
// Pinned at the boundary because cursors cross a trust boundary twice: the
// server mints them and any client may hand one back. A cursor that is
// tampered with, truncated, or from an older shape must fail as
// 'cursor invalid' — a 400 — and never reach a query as a half-valid sort
// key that could silently skip or repeat rows.
import { describe, expect, test } from 'bun:test'

import {
  accountDirectoryPageLimit,
  decodeAccountDirectoryCursor,
  decodeAccountInboxCursor,
  encodeAccountDirectoryCursor,
  encodeAccountInboxCursor,
  isAccountResourceId,
} from '../../src/account-cursor'

function forged(fields: Record<string, unknown>) {
  return Buffer.from(JSON.stringify({ v: 1, ...fields }), 'utf8').toString('base64url')
}

describe('account directory paging boundary', () => {
  test('clamps the page limit into the bounded range', () => {
    expect(accountDirectoryPageLimit(undefined)).toBe(50)
    expect(accountDirectoryPageLimit(1)).toBe(1)
    expect(accountDirectoryPageLimit(100)).toBe(100)
    expect(accountDirectoryPageLimit(0)).toBe(1)
    expect(accountDirectoryPageLimit(-5)).toBe(1)
    expect(accountDirectoryPageLimit(1000)).toBe(100)
    // A non-finite limit is the caller sending nothing meaningful: the default.
    expect(accountDirectoryPageLimit(Number.NaN)).toBe(50)
    expect(accountDirectoryPageLimit(Number.POSITIVE_INFINITY)).toBe(50)
    expect(accountDirectoryPageLimit(1.5)).toBe(1)
  })

  test('accepts only stable resource ids', () => {
    expect(isAccountResourceId('10000000-0000-4000-8000-000000000001')).toBe(true)
    expect(isAccountResourceId('00000000-0000-0000-0000-000000000000')).toBe(false)
    expect(isAccountResourceId('agt_not-a-uuid')).toBe(false)
    expect(isAccountResourceId(undefined)).toBe(false)
  })

  test('round-trips a directory cursor', () => {
    const cursor = {
      id: '10000000-0000-4000-8000-000000000001',
      name: 'Atlas',
      workspaceId: '20000000-0000-4000-8000-000000000002',
    }
    const encoded = encodeAccountDirectoryCursor(cursor)
    expect(encoded).not.toContain('Atlas')
    expect(decodeAccountDirectoryCursor(encoded)).toEqual(cursor)
  })

  test('round-trips an inbox cursor at full microsecond precision', () => {
    // The regression: a Date-normalized cursor truncated PostgreSQL's
    // microseconds to milliseconds, so a boundary row stored at .123456
    // produced a .123000 cursor and the tie group behind it was skipped.
    const microsecond = {
      id: '10000000-0000-4000-8000-000000000003',
      updatedAt: '2026-10-08T12:00:00.123456Z',
    }
    expect(decodeAccountInboxCursor(encodeAccountInboxCursor(microsecond))).toEqual(microsecond)
    // The exact text the query renders is carried verbatim, offset included.
    const rendered = {
      id: '10000000-0000-4000-8000-000000000004',
      updatedAt: '2026-10-08 12:00:00.123456+00',
    }
    expect(decodeAccountInboxCursor(encodeAccountInboxCursor(rendered))).toEqual(rendered)
    expect(decodeAccountInboxCursor(encodeAccountInboxCursor(microsecond)).updatedAt).toContain(
      '.123456'
    )
  })

  test('rejects timestamps the SQL cast cannot trust', () => {
    for (const updatedAt of [
      '2026-10-08T12:00:00.123456789Z', // nanoseconds do not exist in SQL
      '2026-10-08T12:00:00.123456', // no offset: a session zone would decide
      '2026-13-01T10:00:00Z', // month out of range
      '2026-10-08 25:00:00+00', // hour out of range
      '2026-10-08', // date only
    ]) {
      expect(() =>
        decodeAccountInboxCursor(forged({ id: '10000000-0000-4000-8000-000000000001', updatedAt }))
      ).toThrow('Inbox cursor invalid')
    }
  })

  test('rejects malformed cursors as invalid instead of throwing raw errors', () => {
    for (const cursor of [
      '',
      '!!!not-base64url!!!',
      Buffer.from('not json', 'utf8').toString('base64url'),
      Buffer.from('[]', 'utf8').toString('base64url'),
      Buffer.from('null', 'utf8').toString('base64url'),
      Buffer.from('{"v":2}', 'utf8').toString('base64url'),
    ]) {
      expect(() => decodeAccountDirectoryCursor(cursor)).toThrow('Directory cursor invalid')
      expect(() => decodeAccountInboxCursor(cursor)).toThrow('Inbox cursor invalid')
    }
  })

  test('rejects cursors whose sort keys are not stable identities', () => {
    expect(() =>
      decodeAccountDirectoryCursor(forged({ id: 'agt_bogus', name: 'x', workspaceId: 'w' }))
    ).toThrow('Directory cursor invalid')
    expect(() =>
      decodeAccountDirectoryCursor(
        forged({
          id: '10000000-0000-4000-8000-000000000001',
          name: '',
          workspaceId: '20000000-0000-4000-8000-000000000002',
        })
      )
    ).toThrow('Directory cursor invalid')
    expect(() =>
      decodeAccountInboxCursor(
        forged({ id: '10000000-0000-4000-8000-000000000001', updatedAt: 'yesterday' })
      )
    ).toThrow('Inbox cursor invalid')
  })
})
