import { describe, expect, test } from 'bun:test'

import {
  DRAG_ACTIVATE_PX,
  DROP_HYSTERESIS_PX,
  dragBarZone,
  reduceDragBar,
  type DragBarEvent,
  type DragBarGesture,
} from '../src/source-control-app/model/drag-bar'

const press = (
  overrides: Partial<Extract<DragBarEvent, { type: 'press' }>> = {}
): DragBarEvent => ({
  type: 'press',
  repoId: 'repo-1',
  pointerId: 7,
  origin: 'above',
  y: 100,
  barY: 300,
  ...overrides,
})

/** A press plus enough downward travel to become a drag. */
function dragging(overrides: Partial<Extract<DragBarEvent, { type: 'press' }>> = {}): {
  gesture: DragBarGesture
  move: (y: number) => DragBarGesture | undefined
} {
  const down = press(overrides)
  const outcome = reduceDragBar(undefined, down)
  if (!outcome.gesture) throw new Error('press did not start a gesture')
  const activated = reduceDragBar(outcome.gesture, {
    type: 'move',
    pointerId: down.pointerId,
    y: down.y + DRAG_ACTIVATE_PX,
  })
  if (!activated.gesture || activated.gesture.phase !== 'drag')
    throw new Error('travel did not activate the drag')
  return {
    gesture: activated.gesture,
    move: (y: number) =>
      reduceDragBar(activated.gesture, { type: 'move', pointerId: down.pointerId, y }).gesture,
  }
}

describe('dragBarZone', () => {
  test('flips only on a clear crossing of the line', () => {
    // Exactly on the line and inside the hysteresis band: the origin holds.
    expect(dragBarZone(300, 300, 'above')).toBe('above')
    expect(dragBarZone(300 + DROP_HYSTERESIS_PX, 300, 'above')).toBe('above')
    expect(dragBarZone(300 - DROP_HYSTERESIS_PX, 300, 'below')).toBe('below')
    // Past the band the zone follows the pointer, from either origin.
    expect(dragBarZone(300 + DROP_HYSTERESIS_PX + 1, 300, 'above')).toBe('below')
    expect(dragBarZone(300 - DROP_HYSTERESIS_PX - 1, 300, 'below')).toBe('above')
  })
})

describe('reduceDragBar', () => {
  test('a press alone never drops: a click never toggles', () => {
    const started = reduceDragBar(undefined, press())
    expect(started.gesture?.phase).toBe('press')
    expect(started.consumed).toBe(false)
    const released = reduceDragBar(started.gesture, { type: 'release', pointerId: 7 })
    expect(released.gesture).toBeUndefined()
    expect(released.drop).toBeUndefined()
    expect(released.consumed).toBe(false)
  })

  test('travel below the activation threshold stays a press', () => {
    const started = reduceDragBar(undefined, press())
    const nudged = reduceDragBar(started.gesture, {
      type: 'move',
      pointerId: 7,
      y: 100 + DRAG_ACTIVATE_PX - 1,
    })
    expect(nudged.gesture?.phase).toBe('press')
    expect(nudged.consumed).toBe(false)
  })

  test('real travel activates the drag with the origin as the armed zone', () => {
    const { gesture } = dragging()
    expect(gesture.phase).toBe('drag')
    expect(gesture.zone).toBe('above')
  })

  test('dropping below the bar hides the row', () => {
    const { move } = dragging()
    const armed = move(300 + DROP_HYSTERESIS_PX + 5)
    expect(armed?.zone).toBe('below')
    const released = reduceDragBar(armed, { type: 'release', pointerId: 7 })
    expect(released.drop).toEqual({ repoId: 'repo-1', hidden: true })
    expect(released.consumed).toBe(true)
    expect(released.gesture).toBeUndefined()
  })

  test('dragging a hidden row above the bar restores it', () => {
    const { gesture, move } = dragging({ origin: 'below', y: 400, barY: 300 })
    expect(gesture.origin).toBe('below')
    const armed = move(300 - DROP_HYSTERESIS_PX - 5)
    expect(armed?.zone).toBe('above')
    const released = reduceDragBar(armed, { type: 'release', pointerId: 7 })
    expect(released.drop).toEqual({ repoId: 'repo-1', hidden: false })
    expect(released.consumed).toBe(true)
  })

  test('a drag that lands on its own side is a no-op, not a reorder', () => {
    const { move } = dragging()
    // Travel far down the visible list but never across the line.
    const sameSide = move(250)
    expect(sameSide?.zone).toBe('above')
    const released = reduceDragBar(sameSide, { type: 'release', pointerId: 7 })
    expect(released.drop).toBeUndefined()
    // The gesture was still a drag: it must not end in the row's click.
    expect(released.consumed).toBe(true)
  })

  test('release inside the hysteresis band keeps the origin side', () => {
    const { move } = dragging()
    const hovering = move(300 + 4)
    expect(hovering?.zone).toBe('above')
    const released = reduceDragBar(hovering, { type: 'release', pointerId: 7 })
    expect(released.drop).toBeUndefined()
  })

  test('events from another pointer are ignored while a drag is live', () => {
    const started = reduceDragBar(undefined, press())
    const stranger = reduceDragBar(started.gesture, { type: 'move', pointerId: 8, y: 500 })
    expect(stranger.gesture?.phase).toBe('press')
    const strangerUp = reduceDragBar(started.gesture, { type: 'release', pointerId: 8 })
    expect(strangerUp.gesture?.phase).toBe('press')
    const own = reduceDragBar(started.gesture, { type: 'release', pointerId: 7 })
    expect(own.gesture).toBeUndefined()
  })

  test('a second press while a gesture is live changes nothing', () => {
    const { gesture } = dragging()
    const again = reduceDragBar(gesture, press({ repoId: 'repo-2', y: 40 }))
    expect(again.gesture?.repoId).toBe('repo-1')
    expect(again.consumed).toBe(false)
  })

  test('Escape aborts without a drop and consumes the pointer', () => {
    const { move } = dragging()
    const armed = move(340)
    const aborted = reduceDragBar(armed, { type: 'escape' })
    expect(aborted.gesture).toBeUndefined()
    expect(aborted.drop).toBeUndefined()
    expect(aborted.consumed).toBe(true)
  })

  test('cancellation aborts even a mere press cleanly', () => {
    const started = reduceDragBar(undefined, press())
    const aborted = reduceDragBar(started.gesture, { type: 'cancel' })
    expect(aborted.gesture).toBeUndefined()
    expect(aborted.drop).toBeUndefined()
    expect(aborted.consumed).toBe(true)
  })

  test('events after the gesture ended are inert', () => {
    const released = reduceDragBar(undefined, { type: 'release', pointerId: 7 })
    expect(released).toEqual({ gesture: undefined, consumed: false })
    const stray = reduceDragBar(undefined, { type: 'move', pointerId: 7, y: 1 })
    expect(stray).toEqual({ gesture: undefined, consumed: false })
    const ghost = reduceDragBar(undefined, { type: 'cancel' })
    expect(ghost).toEqual({ gesture: undefined, consumed: false })
  })

  test('the zone tracks the pointer back out of the band while dragging', () => {
    const { move } = dragging()
    const down = move(340)
    expect(down?.zone).toBe('below')
    const back = move(300)
    expect(back?.zone).toBe('above')
    const released = reduceDragBar(back, { type: 'release', pointerId: 7 })
    expect(released.drop).toBeUndefined()
  })
})
