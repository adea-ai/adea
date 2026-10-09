import { expect, test } from 'bun:test'

import {
  captureDialogBackgroundState,
  restoreDialogBackgroundState,
} from '../../src/dialog-background-state'

function fakeElement(attributes: Record<string, string> = {}) {
  const store = new Map(Object.entries(attributes))
  return {
    getAttribute: (name: string) => store.get(name) ?? null,
    setAttribute: (name: string, value: string) => void store.set(name, value),
    removeAttribute: (name: string) => void store.delete(name),
    hasAttribute: (name: string) => store.has(name),
    snapshot: () => Object.fromEntries(store),
  }
}

const body = (pointerEvents = '') => ({ style: { pointerEvents } })
const noOtherModal = () => false
const otherModal = () => true

test('a late aria-hidden write is removed and the captured state is restored', () => {
  const element = fakeElement()
  const captured = captureDialogBackgroundState(element, body())
  expect(captured).toEqual({ ariaHidden: null, inert: false, bodyPointerEvents: '' })

  // The modal wrote aria-hidden before it closed; the late write is what is
  // left afterwards.
  element.setAttribute('aria-hidden', 'true')
  expect(
    restoreDialogBackgroundState({ element, body: body(), captured, hasOtherModal: noOtherModal })
  ).toBe(true)
  expect(element.getAttribute('aria-hidden')).toBeNull()
})

test('a pre-existing aria-hidden value is restored, not removed', () => {
  const element = fakeElement({ 'aria-hidden': 'false' })
  const captured = captureDialogBackgroundState(element, body())
  element.setAttribute('aria-hidden', 'true')
  restoreDialogBackgroundState({ element, body: body(), captured, hasOtherModal: noOtherModal })
  expect(element.getAttribute('aria-hidden')).toBe('false')
})

test('another active modal keeps ownership of the background', () => {
  const element = fakeElement()
  const captured = captureDialogBackgroundState(element, body())
  element.setAttribute('aria-hidden', 'true')
  expect(
    restoreDialogBackgroundState({ element, body: body(), captured, hasOtherModal: otherModal })
  ).toBe(false)
  expect(element.getAttribute('aria-hidden')).toBe('true')
})

test('pre-existing inert and pointer-events state is preserved', () => {
  const element = fakeElement({ inert: '' })
  const captured = captureDialogBackgroundState(element, body('auto'))
  expect(captured).toEqual({ ariaHidden: null, inert: true, bodyPointerEvents: 'auto' })

  // A modal-added inert on a frame that had none is removed; a pre-existing
  // one is left alone by the capture rule.
  const plain = fakeElement()
  const plainCaptured = captureDialogBackgroundState(plain, body())
  plain.setAttribute('inert', '')
  restoreDialogBackgroundState({
    element: plain,
    body: body(),
    captured: plainCaptured,
    hasOtherModal: noOtherModal,
  })
  expect(plain.hasAttribute('inert')).toBe(false)

  // Body pointer-events is restored to its captured value, and a captured
  // 'none' is left as the owner wants it.
  const pointerBody = body('')
  pointerBody.style.pointerEvents = 'none'
  restoreDialogBackgroundState({
    element,
    body: pointerBody,
    captured,
    hasOtherModal: noOtherModal,
  })
  expect(pointerBody.style.pointerEvents).toBe('auto')
})

test('missing capture or element is a no-op', () => {
  expect(
    restoreDialogBackgroundState({
      element: undefined,
      body: body(),
      captured: undefined,
      hasOtherModal: noOtherModal,
    })
  ).toBe(false)
  expect(captureDialogBackgroundState(null, body())).toBeUndefined()
})
