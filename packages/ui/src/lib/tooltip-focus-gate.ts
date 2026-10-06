/*
 * Tooltips open on active hover over the control, or on keyboard focus that
 * follows a Tab key press. They must never open from programmatic focus: the
 * autofocus a dialog or sheet gives its first control, and the focus a closing
 * overlay restores to its opener, both land on buttons that carry tooltips —
 * and the tooltip primitive opens immediately on focus and pins the tooltip
 * until blur. That is the "tooltip auto-displays when a sheet opens" report,
 * and the pinned tooltip is the "tooltip gets stuck and never disappears"
 * report: the pointer is nowhere near the control, so no pointer leave ever
 * closes it.
 *
 * The tooltip trigger listens for the native `focus` event on the trigger
 * element, and the published primitives compose their own tooltips internally
 * (ActionButton builds one from its `tooltip` prop), so the single
 * interception point that covers every tooltip in the app is a capture-phase
 * `focus` listener on `document`. When focus lands without a keyboard-intent
 * signal on a button-like element, the event is stopped before any element
 * listener runs: the tooltip never learns about the focus. Hover opens are
 * untouched (they ride pointer events), and the separate `focusin` event
 * still flows, so dialog focus-cycle tracking, `:focus-visible` styling, and
 * focus restoration all keep working.
 *
 * The keyboard-intent signal is a Tab key press immediately before the focus —
 * the only key that moves focus natively. Enter and Space open overlays too,
 * so any "recent key" window wide enough for those would let an overlay's own
 * autofocus back through; Tab-only keeps autofocus suppressed no matter how
 * the overlay was opened, while normal Tab navigation still announces each
 * control's tooltip (hover descriptions stay reachable from the keyboard).
 *
 * Suppression is scoped to button-like targets (`button`, `a[href]`,
 * `[role="button"]`, `[role="link"]`). Composite widgets that move focus
 * programmatically — menu items, listbox options, grid cells — are other
 * element types whose roving-focus highlighting must keep receiving focus
 * events, and text controls keep their own focus behaviour (select on focus,
 * caret placement).
 *
 * Suppressed focus is real as far as the DOM is concerned (`activeElement`
 * moves; only the event was stopped), and the published tooltip treats a
 * trigger that is `activeElement` as keyboard-held: while a tooltip on it is
 * open, pointer movement away only *requests* a close and the request is
 * refused for as long as the pointer keeps moving. Left alone, a later real
 * hover on that control would open the tip and never let it leave — the
 * residual "stuck" case. The gate therefore treats a suppressed focus as a
 * phantom and releases it: the first pointer activity after the focus (a
 * pointer session taking over from a script) blurs the element. Keyboard
 * sessions never release it and never need to — keyboard focus moves by Tab,
 * which is never suppressed, so nothing pins; and the release only runs for
 * elements still holding `activeElement`, so a Tab already taken from the
 * phantom is left alone.
 */

/** How long after a Tab key press a resulting focus event still counts as
 *  keyboard navigation. The native focus move follows the key press
 *  immediately; the window only has to bridge that dispatch, not a later
 *  script-driven focus. */
export const TOOLTIP_FOCUS_INTENT_WINDOW_MS = 250

/** Elements a tooltip-bearing control is rendered as. Everything else keeps
 *  its native focus behaviour, and so do resize grips (see below). */
const BUTTON_LIKE_SELECTOR = 'button, a[href], [role="button"], [role="link"]'

/**
 * Whether a focus event landing on this target could open a tooltip on a
 * button-like control. Accepts any Element (an SVG glyph inside a control,
 * for instance) and duck-types so the decision is testable without a DOM.
 */
export function isButtonLikeFocusTarget(target: unknown): boolean {
  const element = target as Element | null | undefined
  if (typeof element?.closest !== 'function') return false
  const control = element.closest(BUTTON_LIKE_SELECTOR)
  if (control === null) return false
  // Resize grips render as `<button role="separator">` and focus themselves
  // when a pointer drag starts. They carry no tooltip, and the blur that
  // releases a suppressed focus would end the drag on its first move.
  return control.getAttribute?.('role') !== 'separator'
}

/**
 * The suppression decision: a button-like focus target hides a tooltip only
 * when no keyboard navigation is in flight. Anything else — a Tab-driven
 * focus, or focus on a non-button element — passes through untouched.
 */
export function shouldSuppressTooltipFocus(input: {
  isButtonLike: boolean
  keyboardIntentActive: boolean
}): boolean {
  return input.isButtonLike && !input.keyboardIntentActive
}

const installedDocuments = new WeakSet<Document>()

/**
 * Install the gate on a document. Idempotent per document; returns a disposer
 * that removes the listeners (used by tests and by hosts that tear the
 * workspace down).
 */
export function installTooltipFocusGate(doc: Document = document): () => void {
  if (installedDocuments.has(doc)) return () => {}

  let lastTabKeyDownAt = 0
  /** The element holding a suppressed programmatic focus, if it still holds
   *  `activeElement`. One slot: a newer suppressed focus replaces an older
   *  one, and anything that already lost focus needs no release. */
  let phantomFocusTarget: Element | undefined
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Tab') lastTabKeyDownAt = Date.now()
  }
  const onFocus = (event: FocusEvent) => {
    if (!isButtonLikeFocusTarget(event.target)) return
    const keyboardIntentActive = Date.now() - lastTabKeyDownAt <= TOOLTIP_FOCUS_INTENT_WINDOW_MS
    if (!shouldSuppressTooltipFocus({ isButtonLike: true, keyboardIntentActive })) return
    event.stopPropagation()
    phantomFocusTarget = event.target as Element
  }
  const releasePhantomFocus = () => {
    const phantom = phantomFocusTarget
    if (!phantom) return
    const active = (doc as Document).activeElement
    if (active !== phantom) {
      phantomFocusTarget = undefined
      return
    }
    phantomFocusTarget = undefined
    if (typeof (phantom as HTMLElement).blur === 'function') (phantom as HTMLElement).blur()
  }
  const onPointerActivity = () => releasePhantomFocus()

  doc.addEventListener('keydown', onKeyDown, true)
  doc.addEventListener('focus', onFocus, true)
  doc.addEventListener('pointermove', onPointerActivity, true)
  doc.addEventListener('pointerdown', onPointerActivity, true)
  installedDocuments.add(doc)
  return () => {
    doc.removeEventListener('keydown', onKeyDown, true)
    doc.removeEventListener('focus', onFocus, true)
    doc.removeEventListener('pointermove', onPointerActivity, true)
    doc.removeEventListener('pointerdown', onPointerActivity, true)
    installedDocuments.delete(doc)
  }
}
