import { expect, test } from 'bun:test'
import { LeadRuntimeRefusal } from '../src/server/lead-runtime-refusal'
import {
  createLeadTurnRuntime,
  type LeadRuntimeAdapter,
  type LeadRuntimeAuthority,
  type LeadRuntimeStore,
} from '../src/server/lead-turn-runtime'

const intentId = '65a15864-a6b7-4c9c-9be3-cde31d9b3b8d'
const scope = { workspaceId: 'adea-workspace', intentId, userId: 'owner' }
const cpWorkspace = `wsp_${'0'.repeat(26)}`
const prepared = {
  workspaceId: cpWorkspace,
  intentId,
  executionId: `exe_${'0'.repeat(26)}`,
  attemptId: `att_${'0'.repeat(26)}`,
  selectionRef: `msel_${'a'.repeat(32)}`,
  selectionRevision: 1,
  preparationRef: `prep_${'a'.repeat(32)}`,
  expiresAt: '2100-01-01T00:00:00Z',
}

function fixture(options: {
  stored?: Record<string, unknown>
  prepareError?: unknown
  startError?: unknown
}) {
  const calls: string[] = []
  const authority: LeadRuntimeAuthority = {
    intentId,
    messageId: 'message',
    workspaceId: 'adea-workspace',
    controlPlaneWorkspaceId: cpWorkspace,
    originalActorRef: 'user:owner',
  }
  const store = {
    async authorize() {
      return authority
    },
    async read() {
      return options.stored as never
    },
    async prepare() {
      calls.push('prepare')
    },
    async pending() {
      calls.push('pending')
    },
    async observe() {
      return options.stored as never
    },
  } as unknown as LeadRuntimeStore
  const adapter = {
    async prepare() {
      if (options.prepareError) throw options.prepareError
      return prepared
    },
    async dispatch() {
      calls.push('dispatch')
      return {}
    },
  } as unknown as LeadRuntimeAdapter
  const service = createLeadTurnRuntime({
    store,
    adapter,
    authorizeConfirmedStart: async () => {
      if (options.startError) throw options.startError
      return prepared
    },
  })
  return { calls, service }
}

test('a refused preparation reports the bounded readiness reason and stores nothing', async () => {
  const f = fixture({ prepareError: new LeadRuntimeRefusal('QUOTA_EXHAUSTED') })
  const result = await f.service.prepare(scope)
  expect(result).toMatchObject({
    state: 'blocked',
    availability: 'unavailable',
    reasonCode: 'MODEL_NOT_READY',
    readinessReason: 'QUOTA_EXHAUSTED',
  })
  expect(f.calls).not.toContain('prepare')
})

test('a refusal at confirmed start keeps the stored preparation and never dispatches', async () => {
  const f = fixture({
    stored: { ...prepared, state: 'prepared', preparationExpiresAt: prepared.expiresAt },
    startError: new LeadRuntimeRefusal('CREDENTIAL_EXPIRED'),
  })
  const result = await f.service.dispatch(scope)
  expect(result).toMatchObject({
    state: 'prepared',
    reasonCode: 'MODEL_NOT_READY',
    readinessReason: 'CREDENTIAL_EXPIRED',
    selectionRef: prepared.selectionRef,
  })
  expect(f.calls).not.toContain('pending')
  expect(f.calls).not.toContain('dispatch')
})

test('any other failure stays generic and carries no readiness reason', async () => {
  for (const error of [new Error('provider said sk-live'), new Error('RUNTIME_UNAVAILABLE')]) {
    const result = await fixture({ prepareError: error }).service.prepare(scope)
    expect(result.reasonCode).toBe('RUNTIME_UNAVAILABLE')
    expect(result).not.toHaveProperty('readinessReason')
  }
})
