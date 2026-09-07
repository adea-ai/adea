import { describe, expect, test } from 'bun:test'

import { createClientRequestId } from '../../src/request-id'

describe('createClientRequestId', () => {
  test('uses randomUUID when the secure-context API is available', () => {
    const id = '11111111-2222-4333-8444-555555555555' as const
    expect(createClientRequestId({ randomUUID: () => id })).toBe(id)
  })

  test('creates an RFC 4122-shaped id when randomUUID is unavailable', () => {
    const id = createClientRequestId({
      getRandomValues: (bytes) => {
        if (bytes instanceof Uint8Array) bytes.fill(7)
        return bytes
      },
    })
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
