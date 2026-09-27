import { expect, test } from 'bun:test'

import { inspectDevViewChunks } from './check-dev-view-bundle.mjs'

const maxBytes = 84 * 1024

function devEntry(bytes: number) {
  return {
    file: 'src-entry.js',
    bytes,
    source:
      'const paneLabel="Developer workspace panes";const empty="No runtime projects available.";import(`./layout-view.js`);',
  }
}

function layoutRenderer(bytes: number) {
  return {
    file: 'layout-view.js',
    bytes,
    source:
      'const terminalCopy="Terminal output rides the authenticated terminal-bytes-v1 stream";',
  }
}

test('rejects an over-budget combined route when both chunks individually fit', () => {
  expect(() => inspectDevViewChunks([devEntry(80_012), layoutRenderer(34_209)])).toThrow(
    'Dev View entry src-entry.js (80012 bytes) plus layout renderer layout-view.js (34209 bytes) totals 114221 bytes; budget is 86016 bytes'
  )
})

test('accepts an entry and renderer whose combined size equals the unchanged cap', () => {
  expect(inspectDevViewChunks([devEntry(50_000), layoutRenderer(maxBytes - 50_000)])).toMatchObject(
    {
      entry: { bytes: 50_000 },
      layout: { bytes: maxBytes - 50_000 },
    }
  )
})

test('rejects when the renderer pushes a within-budget entry over the combined cap', () => {
  expect(() => inspectDevViewChunks([devEntry(80_012), layoutRenderer(6_005)])).toThrow(
    'Dev View entry src-entry.js (80012 bytes) plus layout renderer layout-view.js (6005 bytes) totals 86017 bytes; budget is 86016 bytes'
  )
})

test('fails closed when the Dev entry does not dynamically import the measured renderer', () => {
  expect(() =>
    inspectDevViewChunks([
      {
        ...devEntry(40_000),
        source: 'const a="Developer workspace panes";const b="No runtime projects available.";',
      },
      layoutRenderer(34_209),
    ])
  ).toThrow(
    'Dev View entry chunk src-entry.js does not dynamically import layout renderer layout-view.js'
  )
})

test('allows lazy imports from the initial shell', () => {
  expect(() =>
    inspectDevViewChunks([
      devEntry(40_000),
      layoutRenderer(34_209),
      {
        file: 'workspace-navigation-entry-abc.js',
        bytes: 10,
        source: 'import("./workspace-mount-abc.js");',
      },
      { file: 'workspace-mount-abc.js', bytes: 10, source: 'import("./src-entry.js");' },
    ])
  ).not.toThrow()
})

test('rejects an initial shell chunk that statically imports the Dev entry', () => {
  expect(() =>
    inspectDevViewChunks([
      devEntry(40_000),
      layoutRenderer(34_209),
      {
        file: 'workspace-navigation-entry-abc.js',
        bytes: 10,
        source: 'import "./workspace-mount-abc.js";',
      },
      { file: 'workspace-mount-abc.js', bytes: 10, source: 'import "./src-entry.js";' },
    ])
  ).toThrow('src-entry.js eagerly imports Dev View entry')
})
