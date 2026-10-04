/**
 * Preserve xterm's current linear selection across a synchronous resize/reflow.
 *
 * The snapshot is limited to the two logical lines that contain its endpoints.
 * Markers keep normal-buffer lines anchored while xterm rewraps them. The
 * alternate buffer has no markers and does not reflow, so it uses fixed row
 * anchors and refuses restoration after a buffer switch. We never search the
 * scrollback for matching text. A failed or ambiguous restore leaves the
 * selection cleared rather than selecting different terminal output.
 */
type BufferCell = {
  getChars: () => string
  getWidth: () => number
}

type BufferLine = {
  isWrapped: boolean
  length: number
  getCell: (column: number) => BufferCell | undefined
}

type ActiveBuffer = {
  type: string
  baseY: number
  cursorY: number
  length: number
  getLine: (row: number) => BufferLine | undefined
}

type BufferMarker = {
  readonly line: number
  dispose: () => void
}

type BufferChangeSubscription = { dispose: () => void }

type BufferAnchor =
  | {
      kind: 'normal'
      startMarker: BufferMarker
      endMarker: BufferMarker
      dispose: () => void
    }
  | {
      kind: 'alternate'
      buffer: ActiveBuffer
      startRow: number
      endRow: number
      wasSwitched: () => boolean
      subscription: BufferChangeSubscription
      dispose: () => void
    }

type Position = { x: number; y: number }

type SelectionTerminal = {
  cols: number
  buffer: {
    active: ActiveBuffer
    onBufferChange: (listener: (buffer: ActiveBuffer) => void) => BufferChangeSubscription
  }
  getSelection: () => string
  getSelectionPosition: () => { start: Position; end: Position } | undefined
  registerMarker: (cursorYOffset?: number) => BufferMarker
  select: (column: number, row: number, length: number) => void
  clearSelection: () => void
}

type PhysicalLine = {
  row: number
  text: string
  /** UTF-16 offsets at cell boundaries, matching xterm's wide-cell translation. */
  columnOffsets: readonly (number | undefined)[]
  /** Offsets at whole-cell boundaries only; restores after an entire wide glyph. */
  restoreColumns: readonly (number | undefined)[]
}

type LogicalLine = {
  start: number
  end: number
  text: string
  lines: readonly PhysicalLine[]
}

type SelectionSnapshot = {
  selectionText: string
  startLineText: string
  endLineText: string
  startOffset: number
  endOffset: number
  anchor: BufferAnchor
  dispose: () => void
  restore: () => void
}

function lineAt(buffer: ActiveBuffer, row: number): BufferLine | undefined {
  if (row < 0 || row >= buffer.length) return undefined
  return buffer.getLine(row)
}

function logicalLineStart(buffer: ActiveBuffer, row: number): number | undefined {
  if (!lineAt(buffer, row)) return undefined
  while (row > 0 && lineAt(buffer, row)?.isWrapped) row--
  return row
}

/**
 * Read just the text-bearing cells from one visible row. Empty trailing cells
 * are layout padding; interior empty cells remain spaces, while width-0 cells
 * are only the second half of a wide glyph and contribute no text.
 */
function readPhysicalLine(
  line: BufferLine,
  row: number,
  columns: number
): PhysicalLine | undefined {
  const visibleColumns = Math.max(0, Math.min(line.length, columns))
  let contentEnd = 0
  for (let column = 0; column < visibleColumns;) {
    const cell = line.getCell(column)
    if (!cell) return undefined
    const width = cell.getWidth()
    if (width > 0 && cell.getChars() !== '') contentEnd = Math.min(visibleColumns, column + width)
    column += width || 1
  }

  let text = ''
  const columnOffsets: (number | undefined)[] = Array(visibleColumns + 1).fill(undefined)
  const restoreColumns: (number | undefined)[] = Array(visibleColumns + 1).fill(undefined)
  columnOffsets[0] = 0
  restoreColumns[0] = 0
  for (let column = 0; column < contentEnd;) {
    const cell = line.getCell(column)
    if (!cell) return undefined
    const width = cell.getWidth()
    if (width === 0) {
      // Continuation padding belongs to the preceding wide glyph.
      column++
      columnOffsets[column] ??= text.length
      continue
    }

    const firstColumn = column
    columnOffsets[firstColumn] ??= text.length
    restoreColumns[firstColumn] ??= text.length
    text += cell.getChars() || ' '
    column += width || 1
    // xterm's string translation includes a wide/combined glyph when the end
    // boundary falls anywhere inside that cell, so map each such boundary to
    // the offset after the complete glyph.
    for (let boundary = firstColumn + 1; boundary <= column; boundary++) {
      if (boundary >= 0 && boundary <= visibleColumns) columnOffsets[boundary] = text.length
    }
    if (column <= visibleColumns) restoreColumns[column] = text.length
  }

  for (let column = contentEnd; column <= visibleColumns; column++) {
    columnOffsets[column] ??= text.length
    restoreColumns[column] ??= text.length
  }
  return { row, text, columnOffsets, restoreColumns }
}

function readLogicalLine(
  buffer: ActiveBuffer,
  start: number,
  columns: number
): LogicalLine | undefined {
  let text = ''
  let row = start
  const lines: PhysicalLine[] = []
  while (row < buffer.length) {
    const line = lineAt(buffer, row)
    if (!line || (row > start && !line.isWrapped)) break
    const physicalLine = readPhysicalLine(line, row, columns)
    if (!physicalLine) return undefined
    lines.push(physicalLine)
    text += physicalLine.text
    row++
  }
  return row > start ? { start, end: row - 1, text, lines } : undefined
}

function offsetAtPosition(logicalLine: LogicalLine, position: Position): number | undefined {
  if (position.y < logicalLine.start || position.y > logicalLine.end) return undefined
  let offset = 0
  for (const line of logicalLine.lines) {
    if (line.row < position.y) {
      offset += line.text.length
      continue
    }
    if (line.row === position.y) {
      const cellOffset =
        line.columnOffsets[Math.max(0, Math.min(position.x, line.columnOffsets.length - 1))]
      return cellOffset === undefined ? undefined : offset + cellOffset
    }
  }
  return undefined
}

function positionAtOffset(logicalLine: LogicalLine, offset: number): Position | undefined {
  if (offset < 0 || offset > logicalLine.text.length) return undefined
  let remaining = offset
  for (const line of logicalLine.lines) {
    if (remaining <= line.text.length) {
      const column = line.restoreColumns.indexOf(remaining)
      return column < 0 ? undefined : { x: column, y: line.row }
    }
    remaining -= line.text.length
  }
  return undefined
}

function samePosition(actual: Position | undefined, expected: Position): boolean {
  return actual?.x === expected.x && actual.y === expected.y
}

function captureSelection(terminal: SelectionTerminal): SelectionSnapshot | undefined {
  const buffer = terminal.buffer.active
  if (buffer.type !== 'normal' && buffer.type !== 'alternate') return undefined

  const range = terminal.getSelectionPosition()
  const selectionText = terminal.getSelection()
  if (!range || selectionText === '') return undefined

  const startLineStart = logicalLineStart(buffer, range.start.y)
  const endLineStart = logicalLineStart(buffer, range.end.y)
  if (startLineStart === undefined || endLineStart === undefined || startLineStart > endLineStart)
    return undefined
  const startLine = readLogicalLine(buffer, startLineStart, terminal.cols)
  const endLine =
    startLineStart === endLineStart
      ? startLine
      : readLogicalLine(buffer, endLineStart, terminal.cols)
  if (!startLine || !endLine) return undefined

  const startOffset = offsetAtPosition(startLine, range.start)
  const endOffset = offsetAtPosition(endLine, range.end)
  if (
    startOffset === undefined ||
    endOffset === undefined ||
    (startLineStart === endLineStart && startOffset > endOffset)
  )
    return undefined

  let anchor: BufferAnchor
  if (buffer.type === 'normal') {
    const cursorRow = buffer.baseY + buffer.cursorY
    let startMarker: BufferMarker | undefined
    let endMarker: BufferMarker | undefined
    try {
      startMarker = terminal.registerMarker(startLineStart - cursorRow)
      endMarker = terminal.registerMarker(endLineStart - cursorRow)
    } catch {
      startMarker?.dispose()
      endMarker?.dispose()
      return undefined
    }

    if (!startMarker || !endMarker || startMarker.line < 0 || endMarker.line < 0) {
      startMarker?.dispose()
      endMarker?.dispose()
      return undefined
    }

    let disposed = false
    anchor = {
      kind: 'normal',
      startMarker,
      endMarker,
      dispose() {
        if (disposed) return
        disposed = true
        startMarker?.dispose()
        endMarker?.dispose()
      },
    }
  } else {
    let switched = false
    let subscription: BufferChangeSubscription
    try {
      subscription = terminal.buffer.onBufferChange(() => {
        switched = true
      })
    } catch {
      return undefined
    }

    let disposed = false
    anchor = {
      kind: 'alternate',
      buffer,
      startRow: startLineStart,
      endRow: endLineStart,
      wasSwitched: () => switched,
      subscription,
      dispose() {
        if (disposed) return
        disposed = true
        subscription.dispose()
      },
    }
  }

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    anchor.dispose()
  }

  return {
    selectionText,
    startLineText: startLine.text,
    endLineText: endLine.text,
    startOffset,
    endOffset,
    anchor,
    dispose,
    restore() {
      try {
        const active = terminal.buffer.active
        let startRow: number | undefined
        let endRow: number | undefined
        if (this.anchor.kind === 'normal') {
          if (active.type !== 'normal') {
            terminal.clearSelection()
            return
          }
          if (this.anchor.startMarker.line < 0 || this.anchor.endMarker.line < 0) {
            terminal.clearSelection()
            return
          }
          startRow = logicalLineStart(active, this.anchor.startMarker.line)
          endRow = logicalLineStart(active, this.anchor.endMarker.line)
        } else {
          if (
            active.type !== 'alternate' ||
            active !== this.anchor.buffer ||
            this.anchor.wasSwitched()
          ) {
            terminal.clearSelection()
            return
          }
          startRow = logicalLineStart(active, this.anchor.startRow)
          endRow = logicalLineStart(active, this.anchor.endRow)
          if (startRow !== this.anchor.startRow || endRow !== this.anchor.endRow) {
            terminal.clearSelection()
            return
          }
        }

        if (startRow === undefined || endRow === undefined || startRow > endRow) {
          terminal.clearSelection()
          return
        }
        const currentStartLine = readLogicalLine(active, startRow, terminal.cols)
        const currentEndLine =
          startRow === endRow ? currentStartLine : readLogicalLine(active, endRow, terminal.cols)
        if (
          !currentStartLine ||
          !currentEndLine ||
          currentStartLine.text !== this.startLineText ||
          currentEndLine.text !== this.endLineText
        ) {
          terminal.clearSelection()
          return
        }

        const start = positionAtOffset(currentStartLine, this.startOffset)
        const end = positionAtOffset(currentEndLine, this.endOffset)
        if (!start || !end || end.y < start.y) {
          terminal.clearSelection()
          return
        }
        const length = (end.y - start.y) * terminal.cols + end.x - start.x
        if (length <= 0) {
          terminal.clearSelection()
          return
        }

        terminal.select(start.x, start.y, length)
        const restoredRange = terminal.getSelectionPosition()
        if (
          terminal.getSelection() !== this.selectionText ||
          !restoredRange ||
          !samePosition(restoredRange.start, start) ||
          !samePosition(restoredRange.end, end)
        )
          terminal.clearSelection()
      } catch {
        // Reflow can invalidate markers or fixed rows while output is arriving.
        // Leave the selection absent rather than restoring an unverified range.
        try {
          terminal.clearSelection()
        } catch {
          /* the terminal may have been disposed during teardown */
        }
      } finally {
        this.dispose()
      }
    },
  }
}

/** Run a synchronous layout change and restore only a still-identical selection. */
export function withTerminalSelectionPreserved<T>(terminal: SelectionTerminal, layout: () => T): T {
  const snapshot = captureSelection(terminal)
  try {
    return layout()
  } finally {
    snapshot?.restore()
  }
}
