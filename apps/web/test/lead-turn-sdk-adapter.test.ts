import { expect, test } from 'bun:test'
import { createLeadTurnSdkAdapter } from '../src/server/lead-turn-sdk-adapter'
import { installedLeadSdkPort, LEAD_SDK_METHODS } from '../src/server/lead-turn-sdk-port'

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
    { state: 'running' },
    { state: 'awaiting_input' },
    { state: 'manual_intervention' },
    { role: 'research reviewer' },
    { role: 'researcher\u202E' },
    { role: 'x'.repeat(257) },
  ]) {
    response = { data: { publication: { ...publication, ...changed } } }
    await expect(
      adapter.childPublicationCurrent!(authority, binding, selection.preparationRef, delegationId)
    ).rejects.toThrow('RUNTIME_RESPONSE_INVALID')
  }
})

test('a child terminal publication accepts only the bounded values the product may publish', async () => {
  const binding = {
    schemaVersion: 'pi-lead-dispatch/v1' as const,
    intentId: authority.intentId,
    dispatchId: `dispatch_${'a'.repeat(32)}`,
    executionId: selection.executionId,
    attemptId: selection.attemptId,
    runtimeSessionId: `ses_${'0'.repeat(26)}`,
  }
  const delegationId = `dlg_${'1'.repeat(26)}`
  const base = {
    ...binding,
    schemaVersion: 'pi-child-publication/v1',
    workspaceId: authority.controlPlaneWorkspaceId,
    intentId: authority.intentId,
    canonicalActorPrincipalId: authority.originalActorRef,
    delegationId,
    childExecutionId: `exe_${'1'.repeat(26)}`,
    childAttemptId: `att_${'1'.repeat(26)}`,
    role: 'researcher',
    state: 'failed',
    authorityRevision: 1,
    expiresAt: '2100-01-01T00:00:00Z',
  }
  const respond = (publication: Record<string, unknown>) => {
    let response: unknown = { data: { publication } }
    const adapter = createLeadTurnSdkAdapter({
      workspaceId: authority.controlPlaneWorkspaceId,
      dispatch: async () => ({}),
      status: async () => ({}),
      progress: async () => ({}),
      cancel: async () => ({}),
      async childPublicationCurrent() {
        return response
      },
    })
    return {
      adapter,
      set: (value: unknown) => {
        response = value
      },
    }
  }
  const port = respond(base)
  // A canonical control-plane token is accepted at the full control-plane length: the surface may
  // show it and the product may publish it. The control plane's schema (e9c1e206) accepts 256
  // characters of this grammar and no others.
  for (const failureCode of ['PROVIDER_FAILED', 'E'.repeat(256)]) {
    port.set({ data: { publication: { ...base, failureCode } } })
    expect(
      await port.adapter.childPublicationCurrent!(
        authority,
        binding,
        selection.preparationRef,
        delegationId
      )
    ).toMatchObject({ state: 'failed', failureCode })
  }
  // A failure code outside that grammar is refused at the boundary, so no unbounded value and no
  // readable reason with a space can reach a surface or a receipt. The control plane never
  // publishes such a value, so a response that carries one is not a canonical response.
  for (const failureCode of ['provider failed', 'failed\u202E', 'failed\u0007', 'E'.repeat(257)]) {
    port.set({ data: { publication: { ...base, failureCode } } })
    await expect(
      port.adapter.childPublicationCurrent!(
        authority,
        binding,
        selection.preparationRef,
        delegationId
      )
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

const digest = `sha256:${'c'.repeat(64)}`
const preparedWith = (childAllowance?: unknown) => {
  const transport = {
    workspaceId: authority.controlPlaneWorkspaceId,
    async prepare() {
      return {
        data: {
          schemaVersion: 'pi-lead-preparation/v1',
          ...selection,
          replayed: false,
          ...(childAllowance === undefined ? {} : { childAllowance }),
          funding: {
            schemaVersion: 'model-funding-display/v1',
            state: 'ready',
            workspaceId: selection.workspaceId,
            executionId: selection.executionId,
            attemptId: selection.attemptId,
            selectionRef: selection.selectionRef,
            selectionRevision: selection.selectionRevision,
            expiresAt: selection.expiresAt,
          },
        },
      }
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
  return createLeadTurnSdkAdapter({
    ...transport,
    preparationSchema: { parse: (value) => value },
  }).prepare!(authority)
}
const stated = {
  schemaVersion: 'pi-lead-child-allowance/v1',
  executionPlanDigest: digest,
  profile: { profileId: 'p', profileVersionId: 'pv', version: 1, revision: 1 },
  state: 'stated',
  currency: 'USD',
  maximumMicrounits: 2_500_000,
  maximumTokens: 120_000,
}
test('prepare projects the child allowance disclosure and keeps an absent one absent', async () => {
  expect(await preparedWith(stated)).toEqual({
    ...selection,
    childAllowance: {
      state: 'stated',
      executionPlanDigest: digest,
      currency: 'USD',
      maximumMicrounits: 2_500_000,
      maximumTokens: 120_000,
    },
  })
  expect(
    await preparedWith({
      schemaVersion: 'pi-lead-child-allowance/v1',
      executionPlanDigest: digest,
      profile: stated.profile,
      state: 'not_stated',
    })
  ).toEqual({
    ...selection,
    childAllowance: { state: 'not_stated', executionPlanDigest: digest },
  })
  const absent = await preparedWith()
  expect(absent).toEqual(selection)
  expect('childAllowance' in absent).toBe(false)
})

test('prepare fails closed on a malformed child allowance disclosure', async () => {
  for (const bad of [
    { ...stated, schemaVersion: 'pi-lead-child-allowance/v2' },
    { ...stated, executionPlanDigest: 'sha256:short' },
    { ...stated, currency: 'EUR' },
    { ...stated, maximumMicrounits: -1 },
    { ...stated, maximumTokens: 1.5 },
    { ...stated, state: 'unknown' },
  ])
    await expect(preparedWith(bad)).rejects.toThrow('RUNTIME_RESPONSE_INVALID')
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

// The released SDK decides which operations exist. The port reads the installed SDK's own
// exports, so a capability the released SDK does not ship stays disabled instead of being
// emulated, and a later SDK that ships it flips the flag on its own.
test('the port capabilities follow the installed SDK surface exactly', async () => {
  const { ControlApiOperations, ControlPlaneClient } = await import('@adea-ai/sdk')
  const shipped = (method: string): boolean =>
    Boolean(Reflect.get(ControlApiOperations, method)) &&
    typeof Reflect.get(ControlPlaneClient.prototype, method) === 'function'

  expect(installedLeadSdkPort.childrenSupported).toBe(shipped('getPiDurableLeadChildren'))
  expect(installedLeadSdkPort.childPublicationSupported).toBe(
    shipped('getPiDurableChildPublication')
  )
  // The lead path stays usable while an optional child capability is missing.
  expect(installedLeadSdkPort.supported).toBe(true)
  expect(LEAD_SDK_METHODS).toContain('getPiDurableChildPublication')
})

// The released SDK does not ship a child-publication read yet. The capability must stay off and
// the composition must not present a child-publication operation for it, so no native or
// provider acceptance is claimed for a method that does not exist.
test('an unshipped child-publication capability stays disabled', async () => {
  const { ControlApiOperations, ControlPlaneClient } = await import('@adea-ai/sdk')
  const shipped =
    Boolean(Reflect.get(ControlApiOperations, 'getPiDurableChildPublication')) &&
    typeof Reflect.get(ControlPlaneClient.prototype, 'getPiDurableChildPublication') === 'function'
  if (shipped) {
    expect(installedLeadSdkPort.childPublicationSupported).toBe(true)
    return
  }
  expect(installedLeadSdkPort.childPublicationSupported).toBe(false)
})
