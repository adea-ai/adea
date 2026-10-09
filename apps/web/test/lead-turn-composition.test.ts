import { expect, test } from 'bun:test'
import { SuccessResponseEnvelopeSchema } from '@adea-ai/contracts'
import { createConfiguredLeadTurnDependencies } from '../src/server/lead-turn-composition'
import { type LeadSdkPort } from '../src/server/lead-turn-sdk-port'
const workspaceId = `wsp_${'0'.repeat(26)}`
const actor = `user:${crypto.randomUUID()}` as const
const authority = {
  workspaceId: crypto.randomUUID(),
  controlPlaneWorkspaceId: workspaceId,
  intentId: crypto.randomUUID(),
  messageId: crypto.randomUUID(),
  originalActorRef: actor,
}
const prepared = {
  workspaceId,
  intentId: authority.intentId,
  executionId: `exe_${'0'.repeat(26)}`,
  attemptId: `att_${'0'.repeat(26)}`,
  selectionRef: `msel_${'a'.repeat(32)}`,
  selectionRevision: 1,
  preparationRef: `prep_${'a'.repeat(32)}`,
  expiresAt: '2100-01-01T00:00:00Z',
}
async function fixture() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const key = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey))
  const calls: {
    method: string
    body: Record<string, unknown>
    claims: Record<string, unknown>
  }[] = []
  let funding = { ...prepared, state: 'ready', expiresAt: prepared.expiresAt }
  let publication = {
    ...prepared,
    dispatchId: `dispatch_${'a'.repeat(32)}`,
    runtimeSessionId: `ses_${'0'.repeat(26)}`,
    canonicalActorPrincipalId: actor,
    resultContentDigest: `sha256:${'b'.repeat(64)}`,
    authorityRevision: 1,
  }
  const port: LeadSdkPort = {
    supported: true,
    preparationSchema: { parse: (data) => data },
    lookupResponseSchema: { parse: (data) => data },
    async invoke(method, credential, body) {
      const claims = JSON.parse(
        Buffer.from(credential.token.split('.')[1]!, 'base64url').toString()
      )
      calls.push({ method, body, claims })
      if (method === 'getModelSelectionFunding') return { data: { funding } }
      if (method === 'getPiDurableLeadPublication') return { data: { publication } }
      if (method === 'dispatchPiDurableLead') {
        // Installed public base envelope is real; the new lead DTO is a disclosed mock
        // until compatible public SDK/runtime schemas are released.
        return SuccessResponseEnvelopeSchema.strict().parse({
          contractVersion: body.contractVersion,
          requestId: body.requestId,
          correlation: body.correlation,
          data: {
            schemaVersion: 'pi-lead-dispatch/v1',
            dispatchId: publication.dispatchId,
            intentId: authority.intentId,
            executionId: prepared.executionId,
            attemptId: prepared.attemptId,
            runtimeSessionId: publication.runtimeSessionId,
            state: 'running',
            replayed: false,
          },
        })
      }
      return { data: {} }
    },
  }
  let resolutions = 0
  const dependencies = {
    resolveControlPlaneScope: async () => {
      resolutions++
      return { workspaceId }
    },
    environment: {
      PI_DURABLE_LEAD_ENABLED: 'true',
      PI_DURABLE_LEAD_TARGET: JSON.stringify({
        harness: 'pi_durable',
        harnessVersion: '1.1.0',
        location: 'remote_host',
        providerBinding: 'pi_durable_models',
      }),
      CONTROL_PLANE_SIGNING_KEY: key,
      CONTROL_PLANE_SIGNING_KEY_ID: 'synthetic-test-only',
      CONTROL_PLANE_SIGNING_ISSUER: 'https://fixture.invalid',
    },
  }
  return {
    calls,
    resolutions: () => resolutions,
    port,
    dependencies,
    setFunding: (value: typeof funding) => {
      funding = value
    },
    setPublication: (value: typeof publication) => {
      publication = value
    },
    publication,
  }
}
test('unconfigured and unsupported installed SDK cannot sign, admit, or invoke a provider', async () => {
  let resolutions = 0
  const dependencies = {
    resolveControlPlaneScope: async () => {
      resolutions++
      return { workspaceId }
    },
    environment: {},
  }
  expect(await createConfiguredLeadTurnDependencies(dependencies)).toEqual({})
  expect(resolutions).toBe(0)
  const f = await fixture()
  expect(
    await createConfiguredLeadTurnDependencies(f.dependencies, undefined, {
      ...f.port,
      supported: false,
    })
  ).toEqual({})
  expect(f.calls).toHaveLength(0)
})
test('configured composition signs only scoped reference commands and rechecks funding without starting', async () => {
  const f = await fixture()
  const composed = await createConfiguredLeadTurnDependencies(f.dependencies, undefined, f.port)
  expect(await composed.authorizeConfirmedStart!(authority, prepared)).toEqual(prepared)
  expect(f.calls[0]!.method).toBe('getModelSelectionFunding')
  expect(f.calls[0]!.claims.scopes).toEqual(['credential:read'])
  const dispatched = await composed.adapter!.dispatch(
    authority,
    `lead-turn:${authority.intentId}`,
    prepared
  )
  expect(dispatched).toEqual({
    schemaVersion: 'pi-lead-dispatch/v1',
    dispatchId: f.publication.dispatchId,
    intentId: authority.intentId,
    executionId: prepared.executionId,
    attemptId: prepared.attemptId,
    runtimeSessionId: f.publication.runtimeSessionId,
    state: 'running',
    replayed: false,
  })
  expect(f.calls[1]!.claims.scopes).toEqual(['execution:accept'])
  expect(f.calls[1]!.claims.workspaceIds).toEqual([workspaceId])
  expect(f.calls[1]!.body.payload).toEqual({
    intentId: authority.intentId,
    preparationRef: prepared.preparationRef,
  })
  expect(f.calls[1]!.body.idempotencyKey).toBe(`lead-turn:${authority.intentId}`)
  expect(f.calls[1]!.body).not.toHaveProperty('projectId')
  f.setFunding({ ...prepared, selectionRevision: 2, state: 'ready' })
  await expect(composed.authorizeConfirmedStart!(authority, prepared)).rejects.toThrow(
    'RUNTIME_RESPONSE_INVALID'
  )
  f.setFunding({ ...prepared, state: 'ready', expiresAt: 'invalid' })
  await expect(composed.authorizeConfirmedStart!(authority, prepared)).rejects.toThrow()
})
test('publication requires exact current actor, selection, receipt and unmodified output digest', async () => {
  const f = await fixture()
  const composed = await createConfiguredLeadTurnDependencies(f.dependencies, undefined, f.port)
  const expected = { ...authority, ...prepared, ...f.publication }
  await composed.adapter!.assertPublicationCurrent!(expected)
  expect(f.calls[0]!.body.parameters).toEqual({
    dispatchId: expected.dispatchId,
    preparationRef: expected.preparationRef,
  })
  expect(f.calls[0]!.claims.scopes).toEqual(['execution:read'])
  expect(f.resolutions()).toBe(1)
  f.setPublication({ ...f.publication, canonicalActorPrincipalId: `user:${crypto.randomUUID()}` })
  await expect(composed.adapter!.assertPublicationCurrent!(expected)).rejects.toThrow(
    'RUNTIME_RESPONSE_INVALID'
  )
  f.setPublication({ ...f.publication, resultContentDigest: `sha256:${'c'.repeat(64)}` })
  await expect(composed.adapter!.assertPublicationCurrent!(expected)).rejects.toThrow(
    'RUNTIME_RESPONSE_INVALID'
  )
  f.setPublication({ ...f.publication, preparationRef: `prep_${'c'.repeat(32)}` })
  await expect(composed.adapter!.assertPublicationCurrent!(expected)).rejects.toThrow(
    'RUNTIME_RESPONSE_INVALID'
  )
})
