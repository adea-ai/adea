import { describe, expect, test } from 'bun:test'

import {
  assertCloudSafeEventPayload,
  FORBIDDEN_EVENT_PAYLOAD_KEYS,
  isWorkspaceEventType,
  MAX_EVENT_PAYLOAD_BYTES,
  resolveWorkspaceEventContract,
  WORKSPACE_EVENT_CONTRACTS,
  WORKSPACE_EVENT_TYPES,
  WorkspaceEventContractError,
} from '../../src/event-contract'

// Exercise the public append contract without a database. Payloads remain
// synthetic metadata; no private product rows or runtime are read.
describe('durable workspace event contract', () => {
  test('every registered type resolves its version, aggregate and metadata-only payload', () => {
    expect(WORKSPACE_EVENT_TYPES as readonly string[]).toEqual(
      Object.keys(WORKSPACE_EVENT_CONTRACTS)
    )
    for (const eventType of WORKSPACE_EVENT_TYPES) {
      const contract = resolveWorkspaceEventContract(eventType)
      expect(isWorkspaceEventType(eventType)).toBe(true)
      expect(contract).toBe(WORKSPACE_EVENT_CONTRACTS[eventType])
      expect(Number.isSafeInteger(contract.schemaVersion)).toBe(true)
      expect(contract.schemaVersion).toBeGreaterThan(0)
      const aggregateIdKey = contract.aggregateIdKey
      const payload = aggregateIdKey ? { [aggregateIdKey]: 'synthetic-id' } : {}
      expect(() => assertCloudSafeEventPayload(eventType, payload)).not.toThrow()
      if (aggregateIdKey) {
        for (const value of [undefined, null, 42]) {
          expect(() =>
            assertCloudSafeEventPayload(eventType, { [aggregateIdKey]: value } as never)
          ).toThrow(`must carry its aggregate id in "${aggregateIdKey}"`)
        }
      }
    }
  })

  test('transient and inherited names cannot resolve as durable event types', () => {
    for (const eventType of [
      'message.delta',
      'typing',
      'camera.frame',
      'unknown',
      'constructor',
      '__proto__',
      'toString',
    ]) {
      expect(isWorkspaceEventType(eventType)).toBe(false)
      expect(() => resolveWorkspaceEventContract(eventType)).toThrow(WorkspaceEventContractError)
      expect(() => assertCloudSafeEventPayload(eventType, {})).toThrow(
        'Unknown durable workspace event type'
      )
    }
    const error = new WorkspaceEventContractError('synthetic')
    expect(error.name).toBe('WorkspaceEventContractError')
    expect(error.message).toBe('synthetic')
  })

  test('every forbidden key is rejected directly and through nested objects and arrays', () => {
    for (const key of FORBIDDEN_EVENT_PAYLOAD_KEYS) {
      expect(() => assertCloudSafeEventPayload('workspace.created', { [key]: null })).toThrow(
        `"${key}"`
      )
      expect(() =>
        assertCloudSafeEventPayload('workspace.created', {
          metadata: [{ safe: true }, { nested: { [key]: 'synthetic' } }],
        })
      ).toThrow(`"metadata.1.nested.${key}"`)
    }
    expect(() =>
      assertCloudSafeEventPayload('workspace.created', {
        metadata: [{ safe: true }, null, 1, 'value', false, []],
      })
    ).not.toThrow()
  })

  test('the payload budget is exact UTF-8 bytes, including JSON framing', () => {
    const framing = Buffer.byteLength(JSON.stringify({ metadata: '' }))
    expect(() =>
      assertCloudSafeEventPayload('workspace.created', {
        metadata: 'a'.repeat(MAX_EVENT_PAYLOAD_BYTES - framing),
      })
    ).not.toThrow()
    expect(() =>
      assertCloudSafeEventPayload('workspace.created', {
        metadata: 'a'.repeat(MAX_EVENT_PAYLOAD_BYTES - framing + 1),
      })
    ).toThrow('durable event budget')
    const unicode = {
      metadata: 'é'.repeat(Math.floor((MAX_EVENT_PAYLOAD_BYTES - framing) / 2) + 1),
    }
    expect(JSON.stringify(unicode).length).toBeLessThan(MAX_EVENT_PAYLOAD_BYTES)
    expect(() => assertCloudSafeEventPayload('workspace.created', unicode)).toThrow(
      WorkspaceEventContractError
    )
  })
})
