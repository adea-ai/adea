import { describe, expect, test } from 'bun:test'
import { withTerminalSelectionPreserved } from '../src/terminal/selection-preserver'

type Cell = { chars: string; width: number }
type BufferType = 'normal' | 'alternate'
type FakeBuffer = {
  type: BufferType
  baseY: number
  cursorY: number
  readonly length: number
  getLine: (row: number) => FakeLine | undefined
}

class FakeLine {
  constructor(
    private readonly rowCells: Cell[],
    readonly isWrapped = false
  ) {}

  get length(): number {
    return this.rowCells.length
  }

  getCell(column: number) {
    const cell = this.rowCells[column]
    return cell
      ? {
          getChars: () => cell.chars,
          getWidth: () => cell.width,
        }
      : undefined
  }

  translateToString(trimRight = false, startColumn = 0, endColumn = this.rowCells.length): string {
    let end = Math.min(endColumn, this.rowCells.length)
    if (trimRight) {
      let trimmedLength = 0
      for (let column = 0; column < this.rowCells.length; column++) {
        const cell = this.rowCells[column]!
        if (cell.chars !== '') trimmedLength = column + (cell.width || 1)
      }
      end = Math.min(end, trimmedLength)
    }

    let text = ''
    for (let column = startColumn; column < end;) {
      const cell = this.rowCells[column]!
      text += cell.chars || ' '
      column += cell.width || 1
    }
    return text
  }
}

function cells(text: string): Cell[] {
  return [...text].map((chars) => ({ chars, width: 1 }))
}

function blanks(count: number): Cell[] {
  return Array.from({ length: count }, () => ({ chars: '', width: 1 }))
}

class FakeTerminal {
  cols: number
  readonly markers: { line: number; dispose: () => void }[] = []
  selectCalls = 0
  clearCalls = 0
  selectionText: string
  selection: { start: { x: number; y: number }; end: { x: number; y: number } } | undefined
  readonly buffer: {
    readonly active: FakeBuffer
    onBufferChange: (listener: (buffer: FakeBuffer) => void) => { dispose: () => void }
  }
  readonly bufferChangeListeners = new Set<(buffer: FakeBuffer) => void>()
  private readonly normalBuffer: FakeBuffer
  private readonly alternateBuffer: FakeBuffer
  private activeBuffer: FakeBuffer

  constructor(
    cols: number,
    private rows: FakeLine[],
    selectionText: string,
    start: { x: number; y: number },
    end: { x: number; y: number },
    activeType: BufferType = 'normal'
  ) {
    this.cols = cols
    this.selectionText = selectionText
    this.selection = { start, end }
    const currentRows = () => this.rows
    const currentBuffer = () => this.activeBuffer
    const createBuffer = (type: BufferType): FakeBuffer => ({
      type,
      baseY: 0,
      cursorY: 0,
      get length() {
        return currentRows().length
      },
      getLine: (row) => this.rows[row],
    })
    this.normalBuffer = createBuffer('normal')
    this.alternateBuffer = createBuffer('alternate')
    this.activeBuffer = activeType === 'normal' ? this.normalBuffer : this.alternateBuffer
    this.buffer = {
      get active() {
        return currentBuffer()
      },
      onBufferChange: (listener) => {
        this.bufferChangeListeners.add(listener)
        return { dispose: () => this.bufferChangeListeners.delete(listener) }
      },
    }
  }

  getSelection(): string {
    return this.selectionText
  }

  getSelectionPosition() {
    return this.selection
  }

  registerMarker(cursorYOffset = 0) {
    const marker = {
      line: this.buffer.active.baseY + this.buffer.active.cursorY + cursorYOffset,
      dispose: () => {
        marker.line = -1
      },
    }
    this.markers.push(marker)
    return marker
  }

  select(column: number, row: number, length: number): void {
    this.selectCalls++
    const cellsFromStart = column + length
    let endRow = row + Math.floor(cellsFromStart / this.cols)
    let endColumn = cellsFromStart % this.cols
    if (endColumn === 0 && length > 0) {
      endRow--
      endColumn = this.cols
    }
    const end = { x: endColumn, y: endRow }
    this.selection = { start: { x: column, y: row }, end }
    this.selectionText = this.textForSelection(this.selection.start, end)
  }

  clearSelection(): void {
    this.clearCalls++
    this.selection = undefined
    this.selectionText = ''
  }

  reflow(cols: number, rows: FakeLine[], markerRows: number[]): void {
    this.cols = cols
    this.rows = rows
    for (const [index, marker] of this.markers.entries()) {
      marker.line = markerRows[index] ?? marker.line
    }
    this.selection = undefined
    this.selectionText = ''
  }

  resizeAlternate(cols: number, rows = this.rows): void {
    this.cols = cols
    this.rows = rows
    this.clearSelection()
  }

  switchBuffer(type: BufferType): void {
    this.activeBuffer = type === 'normal' ? this.normalBuffer : this.alternateBuffer
    this.clearSelection()
    for (const listener of this.bufferChangeListeners) listener(this.activeBuffer)
  }

  makeMarkerDisposed(): void {
    for (const marker of this.markers) marker.line = -1
  }

  private textForSelection(start: { x: number; y: number }, end: { x: number; y: number }): string {
    const text: string[] = []
    for (let row = start.y; row <= end.y; row++) {
      const line = this.rows[row]!
      const from = row === start.y ? start.x : 0
      const to = row === end.y ? end.x : line.length
      const part = line.translateToString(true, from, to)
      if (row > start.y && line.isWrapped) text[text.length - 1] += part
      else text.push(part)
    }
    return text.join('\n')
  }
}

describe('terminal selection preservation across resize', () => {
  test('keeps multiline text, wrapped spaces, wide glyphs, and combining text anchored', () => {
    const originalLine = new FakeLine(cells('abcdefg'))
    const originalWrappedLine = new FakeLine([
      { chars: 'W', width: 1 },
      { chars: '界', width: 2 },
      { chars: '', width: 0 },
      { chars: ' ', width: 1 },
      { chars: 'x', width: 1 },
      { chars: ' ', width: 1 },
      { chars: ' ', width: 1 },
    ])
    const originalContinuation = new FakeLine(
      [{ chars: 'e\u0301', width: 1 }, { chars: 'Z', width: 1 }, ...blanks(5)],
      true
    )
    const terminal = new FakeTerminal(
      7,
      [originalLine, originalWrappedLine, originalContinuation],
      'defg\nW界 x  e\u0301',
      { x: 3, y: 0 },
      { x: 1, y: 2 }
    )

    withTerminalSelectionPreserved(terminal, () => {
      terminal.reflow(
        4,
        [
          new FakeLine(cells('abcd')),
          new FakeLine([...cells('efg'), ...blanks(1)], true),
          new FakeLine([
            { chars: 'W', width: 1 },
            { chars: '界', width: 2 },
            { chars: '', width: 0 },
            { chars: ' ', width: 1 },
          ]),
          new FakeLine(
            [
              { chars: 'x', width: 1 },
              { chars: ' ', width: 1 },
              { chars: ' ', width: 1 },
              { chars: 'e\u0301', width: 1 },
            ],
            true
          ),
          new FakeLine([...cells('Z'), ...blanks(3)], true),
        ],
        [0, 2]
      )
    })

    expect(terminal.getSelection()).toBe('defg\nW界 x  e\u0301')
    expect(terminal.selectCalls).toBe(1)
    expect(terminal.selection).toEqual({ start: { x: 3, y: 0 }, end: { x: 4, y: 3 } })
    expect(terminal.markers.every((marker) => marker.line === -1)).toBe(true)
  })

  test('snaps a mid-wide-glyph endpoint to the end of the complete cell', () => {
    const terminal = new FakeTerminal(
      7,
      [
        new FakeLine([
          { chars: 'a', width: 1 },
          { chars: '界', width: 2 },
          { chars: '', width: 0 },
          ...cells('bcde'),
        ]),
      ],
      'a界',
      { x: 0, y: 0 },
      { x: 2, y: 0 }
    )

    withTerminalSelectionPreserved(terminal, () => {
      terminal.reflow(
        4,
        [
          new FakeLine([
            { chars: 'a', width: 1 },
            { chars: '界', width: 2 },
            { chars: '', width: 0 },
            { chars: 'b', width: 1 },
          ]),
          new FakeLine([...cells('cde'), ...blanks(1)], true),
        ],
        [0, 0]
      )
    })

    expect(terminal.getSelection()).toBe('a界')
    expect(terminal.selection).toEqual({ start: { x: 0, y: 0 }, end: { x: 3, y: 0 } })
    expect(terminal.markers.every((marker) => marker.line === -1)).toBe(true)
  })

  test('clears instead of restoring a range whose anchored text changed', () => {
    const terminal = new FakeTerminal(
      6,
      [new FakeLine(cells('abcdef'))],
      'abc',
      { x: 0, y: 0 },
      { x: 3, y: 0 }
    )

    withTerminalSelectionPreserved(terminal, () => {
      terminal.reflow(6, [new FakeLine(cells('uvwxyz'))], [0, 0])
    })

    expect(terminal.getSelection()).toBe('')
    expect(terminal.selectCalls).toBe(0)
    expect(terminal.clearCalls).toBe(1)
    expect(terminal.markers.every((marker) => marker.line === -1)).toBe(true)
  })

  test('abandons a disposed marker without selecting stale coordinates', () => {
    const terminal = new FakeTerminal(
      6,
      [new FakeLine(cells('abcdef'))],
      'abc',
      { x: 0, y: 0 },
      { x: 3, y: 0 }
    )

    withTerminalSelectionPreserved(terminal, () => {
      terminal.reflow(6, [new FakeLine(cells('abcdef'))], [0, 0])
      terminal.makeMarkerDisposed()
    })

    expect(terminal.getSelection()).toBe('')
    expect(terminal.selectCalls).toBe(0)
    expect(terminal.clearCalls).toBe(1)
  })

  test('does not restore a normal-buffer selection after switching buffers', () => {
    const terminal = new FakeTerminal(
      6,
      [new FakeLine(cells('abcdef'))],
      'abc',
      { x: 0, y: 0 },
      { x: 3, y: 0 }
    )

    withTerminalSelectionPreserved(terminal, () => {
      terminal.reflow(6, [new FakeLine(cells('abcdef'))], [0, 0])
      terminal.switchBuffer('alternate')
    })

    expect(terminal.getSelection()).toBe('')
    expect(terminal.selectCalls).toBe(0)
    expect(terminal.markers.every((marker) => marker.line === -1)).toBe(true)
  })

  test('preserves an alternate-buffer selection when its fixed rows and cells survive resize', () => {
    const terminal = new FakeTerminal(
      8,
      [new FakeLine(cells('')), new FakeLine([...cells('prompt>'), ...blanks(1)])],
      'prompt>',
      { x: 0, y: 1 },
      { x: 7, y: 1 },
      'alternate'
    )

    withTerminalSelectionPreserved(terminal, () => terminal.resizeAlternate(10))

    expect(terminal.getSelection()).toBe('prompt>')
    expect(terminal.selection).toEqual({ start: { x: 0, y: 1 }, end: { x: 7, y: 1 } })
    expect(terminal.selectCalls).toBe(1)
    expect(terminal.markers).toHaveLength(0)
    expect(terminal.bufferChangeListeners.size).toBe(0)
  })

  test('clears an alternate-buffer selection when resize clips its row', () => {
    const terminal = new FakeTerminal(
      8,
      [new FakeLine(cells('zero')), new FakeLine(cells('one')), new FakeLine(cells('two'))],
      'two',
      { x: 0, y: 2 },
      { x: 3, y: 2 },
      'alternate'
    )

    withTerminalSelectionPreserved(terminal, () =>
      terminal.resizeAlternate(8, [new FakeLine(cells('zero')), new FakeLine(cells('one'))])
    )

    expect(terminal.getSelection()).toBe('')
    expect(terminal.selectCalls).toBe(0)
    expect(terminal.clearCalls).toBe(2)
    expect(terminal.markers).toHaveLength(0)
    expect(terminal.bufferChangeListeners.size).toBe(0)
  })

  test('clears an alternate-buffer selection when resize clips its selected columns', () => {
    const terminal = new FakeTerminal(
      6,
      [new FakeLine(cells('abcdef'))],
      'abcdef',
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      'alternate'
    )

    withTerminalSelectionPreserved(terminal, () => terminal.resizeAlternate(4))

    expect(terminal.getSelection()).toBe('')
    expect(terminal.selectCalls).toBe(0)
    expect(terminal.clearCalls).toBe(2)
    expect(terminal.markers).toHaveLength(0)
    expect(terminal.bufferChangeListeners.size).toBe(0)
  })

  test('does not restore after switching away from and back to the alternate buffer', () => {
    const terminal = new FakeTerminal(
      8,
      [new FakeLine(cells('prompt>'))],
      'prompt>',
      { x: 0, y: 0 },
      { x: 7, y: 0 },
      'alternate'
    )

    withTerminalSelectionPreserved(terminal, () => {
      terminal.switchBuffer('normal')
      terminal.switchBuffer('alternate')
    })

    expect(terminal.getSelection()).toBe('')
    expect(terminal.selectCalls).toBe(0)
    expect(terminal.markers).toHaveLength(0)
    expect(terminal.bufferChangeListeners.size).toBe(0)
  })
})
