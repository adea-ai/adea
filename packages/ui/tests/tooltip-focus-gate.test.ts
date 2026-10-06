import { expect, test } from 'bun:test'
import {
  installTooltipFocusGate,
  isButtonLikeFocusTarget,
  shouldSuppressTooltipFocus,
} from '../src/lib/tooltip-focus-gate'

test('the suppression decision hides button-like focus only outside keyboard navigation', () => {
  expect(shouldSuppressTooltipFocus({ isButtonLike: true, keyboardIntentActive: false })).toBe(true)
  expect(shouldSuppressTooltipFocus({ isButtonLike: true, keyboardIntentActive: true })).toBe(false)
  expect(shouldSuppressTooltipFocus({ isButtonLike: false, keyboardIntentActive: false })).toBe(
    false
  )
  expect(shouldSuppressTooltipFocus({ isButtonLike: false, keyboardIntentActive: true })).toBe(
    false
  )
})

test('button-like focus targets duck-type through closest', () => {
  const button = { closest: () => ({}) }
  const plain = { closest: () => null }
  expect(isButtonLikeFocusTarget(button)).toBe(true)
  expect(isButtonLikeFocusTarget(plain)).toBe(false)
  expect(isButtonLikeFocusTarget(null)).toBe(false)
  expect(isButtonLikeFocusTarget(undefined)).toBe(false)
  expect(isButtonLikeFocusTarget({})).toBe(false)
})

type RecordedListener = (event: unknown) => void

/** Minimal capture-phase document stand-in: records listeners, returns a
 *  dispatcher so tests drive real call order without a DOM. */
function stubDocument() {
  const listeners = new Map<string, RecordedListener[]>()
  const doc = {
    addEventListener(type: string, listener: RecordedListener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener])
    },
    removeEventListener(type: string, listener: RecordedListener) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((registered) => registered !== listener)
      )
    },
    dispatch(type: string, event: unknown) {
      for (const listener of listeners.get(type) ?? []) listener(event)
    },
    listenerCount(type: string) {
      return (listeners.get(type) ?? []).length
    },
  }
  return doc
}

test('the gate stops programmatic focus onto button-like controls and lets the rest through', () => {
  const doc = stubDocument()
  const dispose = installTooltipFocusGate(doc as unknown as Document)
  expect(doc.listenerCount('keydown')).toBe(1)
  expect(doc.listenerCount('focus')).toBe(1)

  // Autofocus after a pointer interaction (dialog/sheet open): suppressed.
  const buttonFocus = { target: { closest: () => ({}) }, stopPropagationCalls: 0 }
  ;(buttonFocus as { stopPropagation: () => void }).stopPropagation = () => {
    buttonFocus.stopPropagationCalls += 1
  }
  doc.dispatch('keydown', { key: 'Enter' })
  doc.dispatch('focus', buttonFocus)
  expect(buttonFocus.stopPropagationCalls).toBe(1)

  // Tab navigation directly before the focus: the tooltip stays reachable.
  const tabFocus = {
    target: { closest: () => ({}) },
    stopPropagation: () => {
      throw new Error('keyboard-intent focus must not be suppressed')
    },
  }
  doc.dispatch('keydown', { key: 'Tab' })
  doc.dispatch('focus', tabFocus)
  expect(() => doc.dispatch('focus', tabFocus)).not.toThrow()

  // Non-button targets keep their native focus behaviour.
  const inputFocus = {
    target: { closest: () => null },
    stopPropagation: () => {
      throw new Error('non-button focus must not be suppressed')
    },
  }
  expect(() => doc.dispatch('focus', inputFocus)).not.toThrow()

  dispose()
  expect(doc.listenerCount('keydown')).toBe(0)
  expect(doc.listenerCount('focus')).toBe(0)
})

test('installing twice on one document adds the listeners only once', () => {
  const doc = stubDocument()
  const first = installTooltipFocusGate(doc as unknown as Document)
  const second = installTooltipFocusGate(doc as unknown as Document)
  expect(doc.listenerCount('keydown')).toBe(1)
  expect(doc.listenerCount('focus')).toBe(1)
  first()
  second()
  expect(doc.listenerCount('keydown')).toBe(0)
  expect(doc.listenerCount('focus')).toBe(0)
})
