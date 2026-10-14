import { expect, test } from 'bun:test'
import {
  createLeadTurnRuntime,
  type LeadRuntimeAuthority,
  type LeadRuntimeAuthorityPurpose,
  type LeadRuntimeScope,
  type LeadRuntimeStore,
} from '../src/server/lead-turn-runtime'

// Held authority belongs to one runtime operation. Ordinary reads request only `read`. A mutation
// purpose reads the row only under the same operation's own authority, and a held authority for
// another admission is refused before any read or adapter call.
const intentId = '65a15864-a6b7-4c9c-9be3-cde31d9b3b8d'
const scope: LeadRuntimeScope = { workspaceId: 'adea-workspace', intentId, userId: 'owner' }
const authority: LeadRuntimeAuthority = {
  intentId,
  messageId: 'message',
  workspaceId: 'adea-workspace',
  controlPlaneWorkspaceId: `wsp_${'0'.repeat(26)}`,
  originalActorRef: 'user:owner',
}
const fields = {
  schemaVersion: 'pi-lead-dispatch/v1',
  intentId,
  dispatchId: `dispatch_${'a'.repeat(32)}`,
  executionId: `exe_${'0'.repeat(26)}`,
  attemptId: `att_${'0'.repeat(26)}`,
  runtimeSessionId: `ses_${'0'.repeat(26)}`,
}
const observedAt = '2026-10-08T00:00:00Z'
const stored = { ...fields, state: 'running', observedAt }

function harness(options: {
  authorize?: (purpose: LeadRuntimeAuthorityPurpose) => LeadRuntimeAuthority
}) {
  const authorized: LeadRuntimeAuthorityPurpose[] = []
  const reads: (LeadRuntimeAuthorityPurpose | undefined)[] = []
  const adapterCalls: string[] = []
  const store = {
    async authorize(_scope: LeadRuntimeScope, purpose: LeadRuntimeAuthorityPurpose) {
      authorized.push(purpose)
      return options.authorize ? options.authorize(purpose) : authority
    },
    async read(_scope: LeadRuntimeScope, purpose?: LeadRuntimeAuthorityPurpose) {
      reads.push(purpose)
      return stored as never
    },
    async observe(_scope: LeadRuntimeScope, value: unknown) {
      return value as never
    },
    async recover(_scope: LeadRuntimeScope, value: unknown) {
      return value as never
    },
    async cancelRequested() {},
    async prepare() {},
    async pending() {},
    async publish() {
      return 'agent-message'
    },
  } as unknown as LeadRuntimeStore
  const adapter = {
    async status() {
      adapterCalls.push('status')
      return { ...fields, state: 'running', status: { observedAt } }
    },
    async progress() {
      adapterCalls.push('progress')
      return { events: [], nextSequence: 0 }
    },
    async cancel() {
      adapterCalls.push('cancel')
      return { ...fields, state: 'cancelling', status: { observedAt } }
    },
    async assertPublicationCurrent() {},
  }
  const service = createLeadTurnRuntime({
    store,
    adapter: adapter as never,
    authorizeConfirmedStart: async () => ({}) as never,
  })
  return { service, authorized, reads, adapterCalls }
}

test('ordinary reads request only the read purpose and read the row without a mutation purpose', async () => {
  const h = harness({})
  await h.service.snapshot(scope)
  await h.service.status(scope)
  await h.service.progress(scope, 0)
  expect(new Set(h.authorized)).toEqual(new Set<LeadRuntimeAuthorityPurpose>(['read']))
  expect(h.reads.every((purpose) => purpose === undefined || purpose === 'read')).toBe(true)
})

test('cancel reads its row only under its own cancel authority, and never under read', async () => {
  const h = harness({})
  await h.service.cancel(scope)
  expect(h.authorized).toEqual(['cancel'])
  expect(h.reads.length).toBeGreaterThan(0)
  expect(h.reads.every((purpose) => purpose === 'cancel')).toBe(true)
  expect(h.adapterCalls).toEqual(['cancel'])
})

test('a refused cancel authority reads nothing and reaches no adapter', async () => {
  const h = harness({
    authorize: (purpose) => {
      if (purpose === 'cancel') throw new Error('Lead turn unavailable')
      return authority
    },
  })
  await expect(h.service.cancel(scope)).rejects.toThrow('Lead turn unavailable')
  expect(h.reads).toEqual([])
  expect(h.adapterCalls).toEqual([])
})

test('a held cancel authority for another admission is refused before any read or cancel', async () => {
  const other = { ...authority, intentId: '00000000-0000-4000-8000-000000000000' }
  const h = harness({ authorize: (purpose) => (purpose === 'cancel' ? other : authority) })
  await expect(h.service.cancel(scope)).rejects.toThrow('Lead turn unavailable')
  expect(h.reads).toEqual([])
  expect(h.adapterCalls).toEqual([])
})

test('a prepare without an adapter projects its row only under its own effect authority', async () => {
  const h = harness({})
  await h.service.prepare(scope)
  expect(h.authorized).toEqual(['effect'])
  expect(h.reads.length).toBeGreaterThan(0)
  expect(h.reads.every((purpose) => purpose === 'effect')).toBe(true)
})
