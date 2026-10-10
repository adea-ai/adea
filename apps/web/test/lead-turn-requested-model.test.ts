import { expect, test } from 'bun:test'
import {
  createLeadTurnRuntime,
  type LeadRuntimeAdapter,
  type LeadRuntimeAuthority,
  type LeadRuntimeStore,
} from '../src/server/lead-turn-runtime'

const intentId = '65a15864-a6b7-4c9c-9be3-cde31d9b3b8d'
const scope = { workspaceId: 'adea-workspace', intentId, userId: 'owner' }
const controlPlaneWorkspaceId = `wsp_${'0'.repeat(26)}`
const executionId = `exe_${'0'.repeat(26)}`
const attemptId = `att_${'0'.repeat(26)}`
const requested = { selectionRef: `msel_${'a'.repeat(32)}`, selectionRevision: 1 }
const preparedFor = (selectionRef: string, selectionRevision: number) => ({
  workspaceId: controlPlaneWorkspaceId,
  intentId,
  executionId,
  attemptId,
  selectionRef,
  selectionRevision,
  preparationRef: `prep_${'a'.repeat(32)}`,
  expiresAt: '2100-01-01T00:00:00Z',
})

function fixture(
  requestedLeadSelection: LeadRuntimeAuthority['requestedLeadSelection'],
  candidate: ReturnType<typeof preparedFor>,
  options: { stored?: Record<string, unknown> } = {}
) {
  const calls: string[] = []
  let observed: Record<string, unknown> | undefined = options.stored
  const authority: LeadRuntimeAuthority = {
    intentId,
    messageId: 'message',
    workspaceId: 'adea-workspace',
    controlPlaneWorkspaceId,
    originalActorRef: 'user:owner',
    requestedLeadSelection,
  }
  const store: LeadRuntimeStore = {
    async authorize() {
      calls.push('authorize')
      return authority
    },
    async read() {
      return observed as never
    },
    async prepare(_scope, pin) {
      calls.push('prepare')
      observed = { ...pin, state: 'prepared', preparationExpiresAt: pin.expiresAt }
    },
    async pending() {
      calls.push('pending')
    },
    async observe() {
      calls.push('observe')
      return observed as never
    },
    async recover() {
      calls.push('recover')
      return observed as never
    },
    async cancelRequested() {
      calls.push('cancelRequested')
    },
    async publish() {
      calls.push('publish')
      return 'agent-message'
    },
  }
  const adapter = {
    async prepare(input: LeadRuntimeAuthority) {
      calls.push(`adapter.prepare:${input.requestedLeadSelection?.selectionRef ?? 'default'}`)
      return candidate
    },
    async dispatch(input: LeadRuntimeAuthority) {
      calls.push(`dispatch:${input.originalActorRef}`)
      return { state: 'running' }
    },
    async status() {
      return { state: 'running' }
    },
    async progress() {
      return { events: [], nextSequence: 0 }
    },
    async cancel() {
      return { state: 'cancelling' }
    },
  } as unknown as LeadRuntimeAdapter
  return {
    calls,
    service: createLeadTurnRuntime({
      store,
      adapter,
      authorizeConfirmedStart: async () => candidate,
    }),
  }
}

test('a requested lead choice is passed to the contract and stored when it prepares that exact selection', async () => {
  const f = fixture(requested, preparedFor(requested.selectionRef, requested.selectionRevision))
  const result = await f.service.prepare(scope)
  expect(result).toMatchObject({ state: 'prepared', selectionRef: requested.selectionRef })
  expect(result.reasonCode).toBeUndefined()
  expect(f.calls).toContain(`adapter.prepare:${requested.selectionRef}`)
  expect(f.calls).toContain('prepare')
})

test('a different prepared model is refused before any preparation is stored', async () => {
  const other = `msel_${'b'.repeat(32)}`
  const f = fixture(requested, preparedFor(other, requested.selectionRevision))
  const result = await f.service.prepare(scope)
  expect(result).toMatchObject({
    availability: 'unavailable',
    reasonCode: 'REQUESTED_MODEL_MISMATCH',
  })
  expect(result).not.toHaveProperty('selectionRef')
  expect(f.calls).not.toContain('prepare')
})

test('the same selection reference at another revision is not the requested choice', async () => {
  const f = fixture(requested, preparedFor(requested.selectionRef, requested.selectionRevision + 1))
  const result = await f.service.prepare(scope)
  expect(result.reasonCode).toBe('REQUESTED_MODEL_MISMATCH')
  expect(f.calls).not.toContain('prepare')
})

test('without a requested choice the workspace default preparation is stored unchanged', async () => {
  const other = `msel_${'b'.repeat(32)}`
  const f = fixture(null, preparedFor(other, 2))
  const result = await f.service.prepare(scope)
  expect(result).toMatchObject({ state: 'prepared', selectionRef: other, selectionRevision: 2 })
  expect(f.calls).toContain('adapter.prepare:default')
  expect(f.calls).toContain('prepare')
})

test('dispatch refuses a stored preparation that no longer matches the requested lead', async () => {
  const other = `msel_${'b'.repeat(32)}`
  const f = fixture(requested, preparedFor(requested.selectionRef, requested.selectionRevision), {
    stored: {
      ...preparedFor(other, 1),
      state: 'prepared',
      preparationExpiresAt: '2100-01-01T00:00:00Z',
    },
  })
  const result = await f.service.dispatch(scope)
  expect(result.reasonCode).toBe('REQUESTED_MODEL_MISMATCH')
  expect(f.calls).not.toContain('pending')
  expect(f.calls.some((call) => call.startsWith('dispatch:'))).toBe(false)
})
