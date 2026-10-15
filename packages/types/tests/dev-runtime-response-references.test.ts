import { describe, expect, test } from 'bun:test'

import { decodeRuntimeEvent, type RuntimeEvent } from '../src/dev-runtime-wire'
import {
  CITED_RESPONSE_BYTES_MAX,
  decodeRuntimeResponseReferences,
} from '../src/dev-runtime-response-references'
import * as runtime from '../src/dev-runtime'

const text = 'A 🌍 is round. Read the evidence.'
const references = () => ({
  schemaVersion: 1,
  sources: [{ id: 'earth', title: 'Earth', url: 'https://example.com/earth', snippet: 'Round.' }],
  citations: [{ sourceId: 'earth', start: 0, end: 14 }],
})
const response = (payload: unknown = { text, references: references() }): RuntimeEvent => ({
  schemaVersion: 1,
  eventId: 'response-1',
  runtimeSessionId: 'session-1',
  harnessRunId: 'run-1',
  generation: 1,
  seq: '1',
  occurredAt: '2026-10-15T05:00:00.000Z',
  receivedAt: '2026-10-15T05:00:01.000Z',
  source: 'acp',
  sourceEventId: 'acp-response-1',
  confidence: 'authoritative',
  classification: 'workspace_private',
  kind: 'turn.assistant_message',
  payload,
})
const decode = (payload: unknown) => decodeRuntimeEvent(response(payload), { source: 'acp' })

describe('response references at the wire boundary', () => {
  test('exposes a narrow browser-safe contract through the public runtime barrel', () => {
    expect(runtime.decodeRuntimeResponseReferences).toBe(decodeRuntimeResponseReferences)
    expect(runtime.CITED_RESPONSE_BYTES_MAX).toBe(CITED_RESPONSE_BYTES_MAX)
    expect(decodeRuntimeResponseReferences(references(), text)).toEqual(references())
  })
  test('retains exact response text and self-contained source/citation bytes', () => {
    const event = response()
    expect(decodeRuntimeEvent(event, { source: 'acp' })).toEqual(event)
  })

  test('keeps old no-source payloads opaque and does not invent references', () => {
    for (const payload of [{ text: 'No sources.' }, { content: 'Older message' }, {}]) {
      expect(decode(payload).payload).toEqual(payload)
      expect(decode(payload).payload).not.toHaveProperty('references')
    }
    expect(
      decode({ text: '', references: { schemaVersion: 1, sources: [], citations: [] } })
    ).toBeDefined()
  })

  test('rejects unsupported versions, unknown reference fields and missing response text', () => {
    for (const value of [
      { ...references(), schemaVersion: 2 },
      { ...references(), html: '<a>link</a>' },
      { sources: [], citations: [] },
      null,
      [],
    ])
      expect(() => decode({ text, references: value })).toThrow()
    expect(() => decode({ references: references() })).toThrow()
    expect(() => decode({ text, references: references(), html: '<a>link</a>' })).toThrow()
  })

  test('strictly rejects malformed or extra source and citation fields', () => {
    for (const source of [
      null,
      [],
      {},
      { id: '', title: 'Title', url: 'https://example.com/' },
      { id: 'white space', title: 'Title', url: 'https://example.com/' },
      { id: 'earth', title: '   ', url: 'https://example.com/' },
      { id: 'earth', title: 'Title', url: 'https://example.com/', snippet: null },
      { id: 'earth', title: 'Title', url: 'https://example.com/', html: '<b>x</b>' },
    ])
      expect(() => decode({ text, references: { ...references(), sources: [source] } })).toThrow()
    for (const citation of [
      null,
      [],
      {},
      { sourceId: 'earth', start: 0, end: 1, title: 'extra' },
      { sourceId: 'earth', start: '0', end: 1 },
    ])
      expect(() =>
        decode({ text, references: { ...references(), citations: [citation] } })
      ).toThrow()
    for (const refs of [
      { ...references(), sources: {} },
      { ...references(), citations: null },
    ])
      expect(() => decode({ text, references: refs })).toThrow()
  })

  test('rejects duplicate source IDs and references to another response source list', () => {
    const refs = references()
    expect(() =>
      decode({ text, references: { ...refs, sources: [...refs.sources, ...refs.sources] } })
    ).toThrow()
    expect(() => decode({ text, references: { ...refs, sources: [] } })).toThrow()
    expect(() =>
      decode({
        text,
        references: { ...refs, citations: [{ sourceId: 'foreign', start: 0, end: 1 }] },
      })
    ).toThrow()
  })

  test('rejects invalid spans, including a split surrogate pair and duplicate citations', () => {
    for (const [start, end] of [
      [-1, 1],
      [0, 0],
      [2, 1],
      [0, text.length + 1],
      [0.5, 1],
      [0, 3],
      [3, 4],
    ]) {
      expect(() =>
        decode({
          text,
          references: { ...references(), citations: [{ sourceId: 'earth', start, end }] },
        })
      ).toThrow()
    }
    const refs = references()
    expect(() =>
      decode({ text, references: { ...refs, citations: [...refs.citations, ...refs.citations] } })
    ).toThrow()
  })

  test('keeps spans independent of citation order and allows shared/overlapping claims', () => {
    const refs = references()
    refs.sources.push({ id: 'other', title: 'Other', url: 'http://example.org/', snippet: '' })
    refs.citations = [
      { sourceId: 'earth', start: 15, end: text.length },
      { sourceId: 'earth', start: 0, end: 14 },
      { sourceId: 'other', start: 0, end: 14 },
    ]
    expect(decode({ text, references: refs }).payload).toEqual({ text, references: refs })
  })

  test('rejects unpaired surrogates that a UTF-8 replay would replace', () => {
    for (const invalid of ['\ud800', '\udc00', 'a\ud800b', 'a\udc00b']) {
      expect(() =>
        decode({ text: invalid, references: { schemaVersion: 1, sources: [], citations: [] } })
      ).toThrow()
      for (const field of ['title', 'snippet', 'url']) {
        const refs = references()
        const source = {
          ...refs.sources[0],
          [field]: field === 'url' ? `https://example.com/${invalid}` : invalid,
        }
        expect(() => decode({ text, references: { ...refs, sources: [source] } })).toThrow()
      }
    }
  })

  test('refuses semantic references from terminal fallback', () => {
    expect(() =>
      decodeRuntimeEvent(
        { ...response(), source: 'terminal_fallback', confidence: 'bounded_projection' },
        { source: 'terminal_fallback' }
      )
    ).toThrow()
    expect(
      decodeRuntimeEvent(
        { ...response({ text }), source: 'terminal_fallback', confidence: 'bounded_projection' },
        { source: 'terminal_fallback' }
      ).payload
    ).toEqual({ text })
  })

  test('does not reinterpret unrelated opaque payloads', () => {
    const event = { ...response({ references: { future: true } }), kind: 'tool.progress' as const }
    expect(decodeRuntimeEvent(event, { source: 'acp' })).toEqual(event)
  })
})

describe('producer URL policy', () => {
  test.each([
    'javascript:alert(1)',
    'data:text/html,hi',
    'file:///etc/passwd',
    '//example.com/path',
    '/relative',
    'https:example.com',
    'https:///example.com',
    'https://%65xample.com/',
    ' https://example.com/',
    'https://example.com/\npath',
    'https://example.com/%0apath',
    'https://example.com/\\evil',
    'https://user:password@example.com/',
    'https://@example.com/',
    'http://localhost/',
    'https://a.localhost/',
    'http://127.0.0.1/',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://169.254.169.254/',
    'https://10.0.0.1/',
    'https://intranet/',
    'https://service.internal/',
    'https://printer.local/',
    'https://example.com.:443/',
    'https://example.com:8443/',
    'https://example.com/\u0000path',
    'https://example.com/\u0085path',
    'https://example.com/\u061cpath',
    'https://example.com/\u200epath',
    'https://example.com/\u200fpath',
    'https://example.com/\u202epath',
    'https://example.com/\u2066path',
  ])('rejects unsafe address %s', (url) => {
    const refs = references()
    refs.sources[0]!.url = url
    expect(() => decode({ text, references: refs })).toThrow()
  })

  test.each([
    'https://example.com/a?b=c#claim',
    'http://example.org/path',
    'https://xn--bcher-kva.example/',
  ])('accepts an absolute public web address without rewriting it: %s', (url) => {
    const refs = references()
    refs.sources[0]!.url = url
    expect(decode({ text, references: refs }).payload).toEqual({ text, references: refs })
  })
})

describe('response bounds', () => {
  test('accepts the count boundaries and omits a snippet when no snippet was supplied', () => {
    const sources = Array.from({ length: 32 }, (_, i) => ({
      id: `s-${i}`,
      title: 'Source',
      url: 'https://example.com/',
    }))
    const citations = Array.from({ length: 128 }, (_, i) => ({
      sourceId: 's-0',
      start: i,
      end: i + 1,
    }))
    const payload = { text: 'a'.repeat(128), references: { schemaVersion: 1, sources, citations } }
    expect(decode(payload).payload).toEqual(payload)
    expect(sources[0]).not.toHaveProperty('snippet')
  })

  test('accepts exactly the aggregate byte budget and refuses one extra byte', () => {
    const refs = { schemaVersion: 1, sources: [], citations: [] }
    const overhead = new TextEncoder().encode(JSON.stringify({ text: '', references: refs })).length
    const payload = { text: 'x'.repeat(CITED_RESPONSE_BYTES_MAX - overhead), references: refs }
    expect(decode(payload).payload).toEqual(payload)
    expect(() => decode({ ...payload, text: `${payload.text}x` })).toThrow()
  })
  test('rejects excessive source/citation counts and field lengths', () => {
    const refs = references()
    for (const value of [
      {
        ...refs,
        sources: Array.from({ length: 33 }, (_, i) => ({ ...refs.sources[0], id: `s-${i}` })),
      },
      {
        ...refs,
        citations: Array.from({ length: 129 }, (_, i) => ({
          sourceId: 'earth',
          start: i,
          end: i + 1,
        })),
      },
      { ...refs, sources: [{ ...refs.sources[0], id: 'x'.repeat(129) }] },
      { ...refs, sources: [{ ...refs.sources[0], title: 'x'.repeat(513) }] },
      { ...refs, sources: [{ ...refs.sources[0], snippet: 'x'.repeat(2049) }] },
      {
        ...refs,
        sources: [{ ...refs.sources[0], url: `https://example.com/${'x'.repeat(2048)}` }],
      },
    ])
      expect(() => decode({ text, references: value })).toThrow()
  })

  test('bounds encoded cited responses, including multibyte text, below the stream frame maximum', () => {
    expect(() =>
      decode({
        text: '界'.repeat(17_000),
        references: { schemaVersion: 1, sources: [], citations: [] },
      })
    ).toThrow()
  })
})
