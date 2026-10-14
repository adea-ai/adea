import { describe, expect, test } from 'bun:test'

import { classifyTransport } from '../shell/src/dev-runtime/projects/clone-policy'

describe('classifyTransport', () => {
  test('classifies authentication refusals from git output', () => {
    expect(
      classifyTransport(
        "fatal: unable to access 'https://example.com/o/r.git/': The requested URL returned error: 403"
      )
    ).toBe('auth_required')
    expect(classifyTransport('git@example.com: Permission denied (publickey).')).toBe(
      'auth_required'
    )
    expect(classifyTransport("fatal: could not read Username for 'https://example.com'")).toBe(
      'auth_required'
    )
  })

  test('classifies a missing repository as not_found', () => {
    expect(
      classifyTransport("fatal: '/tmp/owner/missing.git' does not appear to be a git repo")
    ).toBe('not_found')
  })

  test('never classifies from the quoted remote path or URL', () => {
    // A temp directory or repository whose name happens to contain a status
    // code or an auth phrase used to turn a missing repository into auth_required.
    for (const name of ['adea-managed-clone-a403Xz', 'x/403/y', 'permission denied', '403']) {
      expect(
        classifyTransport(
          `fatal: '/tmp/${name}/owner/missing.git' does not appear to be a git repo`
        )
      ).toBe('not_found')
      expect(
        classifyTransport(`fatal: unable to access 'https://h/${name}/r.git/': timed out`)
      ).toBe('remote_unavailable')
    }
  })
})
