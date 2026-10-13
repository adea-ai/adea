import { describe, expect, test } from 'bun:test'

import { ApiClientError } from '@adea-ai/api-client'

import {
  countPortableRecords,
  describePortableFile,
  exportFailure,
  formatPortableBytes,
  portableCountLabels,
  PORTABLE_MAX_BYTES,
  readPortableFile,
  rejectedFileFailure,
  restoreFailure,
} from '../../src/workspace-portable-model'

const bundle = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    content: {
      agents: [{}, {}],
      channels: [{}],
      messages: [{}, {}, {}],
      projects: [{}],
      tasks: [],
      users: [{ displayName: 'Sam Rivera', userId: 'user-1' }],
      workspace: { name: 'Design explorations' },
    },
    exportedAt: '2026-10-12T09:30:00.000Z',
    exportedBy: { role: 'owner', userId: 'user-1' },
    format: 'adea.portable-workspace-export',
    formatVersion: 1,
    ...overrides,
  })

describe('readPortableFile', () => {
  test('summarizes a version 1 export', () => {
    const text = bundle()
    const reading = readPortableFile(text, text.length)
    expect(reading).toMatchObject({
      ok: true,
      summary: {
        counts: { agents: 2, channels: 1, messages: 3, projects: 1, tasks: 0 },
        exportedBy: 'Sam Rivera',
        workspaceName: 'Design explorations',
      },
      text,
    })
  })

  test('leaves the exporter out when the file does not name them', () => {
    const text = bundle({ exportedBy: { role: 'owner', userId: 'someone-else' } })
    const reading = readPortableFile(text, text.length)
    expect(reading.ok && reading.summary.exportedBy).toBeUndefined()
  })

  test('refuses what is not a version 1 Adea export', () => {
    for (const text of [
      'not json',
      '[]',
      bundle({ format: 'something-else' }),
      bundle({ formatVersion: 2 }),
      bundle({ content: { workspace: { name: '   ' } } }),
      bundle({ content: {} }),
    ])
      expect(readPortableFile(text, text.length)).toEqual({ ok: false, reason: 'invalid' })
  })

  test('refuses a file over the size bound before parsing it', () => {
    expect(readPortableFile('{', PORTABLE_MAX_BYTES + 1)).toEqual({
      ok: false,
      reason: 'too_large',
    })
  })
})

describe('labels', () => {
  test('counts are pluralized and fixed in order', () => {
    expect(
      portableCountLabels({ agents: 1, channels: 12, messages: 1842, projects: 3, tasks: 0 })
    ).toEqual(['3 projects', '12 conversations', '1,842 messages', '0 tasks', '1 agent'])
  })

  test('byte sizes use the largest whole unit', () => {
    expect(formatPortableBytes(900)).toBe('900 B')
    expect(formatPortableBytes(1536)).toBe('1.5 KB')
    expect(formatPortableBytes(1.2 * 1024 * 1024)).toBe('1.2 MB')
  })

  test('the file line names who exported it and when, as far as the file says', () => {
    const text = bundle()
    const reading = readPortableFile(text, text.length)
    if (!reading.ok) throw new Error('expected a readable export')
    expect(describePortableFile(reading.summary, 1.2 * 1024 * 1024)).toBe(
      '1.2 MB · exported Oct 12, 2026 by Sam Rivera'
    )
    expect(describePortableFile({ ...reading.summary, exportedAt: undefined }, 2048)).toBe('2.0 KB')
  })

  test('records exclude the workspace row and the people list', () => {
    expect(countPortableRecords(bundle())).toBe(7)
    expect(countPortableRecords('nope')).toBeUndefined()
  })
})

const failure = (code?: string) => new ApiClientError('x', 400, code)

describe('failure copy', () => {
  test('export names an oversized and an unavailable workspace; the latter is final', () => {
    expect(exportFailure(failure('too_large'))).toMatchObject({ tone: 'warning' })
    expect(exportFailure(failure('workspace_unavailable'))).toMatchObject({
      final: true,
      tone: 'destructive',
    })
    expect(exportFailure(failure()).message).toBe('The export could not be prepared. Try again.')
    expect(exportFailure(new Error('network')).message).toBe(
      'The export could not be prepared. Try again.'
    )
  })

  test('restore gives each server refusal its own message', () => {
    const codes = [
      'invalid_document',
      'digest_mismatch',
      'unresolved_users',
      'target_exists',
      'too_large',
      'importer_unavailable',
      'verification_failed',
    ]
    const messages = codes.map((code) => restoreFailure(failure(code)).message)
    expect(new Set(messages).size).toBe(codes.length)
    expect(restoreFailure(failure('target_exists')).tone).toBe('warning')
    expect(restoreFailure(failure('workspace_unavailable')).message).toBe(
      restoreFailure(failure('importer_unavailable')).message
    )
    expect(restoreFailure(failure()).message).toBe(
      'The workspace could not be restored. Try again.'
    )
  })

  test('a file refused before upload reads like the server refusal', () => {
    expect(rejectedFileFailure('invalid')).toEqual(restoreFailure(failure('invalid_document')))
    expect(rejectedFileFailure('too_large')).toEqual(restoreFailure(failure('too_large')))
  })
})
