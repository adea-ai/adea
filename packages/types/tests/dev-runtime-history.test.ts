import { expect, test } from 'bun:test'
import { decodeRuntimeEventHistoryPage } from '../src/dev-runtime-history'

const empty = {
  runtimeSessionId: 'session',
  generation: 1,
  beforeSequence: '1',
  retainedFromSequence: null,
  retainedThroughSequence: null,
  historyStart: 'unavailable',
  items: [],
}
test('history replies are exact, bounded, and cannot assert invented retained history', () => {
  expect(decodeRuntimeEventHistoryPage(empty)).toEqual(empty)
  for (const bad of [
    { ...empty, unknown: true },
    { ...empty, generation: -1 },
    { ...empty, beforeSequence: '01' },
    { ...empty, historyStart: 'generation_start' },
    {
      ...empty,
      historyStart: 'retention_boundary',
      retainedFromSequence: '0',
      retainedThroughSequence: '4',
    },
    { ...empty, nextCursor: 'loop' },
    { ...empty, items: Array.from({ length: 501 }, () => ({})) },
    { ...empty, runtimeSessionId: 'x'.repeat(225 * 1024) },
  ])
    expect(() => decodeRuntimeEventHistoryPage(bad)).toThrow()
})
