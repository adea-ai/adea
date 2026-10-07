/*
 * The sidebar show-more drag bar's decision logic, kept DOM-free so the
 * above/below decision is testable on its own. A pointer gesture on a
 * repository row becomes a drag only after real travel, and the landing
 * zone flips only once the pointer clearly crosses the bar — a click never
 * toggles, and hovering near the line does not flicker the drop target.
 * Hiding itself stays the v1 display preference (`hiddenRepoIds`): the bar
 * only decides which side of the line a row belongs on.
 */

/** A row's place relative to the bar: the visible list or the collapsed group. */
export type DragBarZone = 'above' | 'below'

/** An active row gesture: a press that may still become a drag. */
export type DragBarGesture = Readonly<{
  phase: 'press' | 'drag'
  repoId: string
  pointerId: number
  /** Where the row started: its side of the bar before the gesture. */
  origin: DragBarZone
  /** Pointer y at press time, in viewport coordinates. */
  startY: number
  /** The bar line's y at press time, in viewport coordinates. */
  barY: number
  /** The armed landing zone; equals `origin` until the pointer crosses. */
  zone: DragBarZone
}>

/** Travel past which a press becomes a drag, in CSS pixels. */
export const DRAG_ACTIVATE_PX = 6
/** How far past the line the pointer must travel before the zone flips. */
export const DROP_HYSTERESIS_PX = 12

export type DragBarEvent =
  | Readonly<{
      type: 'press'
      repoId: string
      pointerId: number
      origin: DragBarZone
      y: number
      barY: number
    }>
  | Readonly<{ type: 'move'; pointerId: number; y: number }>
  | Readonly<{ type: 'release'; pointerId: number }>
  | Readonly<{ type: 'cancel' }>
  | Readonly<{ type: 'escape' }>

export type DragBarOutcome = Readonly<{
  /** The gesture after the event; undefined when the gesture is over. */
  gesture: DragBarGesture | undefined
  /** A release that crossed the line: the row's new hidden state to commit. */
  drop?: Readonly<{ repoId: string; hidden: boolean }>
  /**
   * The gesture consumed the pointer: a drag (or an aborted gesture) must
   * never end in the row's click — no selection, no toggle.
   */
  consumed: boolean
}>

/**
 * The landing zone for a pointer y. The flip needs a clear crossing: within
 * the hysteresis band around the line the row keeps its origin side, so the
 * armed drop target is stable exactly where the gesture is hardest to read.
 */
export function dragBarZone(y: number, barY: number, origin: DragBarZone): DragBarZone {
  if (y > barY + DROP_HYSTERESIS_PX) return 'below'
  if (y < barY - DROP_HYSTERESIS_PX) return 'above'
  return origin
}

/** Fold one pointer or key event into the active gesture. */
export function reduceDragBar(
  gesture: DragBarGesture | undefined,
  event: DragBarEvent
): DragBarOutcome {
  if (event.type === 'press') {
    if (gesture) return { gesture, consumed: false }
    return {
      gesture: {
        phase: 'press',
        repoId: event.repoId,
        pointerId: event.pointerId,
        origin: event.origin,
        startY: event.y,
        barY: event.barY,
        zone: event.origin,
      },
      consumed: false,
    }
  }
  if (!gesture) return { gesture: undefined, consumed: false }

  if (event.type === 'move') {
    if (event.pointerId !== gesture.pointerId) return { gesture, consumed: false }
    if (gesture.phase === 'press') {
      const activated = Math.abs(event.y - gesture.startY) >= DRAG_ACTIVATE_PX
      if (!activated) return { gesture, consumed: false }
      return {
        gesture: {
          ...gesture,
          phase: 'drag',
          zone: dragBarZone(event.y, gesture.barY, gesture.origin),
        },
        consumed: false,
      }
    }
    return {
      gesture: { ...gesture, zone: dragBarZone(event.y, gesture.barY, gesture.origin) },
      consumed: false,
    }
  }

  if (event.type === 'release') {
    if (event.pointerId !== gesture.pointerId) return { gesture, consumed: false }
    const drop =
      gesture.phase === 'drag' && gesture.zone !== gesture.origin
        ? { repoId: gesture.repoId, hidden: gesture.zone === 'below' }
        : undefined
    return { gesture: undefined, ...(drop ? { drop } : {}), consumed: gesture.phase === 'drag' }
  }

  // Cancel (pointer cancellation, lost capture) and Escape abort without a
  // drop; the aborted pointer must not fall through to the row's click.
  return { gesture: undefined, consumed: true }
}
