import { describe, expect, test } from 'bun:test'
import { devOperationDefinitions } from '../src/dev-runtime'

describe('chat attachment contract (#1392)', () => {
  test('registers upload/open/remove bound to a runtime session and existing authority', () => {
    const operations = devOperationDefinitions as Record<
      string,
      { capabilities: readonly string[]; resource: unknown }
    >
    for (const [name, capability] of [
      ['attachmentUpload', 'dev.session.manage'],
      ['attachmentOpen', 'dev.session.read'],
      ['attachmentRemove', 'dev.session.manage'],
    ]) {
      expect(operations[`dev.session.${name}`]).toMatchObject({
        capabilities: [capability],
        resource: { kind: 'runtime_session', idField: 'runtimeSessionId' },
      })
    }
  })
})

import {
  decodeChatAttachment,
  decodeChatAttachmentOpenResult,
  decodeChatAttachmentUpload,
  chatAttachmentLimits,
} from '../src/dev-runtime-attachments'
import { decodeRuntimeEvent, devOperationDecoders } from '../src/dev-runtime'

const input = { name: 'notes.txt', mediaType: 'text/plain', contentBase64: btoa('hello') }
const descriptor = {
  attachmentId: '00000000-0000-4000-8000-000000000010',
  runtimeSessionId: 'session-1',
  generation: 1,
  name: 'notes.txt',
  mediaType: 'text/plain',
  byteLength: 5,
  digestSha256: 'a'.repeat(64),
  state: 'available',
  createdAt: '2026-10-15T00:00:00.000Z',
}
const event = {
  schemaVersion: 1,
  eventId: 'event-1',
  runtimeSessionId: 'session-1',
  generation: 1,
  seq: '1',
  occurredAt: '2026-10-15T00:00:00.000Z',
  receivedAt: '2026-10-15T00:00:00.000Z',
  source: 'host',
  sourceEventId: 'upload-1',
  confidence: 'authoritative',
  classification: 'workspace_private',
  kind: 'attachment.added',
  payload: {
    attachment: {
      attachmentId: descriptor.attachmentId,
      mediaType: 'text/plain',
      byteLength: 5,
      state: 'available',
    },
  },
}

describe('bounded attachment DTOs', () => {
  test('validates upload metadata and canonical encoded bytes independently of the host', () => {
    expect(decodeChatAttachmentUpload(input)).toEqual(input)
    expect(
      devOperationDecoders['dev.session.attachmentUpload'].request({
        runtimeSessionId: 'session-1',
        expectedGeneration: 1,
        upload: input,
      })
    ).toMatchObject({ upload: input })
    for (const name of [
      '../notes.txt',
      'a\\b.txt',
      'notes\n.txt',
      'CON.txt',
      '.hidden.txt',
      'a..txt',
      'x'.repeat(129),
      'note.txt ',
    ])
      expect(() => decodeChatAttachmentUpload({ ...input, name })).toThrow()
    for (const contentBase64 of [
      '',
      'Zh==',
      'Zg=',
      'Zg==\n',
      btoa('x'.repeat(chatAttachmentLimits.maxBytes + 1)),
    ])
      expect(() => decodeChatAttachmentUpload({ ...input, contentBase64 })).toThrow()
    for (const mediaType of [
      'text/plain; charset=utf-8',
      'TEXT/PLAIN',
      'text/plain\r\nx:bad',
      'file:///tmp/x',
    ])
      expect(() => decodeChatAttachmentUpload({ ...input, mediaType })).toThrow()
    expect(() => decodeChatAttachmentUpload({ ...input, hostPath: '/private/secret' })).toThrow(
      'unknown key'
    )
  })

  test('references and open replies are strict and never accept paths or removed content', () => {
    expect(decodeChatAttachment(descriptor)).toEqual(descriptor)
    const opened = {
      attachment: descriptor,
      contentBase64: input.contentBase64,
      disposition: 'inert_text',
    }
    expect(decodeChatAttachmentOpenResult(opened)).toEqual(opened)
    expect(() => decodeChatAttachment({ ...descriptor, absolutePath: '/private/a' })).toThrow(
      'unknown key'
    )
    expect(() => decodeChatAttachment({ ...descriptor, attachmentId: '../a' })).toThrow('UUID')
    expect(() => decodeChatAttachment({ ...descriptor, state: 'removed' })).toThrow('removedAt')
    expect(() =>
      decodeChatAttachmentOpenResult({
        ...opened,
        attachment: { ...descriptor, state: 'removed', removedAt: descriptor.createdAt },
      })
    ).toThrow('available')
    expect(() =>
      decodeChatAttachmentOpenResult({ ...opened, contentBase64: btoa('longer') })
    ).toThrow('byte count')
    expect(() => decodeChatAttachmentOpenResult({ ...opened, disposition: 'execute' })).toThrow(
      'inert_text'
    )
  })

  test('transcript facts require authoritative host provenance and contain only bounded references', () => {
    expect(decodeRuntimeEvent(event, { source: 'host' })).toEqual(event)
    for (const source of ['acp', 'native', 'authenticated_hook'] as const)
      expect(() => decodeRuntimeEvent({ ...event, source }, { source })).toThrow('host provenance')
    expect(() =>
      decodeRuntimeEvent({ ...event, confidence: 'bounded_projection' }, { source: 'host' })
    ).toThrow('host provenance')
    expect(() =>
      decodeRuntimeEvent(
        { ...event, payload: { ...event.payload, name: 'secret.txt' } },
        { source: 'host' }
      )
    ).toThrow('unknown key')
    expect(() =>
      decodeRuntimeEvent(
        {
          ...event,
          payload: {
            attachment: { ...event.payload.attachment, contentBase64: input.contentBase64 },
          },
        },
        { source: 'host' }
      )
    ).toThrow('unknown key')
    expect(() =>
      decodeRuntimeEvent({ ...event, kind: 'attachment.removed' }, { source: 'host' })
    ).toThrow('event kind')
  })
})

test('operation success replies must agree with upload/remove state', () => {
  const reply = (
    operation: 'dev.session.attachmentUpload' | 'dev.session.attachmentRemove',
    value: unknown
  ) =>
    devOperationDecoders[operation].reply({
      schemaVersion: 1,
      operation,
      requestId: '00000000-0000-4000-8000-000000000020',
      observedAt: descriptor.createdAt,
      ok: true,
      value,
    })
  const removed = { ...descriptor, state: 'removed', removedAt: descriptor.createdAt }
  expect(reply('dev.session.attachmentUpload', descriptor).ok).toBe(true)
  expect(reply('dev.session.attachmentRemove', removed).ok).toBe(true)
  expect(() => reply('dev.session.attachmentUpload', removed)).toThrow('available')
  expect(() => reply('dev.session.attachmentRemove', descriptor)).toThrow('removed')
})
