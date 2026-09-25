import { describe, expect, test } from 'bun:test'

import {
  CONTENT_SEARCH_LIMIT,
  contentSearchBody,
  contentSearchRows,
  matchLabel,
  matchSummary,
  previewSegments,
  searchQuery,
  type ContentSearchRow,
} from '../src/files/search-model'

const scope = {
  rootIdentity: { mtimeNs: '1', size: '1' },
  relativePath: 'src/index.ts',
  worktreeId: 'wt-1',
}
const identity = { mtimeNs: '1', size: '10' }

function row(overrides: Partial<ContentSearchRow> = {}): ContentSearchRow {
  return {
    column: 7,
    identity,
    line: 12,
    path: scope,
    preview: 'const needle = 1',
    ranges: [{ end: 12, start: 6 }],
    ...overrides,
  }
}

describe('content search request', () => {
  test('sends a trimmed query, refuses whitespace, and caps the wire length', () => {
    expect(searchQuery('  needle  ')).toBe('needle')
    expect(searchQuery('   ')).toBeUndefined()
    expect(searchQuery('')).toBeUndefined()
    expect(searchQuery('x'.repeat(5000))).toHaveLength(4096)
    expect(contentSearchBody('wt-1', 'needle')).toEqual({
      limit: CONTENT_SEARCH_LIMIT,
      query: 'needle',
      worktreeId: 'wt-1',
    })
  })
})

describe('content search results', () => {
  test('keeps the identity a click needs to open the file', () => {
    const rows = contentSearchRows([
      {
        column: 1,
        identity,
        line: 3,
        path: scope,
        preview: 'needle',
        ranges: [{ end: 6, start: 0 }],
      },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ identity, line: 3 })
    expect(matchLabel(rows[0]!)).toBe('src/index.ts:3')
  })

  test('summarizes matches by file, and says when the page is capped', () => {
    expect(matchSummary([], false)).toBe('No matches in this worktree.')
    expect(matchSummary([row()], false)).toBe('1 match in 1 file')
    expect(
      matchSummary([row(), row({ path: { ...scope, relativePath: 'src/other.ts' } })], false)
    ).toBe('2 matches in 2 files')
    expect(matchSummary([row()], true)).toBe('1 match in 1 file (showing the first 1)')
  })

  test('cuts the preview around the matched ranges', () => {
    expect(previewSegments(row())).toEqual([
      { match: false, text: 'const ' },
      { match: true, text: 'needle' },
      { match: false, text: ' = 1' },
    ])
    expect(previewSegments(row({ ranges: [], preview: 'plain' }))).toEqual([
      { match: false, text: 'plain' },
    ])
  })

  test('handles unsorted and overlapping ranges without repeating text', () => {
    const unsorted = row({
      preview: 'aaabbbccc',
      ranges: [
        { end: 9, start: 6 },
        { end: 3, start: 0 },
      ],
    })
    expect(previewSegments(unsorted)).toEqual([
      { match: true, text: 'aaa' },
      { match: false, text: 'bbb' },
      { match: true, text: 'ccc' },
    ])

    const overlapping = row({
      preview: 'aaaabbbb',
      ranges: [
        { end: 6, start: 0 },
        { end: 8, start: 4 },
      ],
    })
    // The second range only contributes the part the first did not cover, so no
    // character is emitted twice.
    const segments = previewSegments(overlapping)
    expect(segments.map((segment) => segment.text).join('')).toBe('aaaabbbb')
    expect(segments).toEqual([
      { match: true, text: 'aaaabb' },
      { match: true, text: 'bb' },
    ])
  })
})
