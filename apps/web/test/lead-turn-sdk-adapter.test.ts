import { expect, test } from 'bun:test'
import { createLeadTurnSdkAdapter } from '../src/server/lead-turn-sdk-adapter'

const actor = 'b7b5038e-77a8-4fbb-82e1-6ea172f376b8'
const authority = {
  workspaceId: 'adea-workspace',
  controlPlaneWorkspaceId: `wsp_${'0'.repeat(26)}`,
  originalActorRef: `user:${actor}` as const,
  messageId: crypto.randomUUID(),
  intentId: crypto.randomUUID(),
}
const selection = {
  workspaceId: authority.controlPlaneWorkspaceId,
  intentId: authority.intentId,
  executionId: `exe_${'0'.repeat(26)}`,
  attemptId: `att_${'0'.repeat(26)}`,
  selectionRef: `msel_${'a'.repeat(32)}`,
  selectionRevision: 1,
  preparationRef: `prep_${'a'.repeat(32)}`,
  expiresAt: '2100-01-01T00:00:00Z',
}
test('candidate SDK adapter forwards only opaque references, never human identity in public command payload', async () => {
  const calls: unknown[] = []
  const adapter = createLeadTurnSdkAdapter({
    workspaceId: authority.controlPlaneWorkspaceId,
    async dispatch(intentId, preparationRef) {
      calls.push({ intentId, preparationRef })
      return {}
    },
    async status() {
      return {}
    },
    async progress() {
      return {}
    },
    async cancel() {
      return {}
    },
  })
  await adapter.dispatch(authority, `lead-turn:${authority.intentId}`, selection)
  expect(calls).toEqual([
    { intentId: authority.intentId, preparationRef: selection.preparationRef },
  ])
  expect(adapter.prepare).toBeUndefined()
  expect(adapter.assertPublicationCurrent).toBeUndefined()
})
test('candidate adapter rejects wrong workspace, substituted transport principal and changed retry key', async () => {
  let calls = 0
  const adapter = createLeadTurnSdkAdapter({
    workspaceId: authority.controlPlaneWorkspaceId,
    async dispatch() {
      calls++
      return {}
    },
    async status() {
      return {}
    },
    async progress() {
      return {}
    },
    async cancel() {
      return {}
    },
  })
  await expect(
    adapter.dispatch(
      { ...authority, controlPlaneWorkspaceId: `wsp_${'1'.repeat(26)}` },
      `lead-turn:${authority.intentId}`,
      selection
    )
  ).rejects.toThrow('RUNTIME_RESPONSE_INVALID')
  await expect(
    adapter.dispatch(
      { ...authority, originalActorRef: 'svc_transport' } as never,
      `lead-turn:${authority.intentId}`,
      selection
    )
  ).rejects.toThrow('RUNTIME_RESPONSE_INVALID')
  await expect(adapter.dispatch(authority, 'changed-key', selection)).rejects.toThrow(
    'RUNTIME_RESPONSE_INVALID'
  )
  expect(calls).toBe(0)
})

test('child terminal publisher accepts only the exact current parent and delegation binding', async () => {
  const binding = {
    schemaVersion: 'pi-lead-dispatch/v1' as const,
    intentId: authority.intentId,
    dispatchId: `dispatch_${'a'.repeat(32)}`,
    executionId: selection.executionId,
    attemptId: selection.attemptId,
    runtimeSessionId: `ses_${'0'.repeat(26)}`,
  }
  const delegationId = `dlg_${'1'.repeat(26)}`
  const publication = {
    ...binding,
    schemaVersion: 'pi-child-publication/v1',
    workspaceId: authority.controlPlaneWorkspaceId,
    intentId: authority.intentId,
    canonicalActorPrincipalId: authority.originalActorRef,
    delegationId,
    childExecutionId: `exe_${'1'.repeat(26)}`,
    childAttemptId: `att_${'1'.repeat(26)}`,
    role: 'researcher',
    state: 'completed',
    resultRef: `art_${'1'.repeat(26)}`,
    conclusion: 'The requested answer is 42.',
    authorityRevision: 1,
    expiresAt: '2100-01-01T00:00:00Z',
  }
  let response: unknown = { data: { publication } }
  const adapter = createLeadTurnSdkAdapter({
    workspaceId: authority.controlPlaneWorkspaceId,
    dispatch: async () => ({}),
    status: async () => ({}),
    progress: async () => ({}),
    cancel: async () => ({}),
    async childPublicationCurrent(dispatchId, preparationRef, childId) {
      expect([dispatchId, preparationRef, childId]).toEqual([
        binding.dispatchId,
        selection.preparationRef,
        delegationId,
      ])
      return response
    },
  })
  expect(
    await adapter.childPublicationCurrent!(
      authority,
      binding,
      selection.preparationRef,
      delegationId
    )
  ).toMatchObject({
    delegationId,
    state: 'completed',
    publication: 'published',
    conclusion: 'The requested answer is 42.',
  })
  for (const changed of [
    { attemptId: `att_${'2'.repeat(26)}` },
    { delegationId: `dlg_${'2'.repeat(26)}` },
    { canonicalActorPrincipalId: `user:${crypto.randomUUID()}` },
    { expiresAt: '2000-01-01T00:00:00Z' },
    { conclusion: 'x'.repeat(1025) },
    { conclusion: 'hidden\u202evalue' },
    { conclusion: ' padded ' },
    { state: 'failed' },
  ]) {
    response = { data: { publication: { ...publication, ...changed } } }
    await expect(
      adapter.childPublicationCurrent!(authority, binding, selection.preparationRef, delegationId)
    ).rejects.toThrow('RUNTIME_RESPONSE_INVALID')
  }
})

test('prepare decodes actual SDK response data and retains only bound references and expiry', async () => {
  const data = {
    schemaVersion: 'pi-lead-preparation/v1',
    ...selection,
    replayed: false,
    funding: {
      schemaVersion: 'model-funding-display/v1',
      state: 'ready',
      workspaceId: selection.workspaceId,
      executionId: selection.executionId,
      attemptId: selection.attemptId,
      selectionRef: selection.selectionRef,
      selectionRevision: selection.selectionRevision,
      expiresAt: selection.expiresAt,
      authorizationRef: 'private-funding-ref',
    },
  }
  const transport = {
    workspaceId: authority.controlPlaneWorkspaceId,
    async prepare() {
      return { data }
    },
    async dispatch() {
      return {}
    },
    async status() {
      return {}
    },
    async progress() {
      return {}
    },
    async cancel() {
      return {}
    },
  }
  expect(createLeadTurnSdkAdapter(transport).prepare).toBeUndefined()
  const decoded: unknown[] = []
  const adapter = createLeadTurnSdkAdapter({
    ...transport,
    preparationSchema: {
      parse(value) {
        decoded.push(value)
        return value
      },
    },
  })
  expect(await adapter.prepare!(authority)).toEqual(selection)
  expect(decoded).toEqual([data])
  expect(JSON.stringify(await adapter.prepare!(authority))).not.toContain('private-funding-ref')
})

test('lookup uses actual strict response decoder and opaque intent only; absent decoder remains disabled', async () => {
  const calls: unknown[] = []
  const data = {
    schemaVersion: 'pi-lead-lookup/v1',
    workspaceId: authority.controlPlaneWorkspaceId,
    intentId: authority.intentId,
    receipt: null,
  }
  const transport = {
    workspaceId: authority.controlPlaneWorkspaceId,
    async lookup(intentId: string) {
      calls.push({ intentId })
      return { data }
    },
    async dispatch() {
      return {}
    },
    async status() {
      return {}
    },
    async progress() {
      return {}
    },
    async cancel() {
      return {}
    },
  }
  expect(createLeadTurnSdkAdapter(transport).lookup).toBeUndefined()
  const adapter = createLeadTurnSdkAdapter({
    ...transport,
    lookupResponseSchema: {
      parse(response) {
        return response
      },
    },
  })
  expect(await adapter.lookup!(authority)).toEqual(data)
  expect(calls).toEqual([{ intentId: authority.intentId }])
  await expect(
    adapter.lookup!({ ...authority, originalActorRef: 'svc_transport' } as never)
  ).rejects.toThrow('RUNTIME_RESPONSE_INVALID')
  expect(calls).toHaveLength(1)
  data.workspaceId = `wsp_${'1'.repeat(26)}`
  await expect(adapter.lookup!(authority)).rejects.toThrow('RUNTIME_RESPONSE_INVALID')
})
