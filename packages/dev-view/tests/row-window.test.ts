import { describe, expect, test } from 'bun:test'

import { RowGeometry, rowWindow } from '../src/files/row-window'

function measuredGeometry(ids: readonly string[], size: number): RowGeometry {
  const geometry = new RowGeometry()
  geometry.replaceItems(ids)
  geometry.applyMeasurements(ids.map((id) => ({ id, blockSize: size })))
  return geometry
}

describe('row geometry', () => {
  test('bootstraps a bounded slice until the shared row reports its real size', () => {
    const geometry = new RowGeometry()
    geometry.replaceItems(Array.from({ length: 100_000 }, (_, index) => `row-${index}`))

    const window = rowWindow({ geometry, scrollTop: 0, viewportHeight: 0 })

    expect(window.start).toBe(0)
    expect(window.end).toBe(64)
    expect(window.offset).toBe(0)
    expect(window.totalSize).toBe(0)
    expect(window.end - window.start).toBeLessThan(100)
  })

  test('uses each measured border-box size for offsets and visible bounds', () => {
    const ids = Array.from({ length: 1_000 }, (_, index) => `row-${index}`)
    const geometry = new RowGeometry()
    geometry.replaceItems(ids)
    geometry.applyMeasurements([
      { id: 'row-0', blockSize: 20 },
      { id: 'row-1', blockSize: 40 },
      { id: 'row-2', blockSize: 30 },
      { id: 'row-3', blockSize: 50 },
    ])

    expect(geometry.offsetAt(2)).toBe(60)
    expect(geometry.indexAtOffset(60)).toBe(2)
    expect(geometry.blockSizeAt(2)).toBe(30)
    expect(geometry.totalSize).toBe(35_000)

    const window = rowWindow({
      geometry,
      overscan: 0,
      scrollTop: 60,
      viewportHeight: 50,
    })
    expect(window.start).toBe(2)
    expect(window.end).toBe(4)
    expect(window.offset).toBe(60)
    expect(window.totalSize).toBe(35_000)
  })

  test('updates the estimate from a mounted text-size change and preserves measured rows', () => {
    const ids = Array.from({ length: 100 }, (_, index) => `row-${index}`)
    const geometry = measuredGeometry(ids.slice(0, 12), 24)
    geometry.replaceItems(ids)

    geometry.applyMeasurements(ids.slice(0, 12).map((id) => ({ id, blockSize: 48 })))

    expect(geometry.estimatedBlockSize).toBe(48)
    expect(geometry.totalSize).toBe(100 * 48)
    expect(geometry.blockSizeAt(0)).toBe(48)
  })

  test('keeps a distant active row from expanding the contiguous DOM window', () => {
    const ids = Array.from({ length: 100_000 }, (_, index) => `row-${index}`)
    const geometry = measuredGeometry(ids, 32)

    const window = rowWindow({
      geometry,
      pinIndex: 99_999,
      scrollTop: 0,
      viewportHeight: 320,
    })

    expect(window.start).toBe(0)
    expect(window.end).toBeLessThan(100)
    expect(window.end).toBeLessThan(99_999)
  })

  test('keeps nearby pinned focus inside the normal overscan range', () => {
    const geometry = measuredGeometry(
      Array.from({ length: 1_000 }, (_, index) => `row-${index}`),
      32
    )
    const window = rowWindow({
      geometry,
      pinIndex: 30,
      scrollTop: 0,
      viewportHeight: 320,
    })

    expect(window.start).toBeLessThanOrEqual(30)
    expect(window.end).toBeGreaterThan(30)
  })

  test('retains sizes for surviving identities when the visible projection changes', () => {
    const geometry = measuredGeometry(['a', 'b', 'c'], 28)
    geometry.applyMeasurements([{ id: 'b', blockSize: 44 }])

    geometry.replaceItems(['b', 'd'])

    expect(geometry.blockSizeAt(0)).toBe(44)
    expect(geometry.offsetAt(1)).toBe(44)
    expect(geometry.totalSize).toBe(72)
    expect(geometry.indexOf('a')).toBe(-1)
  })

  test('an empty projection has no virtual extent', () => {
    const geometry = new RowGeometry()
    geometry.replaceItems([])

    expect(rowWindow({ geometry, scrollTop: 0, viewportHeight: 280 })).toEqual({
      end: 0,
      offset: 0,
      start: 0,
      totalSize: 0,
    })
  })

  test('windows a 100,000-row list at its measured scroll offset', () => {
    const ids = Array.from({ length: 100_000 }, (_, index) => `row-${index}`)
    const geometry = measuredGeometry(ids, 24)
    const window = rowWindow({
      geometry,
      scrollTop: 48_000,
      viewportHeight: 600,
    })

    expect(window.start).toBeGreaterThan(0)
    expect(window.end - window.start).toBeLessThan(100)
    expect(window.offset).toBeLessThan(48_000)
    expect(window.totalSize).toBe(2_400_000)
    expect(window.end).toBeLessThanOrEqual(100_000)
  }, 10_000)
})
