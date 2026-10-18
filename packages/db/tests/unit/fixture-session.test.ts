import { describe, expect, test } from 'bun:test'

import { directFixtureUrl, withFixtureSession, type FixtureSql } from '../fixtures/fixture-session'

// These hold the session-local fixture contract without a database: the fixture
// must pin one backend for the whole body, always close the client, and never
// let a close failure replace the body's own failure.

// A scripted stand-in for postgres(): each query returns the next pid in `pids`
// (the last one repeats), so a backend move can be simulated without a server.
function scriptedSql(pids: number[], onEnd: () => void = () => {}) {
  let index = 0
  const sql = (async () => [
    { pid: pids[Math.min(index++, pids.length - 1)] },
  ]) as unknown as FixtureSql
  ;(sql as unknown as { end: () => Promise<void> }).end = async () => {
    onEnd()
  }
  return sql
}

describe('directFixtureUrl', () => {
  test('requires DATABASE_URL_UNPOOLED', () => {
    expect(() => directFixtureUrl({})).toThrow('DATABASE_URL_UNPOOLED is required')
  })

  test('returns the direct endpoint it was given', () => {
    expect(directFixtureUrl({ DATABASE_URL_UNPOOLED: 'postgresql://direct' })).toBe(
      'postgresql://direct'
    )
  })
})

describe('withFixtureSession', () => {
  const url = 'postgresql://app:secret@127.0.0.1:55432/agent_hq?sslmode=disable'

  test('returns the body result and always closes the client', async () => {
    let closed = false
    const result = await withFixtureSession(
      url,
      async () => 'value',
      () =>
        scriptedSql([1, 1], () => {
          closed = true
        })
    )
    expect(result).toBe('value')
    expect(closed).toBe(true)
  })

  test('opens the client against the URL it was given', async () => {
    let seen: string | undefined
    await withFixtureSession(
      url,
      async () => undefined,
      (target) => {
        seen = target
        return scriptedSql([1, 1])
      }
    )
    expect(seen).toBe(url)
  })

  test('rethrows a body failure and still closes the client', async () => {
    let closed = false
    await expect(
      withFixtureSession(
        url,
        async () => {
          throw new Error('body failed')
        },
        () =>
          scriptedSql([1, 1], () => {
            closed = true
          })
      )
    ).rejects.toThrow('body failed')
    expect(closed).toBe(true)
  })

  test('surfaces a close failure when the body succeeded', async () => {
    await expect(
      withFixtureSession(
        url,
        async () => 'ok',
        () =>
          scriptedSql([1, 1], () => {
            throw new Error('close failed')
          })
      )
    ).rejects.toThrow('close failed')
  })

  test('keeps the body failure when closing also fails', async () => {
    await expect(
      withFixtureSession(
        url,
        async () => {
          throw new Error('body failed')
        },
        () =>
          scriptedSql([1, 1], () => {
            throw new Error('close failed')
          })
      )
    ).rejects.toThrow('body failed')
  })

  test('fails closed when the backend moves, and still closes the client', async () => {
    let closed = false
    await expect(
      withFixtureSession(
        url,
        async () => 'unreachable',
        () =>
          scriptedSql([5, 6], () => {
            closed = true
          })
      )
    ).rejects.toThrow('fixture session moved from backend 5 to 6')
    expect(closed).toBe(true)
  })
})
