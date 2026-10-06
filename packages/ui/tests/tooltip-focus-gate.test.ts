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

test('resize grips rendered as separator buttons keep their native focus', () => {
  const separator = { closest: () => ({ getAttribute: () => 'separator' }) }
  const roleButton = { closest: () => ({ getAttribute: () => 'button' }) }
  expect(isButtonLikeFocusTarget(separator)).toBe(false)
  expect(isButtonLikeFocusTarget(roleButton)).toBe(true)
})

test('a drag-started focus on a resize grip is never released by the next pointer move', () => {
  const doc = stubDocument()
  const dispose = installTooltipFocusGate(doc as unknown as Document)
  let blurred = false
  const grip = {
    closest: () => ({ getAttribute: () => 'separator' }),
    blur: () => {
      blurred = true
    },
  }
  const focus = focusEvent(grip)
  doc.activeElement = grip
  doc.dispatch('focus', focus)
  doc.dispatch('pointermove', {})
  expect(focus.stopPropagationCalls).toBe(0)
  expect(blurred).toBe(false)
  dispose()
})

type RecordedListener = (event: unknown) => void

/** Minimal capture-phase document stand-in: records listeners, returns a
 *  dispatcher so tests drive real call order without a DOM. */
function stubDocument() {
  const listeners = new Map<string, RecordedListener[]>()
  const doc = {
    activeElement: null as unknown,
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

function buttonTarget() {
  return { closest: () => ({}) }
}

function focusEvent(target: unknown) {
  const event = {
    target,
    stopPropagationCalls: 0,
    stopPropagation() {
      event.stopPropagationCalls += 1
    },
  }
  return event
}

test('the gate stops programmatic focus onto button-like controls and lets the rest through', () => {
  const doc = stubDocument()
  const dispose = installTooltipFocusGate(doc as unknown as Document)
  expect(doc.listenerCount('keydown')).toBe(1)
  expect(doc.listenerCount('focus')).toBe(1)

  // Autofocus after a pointer interaction (dialog/sheet open): suppressed.
  const buttonFocus = focusEvent(buttonTarget())
  doc.dispatch('keydown', { key: 'Enter' })
  doc.dispatch('focus', buttonFocus)
  expect(buttonFocus.stopPropagationCalls).toBe(1)

  // Tab navigation directly before the focus: the tooltip stays reachable.
  const tabFocus = {
    target: buttonTarget(),
    stopPropagation: () => {
      throw new Error('keyboard-intent focus must not be suppressed')
    },
  }
  doc.dispatch('keydown', { key: 'Tab' })
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
  expect(doc.listenerCount('pointermove')).toBe(0)
  expect(doc.listenerCount('pointerdown')).toBe(0)
})

test('a suppressed focus is released by the next pointer activity while it still holds focus', () => {
  const doc = stubDocument()
  const dispose = installTooltipFocusGate(doc as unknown as Document)

  const phantom = {
    closest: () => ({}),
    blurred: 0,
    blur() {
      phantom.blurred += 1
    },
  }
  doc.activeElement = phantom
  doc.dispatch('keydown', { key: 'Enter' })
  doc.dispatch('focus', focusEvent(phantom))

  // The pointer taking over from the script releases the phantom focus, so
  // the published close-refusal can never pin a later hover tooltip to it.
  doc.dispatch('pointermove', {})
  expect(phantom.blurred).toBe(1)

  // Released once: with focus gone, later pointer activity is a no-op.
  doc.dispatch('pointermove', {})
  expect(phantom.blurred).toBe(1)

  dispose()
})

test('a phantom that already lost focus is dropped without a blur', () => {
  const doc = stubDocument()
  const dispose = installTooltipFocusGate(doc as unknown as Document)

  const phantom = {
    closest: () => ({}),
    blurred: 0,
    blur() {
      phantom.blurred += 1
    },
  }
  doc.dispatch('keydown', { key: 'Enter' })
  doc.dispatch('focus', focusEvent(phantom))
  // The user Tabbed away (or focus moved for another reason) before any
  // pointer activity: nothing to release.
  doc.activeElement = null
  doc.dispatch('pointerdown', {})
  expect(phantom.blurred).toBe(0)

  dispose()
})

test('installing twice on one document adds the listeners only once', () => {
  const doc = stubDocument()
  const first = installTooltipFocusGate(doc as unknown as Document)
  const second = installTooltipFocusGate(doc as unknown as Document)
  expect(doc.listenerCount('keydown')).toBe(1)
  expect(doc.listenerCount('focus')).toBe(1)
  expect(doc.listenerCount('pointermove')).toBe(1)
  expect(doc.listenerCount('pointerdown')).toBe(1)
  first()
  second()
  expect(doc.listenerCount('keydown')).toBe(0)
  expect(doc.listenerCount('focus')).toBe(0)
  expect(doc.listenerCount('pointermove')).toBe(0)
  expect(doc.listenerCount('pointerdown')).toBe(0)
})
