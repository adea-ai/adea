import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { AgentHqExecutionEventEnvelopeSchema, canonicalJsonStringify } from '@adea-ai/contracts'

import {
  MAX_CONTROL_PLANE_EVENT_BYTES,
  projectControlPlaneExecutionEvent,
} from '../src/server/control-plane-events'

const suffix = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const scope = {
  workspaceId: `wsp_${suffix}`,
  projectId: `prj_${suffix}`,
  taskId: `tsk_${suffix}`,
  agentId: `agt_${suffix}`,
  executionId: `exe_${suffix}`,
}
const digest = (value: unknown) =>
  createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')
function event(data: Record<string, unknown> = { state: 'completed' }) {
  return {
    ...scope,
    contractVersion: { major: 1, minor: 0 },
    eventId: `evt_${suffix}`,
    attemptId: `att_${suffix}`,
    workflowId: `wfl_${suffix}`,
    eventType: 'execution.completed',
    sequence: 3,
    schemaVersion: 1,
    payloadHash: digest(data),
    occurredAt: '2026-10-07T10:00:00.000Z',
    recordedAt: '2026-10-07T10:00:01.000Z',
    correlation: { requestId: `req_${suffix}`, traceId: `trc_${suffix}` },
    data,
  }
}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
function refusal(value: unknown, code: string, expected = scope) {
  expect(() => projectControlPlaneExecutionEvent(bytes(value), expected)).toThrow(code)
}

describe('cloud-safe Control Plane execution event projection', () => {
  test('uses the public envelope while removing unrestricted runtime/provider content', () => {
    const input = event({
      state: 'completed',
      prompt: 'PRIVATE_PROMPT_SENTINEL',
      response: 'PRIVATE_RESPONSE_SENTINEL',
      provider: { content: 'PRIVATE_PROVIDER_SENTINEL' },
      contextPackage: { body: 'PRIVATE_CONTEXT_SENTINEL' },
      resultReference: 'file:///PRIVATE_NATIVE_PATH_SENTINEL',
    })
    expect(AgentHqExecutionEventEnvelopeSchema.safeParse(input).success).toBe(true)
    const result = projectControlPlaneExecutionEvent(bytes(input), scope)
    expect(result).toMatchObject({ ...scope, eventId: input.eventId, sequence: 3 })
    expect(result.data).toEqual({ state: 'completed' })
    expect(result.payloadHash).toBe(input.payloadHash)
    expect(result.projectionHash).toBe(digest({ state: 'completed' }))
    expect(JSON.stringify(result)).not.toContain('PRIVATE_')
    expect(result).not.toHaveProperty('runtimeNodeId')
    expect(result).not.toHaveProperty('locationKind')
  })

  test('preserves bounded counts and opaque artifact metadata without copying locators', () => {
    const input = event({
      state: 'completed',
      progress: { completed: 4, total: 4, message: 'PRIVATE_PROGRESS_SENTINEL' },
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        durationMs: 30,
        cost: { amount: '0.001', currency: 'USD' },
        providerOutput: 'PRIVATE_USAGE_SENTINEL',
      },
      artifactRefs: [
        {
          artifactId: `art_${suffix}`,
          version: 1,
          digest: `sha256:${'a'.repeat(64)}`,
          sizeBytes: 64,
          locator: 'file:///PRIVATE_ARTIFACT_SENTINEL',
          mediaType: 'PRIVATE_MEDIA_SENTINEL',
        },
      ],
    })
    const result = projectControlPlaneExecutionEvent(bytes(input), scope)
    expect(result.data).toEqual({
      state: 'completed',
      progress: { completed: 4, total: 4 },
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        durationMs: 30,
        cost: { amount: '0.001', currency: 'USD' },
      },
      artifactRefs: [
        {
          artifactId: `art_${suffix}`,
          version: 1,
          digest: `sha256:${'a'.repeat(64)}`,
          sizeBytes: 64,
        },
      ],
    })
    expect(JSON.stringify(result)).not.toContain('PRIVATE_')
  })

  test('binds every correlation identity to an independently resolved execution scope', () => {
    for (const key of Object.keys(scope) as Array<keyof typeof scope>) {
      const expected = { ...scope, [key]: scope[key].replace(/V$/, 'W') }
      refusal(event(), 'correlation_mismatch', expected)
    }
    refusal(event(), 'correlation_mismatch', { ...scope, workspaceId: 'PRIVATE_SCOPE_SENTINEL' })
  })

  test('retains classified availability and failure without free-form diagnostics', () => {
    const input = event({
      state: 'failed',
      availability: 'unavailable',
      providerState: 'rate_limited',
      failure: {
        classification: 'runtime_error',
        retryable: true,
        code: 'PRIVATE_CODE_SENTINEL',
        message: 'PRIVATE_FAILURE_SENTINEL',
      },
    })
    const result = projectControlPlaneExecutionEvent(
      bytes({ ...input, eventType: 'attempt.failed' }),
      scope
    )
    expect(result.data).toEqual({
      state: 'failed',
      availability: 'unavailable',
      providerState: 'rate_limited',
      failure: { classification: 'runtime_error', retryable: true },
    })
    expect(JSON.stringify(result)).not.toContain('PRIVATE_')
  })

  test('removes unknown ordinary object keys while refusing prototype-mutating JSON keys', () => {
    const input = event({
      state: 'completed',
      provider: {
        constructor: 'PRIVATE_CONSTRUCTOR_SENTINEL',
        prototype: 'PRIVATE_PROTOTYPE_SENTINEL',
      },
    })
    expect(projectControlPlaneExecutionEvent(bytes(input), scope).data).toEqual({
      state: 'completed',
    })
    refusal(
      event(JSON.parse('{"__proto__":{"state":"PRIVATE_PROTO_SENTINEL"}}')),
      'invalid_envelope'
    )
  })

  test('returns an isolated immutable projection for deferred application', () => {
    const input = event({
      state: 'completed',
      usage: { inputTokens: 1, outputTokens: 2, durationMs: 3 },
    })
    const result = projectControlPlaneExecutionEvent(bytes(input), scope)
    const snapshot = JSON.stringify(result)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.correlation)).toBe(true)
    expect(Object.isFrozen(result.data)).toBe(true)
    expect(Object.isFrozen(result.data.usage)).toBe(true)
    expect(Reflect.set(result.data.usage!, 'inputTokens', 999)).toBe(false)
    input.data.usage = { inputTokens: 999, outputTokens: 2, durationMs: 3 }
    expect(JSON.stringify(result)).toBe(snapshot)
  })

  test('checks the canonical source hash before projecting away private fields', () => {
    const original = event({ state: 'completed', prompt: 'PRIVATE_ORIGINAL_SENTINEL' })
    refusal(
      { ...original, data: { state: 'completed', prompt: 'PRIVATE_CHANGED_SENTINEL' } },
      'payload_mismatch'
    )
    const reordered = {
      ...original,
      data: { prompt: 'PRIVATE_ORIGINAL_SENTINEL', state: 'completed' },
    }
    expect(projectControlPlaneExecutionEvent(bytes(reordered), scope).payloadHash).toBe(
      original.payloadHash
    )
  })

  test('refuses unsupported schemas and event types without retaining their input', () => {
    refusal({ ...event(), contractVersion: { major: 2, minor: 0 } }, 'unsupported_schema')
    refusal({ ...event(), schemaVersion: 2 }, 'unsupported_schema')
    refusal({ ...event(), eventType: 'execution.private_content_sentinel' }, 'unsupported_event')
    expect(
      projectControlPlaneExecutionEvent(
        bytes({ ...event(), contractVersion: { major: 1, minor: 1 } }),
        scope
      ).contractVersion
    ).toEqual({ major: 1, minor: 1 })
  })

  test('refuses conflicting lifecycle facts and invalid known metadata', () => {
    for (const data of [
      { state: 'running' },
      { state: 'PRIVATE_STATE_SENTINEL' },
      { state: 'completed', progress: { completed: 5, total: 4 } },
      { state: 'completed', usage: { inputTokens: -1, outputTokens: 0, durationMs: 1 } },
      { state: 'completed', artifactRefs: [{ artifactId: 'file:///PRIVATE_REF_SENTINEL' }] },
    ])
      refusal(event(data), 'invalid_projection')
    refusal({ ...event(), eventType: 'execution.accepted' }, 'invalid_projection')
    refusal({ ...event(), eventType: 'attempt.queued' }, 'invalid_projection')
  })

  test('bounds the bytes and structural work before public recursive schema parsing', () => {
    expect(() =>
      projectControlPlaneExecutionEvent(new Uint8Array(MAX_CONTROL_PLANE_EVENT_BYTES + 1), scope)
    ).toThrow('event_too_large')
    expect(() => projectControlPlaneExecutionEvent(new Uint8Array([0xff]), scope)).toThrow(
      'invalid_envelope'
    )
    let nested: unknown = 'PRIVATE_DEEP_SENTINEL'
    for (let i = 0; i < 30; i += 1) nested = { nested }
    refusal(event({ nested }), 'invalid_envelope')
    refusal(event({ values: Array.from({ length: 600 }, () => 0) }), 'invalid_envelope')
    refusal(event({ prompt: 'p'.repeat(17 * 1024) }), 'event_too_large')
    refusal(
      { ...event(), occurredAt: `2026-10-07T10:00:00.${'1'.repeat(500)}Z` },
      'invalid_envelope'
    )
  })

  test('rejects unexpected envelope metadata and reports only classified errors', () => {
    for (const value of [
      { ...event(), nativePath: 'PRIVATE_HEADER_SENTINEL' },
      {
        ...event(),
        correlation: { ...event().correlation, secret: 'PRIVATE_CORRELATION_SENTINEL' },
      },
      { ...event(), sequence: Number.MAX_SAFE_INTEGER + 1 },
      { ...event(), data: { state: 'PRIVATE_ERROR_SENTINEL' } },
    ]) {
      try {
        projectControlPlaneExecutionEvent(bytes(value), scope)
        throw new Error('expected refusal')
      } catch (error) {
        expect(String(error)).not.toContain('PRIVATE_')
        expect(String(error)).not.toContain('expected refusal')
      }
    }
  })
})
