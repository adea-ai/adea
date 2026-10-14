import { describe, expect, test } from 'bun:test'

import { ApiClientError } from '@adea-ai/api-client'

import {
  restoreConsequences,
  restoreFailureMessage,
} from '../../src/workspace-archived-projects-model'

describe('restoreConsequences', () => {
  test('says what comes back, that visibility is unchanged, and that a Dev binding is not recreated', () => {
    const text = restoreConsequences().join(' ')
    expect(text).toContain('with its conversations')
    expect(text).toContain('Who can see it does not change.')
    expect(text).toContain('local repository binding was removed')
  })
})

describe('restoreFailureMessage', () => {
  test('a stale revision asks the owner to review the refreshed row, never to force', () => {
    expect(
      restoreFailureMessage(new ApiClientError('Conflict', 409, 'project_conflict'))
    ).toContain('changed since it was listed')
  })

  test('an unavailable project and an expired session are named', () => {
    expect(restoreFailureMessage(new ApiClientError('Gone', 404))).toContain('unavailable')
    expect(restoreFailureMessage(new ApiClientError('No', 403))).toContain('unavailable')
    expect(restoreFailureMessage(new ApiClientError('Auth', 401))).toContain('Sign in')
  })

  test('anything else is a plain retry', () => {
    expect(restoreFailureMessage(new ApiClientError('Boom', 500))).toBe(
      'The project could not be restored. Try again.'
    )
    expect(restoreFailureMessage(new Error('network'))).toBe(
      'The project could not be restored. Try again.'
    )
  })
})
