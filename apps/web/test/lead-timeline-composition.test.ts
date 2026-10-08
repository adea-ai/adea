import { expect, test } from 'bun:test'
import { timelineCompositionFixture } from './helpers/lead-timeline-composition-fixture'
import {
  createLeadTurnRuntime,
  type LeadRuntimeStore,
  type LeadRuntimeStored,
} from '../src/server/lead-turn-runtime'

async function fixture() {
  const intentId = crypto.randomUUID()
  const originalActorRef = `user:${crypto.randomUUID()}` as const
  const cpWorkspaceId = `wsp_${'0'.repeat(26)}`
  const cp = await timelineCompositionFixture({
    workspaceId: cpWorkspaceId,
    intentId,
    originalActorRef,
  })
  const scope = { workspaceId: crypto.randomUUID(), intentId, userId: originalActorRef.slice(5) }
  const authority = {
    ...scope,
    messageId: crypto.randomUUID(),
    controlPlaneWorkspaceId: cpWorkspaceId,
    originalActorRef,
  }
  let stored: LeadRuntimeStored | undefined
  const messages: string[] = []
  const store: LeadRuntimeStore = {
    authorize: async () => authority,
    read: async () => stored,
    prepare: async (_scope, pin) => {
      stored = {
        intentId,
        messageId: authority.messageId,
        ...pin,
        state: 'prepared',
        preparationExpiresAt: pin.expiresAt,
      }
    },
    pending: async () => {
      stored = { ...stored!, state: 'dispatch_pending' }
    },
    observe: async (_scope, value) => {
      stored = { ...stored!, ...value }
      return stored
    },
    recover: async (_scope, value) => {
      stored = { ...stored!, ...value }
      return stored
    },
    cancelRequested: async () => {},
    publish: async (_scope, _binding, text, check) => {
      await check()
      if (!stored!.publishedMessageId) {
        messages.push(text)
        stored = { ...stored!, publishedMessageId: crypto.randomUUID() }
      }
      return stored!.publishedMessageId!
    },
  }
  return { cp, scope, messages, runtime: createLeadTurnRuntime({ store, ...cp.dependencies }) }
}
test('normal configured composition decodes SDK envelopes through completion and exact-output publication replay', async () => {
  const f = await fixture()
  expect((await f.runtime.prepare(f.scope)).state).toBe('prepared')
  expect((await f.runtime.dispatch(f.scope)).state).toBe('running')
  expect((await f.runtime.progress(f.scope, 0)).nextSequence).toBe(0)
  const completed = await f.runtime.status(f.scope)
  expect(completed.state).toBe('completed')
  expect(completed.publishedMessageId).toBeString()
  expect((await f.runtime.status(f.scope)).publishedMessageId).toBe(completed.publishedMessageId)
  expect(f.messages).toEqual(['Accepted answer\n'])
  expect(f.cp.calls.filter((call) => call.method === 'dispatchPiDurableLead')).toHaveLength(1)
})
test('current publication denial or changed actor/attempt/digest withholds output; retry never redispatches', async () => {
  const f = await fixture()
  await f.runtime.prepare(f.scope)
  await f.runtime.dispatch(f.scope)
  f.cp.denyPublication(true)
  expect((await f.runtime.status(f.scope)).reasonCode).toBe('PUBLICATION_WITHHELD')
  f.cp.denyPublication(false)
  for (const change of [
    { canonicalActorPrincipalId: `user:${crypto.randomUUID()}` },
    { attemptId: `att_${'1'.repeat(26)}` },
    { resultContentDigest: `sha256:${'0'.repeat(64)}` },
  ]) {
    f.cp.resetPublication()
    f.cp.changePublication(change)
    expect((await f.runtime.status(f.scope)).reasonCode).toBe('PUBLICATION_WITHHELD')
  }
  expect(f.messages).toHaveLength(0)
  f.cp.resetPublication()
  expect((await f.runtime.status(f.scope)).publishedMessageId).toBeString()
  expect(f.messages).toEqual(['Accepted answer\n'])
  expect(f.cp.calls.filter((call) => call.method === 'dispatchPiDurableLead')).toHaveLength(1)
})
test('malformed dispatch envelope fails closed and cancellation decodes the SDK data without readiness inference', async () => {
  const f = await fixture()
  await f.runtime.prepare(f.scope)
  f.cp.malformedResponse('dispatchPiDurableLead')
  expect((await f.runtime.dispatch(f.scope)).reasonCode).toBe('RUNTIME_RESPONSE_INVALID')
  expect(f.messages).toHaveLength(0)
  const valid = await fixture()
  await valid.runtime.prepare(valid.scope)
  await valid.runtime.dispatch(valid.scope)
  expect((await valid.runtime.cancel(valid.scope)).state).toBe('cancelling')
})

test('installed base envelope parsing rejects malformed identity or extra authority before runtime publication', async () => {
  for (const fault of ['request', 'unknown', 'missingData'] as const) {
    const f = await fixture()
    await f.runtime.prepare(f.scope)
    f.cp.envelopeFailure(fault)
    const status = await f.runtime.dispatch(f.scope)
    expect(status.availability).toBe('unavailable')
    expect(status).not.toHaveProperty('runtimeSessionId')
    expect(f.messages).toHaveLength(0)
    expect(f.cp.calls.filter((call) => call.method === 'dispatchPiDurableLead')).toHaveLength(1)
  }
})
