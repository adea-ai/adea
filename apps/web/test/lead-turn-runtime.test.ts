import { expect, test } from 'bun:test'
import {
  createLeadTurnRuntime,
  type LeadRuntimeStore,
  type LeadRuntimeAdapter,
} from '../src/server/lead-turn-runtime'

const intentId = '65a15864-a6b7-4c9c-9be3-cde31d9b3b8d'
const scope = { workspaceId: 'adea-workspace', intentId, userId: 'owner' }
const authority = {
  intentId,
  messageId: 'message',
  workspaceId: 'adea-workspace',
  controlPlaneWorkspaceId: `wsp_${'0'.repeat(26)}`,
  originalActorRef: 'user:owner' as const,
}
const binding = {
  schemaVersion: 'pi-lead-dispatch/v1',
  intentId,
  dispatchId: `dispatch_${'a'.repeat(32)}`,
  executionId: `exe_${'0'.repeat(26)}`,
  attemptId: `att_${'0'.repeat(26)}`,
  runtimeSessionId: `ses_${'0'.repeat(26)}`,
}
const selection = {
  workspaceId: authority.controlPlaneWorkspaceId,
  intentId,
  executionId: binding.executionId,
  attemptId: binding.attemptId,
  selectionRef: `msel_${'a'.repeat(32)}`,
  selectionRevision: 1,
  preparationRef: `prep_${'a'.repeat(32)}`,
  expiresAt: '2100-01-01T00:00:00Z',
}
function fixture() {
  const calls: string[] = []
  let observed: Record<string, unknown> | undefined
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
      observed ??= {
        ...authority,
        ...pin,
        workspaceId: authority.workspaceId,
        state: 'prepared',
        preparationExpiresAt: pin.expiresAt,
      }
    },
    async pending() {
      calls.push('pending')
      observed = { ...observed, state: 'dispatch_pending' }
    },
    async observe(_scope, value) {
      calls.push('observe')
      observed = { ...observed, ...value } as never
      return observed as never
    },
    async recover(_scope, value) {
      calls.push('recover')
      observed = { ...observed, ...value } as never
      return observed as never
    },
    async cancelRequested() {
      calls.push('cancelRequested')
    },
    async publish(_scope, _binding, _text, check) {
      calls.push('publication-lock')
      await check()
      calls.push('publish')
      observed = { ...observed, publishedMessageId: 'agent-message' }
      return 'agent-message'
    },
  }
  const adapter: LeadRuntimeAdapter = {
    async prepare() {
      return selection
    },
    async dispatch(input) {
      calls.push(`dispatch:${input.originalActorRef}`)
      return { ...binding, state: 'running', replayed: false }
    },
    async status() {
      return { ...binding, state: 'running', status: { observedAt: '2026-10-08T00:00:00Z' } }
    },
    async progress() {
      return { ...binding, events: [], nextSequence: 0 }
    },
    async cancel() {
      calls.push('cancel')
      return { ...binding, state: 'cancelling', status: { observedAt: '2026-10-08T00:00:00Z' } }
    },
    async assertPublicationCurrent(input) {
      calls.push(`grant:${input.originalActorRef}`)
    },
  }
  return {
    calls,
    store,
    adapter,
    service: createLeadTurnRuntime({
      store,
      adapter,
      authorizeConfirmedStart: async () => selection,
    }),
  }
}

test('absent adapter fails closed without dispatch or pending execution claims', async () => {
  const f = fixture()
  const result = await createLeadTurnRuntime({ store: f.store }).dispatch(scope)
  expect(result).toMatchObject({
    state: 'blocked',
    availability: 'unavailable',
    reasonCode: 'ADMISSION_SERVICE_UNAVAILABLE',
  })
  expect(f.calls).not.toContain('pending')
})

test('lost acknowledgement recovers actual binding after preparation expires without start or funding', async () => {
  const f = fixture()
  await f.service.prepare(scope)
  f.adapter.dispatch = async () => {
    throw new Error('lost acknowledgement')
  }
  await f.service.dispatch(scope)
  f.calls.length = 0
  f.adapter.prepare = async () => {
    throw new Error('admission must not run')
  }
  f.adapter.lookup = async (input) => {
    f.calls.push(`lookup:${input.originalActorRef}`)
    return {
      schemaVersion: 'pi-lead-lookup/v1',
      workspaceId: authority.controlPlaneWorkspaceId,
      intentId,
      receipt: { ...binding, state: 'dispatched' },
    }
  }
  const expired = createLeadTurnRuntime({
    store: f.store,
    adapter: f.adapter,
    now: () => new Date('2101-01-01T00:00:00Z'),
    authorizeConfirmedStart: async () => {
      throw new Error('funding must not run')
    },
  })
  expect(await expired.status(scope)).toMatchObject({
    state: 'running',
    runtimeSessionId: binding.runtimeSessionId,
  })
  expect(f.calls).toContain('lookup:user:owner')
  expect(f.calls).toContain('recover')
  expect(f.calls.some((call) => call.startsWith('dispatch:'))).toBe(false)
  expect(f.calls).not.toContain('pending')
  expect(f.calls).not.toContain('prepare')
  expect(await expired.status(scope)).toMatchObject({
    state: 'running',
    dispatchId: binding.dispatchId,
  })
  expect(f.calls.filter((call) => call.startsWith('lookup:'))).toHaveLength(1)
})

test('missing and incomplete lookup receipts retain pending without inventing a session or runtime state', async () => {
  for (const receipt of [
    null,
    {
      dispatchId: binding.dispatchId,
      executionId: binding.executionId,
      attemptId: binding.attemptId,
      state: 'dispatching',
    },
    {
      dispatchId: binding.dispatchId,
      executionId: binding.executionId,
      attemptId: binding.attemptId,
      state: 'reconciliation_required',
    },
  ]) {
    const f = fixture()
    await f.service.prepare(scope)
    f.adapter.dispatch = async () => {
      throw new Error('lost acknowledgement')
    }
    await f.service.dispatch(scope)
    f.calls.length = 0
    f.adapter.prepare = async () => {
      throw new Error('admission must not run')
    }
    f.adapter.lookup = async () => ({
      schemaVersion: 'pi-lead-lookup/v1',
      workspaceId: authority.controlPlaneWorkspaceId,
      intentId,
      receipt,
    })
    f.adapter.status = async () => {
      throw new Error('status must not run')
    }
    const result = await f.service.status(scope)
    expect(result).toMatchObject({ state: 'dispatch_pending' })
    expect(result).not.toHaveProperty('runtimeSessionId')
    expect(f.calls).not.toContain('recover')
    expect(f.calls).not.toContain('prepare')
    expect(f.calls).not.toContain('pending')
    expect(f.calls.some((call) => call.startsWith('dispatch:'))).toBe(false)
    expect(f.calls).not.toContain('publish')
  }
})

test('lookup refuses mismatched canonical pins and late authority changes before publication', async () => {
  for (const patch of [
    { workspaceId: 'wrong-workspace' },
    { intentId: crypto.randomUUID() },
    { receipt: { ...binding, attemptId: `att_${'1'.repeat(26)}`, state: 'dispatched' } },
  ]) {
    const f = fixture()
    await f.service.prepare(scope)
    f.adapter.dispatch = async () => {
      throw new Error('lost acknowledgement')
    }
    await f.service.dispatch(scope)
    f.calls.length = 0
    f.adapter.lookup = async () => ({
      schemaVersion: 'pi-lead-lookup/v1',
      workspaceId: authority.controlPlaneWorkspaceId,
      intentId,
      receipt: { ...binding, state: 'dispatched' },
      ...patch,
    })
    expect(await f.service.status(scope)).toMatchObject({
      state: 'dispatch_pending',
      reasonCode: 'RUNTIME_RESPONSE_INVALID',
    })
    expect(f.calls).not.toContain('recover')
    expect(f.calls).not.toContain('publish')
  }
  const f = fixture()
  await f.service.prepare(scope)
  f.adapter.dispatch = async () => {
    throw new Error('lost acknowledgement')
  }
  await f.service.dispatch(scope)
  f.adapter.lookup = async () => {
    f.store.authorize = async () => {
      throw new Error('Lead turn unavailable')
    }
    return {
      schemaVersion: 'pi-lead-lookup/v1',
      workspaceId: authority.controlPlaneWorkspaceId,
      intentId,
      receipt: { ...binding, state: 'dispatched' },
    }
  }
  await expect(f.service.status(scope)).rejects.toThrow('unavailable')
  expect(f.calls).not.toContain('recover')
  expect(f.calls).not.toContain('publish')
})

test('lookup denial retains pending and exposes no service/provider details or output', async () => {
  const f = fixture()
  await f.service.prepare(scope)
  f.adapter.dispatch = async () => {
    throw new Error('lost acknowledgement')
  }
  await f.service.dispatch(scope)
  f.calls.length = 0
  f.adapter.lookup = async () => {
    throw new Error('revoked service grant private-detail')
  }
  const result = await f.service.status(scope)
  expect(result).toMatchObject({ state: 'dispatch_pending', reasonCode: 'RUNTIME_UNAVAILABLE' })
  expect(JSON.stringify(result)).not.toContain('private-detail')
  expect(f.calls).not.toContain('recover')
  expect(f.calls).not.toContain('publish')
})
test('configured transport still cannot start without trusted confirmed funding', async () => {
  const f = fixture()
  expect(
    await createLeadTurnRuntime({ store: f.store, adapter: f.adapter }).dispatch(scope)
  ).toMatchObject({ state: 'blocked', reasonCode: 'FUNDING_CONFIRMATION_REQUIRED' })
  expect(f.calls).not.toContain('pending')
})
test('prepare persists an exact binding without starting inference or creating a runtime session', async () => {
  const f = fixture()
  expect(await f.service.prepare(scope)).toMatchObject({
    state: 'prepared',
    selectionRef: selection.selectionRef,
    selectionRevision: 1,
    executionId: binding.executionId,
    attemptId: binding.attemptId,
  })
  expect(await f.service.snapshot(scope)).not.toHaveProperty('runtimeSessionId')
  expect(f.calls).not.toContain('pending')
  expect(f.calls.some((call) => call.startsWith('dispatch:'))).toBe(false)
})
test('persists repair identity before transport and keeps original human distinct from transport', async () => {
  const f = fixture()
  await f.service.prepare(scope)
  f.calls.length = 0
  expect(await f.service.dispatch(scope)).toMatchObject({
    state: 'running',
    runtimeSessionId: binding.runtimeSessionId,
  })
  expect(f.calls.slice(0, 3)).toEqual(['authorize', 'pending', 'dispatch:user:owner'])
})
test('mismatched intent or canonical runtime session is refused', async () => {
  const f = fixture()
  await f.service.prepare(scope)
  f.adapter.dispatch = async () => ({ ...binding, intentId: crypto.randomUUID(), state: 'running' })
  expect(await f.service.dispatch(scope)).toMatchObject({
    availability: 'unavailable',
    reasonCode: 'RUNTIME_RESPONSE_INVALID',
  })
  expect(f.calls).not.toContain('observe')
})
test('unknown transport outcome stays pending and cancel acknowledgement is not cancellation', async () => {
  const f = fixture()
  await f.service.prepare(scope)
  f.adapter.dispatch = async () => {
    throw new Error('provider secret detail')
  }
  expect(await f.service.dispatch(scope)).toMatchObject({
    state: 'dispatch_pending',
    reasonCode: 'RUNTIME_UNAVAILABLE',
  })
  f.adapter.dispatch = async () => ({ ...binding, state: 'running' })
  await f.service.dispatch(scope)
  expect(await f.service.cancel(scope)).toMatchObject({ state: 'cancelling' })
  expect(f.calls).toContain('cancelRequested')
})
test('completed output requires current trusted grant inside publication boundary', async () => {
  const f = fixture()
  await f.service.prepare(scope)
  await f.service.dispatch(scope)
  f.adapter.status = async () => ({
    ...binding,
    state: 'completed',
    status: {
      observedAt: '2026-10-08T00:00:00Z',
      result: { output: { text: 'Canonical answer' } },
    },
  })
  expect(await f.service.status(scope)).toMatchObject({
    state: 'completed',
    publishedMessageId: 'agent-message',
  })
  expect(
    f.calls.filter(
      (call) => call === 'publication-lock' || call.startsWith('grant:') || call === 'publish'
    )
  ).toEqual(['publication-lock', 'grant:user:owner', 'publish'])
})
test('missing or revoked publication authority never leaks terminal output', async () => {
  const f = fixture()
  await f.service.prepare(scope)
  await f.service.dispatch(scope)
  f.adapter.status = async () => ({
    ...binding,
    state: 'completed',
    status: {
      result: { output: { text: 'private answer' } },
    },
  })
  f.adapter.assertPublicationCurrent = undefined
  const result = await f.service.status(scope)
  expect(result).toMatchObject({ state: 'completed', reasonCode: 'PUBLICATION_WITHHELD' })
  expect(JSON.stringify(result)).not.toContain('private answer')
  expect(f.calls).not.toContain('publish')
  f.adapter.assertPublicationCurrent = async () => {
    throw new Error('revoked grant with private detail')
  }
  expect(await f.service.status(scope)).toMatchObject({ reasonCode: 'PUBLICATION_WITHHELD' })
  expect(f.calls).not.toContain('publish')
})
test('progress validates cursor ordering and projects no raw data or provider errors', async () => {
  const f = fixture()
  await f.service.prepare(scope)
  await f.service.dispatch(scope)
  f.adapter.progress = async () => ({
    ...binding,
    events: [
      {
        handleId: 'runtime-handle',
        sequence: 1,
        occurredAt: '2026-10-08T00:00:00Z',
        type: 'output',
        data: { text: 'private answer', credential: 'secret' },
      },
    ],
    nextSequence: 1,
  })
  expect(await f.service.progress(scope, 0)).toMatchObject({
    nextSequence: 1,
    events: [{ sequence: 1, type: 'output' }],
  })
  expect(JSON.stringify(await f.service.progress(scope, 0))).not.toContain('private answer')
  expect(await f.service.progress(scope, 1)).toMatchObject({ events: [], nextSequence: 1 })
})

test('missing or expired preparation never persists a start or reaches inference', async () => {
  for (const invalid of [
    { ...selection, preparationRef: undefined },
    { ...selection, preparationRef: `prep_${'a'.repeat(32)}`, expiresAt: '2000-01-01T00:00:00Z' },
  ]) {
    const f = fixture()
    f.adapter.prepare = async () => invalid as never
    expect(await f.service.prepare(scope)).toMatchObject({
      state: 'blocked',
      reasonCode: 'RUNTIME_RESPONSE_INVALID',
    })
    expect(f.calls).not.toContain('prepare')
    expect(f.calls.some((call) => call.startsWith('dispatch:'))).toBe(false)
  }
})
test('changed preparation confirmation is refused and identical preparation replays the exact reference', async () => {
  const f = fixture()
  await f.service.prepare(scope)
  const changed = createLeadTurnRuntime({
    store: f.store,
    adapter: f.adapter,
    authorizeConfirmedStart: async () =>
      ({
        ...selection,
        preparationRef: `prep_${'b'.repeat(32)}`,
        expiresAt: '2100-01-01T00:00:00Z',
      }) as never,
  })
  expect(await changed.dispatch(scope)).toMatchObject({
    state: 'prepared',
    reasonCode: 'RUNTIME_RESPONSE_INVALID',
  })
  expect(f.calls).not.toContain('pending')
  const references: unknown[] = []
  f.adapter.dispatch = async (_authority, _key, pin) => {
    references.push(pin.preparationRef)
    return { ...binding, state: 'running' }
  }
  await f.service.dispatch(scope)
  await f.service.dispatch(scope)
  expect(references).toEqual([`prep_${'a'.repeat(32)}`, `prep_${'a'.repeat(32)}`])
})
