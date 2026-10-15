import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeCbor } from '../../../packages/types/src/dev-runtime-wire'

import {
  createSessionEventLog,
  type SessionEventInput,
} from '../shell/src/dev-runtime/harness/events'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const scope = { accountId: 'a', workspaceId: 'w', runtimeNodeId: 'n' }
function setup(
  options: Omit<Parameters<typeof createSessionEventLog>[0], 'dataDir' | 'scope'> = {}
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-call-contract-'))
  directories.push(dataDir)
  const create = () => createSessionEventLog({ dataDir, scope, ...options })
  return { log: create(), create }
}
function observation(overrides: Partial<SessionEventInput> = {}): SessionEventInput {
  return {
    runtimeSessionId: 'session-1',
    harnessRunId: 'run-1',
    generation: 1,
    source: 'acp',
    confidence: 'authoritative',
    classification: 'workspace_private',
    kind: 'tool.started',
    sourceEventId: 'source-1',
    payload: {
      schemaVersion: 1,
      callId: 'call-1',
      phase: 'started',
      permissionEligibility: 'unknown',
    },
    ...overrides,
  }
}
const callPayload = (overrides: Record<string, unknown> = {}) => ({
  ...(observation().payload as object),
  ...overrides,
})

describe('call admission into the canonical event log', () => {
  test('retry exemptions require the exact source tuple rather than a delimiter collision', () => {
    const { log } = setup()
    const first = log.append(
      observation({ runtimeSessionId: 's', sourceEventId: 'x\u00002\u0000native\u0000y' })
    )
    const second = log.append(
      observation({
        runtimeSessionId: 's\u00001\u0000acp\u0000x',
        generation: 2,
        source: 'native',
        sourceEventId: 'y',
      })
    )
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(log.events()).toHaveLength(2)
  })
  test('an exactly fitting call at sequence 9 retries without consuming sequence 10 or bypassing eligibility', () => {
    for (const permissionEligibility of ['unknown', 'not_required']) {
      let eligible = true
      const { log } = setup({ verifyCallPermissionEligibility: () => eligible })
      let seed
      for (let index = 1; index <= 8; index += 1)
        seed = log.append(observation({ sourceEventId: `source-${index}` }))
      if (!seed) throw new Error('expected a seed event')
      const data = () => ({ type: 'inline', value: ['x'.repeat(16_384), 'x'.repeat(16_377)] })
      const payload = {
        schemaVersion: 1,
        callId: 'call-1',
        phase: 'completed',
        permissionEligibility,
        input: data(),
        output: data(),
      }
      const probe = {
        ...seed,
        kind: 'tool.completed',
        seq: '9',
        sourceEventId: 'source-9',
        payload,
      }
      payload.output.value[1] = payload.output.value[1]!.slice(
        0,
        -(encodeCbor(probe).byteLength - 65_536)
      )
      expect(encodeCbor(probe).byteLength).toBe(65_536)
      const value = observation({ kind: 'tool.completed', sourceEventId: 'source-9', payload })
      const accepted = log.append(value)
      expect(accepted?.seq).toBe('9')
      const retained = log.events()
      expect(log.append(value)).toBeUndefined()
      if (permissionEligibility === 'not_required') {
        eligible = false
        expect(() => log.append(value)).toThrow('permissionEligibility')
        eligible = true
      }
      expect(() => log.append({ ...value, sourceEventId: 'source-X' })).toThrow('CBOR')
      payload.output.value[0] = `y${payload.output.value[0]!.slice(1)}`
      let refusal: unknown
      try {
        log.append(value)
      } catch (error) {
        refusal = error
      }
      expect(refusal).toMatchObject({ code: 'idempotency_conflict' })
      expect(log.events()).toEqual(retained)
      expect(log.latestSequence('session-1')).toBe('9')
    }
  })
  test('refuses opaque and invalid calls before persistence, sequence or subscriber effects', () => {
    const { log, create } = setup()
    let delivered = 0
    log.subscribe('session-1', () => (delivered += 1))
    for (const invalid of [
      { name: 'read_file' },
      callPayload({ callId: '' }),
      callPayload({ phase: 'completed' }),
      callPayload({ parentCallId: 'call-1' }),
      callPayload({ input: { type: 'inline', value: 'x'.repeat(16_385) } }),
    ])
      expect(() => log.append(observation({ payload: invalid }))).toThrow()
    expect(log.events()).toEqual([])
    expect(log.latestSequence('session-1')).toBe('0')
    expect(create().events()).toEqual([])
    expect(delivered).toBe(0)
    expect(log.append(observation())?.seq).toBe('1')
  })

  test('persists identity, parent, phase, input/output and duration exactly across restart', () => {
    const { log, create } = setup()
    const first = log.append(
      observation({
        payload: callPayload({
          parentCallId: 'parent-1',
          input: { type: 'inline', value: { q: 'hello' } },
        }),
      })
    )
    const second = log.append(
      observation({
        sourceEventId: 'source-2',
        kind: 'tool.completed',
        payload: callPayload({
          phase: 'completed',
          parentCallId: 'parent-1',
          durationMs: 25,
          output: { type: 'reference', referenceId: 'output-1' },
        }),
      })
    )
    expect(create().read('session-1')).toEqual([first, second])
    expect(
      log.append(
        observation({
          payload: callPayload({
            parentCallId: 'parent-1',
            input: { type: 'inline', value: { q: 'hello' } },
          }),
        })
      )
    ).toBeUndefined()
    expect(() => log.append(observation({ payload: callPayload({ name: 'changed' }) }))).toThrow()
  })

  test('requires adapter evidence for known permission eligibility; source/capabilities alone do not qualify', () => {
    const { log } = setup()
    for (const permissionEligibility of ['not_required', 'requires_approval']) {
      expect(() =>
        log.append(observation({ payload: callPayload({ permissionEligibility }) }))
      ).toThrow('permissionEligibility')
    }
    expect(log.events()).toEqual([])
    const seen: unknown[] = []
    const verified = setup({
      verifyCallPermissionEligibility: (event: unknown) => {
        seen.push(event)
        return true
      },
    })
    const accepted = verified.log.append(
      observation({ payload: callPayload({ permissionEligibility: 'not_required' }) })
    )
    expect(seen).toEqual([accepted])
    expect(verified.create().events()).toEqual([accepted])
    const refused = setup({ verifyCallPermissionEligibility: () => false })
    expect(() =>
      refused.log.append(
        observation({ payload: callPayload({ permissionEligibility: 'not_required' }) })
      )
    ).toThrow('permissionEligibility')
  })

  test('isolates the verified snapshot from caller, verifier and subscriber mutation', () => {
    const submitted = callPayload({
      permissionEligibility: 'not_required',
      input: { type: 'inline', value: { q: 'original' } },
    })
    const { log, create } = setup({
      verifyCallPermissionEligibility: (event) => {
        expect(() => Object.assign(event.payload, { callId: 'forged' })).toThrow()
        return true
      },
    })
    log.subscribe('session-1', (event) => {
      expect(() => Object.assign(event.payload as object, { phase: 'failed' })).toThrow()
    })
    const accepted = log.append(observation({ payload: submitted }))
    submitted.callId = 'changed-after-append'
    expect(accepted).toMatchObject({ payload: { callId: 'call-1' } })
    expect(create().events()).toEqual([accepted])
  })

  test('keeps a call namespace bound to session, generation, run and source', () => {
    const { log } = setup()
    log.append(observation({ payload: callPayload({ parentCallId: 'parent-1' }) }))
    const changed = {
      sourceEventId: 'different-source-event',
      payload: callPayload({ parentCallId: 'parent-2' }),
    }
    expect(() => log.append(observation(changed))).toThrow('parentCallId')
    for (const namespace of [
      { runtimeSessionId: 'session-2' },
      { generation: 2 },
      { harnessRunId: 'run-2' },
      { source: 'native' as const },
    ])
      expect(log.append(observation({ ...changed, ...namespace }))).toBeDefined()
    expect(log.events()).toHaveLength(5)
  })

  test('a repeated source event cannot silently change the call run or provenance facts', () => {
    const { log } = setup()
    const first = log.append(observation({ occurredAt: '2026-10-15T05:00:00.000Z' }))
    for (const changed of [
      { harnessRunId: 'run-2' },
      { confidence: 'untrusted_hint' as const },
      { classification: 'credential' as const },
      { occurredAt: '2026-10-15T05:00:01.000Z' },
    ]) {
      let refusal: unknown
      try {
        log.append(observation(changed))
      } catch (error) {
        refusal = error
      }
      expect(refusal).toMatchObject({ code: 'idempotency_conflict' })
    }
    expect(log.events()).toEqual([first])
    expect(log.append(observation({ occurredAt: '2026-10-15T05:00:00.000Z' }))).toBeUndefined()
  })

  test('rejects retained parent cycles and reuse across tool/subagent families without inventing missing history', () => {
    const { log } = setup()
    log.append(observation({ payload: callPayload({ parentCallId: 'parent-1' }) }))
    expect(() =>
      log.append(
        observation({
          sourceEventId: 'source-2',
          payload: callPayload({ callId: 'parent-1', parentCallId: 'call-1' }),
        })
      )
    ).toThrow('cycle')
    expect(() =>
      log.append(observation({ sourceEventId: 'source-2', kind: 'subagent.observed' }))
    ).toThrow('kind')
    const child = log.append(
      observation({
        sourceEventId: 'source-2',
        kind: 'subagent.observed',
        payload: callPayload({ callId: 'child-1', phase: 'completed', parentCallId: 'call-1' }),
      })
    )
    expect(child?.kind).toBe('subagent.observed')
    expect(log.events()).toHaveLength(2)
  })

  test('retains validation after restart and remains honest when prior observations were evicted', () => {
    const { log, create } = setup({ maxPerSession: 1 })
    log.append(observation({ payload: callPayload({ parentCallId: null }) }))
    expect(() =>
      create().append(
        observation({
          sourceEventId: 'source-2',
          payload: callPayload({ parentCallId: 'parent-1' }),
        })
      )
    ).toThrow('parentCallId')
    log.append(
      observation({ sourceEventId: 'source-2', payload: callPayload({ callId: 'other' }) })
    )
    const completed = create().append(
      observation({
        sourceEventId: 'source-3',
        kind: 'tool.completed',
        payload: callPayload({ phase: 'completed' }),
      })
    )
    expect(completed?.seq).toBe('3')
    expect(completed?.payload).not.toHaveProperty('parentCallId')
  })
})
