import { expect, test } from 'bun:test'
import { decodeRuntimeUsageObservedPayload } from '../src/dev-runtime-usage'
import { decodeRuntimeUsageObservedPayload as aggregate } from '../src/dev-runtime'
import { decodeCbor, decodeRuntimeEvent, encodeCbor } from '../src/dev-runtime-wire'

const payload = {
  schemaVersion: 1,
  model: { providerId: 'provider-a', modelId: 'model-a' },
  generation: 2,
  context: { used: 12, total: 128 },
}
const event = (usage: unknown) => ({
  schemaVersion: 1,
  eventId: 'usage-1',
  runtimeSessionId: 'session-1',
  harnessRunId: 'run-1',
  generation: 2,
  seq: '1',
  occurredAt: '2026-10-18T00:00:00Z',
  receivedAt: '2026-10-18T00:00:00Z',
  source: 'native',
  sourceEventId: 'usage-1',
  confidence: 'authoritative',
  classification: 'workspace_metadata',
  kind: 'usage.observed',
  payload: usage,
})
for (const field of ['providerId', 'modelId'] as const) {
  for (const bad of ['\ud800', '\udc00', 'prefix\ud800suffix', 'prefix\udc00suffix']) {
    test(`usage ${field} rejects ill-formed Unicode ${JSON.stringify(bad)} before admission`, () => {
      const usage = { ...payload, model: { ...payload.model, [field]: bad } }
      expect(() => decodeRuntimeUsageObservedPayload(usage, 2)).toThrow('ill-formed Unicode')
      expect(() => aggregate(usage, 2)).toThrow('ill-formed Unicode')
      expect(() => decodeRuntimeEvent(event(usage), { source: 'native' })).toThrow()
    })
  }
  test(`usage ${field} preserves valid astral pairs through decode/CBOR/decode`, () => {
    const usage = { ...payload, model: { ...payload.model, [field]: 'model-🚀-𐐷' } }
    const admitted = decodeRuntimeEvent(event(usage), { source: 'native' })
    expect(decodeRuntimeUsageObservedPayload(usage, 2)).toEqual(usage)
    expect(aggregate(usage, 2)).toEqual(usage)
    const replay = decodeRuntimeEvent(decodeCbor(encodeCbor(admitted)).value, { source: 'native' })
    expect(replay).toEqual(admitted)
    expect(replay.payload).toEqual(usage)
  })
}
