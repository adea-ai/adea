import { describe, expect, test } from 'bun:test'

import { createDevKeyboardController, devShortcuts, isEditableTarget } from '../src/keyboard'
import type { DevShortcutActions } from '../src/keyboard'

function keyEvent(init: Partial<KeyboardEvent> & { key: string }): Event {
  const event = new Event('keydown', { cancelable: true })
  Object.assign(event, init)
  return event
}

function recordingActions(): DevShortcutActions & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    toggleFocusMode: () => calls.push('focus'),
    moveFocusedPane: ({ step, direction }) => calls.push(`move:${step}:${direction}`),
  }
}

describe('Dev keyboard controller', () => {
  test('registers focus and move shortcuts centrally and removes them on dispose', () => {
    const target = new EventTarget()
    const actions = recordingActions()
    const controller = createDevKeyboardController({ target, actions })

    target.dispatchEvent(keyEvent({ key: 'f', metaKey: true, shiftKey: true }))
    expect(actions.calls).toEqual(['focus'])

    target.dispatchEvent(keyEvent({ key: 'ArrowRight', ctrlKey: true, altKey: true }))
    expect(actions.calls).toEqual(['focus', 'move:1:row'])

    controller.dispose()
    target.dispatchEvent(keyEvent({ key: 'f', metaKey: true, shiftKey: true }))
    expect(actions.calls).toEqual(['focus', 'move:1:row'])
  })

  test('ignores editable targets and held repeats', () => {
    const target = new EventTarget()
    const actions = recordingActions()
    const controller = createDevKeyboardController({ target, actions })

    const inputLike = { tagName: 'INPUT' }
    const editableEvent = new Event('keydown', { cancelable: true })
    Object.assign(editableEvent, { key: 'f', metaKey: true, shiftKey: true })
    Object.defineProperty(editableEvent, 'target', { value: inputLike })
    target.dispatchEvent(editableEvent)
    expect(actions.calls).toEqual([])

    const repeat = new Event('keydown', { cancelable: true })
    Object.assign(repeat, { key: 'f', metaKey: true, shiftKey: true, repeat: true })
    target.dispatchEvent(repeat)
    expect(actions.calls).toEqual([])

    controller.dispose()
  })

  test('maps arrow move shortcuts to reading-order directions', () => {
    const actions = recordingActions()
    const shortcuts = devShortcuts(actions)
    const run = (key: string) => {
      const event = keyEvent({ key, ctrlKey: true, altKey: true })
      const shortcut = shortcuts.find((candidate) => candidate.test(event as KeyboardEvent))
      shortcut?.run(event as KeyboardEvent)
    }
    run('ArrowLeft')
    run('ArrowRight')
    run('ArrowUp')
    run('ArrowDown')
    expect(actions.calls).toEqual(['move:-1:row', 'move:1:row', 'move:-1:column', 'move:1:column'])
  })

  test('does not treat plain keys or wrong modifiers as shortcuts', () => {
    const actions = recordingActions()
    const shortcuts = devShortcuts(actions)
    const plain = keyEvent({ key: 'f' }) as KeyboardEvent
    const altShiftF = keyEvent({ key: 'f', altKey: true, shiftKey: true }) as KeyboardEvent
    expect(shortcuts.some((shortcut) => shortcut.test(plain))).toBe(false)
    expect(shortcuts.some((shortcut) => shortcut.test(altShiftF))).toBe(false)
    expect(actions.calls).toEqual([])
  })

  test('duck-typed editable detection works without DOM globals', () => {
    expect(isEditableTarget({ tagName: 'INPUT' })).toBe(true)
    expect(isEditableTarget({ tagName: 'textarea' })).toBe(true)
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(isEditableTarget({ tagName: 'DIV' })).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})
