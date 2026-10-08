import { describe, expect, test } from 'bun:test'
import { createCandidateLeadDispatch } from './lead-dispatch-consumer'

// Response-schema fixtures only; these identifiers never authorize real work.
const intentId = 'd3fe1131-0844-4bad-ae84-2014b504d576'
const dispatchId = `dispatch_${'1'.repeat(32)}`
const receipt = {
  schemaVersion: 'pi-lead-dispatch/v1',
  dispatchId,
  intentId,
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  runtimeSessionId: 'ses_01JABCDEF0123456789ABCDEFG',
}

function fixture(wrongResource: boolean) {
  return createCandidateLeadDispatch({
    baseUrl: 'http://127.0.0.1:43199',
    serviceToken: 'synthetic-fixture-token',
    workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
    servicePrincipalId: 'svc_pi-candidate-test',
    requestId: () => 'req_01JABCDEF0123456789ABCDEFG',
    traceId: () => 'trc_01JABCDEF0123456789ABCDEFG',
    commandId: () => 'cmd_01JABCDEF0123456789ABCDEFG',
    now: () => new Date('2026-10-08T12:00:00.000Z'),
    fetch: async (url, init) => {
      const request = JSON.parse(String(init?.body))
      const path = new URL(String(url)).pathname
      const boundReceipt = {
        ...receipt,
        ...(wrongResource
          ? {
              intentId: '6879a690-20cc-4ae6-931b-b22e71d51bdb',
              dispatchId: `dispatch_${'2'.repeat(32)}`,
            }
          : {}),
      }
      const status = {
        state: 'running',
        observedAt: '2026-10-08T12:00:00.000Z',
        handle: {
          handleId: 'fixture-handle',
          attemptId: receipt.attemptId,
          externalSessionId: receipt.runtimeSessionId,
          startedAt: '2026-10-08T12:00:00.000Z',
        },
      }
      const data = path.endsWith('/dispatch')
        ? { ...boundReceipt, state: 'running', replayed: false }
        : path.endsWith('/progress')
          ? { ...boundReceipt, events: [], nextSequence: 0 }
          : { ...boundReceipt, state: 'running', status }
      return Response.json({
        contractVersion: request.contractVersion,
        requestId: request.requestId,
        correlation: request.correlation,
        data,
      })
    },
  })
}

describe('packed SDK candidate lead consumer', () => {
  test('binds all four responses to the requested canonical resource', async () => {
    const consumer = fixture(false)
    expect((await consumer.dispatch(intentId)).intentId).toBe(intentId)
    expect((await consumer.status(dispatchId)).dispatchId).toBe(dispatchId)
    expect((await consumer.progress(dispatchId)).dispatchId).toBe(dispatchId)
    expect((await consumer.cancel(dispatchId)).dispatchId).toBe(dispatchId)
  })

  test('rejects correlated schema-valid responses for another intent or dispatch', async () => {
    const consumer = fixture(true)
    for (const call of [
      () => consumer.dispatch(intentId),
      () => consumer.status(dispatchId),
      () => consumer.progress(dispatchId),
      () => consumer.cancel(dispatchId),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'CANDIDATE_RESPONSE_MISMATCH' })
    }
  })
})
