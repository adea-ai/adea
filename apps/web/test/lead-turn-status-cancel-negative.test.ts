import { expect, test } from 'bun:test'
import {
  createLeadTurnRuntime,
  type LeadRuntimeAdapter,
  type LeadRuntimeStore,
} from '../src/server/lead-turn-runtime'

// Negative checks against the real status and cancel service. Missing, stale and mismatched
// runtime envelopes must be refused before anything is observed, and a refused authority must stop
// the call before any adapter call. Fenced admissions keep the read-safe observation path.
const intentId = '65a15864-a6b7-4c9c-9be3-cde31d9b3b8d'
const scope = { workspaceId: 'adea-workspace', intentId, userId: 'owner' }
const authority = {
  intentId,
  messageId: 'message',
  workspaceId: 'adea-workspace',
  controlPlaneWorkspaceId: `wsp_${'0'.repeat(26)}`,
  originalActorRef: 'user:owner' as const,
}
const executionId = `exe_${'0'.repeat(26)}`
const attemptId = `att_${'0'.repeat(26)}`
const dispatchId = `dispatch_${'a'.repeat(32)}`
const runtimeSessionId = `ses_${'0'.repeat(26)}`
const stored = {
  intentId,
  workspaceId: authority.controlPlaneWorkspaceId,
  messageId: 'message',
  state: 'running',
  executionId,
  attemptId,
  selectionRef: `msel_${'a'.repeat(32)}`,
  selectionRevision: 1,
  preparationRef: `prep_${'a'.repeat(32)}`,
  preparationExpiresAt: '2100-01-01T00:00:00Z',
  dispatchId,
  runtimeSessionId,
}
const binding = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 'pi-lead-dispatch/v1',
  intentId,
  dispatchId,
  executionId,
  attemptId,
  runtimeSessionId,
  ...overrides,
})

function harness(options: {
  record?: Record<string, unknown> | undefined
  refuse?: 'cancel' | 'read'
  status?: () => Promise<unknown>
  cancel?: () => Promise<unknown>
}) {
  const calls: string[] = []
  const observed: unknown[] = []
  const store = {
    async authorize(_scope: unknown, purpose: string) {
      calls.push(`authorize:${purpose}`)
      if (purpose === options.refuse) throw new Error('Lead turn unavailable')
      return authority
    },
    async read() {
      return options.record as never
    },
    async observe(_scope: unknown, value: unknown) {
      calls.push('observe')
      observed.push(value)
      return value as never
    },
    async recover(_scope: unknown, value: unknown) {
      return value as never
    },
    async cancelRequested() {
      calls.push('cancelRequested')
    },
    async publish() {
      calls.push('publish')
      return 'agent-message'
    },
  } as unknown as LeadRuntimeStore
  const adapter = {
    async status() {
      calls.push('adapter.status')
      return options.status
        ? options.status()
        : binding({ state: 'running', status: { observedAt: '2026-10-08T00:00:00Z' } })
    },
    async cancel() {
      calls.push('adapter.cancel')
      return options.cancel
        ? options.cancel()
        : binding({ state: 'cancelling', status: { observedAt: '2026-10-08T00:00:00Z' } })
    },
    async progress() {
      return { events: [], nextSequence: 0 }
    },
    async assertPublicationCurrent() {},
  } as unknown as LeadRuntimeAdapter
  const service = createLeadTurnRuntime({
    store,
    adapter,
    authorizeConfirmedStart: async () => ({}) as never,
  })
  return { service, calls, observed }
}

test('missing: a status request with no stored record never calls the adapter', async () => {
  const { service, calls, observed } = harness({ record: undefined })
  const result = await service.status(scope)
  expect(result).toMatchObject({ schemaVersion: 'adea-lead-turn/v1' })
  expect(calls).not.toContain('adapter.status')
  expect(observed).toEqual([])
})

test('missing: a cancel without a dispatch id is refused before any cancel request is recorded', async () => {
  const { service, calls } = harness({ record: { ...stored, dispatchId: undefined } })
  const result = await service.cancel(scope)
  expect(result).toMatchObject({ reasonCode: 'RUNTIME_UNAVAILABLE' })
  expect(calls).not.toContain('adapter.cancel')
  expect(calls).not.toContain('cancelRequested')
})

test('missing: a cancel refused at its actor authority reaches neither the adapter nor the store', async () => {
  const { service, calls } = harness({ record: stored, refuse: 'cancel' })
  await expect(service.cancel(scope)).rejects.toThrow('Lead turn unavailable')
  expect(calls).toEqual(['authorize:cancel'])
})

test('mismatched: a status response bound to another execution is refused and nothing is observed', async () => {
  const { service, observed } = harness({
    record: stored,
    status: async () =>
      binding({
        executionId: `exe_${'1'.repeat(26)}`,
        state: 'running',
        status: { observedAt: '2026-10-08T00:00:00Z' },
      }),
  })
  const result = await service.status(scope)
  expect(result).toMatchObject({ reasonCode: 'RUNTIME_RESPONSE_INVALID' })
  expect(observed).toEqual([])
})

test('stale: a status response from an earlier attempt is refused and nothing is observed', async () => {
  const { service, observed } = harness({
    record: stored,
    status: async () =>
      binding({
        attemptId: `att_${'2'.repeat(26)}`,
        state: 'running',
        status: { observedAt: '2026-10-08T00:00:00Z' },
      }),
  })
  const result = await service.status(scope)
  expect(result).toMatchObject({ reasonCode: 'RUNTIME_RESPONSE_INVALID' })
  expect(observed).toEqual([])
})

test('mismatched: a status response bound to another intent is refused and nothing is observed', async () => {
  const { service, observed } = harness({
    record: stored,
    status: async () =>
      binding({
        intentId: '11111111-2222-4333-8444-555555555555',
        state: 'running',
        status: { observedAt: '2026-10-08T00:00:00Z' },
      }),
  })
  const result = await service.status(scope)
  expect(result).toMatchObject({ reasonCode: 'RUNTIME_RESPONSE_INVALID' })
  expect(observed).toEqual([])
})

test('malformed: an unknown runtime state or an unparseable observation time is refused and nothing is observed', async () => {
  const unknownState = harness({
    record: stored,
    status: async () =>
      binding({ state: 'resumed', status: { observedAt: '2026-10-08T00:00:00Z' } }),
  })
  expect(await unknownState.service.status(scope)).toMatchObject({
    reasonCode: 'RUNTIME_RESPONSE_INVALID',
  })
  expect(unknownState.observed).toEqual([])
  const badTime = harness({
    record: stored,
    status: async () => binding({ state: 'running', status: { observedAt: 'not-a-time' } }),
  })
  expect(await badTime.service.status(scope)).toMatchObject({
    reasonCode: 'RUNTIME_RESPONSE_INVALID',
  })
  expect(badTime.observed).toEqual([])
})

test('mismatched: a cancel acknowledgement for another dispatch is refused, and the cancel request stays durable', async () => {
  const { service, calls, observed } = harness({
    record: stored,
    cancel: async () =>
      binding({
        dispatchId: `dispatch_${'b'.repeat(32)}`,
        state: 'cancelling',
        status: { observedAt: '2026-10-08T00:00:00Z' },
      }),
  })
  const result = await service.cancel(scope)
  expect(result).toMatchObject({ reasonCode: 'RUNTIME_RESPONSE_INVALID' })
  expect(calls).toContain('cancelRequested')
  expect(observed).toEqual([])
})

test('positive: a fenced admission keeps read-safe observation, and a matching status is recorded', async () => {
  const { service, calls, observed } = harness({ record: stored })
  await service.status(scope)
  expect(calls).toContain('authorize:read')
  expect(calls).toContain('adapter.status')
  expect(observed).toHaveLength(1)
  expect(observed[0]).toMatchObject({ dispatchId, state: 'running' })
})

test('positive: a matching cancel is requested, sent once with the dispatch key, and observed', async () => {
  const { service, calls, observed } = harness({ record: stored })
  await service.cancel(scope)
  expect(calls.filter((call) => call === 'adapter.cancel')).toHaveLength(1)
  expect(calls).toContain('cancelRequested')
  expect(observed).toHaveLength(1)
  expect(observed[0]).toMatchObject({ dispatchId, state: 'cancelling' })
})
