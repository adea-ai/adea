import { createHash } from 'node:crypto'
import { SuccessResponseEnvelopeSchema } from '@adea-ai/contracts'
import { createConfiguredLeadTurnDependencies } from '../../src/server/lead-turn-composition'
import type { LeadSdkMethod, LeadSdkPort } from '../../src/server/lead-turn-sdk-port'

/** Mock CP transport only; signing and Adea composition use their real implementations. */
export async function timelineCompositionFixture(input: {
  workspaceId: string
  intentId: string
  originalActorRef: string
  text?: string
}) {
  const text = input.text ?? 'Accepted answer\n'
  const expiry = new Date(Date.now() + 300_000).toISOString()
  const prepared = {
    ...input,
    executionId: `exe_${'0'.repeat(26)}`,
    attemptId: `att_${'0'.repeat(26)}`,
    selectionRef: `msel_${'a'.repeat(32)}`,
    selectionRevision: 1,
    preparationRef: `prep_${'a'.repeat(32)}`,
    expiresAt: expiry,
  }
  const binding = {
    schemaVersion: 'pi-lead-dispatch/v1',
    intentId: input.intentId,
    dispatchId: `dispatch_${'a'.repeat(32)}`,
    executionId: prepared.executionId,
    attemptId: prepared.attemptId,
    runtimeSessionId: `ses_${'0'.repeat(26)}`,
  }
  let publication = {
    ...prepared,
    ...binding,
    schemaVersion: 'pi-lead-publication/v1',
    canonicalActorPrincipalId: input.originalActorRef,
    authorityRevision: 1,
    resultContentDigest: `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`,
  }
  const originalPublication = { ...publication }
  const calls: { method: LeadSdkMethod; body: Record<string, unknown> }[] = []
  let denied = false
  let malformed: LeadSdkMethod | undefined
  let envelopeFault: 'request' | 'unknown' | 'missingData' | undefined
  let envelopeFaultMethod: LeadSdkMethod = 'dispatchPiDurableLead'
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const port: LeadSdkPort = {
    supported: true,
    preparationSchema: { parse: (value) => value },
    lookupResponseSchema: { parse: (value) => value },
    async invoke(method, _credential, body) {
      calls.push({ method, body })
      if (method === 'getPiDurableLeadPublication' && denied) throw new Error('denied')
      const funding = { ...prepared, schemaVersion: 'model-funding-display/v1', state: 'ready' }
      const data =
        method === 'preparePiDurableLead'
          ? { ...prepared, schemaVersion: 'pi-lead-preparation/v1', funding, replayed: false }
          : method === 'getModelSelectionFunding'
            ? { funding }
            : method === 'getPiDurableLeadPublication'
              ? { publication }
              : method === 'lookupPiDurableLead'
                ? {
                    schemaVersion: 'pi-lead-lookup/v1',
                    workspaceId: input.workspaceId,
                    intentId: input.intentId,
                    receipt: null,
                  }
                : method === 'getPiDurableLeadStatus'
                  ? {
                      ...binding,
                      state: 'completed',
                      status: {
                        observedAt: new Date().toISOString(),
                        result: { output: { text } },
                      },
                    }
                  : method === 'getPiDurableLeadProgress'
                    ? {
                        ...binding,
                        events: [],
                        nextSequence: Number(
                          (body.parameters as Record<string, unknown>).afterSequence
                        ),
                      }
                    : {
                        ...binding,
                        state: method === 'cancelPiDurableLead' ? 'cancelling' : 'running',
                        replayed: false,
                      }
      const response: Record<string, unknown> = {
        contractVersion: body.contractVersion,
        requestId: body.requestId,
        correlation: body.correlation,
        data: method === malformed ? { ...data, schemaVersion: 'wrong' } : data,
      }
      if (method === envelopeFaultMethod && envelopeFault === 'request')
        response.requestId = 'invalid-request'
      if (method === envelopeFaultMethod && envelopeFault === 'unknown')
        response.callerAuthority = 'untrusted'
      if (method === envelopeFaultMethod && envelopeFault === 'missingData') delete response.data
      // Real installed base envelope grammar only. New lead DTO parsers and actual SDK
      // transport remain unqualified until #996's released packages are available.
      return SuccessResponseEnvelopeSchema.strict().parse(response)
    },
  }
  const dependencies = await createConfiguredLeadTurnDependencies(
    {
      resolveControlPlaneScope: async () => ({ workspaceId: input.workspaceId }),
      environment: {
        PI_DURABLE_LEAD_ENABLED: 'true',
        PI_DURABLE_LEAD_TARGET: JSON.stringify({
          location: 'remote_host',
          harness: 'pi_durable',
          harnessVersion: '1.1.0',
          providerBinding: 'pi_durable_models',
        }),
        CONTROL_PLANE_SIGNING_KEY: JSON.stringify(
          await crypto.subtle.exportKey('jwk', pair.privateKey)
        ),
        CONTROL_PLANE_SIGNING_KEY_ID: 'synthetic-timeline-key',
        CONTROL_PLANE_SIGNING_ISSUER: 'https://synthetic.invalid',
      },
    },
    undefined,
    port
  )
  return {
    dependencies,
    prepared,
    binding,
    calls,
    text,
    resetPublication: () => {
      publication = { ...originalPublication }
    },
    denyPublication: (value: boolean) => {
      denied = value
    },
    changePublication: (value: Partial<typeof publication>) => {
      publication = { ...publication, ...value }
    },
    envelopeFailure: (
      value?: 'request' | 'unknown' | 'missingData',
      method: LeadSdkMethod = 'dispatchPiDurableLead'
    ) => {
      envelopeFault = value
      envelopeFaultMethod = method
    },
    malformedResponse: (method?: LeadSdkMethod) => {
      malformed = method
    },
  }
}
