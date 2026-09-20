/*
 * Editor document round-trip tests (#399): per-line mixed EOL, BOM, and
 * final-newline preservation — a save reproduces the loaded bytes instead of
 * normalizing to a majority style.
 */
import { describe, expect, test } from 'bun:test'

import {
  documentFromRead,
  documentToBytes,
  editingReadiness,
  type EditorDocument,
} from '../src/editor/editor-document'

function readOf(bytes: Uint8Array, eof = true) {
  return {
    entry: {
      path: { worktreeId: 'wt', rootIdentity: { mtimeNs: '1', size: '1' }, relativePath: 'f.txt' },
      identity: { mtimeNs: '1', size: String(bytes.length) },
      kind: 'file' as const,
      size: String(bytes.length),
      observedAt: '2026-01-01T00:00:00.000Z',
    },
    offset: '0',
    bytes,
    eof,
    eol: 'mixed' as const,
    encoding: 'utf8' as const,
  }
}

const encoder = new TextEncoder()

describe('editor document', () => {
  test('round-trips pure LF files byte for byte', () => {
    const bytes = encoder.encode('a\nb\nc\n')
    const document = documentFromRead(readOf(bytes))
    expect(document.endsWithNewline).toBe(true)
    expect(documentToBytes(document, 'a\nb\nc', 'preserve')).toEqual(bytes)
  })

  test('round-trips pure CRLF files byte for byte', () => {
    const bytes = encoder.encode('a\r\nb\r\n')
    const document = documentFromRead(readOf(bytes))
    expect(document.eols.every((eol) => eol === 'crlf')).toBe(true)
    expect(documentToBytes(document, 'a\nb', 'preserve')).toEqual(bytes)
  })

  test('round-trips mixed-EOL files byte for byte (no majority normalization)', () => {
    const bytes = encoder.encode('lf\n crlf\r\nlf again\nlast no newline')
    const document = documentFromRead(readOf(bytes))
    expect(document.endsWithNewline).toBe(false)
    expect(document.eols).toEqual(['lf', 'crlf', 'lf'])
    expect(
      documentToBytes(
        document,
        'lf\n crlf\r\nlf again\nlast no newline'.replace(/\r\n/g, '\n'),
        'preserve'
      )
    ).toEqual(bytes)
  })

  test('preserves the BOM and the absence of a final newline', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode('héllo\nworld')])
    const document = documentFromRead(readOf(bytes))
    expect(document.hadBom).toBe(true)
    expect(document.endsWithNewline).toBe(false)
    expect(documentToBytes(document, 'héllo\nworld', 'preserve')).toEqual(bytes)
  })

  test('explicit policies normalize every break while keeping BOM and final newline', () => {
    const bytes = encoder.encode('a\r\nb\n')
    const document = documentFromRead(readOf(bytes))
    expect(documentToBytes(document, 'a\nb', 'lf')).toEqual(encoder.encode('a\nb\n'))
    expect(documentToBytes(document, 'a\nb', 'crlf')).toEqual(encoder.encode('a\r\nb\r\n'))
    void bytes
  })

  test('readiness refuses binary and partial reads', () => {
    expect(editingReadiness(readOf(encoder.encode('text')))).toEqual({ editable: true })
    expect(
      editingReadiness({
        ...readOf(new Uint8Array([1, 0, 2]), false),
        encoding: 'binary' as const,
      }).editable
    ).toBe(false)
    expect(editingReadiness(readOf(encoder.encode('big file'), false)).editable).toBe(false)
  })

  test('documents expose the EOL ledger for the conflict path', () => {
    const document: EditorDocument = documentFromRead(readOf(encoder.encode('x\r\n')))
    expect(document.eols).toEqual(['crlf'])
    expect(document.text).toBe('x')
  })
})
