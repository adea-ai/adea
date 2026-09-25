import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { FILES_ROW_HEIGHT_PX, rowWindow } from '../src/files/row-window'

const viewport = { scrollTop: 0, total: 1_000, viewportHeight: 280 }

describe('row window', () => {
  test('renders the viewport plus overscan from the top', () => {
    const window = rowWindow(viewport)
    expect(window.start).toBe(0)
    // 280px viewport / 28px rows = 10 visible, plus overscan both sides.
    expect(window.end).toBe(10 + 8 * 2)
    expect(window.padTop).toBe(0)
    expect(window.padBottom).toBe((1_000 - window.end) * FILES_ROW_HEIGHT_PX)
  })

  test('follows the scroll position and keeps the padding in step', () => {
    const window = rowWindow({ ...viewport, scrollTop: 2_800 })
    // Row 100 is the first visible one; overscan reaches back eight rows.
    expect(window.start).toBe(92)
    expect(window.padTop).toBe(92 * FILES_ROW_HEIGHT_PX)
    // The padding above plus what is rendered plus the padding below is the
    // whole list, which is what keeps the scrollbar honest.
    const rendered = (window.end - window.start) * FILES_ROW_HEIGHT_PX
    expect(window.padTop + rendered + window.padBottom).toBe(1_000 * FILES_ROW_HEIGHT_PX)
  })

  test('clamps at the end rather than rendering past the list', () => {
    const window = rowWindow({ ...viewport, scrollTop: 1_000_000 })
    expect(window.end).toBe(1_000)
    expect(window.padBottom).toBe(0)
    expect(window.start).toBeLessThan(1_000)
  })

  test('renders a window before the viewport has been measured', () => {
    const window = rowWindow({ scrollTop: 0, total: 500, viewportHeight: 0 })
    // An unmeasured viewport must not paint an empty directory.
    expect(window.end).toBeGreaterThan(1)
  })

  test('an empty list renders nothing', () => {
    expect(rowWindow({ scrollTop: 0, total: 0, viewportHeight: 280 })).toEqual({
      end: 0,
      padBottom: 0,
      padTop: 0,
      start: 0,
    })
  })

  test('a pinned row is always inside the window', () => {
    // Focus above the viewport: the window reaches back for it.
    const above = rowWindow({ ...viewport, pinIndex: 10, scrollTop: 2_800 })
    expect(above.start).toBeLessThanOrEqual(10)
    expect(above.end).toBeGreaterThan(10)

    // Focus below the viewport: the window extends forward.
    const below = rowWindow({ ...viewport, pinIndex: 990, scrollTop: 0 })
    expect(below.end).toBeGreaterThan(990)

    // A pin outside the list is ignored rather than clamped into it.
    expect(rowWindow({ ...viewport, pinIndex: 5_000 }).end).toBe(rowWindow(viewport).end)
    expect(rowWindow({ ...viewport, pinIndex: -1 }).start).toBe(rowWindow(viewport).start)
  })
})

describe('row height agreement', () => {
  test('the stylesheet row height matches the window constant', () => {
    // The window is only correct if the row really is that tall; a silent
    // drift here would misalign every scroll position.
    const css = readFileSync(resolve(import.meta.dirname, '../src/files/files-pane.css'), 'utf8')
    const declared = css.match(/--dev-files-row-height:\s*(\d+)px/)
    expect(declared?.[1]).toBe(String(FILES_ROW_HEIGHT_PX))
  })
})
