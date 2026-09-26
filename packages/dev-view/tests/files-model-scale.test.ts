/*
 * Files model at scale. The audit flagged the `push(...recurse())` pattern in
 * this model as "suspected, unproven" because no fixture was ever large enough
 * to settle it. These settle it, and pin the flattening cost at a size a real
 * monorepo actually reaches.
 *
 * Measured on this runtime: `arr.push(...other)` survives 600k arguments and
 * throws a RangeError from 700k up. So the spread form was a distant ceiling,
 * not a routine one. These tests cover the size a real monorepo reaches
 * (100k children) and a 2,000-deep chain, and guard against a quadratic
 * regression in the flattening.
 *
 * Honest scope: at 100k the spread form ALSO passes, so these tests do NOT
 * discriminate the in-place append. Proving that would need a ~700k-entry
 * fixture — hundreds of MB and seconds of CI time for a case no real workspace
 * reaches. The append is kept because it removes the ceiling for free, not
 * because a test here demands it.
 */
import { describe, expect, test } from 'bun:test'

import type { FileTreeNode } from '../src/files/files-model'
import { rowWindow } from '../src/files/row-window'
import { visibleRows } from '../src/files/files-model'

const WIDE = 100_000

function node(relativePath: string, kind: 'file' | 'directory'): FileTreeNode {
  return {
    children: [],
    kind,
    relativePath,
  } as unknown as FileTreeNode
}

/** One directory holding WIDE files. */
function wideTree(): FileTreeNode {
  return {
    children: Array.from({ length: WIDE }, (_, index) =>
      node(`node_modules/pkg-${index}/index.js`, 'file')
    ),
    kind: 'directory',
    relativePath: 'node_modules',
  } as unknown as FileTreeNode
}

/** A chain `DEPTH` directories deep, the last holding a file. */
function deepTree(depth: number): FileTreeNode {
  let current = node('leaf.txt', 'file')
  for (let level = depth - 1; level >= 0; level -= 1)
    current = {
      children: [current],
      kind: 'directory',
      relativePath: `d${level}`,
    } as unknown as FileTreeNode
  return current
}

describe('files model at scale', () => {
  test('flattens a directory with 100,000 children', () => {
    const root = wideTree()
    const started = performance.now()
    const rows = visibleRows([root], new Set([root.relativePath]))
    const elapsed = performance.now() - started
    // The directory row itself, plus one row per child.
    expect(rows).toHaveLength(WIDE + 1)
    expect(rows[0]?.node.relativePath).toBe('node_modules')
    expect(rows[1]?.node.relativePath).toBe('node_modules/pkg-0/index.js')
    expect(rows.at(-1)?.node.relativePath).toBe(`node_modules/pkg-${WIDE - 1}/index.js`)
    expect(rows[1]?.depth).toBe(1)
    expect(rows[1]?.hasChildren).toBe(false)
    // Guards against a quadratic regression, not a wall-clock promise.
    expect(elapsed).toBeLessThan(5_000)
  }, 30_000)

  test('flattens a 2,000-deep directory chain', () => {
    const root = deepTree(2_000)
    const expanded = new Set<string>()
    for (let level = 0; level < 2_000; level += 1) expanded.add(`d${level}`)
    const rows = visibleRows([root], expanded)
    // Every directory in the chain, plus the leaf file.
    expect(rows).toHaveLength(2_001)
    expect(rows[0]?.depth).toBe(0)
    expect(rows.at(-1)?.node.relativePath).toBe('leaf.txt')
    expect(rows.at(-1)?.depth).toBe(2_000)
  }, 30_000)

  test('windows a 100,000-row list to the viewport', () => {
    // The window math is what keeps a 100k-row tree from mounting 100k rows,
    // so pin it against a total that large — the existing row-window tests use
    // totals in the hundreds.
    const slice = rowWindow({
      pinIndex: undefined,
      rowHeight: 24,
      scrollTop: 48_000,
      total: WIDE + 1,
      viewportHeight: 600,
    })
    expect(slice.start).toBeGreaterThan(0)
    expect(slice.end - slice.start).toBeLessThan(200)
    // padTop stands in for the rows above the window, so it tracks `start`,
    // which sits OVERSCAN rows above the first visible one.
    expect(slice.padTop).toBe(slice.start * 24)
    expect(slice.padTop).toBeLessThan(48_000)
    expect(slice.start).toBeLessThanOrEqual(WIDE)
    expect(slice.end).toBeLessThanOrEqual(WIDE + 1)
  }, 10_000)
})
