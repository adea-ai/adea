import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { cborByteLength } from '../src/dev-runtime-cbor-length'
import {
  decodeRuntimeCallEvent,
  decodeRuntimeEnvelope,
  decodeRuntimeEvent,
  encodeCbor,
} from '../src/dev-runtime-wire'

function event(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    eventId: 'event-1',
    runtimeSessionId: 'session-1',
    harnessRunId: 'run-1',
    generation: 1,
    seq: '1',
    occurredAt: '2026-10-15T05:00:00.000Z',
    receivedAt: '2026-10-15T05:00:01.000Z',
    source: 'acp',
    sourceEventId: 'source-1',
    confidence: 'authoritative',
    classification: 'workspace_private',
    kind: 'tool.started',
    payload: {
      schemaVersion: 1,
      callId: 'call-1',
      phase: 'started',
      permissionEligibility: 'unknown',
    },
    ...overrides,
  }
}

const provenance = { source: 'acp' } as const

describe('cborByteLength', () => {
  const integers = [
    0,
    1,
    23,
    24,
    255,
    256,
    65_535,
    65_536,
    4_294_967_295,
    4_294_967_296,
    Number.MAX_SAFE_INTEGER,
    -1,
    -24,
    -25,
    -256,
    -257,
    -65_536,
    -65_537,
    -4_294_967_296,
    -4_294_967_297,
    Number.MIN_SAFE_INTEGER,
  ]
  const floats = [
    0.5,
    1.5,
    -2.25,
    65_504,
    65_505,
    0.1,
    1e-8,
    16_777_216.5,
    3.4e38,
    1e300,
    2 ** 53,
    -(2 ** 60),
  ]
  const strings = [
    '',
    'a',
    'a'.repeat(23),
    'a'.repeat(24),
    'a'.repeat(255),
    'a'.repeat(256),
    '€'.repeat(100),
    '😀'.repeat(70),
    'x'.repeat(65_535),
    'x'.repeat(65_536),
  ]

  test('matches the canonical encoder for every head width, float width and string size', () => {
    for (const value of [null, true, false, ...integers, ...floats, ...strings]) {
      expect(cborByteLength(value)).toBe(encodeCbor(value).byteLength)
    }
  })

  test('matches the canonical encoder for nested arrays, objects and key sizes', () => {
    const wide = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, i]))
    for (const value of [
      [],
      {},
      Array.from({ length: 24 }, (_, i) => i),
      Array.from({ length: 256 }, () => 'x'),
      wide,
      { b: [1, 2.5, 'é', null, { z: false }], a: { é: '😀', '': '' } },
      event(),
    ]) {
      expect(cborByteLength(value)).toBe(encodeCbor(value).byteLength)
    }
  })

  test('matches the canonical encoder on seeded random JSON values', () => {
    let seed = 0x2f6e2b1
    const next = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
      return seed / 2 ** 32
    }
    const build = (depth: number): unknown => {
      const pick = Math.floor(next() * (depth > 3 ? 6 : 8))
      if (pick === 0) return null
      if (pick === 1) return next() < 0.5
      if (pick === 2) return Math.floor((next() - 0.5) * 2 ** Math.floor(next() * 53))
      if (pick === 3) return (next() - 0.5) * 10 ** Math.floor(next() * 40 - 20)
      if (pick === 4) return 'é€😀abc'.repeat(Math.floor(next() * 12))
      if (pick === 5) return Math.fround(next() * 100)
      if (pick === 6) return Array.from({ length: Math.floor(next() * 30) }, () => build(depth + 1))
      return Object.fromEntries(
        Array.from({ length: Math.floor(next() * 30) }, (_, i) => [
          `key-${i}-${'ü'.repeat(Math.floor(next() * 4))}`,
          build(depth + 1),
        ])
      )
    }
    for (let round = 0; round < 400; round += 1) {
      const value = build(0)
      expect(cborByteLength(value)).toBe(encodeCbor(value).byteLength)
    }
  })

  test('refuses values the wire vocabulary cannot carry', () => {
    for (const value of [
      undefined,
      () => 1,
      Symbol('x'),
      Number.NaN,
      Infinity,
      new Date(),
      new Map(),
    ])
      expect(() => cborByteLength(value)).toThrow()
    expect(() => cborByteLength({ nested: undefined })).toThrow()
  })
})

describe('lean envelope decoder', () => {
  test('accepts a valid envelope without interpreting kind-specific payloads', () => {
    const malformedCall = event({ payload: { schemaVersion: 1, callId: 'call 1 with spaces' } })
    expect(() => decodeRuntimeEvent(malformedCall, provenance)).toThrow()
    expect(() => decodeRuntimeCallEvent(malformedCall, provenance)).toThrow()
    expect(decodeRuntimeEnvelope(malformedCall, provenance)).toBe(malformedCall)

    const badSummary = event({ kind: 'turn.reasoning_summary', payload: {} })
    expect(() => decodeRuntimeEvent(badSummary, provenance)).toThrow()
    expect(decodeRuntimeEnvelope(badSummary, provenance)).toBe(badSummary)

    const badReferences = event({
      kind: 'turn.assistant_message',
      source: 'native',
      payload: { text: 'hello', references: { schemaVersion: 1, sources: 'nope', citations: [] } },
    })
    expect(() => decodeRuntimeEvent(badReferences, { source: 'native' })).toThrow()
    expect(decodeRuntimeEnvelope(badReferences, { source: 'native' })).toBe(badReferences)
  })

  test('still enforces the authenticated envelope and generic payload bounds', () => {
    expect(() => decodeRuntimeEnvelope(event({ extra: 1 }), provenance)).toThrow('unknown key')
    expect(() => decodeRuntimeEnvelope(event(), { source: 'native' })).toThrow('provenance')
    expect(() => decodeRuntimeEnvelope(event({ seq: '01' }), provenance)).toThrow('uint64')
    expect(() =>
      decodeRuntimeEnvelope(
        event({ kind: 'turn.result', payload: { text: 'x'.repeat(65_537) } }),
        provenance
      )
    ).toThrow()
  })

  test('keeps the complete frame bound for versioned call claims, not for legacy payloads', () => {
    const data = { type: 'inline', value: ['x'.repeat(16_384), 'x'.repeat(16_377)] }
    const oversized = event({
      kind: 'tool.completed',
      classification: 'restricted_local',
      payload: {
        schemaVersion: 1,
        callId: 'call-1',
        phase: 'completed',
        permissionEligibility: 'unknown',
        input: data,
        output: data,
      },
    })
    expect(encodeCbor(oversized).byteLength).toBeGreaterThan(65_536)
    expect(() => decodeRuntimeEnvelope(oversized, provenance)).toThrow('CBOR')
    expect(() => decodeRuntimeEvent(oversized, provenance)).toThrow('CBOR')

    const legacy = event({ kind: 'tool.completed', payload: { text: 'x'.repeat(60_000) } })
    expect(decodeRuntimeEnvelope(legacy, provenance)).toBe(legacy)
  })

  test('the browser entry bundle excludes every kind-specific validator', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'adea-envelope-'))
    try {
      const entry = join(directory, 'entry.ts')
      writeFileSync(
        entry,
        `import { decodeCbor, decodeRuntimeEnvelope } from ${JSON.stringify(
          resolve(import.meta.dir, '../src/dev-runtime-wire.ts')
        )}\nglobalThis.lean = [decodeCbor, decodeRuntimeEnvelope]\n`
      )
      const result = await Bun.build({ entrypoints: [entry], minify: true, target: 'browser' })
      expect(result.success).toBe(true)
      const text = await result.outputs[0]!.text()
      // Interaction, attachment and any later contract validators belong behind
      // `eventSemantics` in dev-runtime-wire.ts; reaching them from the lean
      // decoder moves their bytes into the shared utility bundle.
      for (const marker of [
        'call observations require',
        'expected opaque call identifier',
        'maximum cited response',
        'duplicate source ID',
        'event.summary',
        'ill-formed Unicode',
      ])
        expect(text).not.toContain(marker)
      expect(text.length).toBeLessThan(8_500)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

const call = (payload: Record<string, unknown>, overrides: Record<string, unknown> = {}) =>
  event({
    classification: 'restricted_local',
    payload: {
      schemaVersion: 1,
      callId: 'call-1',
      phase: 'started',
      permissionEligibility: 'unknown',
      ...payload,
    },
    ...overrides,
  })
const reject = (value: unknown) =>
  expect(() => decodeRuntimeCallEvent(value, provenance)).toThrow('Unicode')

describe('call Unicode checks cover every producer-supplied string', () => {
  test('refuses lone surrogates in names, inline keys, nested values and envelope metadata', () => {
    for (const lone of [
      '\ud800',
      '\udc00',
      'a\ud800b',
      'a\udc00b',
      '\ud800\ud800',
      '\udc00\ud800',
    ]) {
      reject(call({ name: lone }))
      reject(call({ input: { type: 'inline', value: { [`k${lone}`]: 1 } } }))
      reject(call({ output: { type: 'inline', value: [['nested', { deep: lone }]] } }))
      reject(call({}, { eventId: lone }))
      reject(call({}, { harnessRunId: lone }))
    }
  })

  test('keeps valid pairs, literal replacement characters and mixed scripts intact', () => {
    const value = call({
      name: '工具😀',
      input: { type: 'inline', value: { '键😀': ['\ud83d\ude00', '\ufffd', 'é'] } },
    })
    expect(decodeRuntimeCallEvent(value, provenance)).toEqual(value)
    expect(decodeRuntimeEnvelope(value, provenance)).toBe(value)
  })
})
