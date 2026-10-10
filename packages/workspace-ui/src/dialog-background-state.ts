/**
 * The workspace frame leaves the accessibility tree while a modal is open.
 * Kobalte schedules that `aria-hidden` write with `setTimeout →
 * requestAnimationFrame` and never guards it against disposal, while its
 * removal path is guarded and deferred: a write scheduled before close can
 * land afterwards and stick, leaving a visible board unqueryable by role.
 *
 * A panel that opened a modal captures the frame's pre-open state and, once
 * the modal is gone, restores exactly the state it captured. It never removes
 * another overlay's state and never writes a value it did not record.
 */
export type DialogBackgroundState = Readonly<{
  ariaHidden: string | null
  inert: boolean
  bodyPointerEvents: string
}>

export type DialogBackgroundElement = {
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  hasAttribute(name: string): boolean
}

export function captureDialogBackgroundState(
  element: DialogBackgroundElement | null | undefined,
  body: { style: { pointerEvents: string } }
): DialogBackgroundState | undefined {
  if (!element) return undefined
  return {
    ariaHidden: element.getAttribute('aria-hidden'),
    inert: element.hasAttribute('inert'),
    bodyPointerEvents: body.style.pointerEvents,
  }
}

/**
 * A modal that is actually present in the layout owns the background. A
 * hidden-but-mounted dialog must not block repair, so visibility is part of
 * the ownership test.
 */
export type DialogQueryRoot = {
  querySelectorAll(selector: string): ArrayLike<{ getClientRects(): ArrayLike<unknown> }>
}

export function hasVisibleModal(root: DialogQueryRoot): boolean {
  const dialogs = root.querySelectorAll('[role="dialog"], [role="alertdialog"]')
  for (let index = 0; index < dialogs.length; index += 1) {
    const dialog = dialogs[index]
    if (dialog && dialog.getClientRects().length > 0) return true
  }
  return false
}

/**
 * Restores the captured pre-open state. Returns whether anything changed.
 * Skipped while another modal is present so a second overlay keeps ownership
 * of the background it is hiding.
 */
export function restoreDialogBackgroundState(options: {
  element: DialogBackgroundElement | null | undefined
  body: { style: { pointerEvents: string } }
  captured: DialogBackgroundState | undefined
  hasOtherModal: () => boolean
}): boolean {
  const { element, body, captured, hasOtherModal } = options
  if (!element || !captured) return false
  if (hasOtherModal()) return false

  let changed = false
  if (captured.ariaHidden === null) {
    if (element.getAttribute('aria-hidden') === 'true') {
      element.removeAttribute('aria-hidden')
      changed = true
    }
  } else if (element.getAttribute('aria-hidden') !== captured.ariaHidden) {
    element.setAttribute('aria-hidden', captured.ariaHidden)
    changed = true
  }
  if (!captured.inert && element.hasAttribute('inert')) {
    element.removeAttribute('inert')
    changed = true
  }
  if (captured.bodyPointerEvents !== 'none' && body.style.pointerEvents === 'none') {
    body.style.pointerEvents = captured.bodyPointerEvents
    changed = true
  }
  return changed
}
