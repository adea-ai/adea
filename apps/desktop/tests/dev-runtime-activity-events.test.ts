import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { decodeDevStreamGrant } from '../../../packages/types/src/dev-runtime'
import { createChannelAuthority } from '../shell/src/dev-runtime/channel/authority'
import { encodeStreamFrame, parseStreamFrame } from '../shell/src/dev-runtime/channel/wire'

import { runtimeActivityEventKinds } from '../../../packages/types/src/dev-runtime-activity'
import {
  decodeRuntimeEvent,
  decodeCbor,
  encodeCbor,
  type RuntimeEventProvenance,
} from '../../../packages/types/src/dev-runtime-wire'
import {
  createSessionEventLog,
  type SessionEventInput,
} from '../shell/src/dev-runtime/harness/events'

const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})
const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const proof = { source: 'native', ownedActivityKinds: runtimeActivityEventKinds } as const
function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-activity-contract-'))
  directories.push(dataDir)
  const create = () => createSessionEventLog({ dataDir, scope, maxPerSession: 20 })
  return { log: create(), create, dataDir }
}
function input(overrides: Partial<SessionEventInput> = {}): SessionEventInput {
  return {
    runtimeSessionId: 'session-1',
    generation: 1,
    harnessRunId: 'run-1',
    source: 'native',
    confidence: 'authoritative',
    classification: 'workspace_private',
    sourceEventId: 'source-1',
    kind: 'test_run.observed',
    payload: { schemaVersion: 1, testRunId: 'tests-1', status: 'unknown' },
    ...overrides,
  }
}
function output(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    terminalId: 'term-1',
    commandId: 'command-1',
    sequence: '1',
    phase: 'output',
    status: 'running',
    stream: 'stdout',
    text: 'first',
    ...overrides,
  }
}
type Log = ReturnType<typeof createSessionEventLog>
// The second argument is the trusted adapter seam added by this contract.
const append = (log: Log, value: SessionEventInput, provenance?: RuntimeEventProvenance) =>
  log.append(value, provenance)

describe('structured activity admission', () => {
  test('semantic terminal retries validate Unicode and ownership without allocating another full frame', () => {
    const { log } = setup()
    let seed
    for (let index = 1; index <= 8; index += 1)
      seed = append(
        log,
        input({
          kind: 'terminal.output',
          sourceEventId: `source-${index}`,
          payload: output({ commandId: `seed-${index}` }),
        }),
        proof
      )
    if (!seed) throw new Error('expected a seed event')
    const payload = output({ text: '界'.repeat(16_384), command: 'é'.repeat(8192) }) as ReturnType<
      typeof output
    > & { command: string; text: string }
    const probe = { ...seed, seq: '9', sourceEventId: 'source-9', payload }
    const excess = encodeCbor(probe).byteLength - 65_536
    payload.command = payload.command.slice(0, -Math.floor(excess / 2))
    if (excess % 2) payload.command = `${payload.command.slice(0, -1)}x`
    expect(encodeCbor(probe).byteLength).toBe(65_536)
    const value = input({ kind: 'terminal.output', sourceEventId: 'source-9', payload })
    expect(append(log, value, proof)?.seq).toBe('9')
    const retained = log.events()
    expect(append(log, value, proof)).toBeUndefined()
    expect(
      append(log, { ...value, sourceEventId: 'longer-replay-identity' }, proof)
    ).toBeUndefined()
    expect(() => append(log, { ...value, sourceEventId: '\ud800' }, proof)).toThrow('Unicode')
    expect(() => append(log, value, { source: 'native', ownedActivityKinds: [] })).toThrow(
      'ownership'
    )
    expect(() =>
      append(
        log,
        { ...value, sourceEventId: 'source-X', payload: { ...payload, sequence: '2' } },
        proof
      )
    ).toThrow('CBOR')
    expect(log.events()).toEqual(retained)
    expect(log.latestSequence('session-1')).toBe('9')
  })

  test('an exact 8 KiB hook event retries but a new sequence-10 hook event still exceeds the limit', () => {
    const { log } = setup()
    const hookProof = { ...proof, source: 'authenticated_hook' } as const
    let seed
    for (let index = 1; index <= 8; index += 1)
      seed = append(
        log,
        input({ source: hookProof.source, sourceEventId: `source-${index}` }),
        hookProof
      )
    if (!seed) throw new Error('expected a seed event')
    const payload = {
      schemaVersion: 1,
      testRunId: 't',
      status: 'unknown',
      failures: [{ failureId: 'f', message: 'x' }],
    }
    const probe = { ...seed, seq: '9', sourceEventId: 'source-9', payload }
    payload.failures[0]!.message += 'x'.repeat(
      8192 - new TextEncoder().encode(JSON.stringify(probe)).byteLength
    )
    expect(new TextEncoder().encode(JSON.stringify(probe)).byteLength).toBe(8192)
    const value = input({ source: hookProof.source, sourceEventId: 'source-9', payload })
    expect(append(log, value, hookProof)?.seq).toBe('9')
    const retained = log.events()
    expect(append(log, value, hookProof)).toBeUndefined()
    expect(() => append(log, { ...value, sourceEventId: 'source-X' }, hookProof)).toThrow('8 KiB')
    expect(log.events()).toEqual(retained)
  })
  test('ill-formed terminal text never enters or silently deduplicates in the log', () => {
    const { log } = setup()
    for (const text of ['\ud800', '\ud801']) {
      expect(() =>
        append(log, input({ kind: 'terminal.output', payload: output({ text }) }), proof)
      ).toThrow('Unicode')
    }
    expect(log.events()).toEqual([])
  })

  test('an exact-boundary event at sequence 9 retries without a provisional sequence-10 budget', () => {
    const { log } = setup()
    let seed
    for (let index = 1; index <= 8; index += 1)
      seed = append(log, input({ sourceEventId: `source-${index}` }), proof)
    if (!seed) throw new Error('expected a seed event')
    const payload = {
      schemaVersion: 1,
      testRunId: 't',
      status: 'unknown',
      failures: Array.from({ length: 8 }, (_, index) => ({
        failureId: `f-${index}`,
        message: index < 7 ? 'x'.repeat(8192) : 'x',
      })),
    }
    const last = payload.failures[7]!
    last.message += 'x'.repeat(
      64 * 1024 - new TextEncoder().encode(JSON.stringify(payload)).byteLength
    )
    const probe = { ...seed, seq: '9', sourceEventId: 'source-9', payload }
    last.message = last.message.slice(0, -(encodeCbor(probe).byteLength - 65_536))
    expect(encodeCbor(probe).byteLength).toBe(65_536)
    const value = input({ sourceEventId: 'source-9', payload })
    const accepted = append(log, value, proof)
    expect(accepted?.seq).toBe('9')
    const retained = log.events()
    expect(append(log, value, proof)).toBeUndefined()
    expect(() => append(log, input({ sourceEventId: 'source-X', payload }), proof)).toThrow('CBOR')
    expect(() => append(log, value, { source: 'native', ownedActivityKinds: [] })).toThrow(
      'ownership'
    )
    payload.failures[0]!.message = `y${payload.failures[0]!.message.slice(1)}`
    let refusal: unknown
    try {
      append(log, value, proof)
    } catch (error) {
      refusal = error
    }
    expect(refusal).toMatchObject({ code: 'idempotency_conflict' })
    expect(log.events()).toEqual(retained)
    expect(log.latestSequence('session-1')).toBe('9')
  })
  test('the full CBOR envelope fits an actual stream grant at the exact limit, including UTF-8 expansion', () => {
    const authority = createChannelAuthority({
      shellHost: '127.0.0.1',
      shellOrigin: 'http://127.0.0.1:4789',
    })
    const handshake = authority.handshake(
      {
        schemaVersion: 1,
        method: 'dev.runtime.handshake.v1',
        requestId: randomUUID(),
        bootstrap: authority.issueLaunchBootstrap(),
        supportedProtocolVersions: ['1'],
        nonce: Buffer.from(randomUUID()).toString('base64url'),
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      },
      { trusted: true }
    )
    if (!handshake.ok) throw new Error('fixture handshake failed')
    const grant = authority.mintStreamGrant({
      identity: {
        channelId: handshake.channelId,
        clientCredentialId: handshake.clientCredentialId,
      },
      protocol: 'runtime-events-v1',
      direction: 'read',
      scope,
      resource: { kind: 'runtime_session', id: 'session-1', generation: 1 },
    })
    expect(grant.maxFrameBytes).toBe(65_536)
    expect(decodeDevStreamGrant(grant)).toEqual(grant)
    const { log } = setup()
    const seed = append(log, input(), proof)
    if (!seed) throw new Error('expected seed event')
    const payload = {
      schemaVersion: 1,
      testRunId: 't',
      status: 'unknown',
      failures: Array.from({ length: 8 }, (_, index) => ({
        failureId: `f-${index}`,
        message: index < 7 ? 'x'.repeat(8192) : 'x',
      })),
    }
    const last = payload.failures[7]!
    last.message += 'x'.repeat(
      64 * 1024 - new TextEncoder().encode(JSON.stringify(payload)).byteLength
    )
    const oversizedBytes = encodeCbor({ ...seed, payload }).byteLength
    expect(oversizedBytes).toBeGreaterThan(grant.maxFrameBytes)
    expect(() => append(log, input({ sourceEventId: 'source-2', payload }), proof)).toThrow('CBOR')
    expect(log.events()).toEqual([seed])
    last.message = last.message.slice(0, -(oversizedBytes - grant.maxFrameBytes))
    expect(encodeCbor({ ...seed, payload }).byteLength).toBe(grant.maxFrameBytes)
    const accepted = append(log, input({ sourceEventId: 'source-2', payload }), proof)
    if (!accepted) throw new Error('expected exact-boundary event')
    const bytes = encodeCbor(accepted)
    expect(bytes.byteLength).toBe(grant.maxFrameBytes)
    const frame = parseStreamFrame(
      encodeStreamFrame({ type: 'data', sequence: accepted.seq, bytes })
    )
    if (frame.type !== 'data') throw new Error('expected a data frame')
    expect(frame.bytes.byteLength).toBeLessThanOrEqual(grant.maxFrameBytes)
    expect(decodeCbor(frame.bytes).value).toEqual(accepted)
    last.message += 'x'
    expect(encodeCbor({ ...seed, payload }).byteLength).toBe(grant.maxFrameBytes + 1)
    expect(() => append(log, input({ sourceEventId: 'source-3', payload }), proof)).toThrow('CBOR')
    last.message = `${last.message.slice(0, -2)}é`
    expect(encodeCbor({ ...seed, payload }).byteLength).toBe(grant.maxFrameBytes + 1)
    expect(() => append(log, input({ sourceEventId: 'source-3', payload }), proof)).toThrow('CBOR')
    expect(log.events()).toHaveLength(2)
    expect(log.latestSequence('session-1')).toBe('2')
  })
  test('requires out-of-band ownership and refuses invalid facts before writes, sequencing or publish', () => {
    const { log, create } = setup()
    let delivered = 0
    log.subscribe('session-1', () => (delivered += 1))
    for (const key of ['source', 'confidence', 'classification'] as const) {
      expect(() => append(log, input({ [key]: undefined }), proof)).toThrow(key)
    }
    expect(() => append(log, input())).toThrow('ownership')
    expect(() =>
      append(log, input(), { source: 'native', ownedActivityKinds: ['task.observed'] })
    ).toThrow('ownership')
    expect(() => append(log, input(), { ...proof, source: 'acp' })).toThrow('provenance')
    expect(() => append(log, input({ payload: { text: 'opaque' } }), proof)).toThrow(
      'schemaVersion'
    )
    expect(() =>
      append(
        log,
        input({
          payload: { schemaVersion: 1, testRunId: 't', status: 'passed', summary: { passed: -1 } },
        }),
        proof
      )
    ).toThrow()
    expect(() => append(log, input({ confidence: 'untrusted_hint' }), proof)).toThrow('confidence')
    expect(log.events()).toEqual([])
    expect(create().events()).toEqual([])
    expect(log.latestSequence('session-1')).toBe('0')
    expect(delivered).toBe(0)
    expect(append(log, input(), proof)?.seq).toBe('1')
  })

  test('preserves counts and explicit unknown status through persistence and restart', () => {
    const { log, create } = setup()
    const payload = {
      schemaVersion: 1,
      testRunId: 't',
      status: 'unknown',
      summary: { total: 100, passed: 40 },
      tests: [{ testId: 't1', name: 'Only retained test', status: 'passed' }],
    }
    const accepted = append(log, input({ payload }), proof)
    payload.status = 'failed'
    payload.summary.passed = 1
    expect(accepted?.payload).toMatchObject({
      status: 'unknown',
      summary: { total: 100, passed: 40 },
    })
    expect(create().read('session-1')).toEqual([accepted])
    expect(() => Object.assign(accepted?.payload as object, { status: 'passed' })).toThrow()
  })

  test('terminal chunk identity is fenced by source, session, generation, run, command and stream', () => {
    const { log } = setup()
    const first = append(log, input({ kind: 'terminal.output', payload: output() }), proof)
    expect(
      append(
        log,
        input({ kind: 'terminal.output', sourceEventId: 'replay', payload: output() }),
        proof
      )
    ).toBeUndefined()
    expect(() =>
      append(
        log,
        input({
          kind: 'terminal.output',
          sourceEventId: 'changed',
          payload: output({ text: 'different' }),
        }),
        proof
      )
    ).toThrow()
    for (const namespace of [
      { runtimeSessionId: 'session-2' },
      { generation: 2 },
      { harnessRunId: 'run-2' },
      { source: 'acp' as const },
    ])
      expect(
        append(
          log,
          input({
            ...namespace,
            kind: 'terminal.output',
            sourceEventId: 'other',
            payload: output(),
          }),
          { ...proof, source: namespace.source ?? 'native' }
        )
      ).toBeDefined()
    expect(
      append(
        log,
        input({
          kind: 'terminal.output',
          sourceEventId: 'stderr',
          payload: output({ stream: 'stderr' }),
        }),
        proof
      )
    ).toBeDefined()
    expect(
      append(
        log,
        input({
          kind: 'terminal.output',
          sourceEventId: 'command-2',
          payload: output({ commandId: 'command-2' }),
        }),
        proof
      )
    ).toBeDefined()
    expect(log.read('session-1')[0]).toEqual(first)
  })

  test('source-event dedupe refuses identity/provenance changes and ignores object key ordering', () => {
    const { log } = setup()
    const first = append(log, input({ occurredAt: '2026-10-15T05:00:00.000Z' }), proof)
    expect(
      append(
        log,
        input({ payload: { status: 'unknown', testRunId: 'tests-1', schemaVersion: 1 } }),
        proof
      )
    ).toBeUndefined()
    for (const changed of [
      { harnessRunId: 'run-2' },
      { classification: 'credential' as const },
      { occurredAt: '2026-10-15T05:00:01.000Z' },
    ]) {
      let refusal: unknown
      try {
        append(log, input(changed), proof)
      } catch (error) {
        refusal = error
      }
      expect(refusal).toMatchObject({ code: 'idempotency_conflict' })
    }
    expect(log.events()).toEqual([first])
  })

  test('legacy retained activity payloads stay readable and are not silently upgraded', () => {
    const { log, create, dataDir } = setup()
    const reference = append(log, input(), proof)
    const legacy = { ...reference, payload: { text: 'legacy' }, scope }
    const file = join(dataDir, 'dev-runtime', 'harness', 'session-events.json')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 1, savedAt: new Date().toISOString(), records: [legacy] })
    )
    const retained = create().events()[0]
    expect(retained?.payload).toEqual({ text: 'legacy' })
    expect(decodeRuntimeEvent(retained, { source: 'native' }).payload).toEqual({ text: 'legacy' })
    expect(() =>
      append(create(), input({ sourceEventId: 'new', payload: { text: 'legacy' } }), proof)
    ).toThrow('schemaVersion')
  })
})
