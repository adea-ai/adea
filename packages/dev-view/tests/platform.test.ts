import { expect, test } from 'bun:test'

import { createUnavailableDevRuntimeService } from '../src/platform'

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
} as const

test('unavailable provider reports every capability unavailable without fabricating grants', async () => {
  const service = createUnavailableDevRuntimeService({
    reason: 'channel_unauthenticated',
    now: () => '2026-09-15T12:00:00.000Z',
  })

  const snapshot = await service.capabilitySnapshot(scope)
  expect(snapshot.granted).toEqual([])
  expect(snapshot.unavailable.length).toBeGreaterThan(20)
  expect(new Set(snapshot.unavailable.map((entry) => entry.reason))).toEqual(
    new Set(['channel_unauthenticated'])
  )
  expect(service.state()).toEqual({
    status: 'unavailable',
    reason: 'channel_unauthenticated',
  })
})

test('unavailable provider fails commands with the stable operation and request ID', async () => {
  const service = createUnavailableDevRuntimeService({
    reason: 'channel_unauthenticated',
    now: () => '2026-09-15T12:00:00.000Z',
  })
  const reply = await service.execute({
    schemaVersion: 1,
    operation: 'dev.capability.snapshot',
    requestId: '00000000-0000-4000-8000-000000000004',
    nonce: 'dGhpcy1ub25jZS1oYXMtYXQtbGVhc3QtMTI4LWJpdHM',
    issuedAt: '2026-09-15T12:00:00.000Z',
    expiresAt: '2026-09-15T12:01:00.000Z',
    scope,
    capabilities: [],
    body: {},
  })
  expect(reply).toEqual({
    schemaVersion: 1,
    operation: 'dev.capability.snapshot',
    requestId: '00000000-0000-4000-8000-000000000004',
    ok: false,
    error: {
      code: 'channel_unauthenticated',
      retryable: false,
      message: 'Dev Runtime is unavailable until its authenticated command channel is ready.',
      observedAt: '2026-09-15T12:00:00.000Z',
    },
  })
})
