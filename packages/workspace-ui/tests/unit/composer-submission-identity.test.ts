import { expect, test } from 'bun:test'
import { createComposerSubmissionIdentity } from '../../src/composer-submission-identity'

test('an interrupted or repeated unchanged save retries the same canonical key', () => {
  let generated = 0
  const identity = createComposerSubmissionIdentity(() => `key-${++generated}`)
  const input = {
    channelId: 'topic',
    bodyText: 'Question',
    artifactIds: ['artifact'],
    mentions: [],
  }
  expect(identity.key(input)).toBe('key-1')
  expect(identity.key({ ...input, artifactIds: ['artifact'] })).toBe('key-1')
  expect(generated).toBe(1)
  identity.reset()
  expect(identity.key(input)).toBe('key-2')
})

test('a changed topic, body, attachment or mention is a distinct submission', () => {
  let generated = 0
  const identity = createComposerSubmissionIdentity(() => `key-${++generated}`)
  const input = {
    channelId: 'topic',
    bodyText: 'Question',
    artifactIds: ['artifact'],
    mentions: [],
  }
  expect(identity.key(input)).toBe('key-1')
  expect(identity.key({ ...input, channelId: 'other' })).toBe('key-2')
  expect(identity.key({ ...input, bodyText: 'New question' })).toBe('key-3')
  expect(identity.key({ ...input, artifactIds: [] })).toBe('key-4')
  expect(identity.key({ ...input, mentions: [{ kind: 'agent', id: 'lead' }] })).toBe('key-5')
})
