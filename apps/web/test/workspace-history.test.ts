import { expect, test } from 'bun:test'
import { workspaceHistoryPosition } from '../src/lib/workspace-history'

test('router history advertises only proven positions and truncates forward on push', () => {
  let state = workspaceHistoryPosition(undefined, 'REPLACE', 0)
  expect(state).toEqual({ maximum: 0, canGoBack: false, canGoForward: false })
  state = workspaceHistoryPosition(state.maximum, 'PUSH', 1)
  expect(state.canGoBack).toBe(true)
  state = workspaceHistoryPosition(state.maximum, 'BACK', 0)
  expect(state.canGoForward).toBe(true)
  state = workspaceHistoryPosition(state.maximum, 'REPLACE', 0)
  expect(state.canGoForward).toBe(true)
  state = workspaceHistoryPosition(state.maximum, 'PUSH', 1)
  expect(state.canGoForward).toBe(false)
})

test('missing, negative, fractional, and non-finite router bookkeeping disables arrows', () => {
  for (const index of [undefined, null, -1, 1.5, NaN, Infinity, '1']) {
    expect(workspaceHistoryPosition(2, 'BACK', index)).toEqual({
      maximum: undefined,
      canGoBack: false,
      canGoForward: false,
    })
  }
})

test('a restored watermark survives traversal; a fresh arrival collapses it', () => {
  expect(workspaceHistoryPosition(3, 'REPLACE', 1).canGoForward).toBe(true)
  expect(workspaceHistoryPosition(undefined, 'REPLACE', 1).canGoForward).toBe(false)
})
