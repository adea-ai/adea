import { expect, test } from 'bun:test'
import {
  createLeadTurnRuntime,
  type LeadRuntimeAdapter,
  type LeadRuntimeStore,
} from '../src/server/lead-turn-runtime'

// Negative contract checks for the runtime service. A refused effect authority must stop the call
// before any adapter (runtime or control-plane) call, and archived publication must write nothing.
const intentId = '65a15864-a6b7-4c9c-9be3-cde31d9b3b8d'
const scope = { workspaceId: 'adea-workspace', intentId, userId: 'owner' }
const authority = {
  intentId,
  messageId: 'message',
  workspaceId: 'adea-workspace',
  controlPlaneWorkspaceId: `wsp_${'0'.repeat(26)}`,
  originalActorRef: 'user:owner' as const,
}
const selection = {
  workspaceId: authority.controlPlaneWorkspaceId,
  intentId,
  executionId: `exe_${'0'.repeat(26)}`,
  attemptId: `att_${'0'.repeat(26)}`,
  selectionRef: `msel_${'a'.repeat(32)}`,
  selectionRevision: 1,
  preparationRef: `prep_${'a'.repeat(32)}`,
  expiresAt: '2100-01-01T00:00:00Z',
}

function adapterCalls() {
  const calls: string[] = []
  const adapter: LeadRuntimeAdapter = {
    async prepare() {
      calls.push('adapter.prepare')
      return selection
    },
    async dispatch() {
      calls.push('adapter.dispatch')
      return {
        schemaVersion: 'pi-lead-dispatch/v1',
        intentId,
        dispatchId: `dispatch_${'a'.repeat(32)}`,
        executionId: selection.executionId,
        attemptId: selection.attemptId,
        runtimeSessionId: `ses_${'0'.repeat(26)}`,
        state: 'running',
        replayed: false,
      }
    },
    async status() {
      calls.push('adapter.status')
      return {
        schemaVersion: 'pi-lead-dispatch/v1',
        intentId,
        dispatchId: `dispatch_${'a'.repeat(32)}`,
        executionId: selection.executionId,
        attemptId: selection.attemptId,
        runtimeSessionId: `ses_${'0'.repeat(26)}`,
        state: 'completed',
        status: { observedAt: '2026-10-08T00:00:00Z', result: { output: { text: 'Answer' } } },
      }
    },
    async progress() {
      return { events: [], nextSequence: 0 }
    },
    async cancel() {
      calls.push('adapter.cancel')
      return { state: 'cancelling', status: { observedAt: '2026-10-08T00:00:00Z' } }
    },
    async assertPublicationCurrent() {},
  } as unknown as LeadRuntimeAdapter
  return { calls, adapter }
}

test('a refused effect authority stops prepare and dispatch before any control-plane or runtime call', async () => {
  for (const refusal of ['LEAD_TURN_FENCED', 'Lead turn unavailable']) {
    const { calls, adapter } = adapterCalls()
    const store = {
      authorize: async (_scope: unknown, purpose: string) => {
        if (purpose === 'effect') throw new Error(refusal)
        return authority
      },
      read: async () => undefined,
    } as unknown as LeadRuntimeStore
    const service = createLeadTurnRuntime({
      store,
      adapter,
      authorizeConfirmedStart: async () => selection,
    })
    await expect(service.prepare(scope)).rejects.toThrow(refusal)
    await expect(service.dispatch(scope)).rejects.toThrow(refusal)
    expect(calls).toEqual([])
  }
})

test('a fenced dispatch refused at pending reaches no runtime dispatch and reports unavailable', async () => {
  const { calls, adapter } = adapterCalls()
  const prepared = {
    ...selection,
    intentId,
    state: 'prepared',
    preparationExpiresAt: selection.expiresAt,
  }
  const store = {
    authorize: async () => authority,
    read: async () => prepared,
    pending: async () => {
      throw new Error('LEAD_TURN_FENCED')
    },
    observe: async (_s: unknown, value: unknown) => value,
    recover: async (_s: unknown, value: unknown) => value,
    cancelRequested: async () => {},
    publish: async () => 'agent-message',
  } as unknown as LeadRuntimeStore
  const service = createLeadTurnRuntime({
    store,
    adapter,
    authorizeConfirmedStart: async () => selection,
  })
  const result = await service.dispatch(scope)
  expect(result).toMatchObject({ reasonCode: 'RUNTIME_UNAVAILABLE', availability: 'unavailable' })
  expect(calls).not.toContain('adapter.dispatch')
})

test('archived publication is withheld: nothing is published, even for a completed runtime result', async () => {
  const { calls, adapter } = adapterCalls()
  let published = 0
  const store = {
    authorize: async () => authority,
    read: async () => ({
      ...selection,
      intentId,
      state: 'dispatch_pending',
      dispatchId: `dispatch_${'a'.repeat(32)}`,
      preparationExpiresAt: selection.expiresAt,
    }),
    observe: async (_s: unknown, value: unknown) => ({ ...(value as object), state: 'completed' }),
    recover: async (_s: unknown, value: unknown) => value,
    cancelRequested: async () => {},
    publish: async () => {
      published++
      throw new Error('Lead turn unavailable')
    },
  } as unknown as LeadRuntimeStore
  const service = createLeadTurnRuntime({
    store,
    adapter,
    authorizeConfirmedStart: async () => selection,
  })
  const result = await service.status(scope)
  expect(result).toMatchObject({ reasonCode: 'PUBLICATION_WITHHELD' })
  expect(published).toBe(1)
  expect(calls).not.toContain('adapter.cancel')
})
