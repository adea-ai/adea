/*
 * Windowed rendering for the Files tree (#677). The pane flattened every
 * visible row and rendered all of them, so a fully expanded 100k-entry tree
 * put 100k elements in the DOM. This is the pure half: which slice of the
 * flattened rows a viewport shows, and how much padding stands in for the
 * rows that are not rendered.
 */

/** The fixed height every rendered tree row must have — the window is only
 *  correct if this matches the row's real height, so
 *  `row-window.test.ts` asserts the stylesheet agrees with this number. */
export const FILES_ROW_HEIGHT_PX = 28

/** Rows rendered beyond the viewport, so a fast scroll does not show blanks. */
export const FILES_WINDOW_OVERSCAN = 8

export type RowWindow = Readonly<{
  /** First flattened index to render (inclusive). */
  start: number
  /** One past the last flattened index to render. */
  end: number
  /** Pixels standing in for the rows above the window. */
  padTop: number
  /** Pixels standing in for the rows below the window. */
  padBottom: number
}>

export function rowWindow(
  input: Readonly<{
    total: number
    scrollTop: number
    viewportHeight: number
    rowHeight?: number
    overscan?: number
    /** A row that must be rendered whatever the scroll position — the focused
     *  one, so keyboard navigation never sends focus to an unmounted row. */
    pinIndex?: number
  }>
): RowWindow {
  const rowHeight = input.rowHeight ?? FILES_ROW_HEIGHT_PX
  const overscan = input.overscan ?? FILES_WINDOW_OVERSCAN
  const total = Math.max(0, Math.trunc(input.total))
  if (total === 0 || rowHeight <= 0) return { end: 0, padBottom: 0, padTop: 0, start: 0 }

  const scrollTop = Math.max(0, Number.isFinite(input.scrollTop) ? input.scrollTop : 0)
  // A viewport that has not been measured yet still renders a window rather
  // than nothing: an empty first paint would look like an empty directory.
  const viewportHeight = Math.max(
    rowHeight,
    Number.isFinite(input.viewportHeight) ? input.viewportHeight : 0
  )

  const first = Math.min(total - 1, Math.max(0, Math.floor(scrollTop / rowHeight) - overscan))
  const visible = Math.ceil(viewportHeight / rowHeight) + overscan * 2
  let end = Math.min(total, first + Math.max(1, visible))

  let start = first
  const pin = input.pinIndex
  if (pin !== undefined && Number.isInteger(pin) && pin >= 0 && pin < total) {
    if (pin < start) start = Math.max(0, pin - overscan)
    if (pin >= end) end = Math.min(total, pin + 1 + overscan)
  }

  return {
    end,
    padBottom: Math.max(0, (total - end) * rowHeight),
    padTop: start * rowHeight,
    start,
  }
}
