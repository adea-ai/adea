import { describe, expect, test } from 'bun:test'

import {
  createTemporaryCredential,
  digestTemporaryCredential,
  readTemporaryCredential,
} from '../src/server/temporary-session'

describe('temporary workspace credentials', () => {
  test('creates opaque credentials and stores only a deterministic digest', async () => {
    const first = createTemporaryCredential()
    const second = createTemporaryCredential()
    expect(first).not.toBe(second)
    expect(first).toMatch(/^adea_tmp_[A-Za-z0-9_-]{43}$/)
    expect(await digestTemporaryCredential(first)).toHaveLength(64)
    expect(await digestTemporaryCredential(first)).toBe(await digestTemporaryCredential(first))
  })

  test('reads an exact Temporary authorization scheme before the browser cookie', () => {
    const headerCredential = `adea_tmp_${'a'.repeat(43)}`
    const request = new Request('https://hq.example/api/workspaces', {
      headers: {
        authorization: `Temporary ${headerCredential}`,
        cookie: `agent_hq_temporary_session=adea_tmp_${'b'.repeat(43)}; theme=dark`,
      },
    })
    expect(readTemporaryCredential(request)).toBe(headerCredential)
  })

  test('rejects malformed authorization credentials without falling back', () => {
    const request = new Request('https://hq.example/api/workspaces', {
      headers: {
        authorization: 'Bearer secret',
        cookie: `agent_hq_temporary_session=adea_tmp_${'b'.repeat(43)}`,
      },
    })
    expect(readTemporaryCredential(request)).toBeNull()
  })
})
