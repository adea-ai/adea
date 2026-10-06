import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { inspectDevViewChunks } from './check-dev-view-bundle.mjs'

const maxBytes = 112 * 1024
const maxGzipBytes = 34 * 1024

function devEntry(bytes: number, gzipBytes = 1_000) {
  return {
    file: 'src-entry.js',
    bytes,
    gzipBytes,
    source:
      'const paneLabel="Developer workspace panes";const empty="No runtime projects available.";import(`./layout-view.js`);',
  }
}

function layoutRenderer(bytes: number, gzipBytes = 1_000) {
  return {
    file: 'layout-view.js',
    bytes,
    gzipBytes,
    source: 'const centerLabel="Developer center panes";',
  }
}

test('rejects an over-budget combined route when both chunks individually fit', () => {
  expect(() => inspectDevViewChunks([devEntry(80_012), layoutRenderer(34_677)])).toThrow(
    'Dev View entry src-entry.js (80012 bytes) plus layout renderer layout-view.js (34677 bytes) totals 114689 bytes; budget is 114688 bytes'
  )
})

test('accepts an entry and renderer whose combined size equals the raw cap', () => {
  expect(inspectDevViewChunks([devEntry(50_000), layoutRenderer(maxBytes - 50_000)])).toMatchObject(
    {
      entry: { bytes: 50_000 },
      layout: { bytes: maxBytes - 50_000 },
    }
  )
})

test('enforces a separate gzip cap on the entry and layout pair', () => {
  expect(() =>
    inspectDevViewChunks([
      devEntry(40_000, 20_000),
      layoutRenderer(34_000, maxGzipBytes - 20_000 + 1),
    ])
  ).toThrow(
    `Dev View entry src-entry.js (20000 gzip bytes) plus layout renderer layout-view.js (${maxGzipBytes - 20_000 + 1} gzip bytes) totals ${maxGzipBytes + 1} gzip bytes; budget is ${maxGzipBytes} bytes`
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

test('loads Dev View only through the selected-view lazy boundary and intent preloader', () => {
  const navigation = readFileSync(
    resolve(import.meta.dir, '../apps/web/src/components/workspace-navigation.tsx'),
    'utf8'
  )
  const devEntryStart = navigation.indexOf('const DevWorkspace = lazyComponent(')
  const devEntryEnd = navigation.indexOf('\n)\n', devEntryStart) + 3
  const preloadStart = navigation.indexOf('function preloadView(')
  const preloadEnd = navigation.indexOf('\n}', preloadStart) + 2
  const devEntrySource = navigation.slice(devEntryStart, devEntryEnd)
  const preload = navigation.slice(preloadStart, preloadEnd)
  const withoutLazyBoundaries = navigation.replace(devEntrySource, '').replace(preload, '')

  expect(devEntrySource).toContain("import('@adea-ai/dev-view')")
  expect(preload).toContain("else if (nextView === 'dev')")
  // A bare namespace import keeps every barrel export (the DEV-only fixture
  // workspace among them) in the production Dev entry chunk.
  expect(preload).toMatch(/void import\('@adea-ai\/dev-view'\)\s*\.then\(\s*\(\{/)
  expect(devEntrySource).toContain('import.meta.env.DEV')
  expect(navigation).toContain("when={view() !== 'dev'}")
  expect(withoutLazyBoundaries).not.toMatch(/(?:from\s*|import\()\s*['"]@adea-ai\/dev-view['"]/)
})
