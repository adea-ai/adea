/*
 * Window geometry for the Files tree (#677). Row dimensions come from the
 * shared TreeRow border-box measurements; the host owns the visible range and
 * the scroll anchor. The initial render is a bounded bootstrap slice until a
 * shared row reports a measured CSS-pixel size.
 */

/** Rows mounted beyond the viewport to keep keyboard moves and fast scrolls smooth. */
export const FILES_WINDOW_OVERSCAN = 8

/** Initial rows rendered before ResizeObserver provides shared row geometry. */
export const FILES_WINDOW_BOOTSTRAP_ROWS = 64

export type RowMeasurement = Readonly<{ id: string; blockSize: number }>

/**
 * Identity-keyed variable row geometry backed by a Fenwick tree.
 *
 * Scroll and prefix queries stay logarithmic after each projection rebuild;
 * mounted rows report their actual border-box size, while unseen rows use the
 * average measured block size. A coherent group of changed measurements
 * replaces that estimate, which keeps the full scroll extent aligned when
 * root text sizing or browser zoom changes the shared row dimensions.
 */
export class RowGeometry {
  private ids: readonly string[] = []
  private indexById = new Map<string, number>()
  private measuredById = new Map<string, number>()
  private blockSizes = new Float64Array(0)
  private fenwick = new Float64Array(1)
  private estimate: number | undefined

  get itemCount(): number {
    return this.ids.length
  }

  get isMeasured(): boolean {
    return this.estimate !== undefined
  }

  get estimatedBlockSize(): number | undefined {
    return this.estimate
  }

  get totalSize(): number {
    return this.offsetAt(this.ids.length)
  }

  /** Replace the currently visible identity projection; cached live sizes survive. */
  replaceItems(ids: readonly string[]): boolean {
    if (ids.length === this.ids.length && ids.every((id, index) => id === this.ids[index]))
      return false

    this.ids = [...ids]
    this.indexById = new Map(this.ids.map((id, index) => [id, index]))
    for (const id of this.measuredById.keys()) {
      if (!this.indexById.has(id)) this.measuredById.delete(id)
    }
    this.rebuild()
    return true
  }

  /** Apply a ResizeObserver batch and return whether geometry changed. */
  applyMeasurements(measurements: readonly RowMeasurement[]): boolean {
    const updates: { index: number; id: string; blockSize: number }[] = []
    const changedKnown: number[] = []

    for (const measurement of measurements) {
      const index = this.indexById.get(measurement.id)
      const blockSize = measurement.blockSize
      if (index === undefined || !Number.isFinite(blockSize) || blockSize <= 0) continue

      const previous = this.measuredById.get(measurement.id)
      if (previous !== undefined && Math.abs(previous - blockSize) < 0.25) continue
      this.measuredById.set(measurement.id, blockSize)
      updates.push({ id: measurement.id, index, blockSize })
      if (previous !== undefined) changedKnown.push(blockSize)
    }

    if (updates.length === 0) return false

    const nextEstimate =
      this.estimate === undefined
        ? mean(updates.map((update) => update.blockSize))
        : coherentScaledEstimate(changedKnown, this.estimate)

    if (nextEstimate !== undefined && Math.abs(nextEstimate - (this.estimate ?? 0)) >= 0.25) {
      this.estimate = nextEstimate
      this.rebuild()
      return true
    }

    if (this.estimate === undefined) {
      this.estimate = mean(updates.map((update) => update.blockSize))
      this.rebuild()
      return true
    }

    for (const update of updates) this.updateBlockSize(update.index, update.blockSize)
    return true
  }

  indexOf(id: string): number {
    return this.indexById.get(id) ?? -1
  }

  idAt(index: number): string | undefined {
    return Number.isInteger(index) && index >= 0 ? this.ids[index] : undefined
  }

  blockSizeAt(index: number): number {
    if (!Number.isInteger(index) || index < 0 || index >= this.ids.length) return 0
    return this.blockSizes[index] ?? 0
  }

  /** Sum the first `count` row sizes. */
  offsetAt(count: number): number {
    let index = Math.max(0, Math.min(this.ids.length, Math.trunc(count)))
    let total = 0
    while (index > 0) {
      total += this.fenwick[index] ?? 0
      index -= index & -index
    }
    return total
  }

  /** Find the row containing a CSS-pixel offset. */
  indexAtOffset(offset: number): number {
    const count = this.ids.length
    if (count === 0) return -1
    const total = this.totalSize
    const target = Math.max(0, Math.min(Number.isFinite(offset) ? offset : 0, total))
    if (target >= total) return count - 1

    let index = 0
    let prefix = 0
    let bit = 1
    while (bit * 2 <= count) bit *= 2

    while (bit > 0) {
      const next = index + bit
      if (next <= count && prefix + (this.fenwick[next] ?? 0) <= target) {
        index = next
        prefix += this.fenwick[next] ?? 0
      }
      bit >>= 1
    }
    return Math.min(index, count - 1)
  }

  private updateBlockSize(index: number, blockSize: number): void {
    const previous = this.blockSizes[index] ?? 0
    this.blockSizes[index] = blockSize
    const delta = blockSize - previous
    if (delta === 0) return
    for (let cursor = index + 1; cursor < this.fenwick.length; cursor += cursor & -cursor) {
      this.fenwick[cursor] = (this.fenwick[cursor] ?? 0) + delta
    }
  }

  private rebuild(): void {
    this.blockSizes = new Float64Array(this.ids.length)
    this.fenwick = new Float64Array(this.ids.length + 1)
    for (let index = 0; index < this.ids.length; index += 1) {
      this.blockSizes[index] = this.measuredById.get(this.ids[index] ?? '') ?? this.estimate ?? 0
    }
    for (let index = 1; index < this.fenwick.length; index += 1) {
      this.fenwick[index] += this.blockSizes[index - 1] ?? 0
      const parent = index + (index & -index)
      if (parent < this.fenwick.length) this.fenwick[parent] += this.fenwick[index] ?? 0
    }
  }
}

export type RowWindow = Readonly<{
  /** First flattened index to render (inclusive). */
  start: number
  /** One past the last flattened index to render. */
  end: number
  /** CSS-pixel offset for the mounted window inside its virtual scroll space. */
  offset: number
  /** Estimated full scroll-space block size in CSS pixels. */
  totalSize: number
}>

export function rowWindow(
  input: Readonly<{
    geometry: RowGeometry
    scrollTop: number
    viewportHeight: number
    overscan?: number
    /** A nearby focused row to preserve while the host's reveal callback scrolls. */
    pinIndex?: number
  }>
): RowWindow {
  const total = input.geometry.itemCount
  if (total === 0) return { end: 0, offset: 0, start: 0, totalSize: 0 }

  if (!input.geometry.isMeasured) {
    return {
      end: Math.min(total, FILES_WINDOW_BOOTSTRAP_ROWS),
      offset: 0,
      start: 0,
      totalSize: 0,
    }
  }

  const overscan = Math.max(0, Math.trunc(input.overscan ?? FILES_WINDOW_OVERSCAN))
  const estimate = input.geometry.estimatedBlockSize ?? 1
  const totalSize = input.geometry.totalSize
  const scrollTop = Math.max(
    0,
    Math.min(Number.isFinite(input.scrollTop) ? input.scrollTop : 0, totalSize)
  )
  const viewportHeight = Math.max(
    estimate,
    Number.isFinite(input.viewportHeight) ? input.viewportHeight : 0
  )
  const firstVisible = input.geometry.indexAtOffset(scrollTop)
  const lastVisible = input.geometry.indexAtOffset(Math.min(totalSize, scrollTop + viewportHeight))
  let start = Math.max(0, firstVisible - overscan)
  let end = Math.min(total, Math.max(firstVisible + 1, lastVisible + 1) + overscan)

  const pin = input.pinIndex
  const pinDistance = overscan * 2
  if (pin !== undefined && Number.isInteger(pin) && pin >= 0 && pin < total) {
    if (pin < start && start - pin <= pinDistance) start = pin
    if (pin >= end && pin - end < pinDistance) end = pin + 1
  }

  return {
    end,
    offset: input.geometry.offsetAt(start),
    start,
    totalSize,
  }
}

function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  return values.reduce((total, value) => total + value, 0) / values.length
}

function coherentScaledEstimate(values: readonly number[], current: number): number | undefined {
  if (values.length < 3) return undefined
  const average = mean(values)
  if (average === undefined || Math.abs(average - current) < Math.max(1, current * 0.08))
    return undefined
  const variance =
    values.reduce((total, value) => total + (value - average) ** 2, 0) / values.length
  return Math.sqrt(variance) <= average * 0.08 ? average : undefined
}
