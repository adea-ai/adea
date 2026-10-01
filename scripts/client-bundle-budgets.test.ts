import { expect, test } from 'bun:test'

import {
  CLIENT_BUNDLE_BUDGETS,
  assertClientBundleBudgets,
  inspectClientBundle,
} from './client-bundle-budgets.mjs'

interface ClientChunk {
  file: string
  source: string
  bytes: number
  gzipBytes: number
}

function chunk(file: string, source: string, bytes = 100, gzipBytes = 50): ClientChunk {
  return { file, source, bytes, gzipBytes }
}

function fixture(): ClientChunk[] {
  return [
    chunk('client-main.js', 'import "./runtime.js"; import("./chat-entry.js");', 10, 5),
    chunk('workspace-mount-main.js', 'import "./shared-shell.js";', 10, 5),
    chunk('workspace-navigation-entry-main.js', 'import "./shared-shell.js";', 10, 5),
    chunk('runtime.js', 'export const ready = true;', 4, 2),
    chunk('shared-shell.js', 'export const shell = true;', 12, 6),
    chunk(
      'workspace-shell-main.js',
      'import "./shared-shell.js"; import "./virtual-room-controls.js"; import "./virtual-unavailable.js"; const copy = "Virtual view lives in Agent Sim";',
      7,
      4
    ),
    chunk(
      'virtual-room-controls.js',
      'import "./shared-shell.js"; export const virtual = true;',
      5,
      3
    ),
    chunk('virtual-unavailable.js', 'export const fallback = true;', 3, 2),
    chunk(
      'conventional-workspace-entry-chat.js',
      'import "./shared-shell.js"; import "./chat-view.js";',
      20,
      10
    ),
    chunk('chat-view.js', 'export const chat = true;', 10, 5),
    chunk(
      'app-library-page-main.js',
      'import "./shared-shell.js"; import "./input-library.js";',
      6,
      3
    ),
    chunk('input-library.js', 'export const input = true;', 2, 1),
    chunk(
      'src-dev.js',
      'import "./shared-shell.js"; import "./dev-helper.js"; import("./layout-view.js"); import("./other-pane.js"); import("./runtime-terminal-pane-main.js"); import("./code-editor-main.js"); const a = "Developer workspace panes"; const b = "No runtime projects available.";',
      20,
      10
    ),
    chunk(
      'layout-view.js',
      'import "./shared-shell.js"; import "./layout-helper.js"; const copy = "terminal-bytes-v1 stream";',
      10,
      5
    ),
    chunk('dev-helper.js', 'export const dev = true;', 4, 2),
    chunk('layout-helper.js', 'export const layout = true;', 2, 1),
    chunk('other-pane.js', 'import "./shared-shell.js"; import "./other-pane-helper.js";', 5, 3),
    chunk('other-pane-helper.js', 'export const pane = true;', 4, 2),
    chunk(
      'terminal-pane-main.js',
      'import "./shared-shell.js"; import "./terminal-helper.js";',
      15,
      8
    ),
    chunk('terminal-helper.js', 'export const terminal = true;', 8, 4),
    chunk(
      'runtime-terminal-pane-main.js',
      'import("./terminal-pane-main.js"); export const runtime = true;',
      6,
      3
    ),
    chunk(
      'code-editor-main.js',
      'import("./editor-mirror-main.js"); import("./file-stream-main.js"); export const editor = true;',
      5,
      3
    ),
    chunk('editor-mirror-main.js', 'export const mirror = true;', 30, 15),
    chunk('file-stream-main.js', 'export const stream = true;', 8, 5),
  ]
}

test('measures the workspace startup graph separately from each lazy view', () => {
  const report = inspectClientBundle(fixture())

  expect(report.startup).toMatchObject({ rawBytes: 46, gzipBytes: 23 })
  expect(report.views.virtual).toMatchObject({ rawBytes: 15, gzipBytes: 9 })
  expect(report.views.chat).toMatchObject({ rawBytes: 30, gzipBytes: 15 })
  expect(report.views.appLibrary).toMatchObject({ rawBytes: 8, gzipBytes: 4 })
  expect(report.views.devShell).toMatchObject({ rawBytes: 36, gzipBytes: 18 })
  expect(report.views.devUtilityPanes).toMatchObject({ rawBytes: 9, gzipBytes: 5 })
  expect(report.views.devTerminal).toMatchObject({ rawBytes: 65, gzipBytes: 33 })
  expect(report.views.devEditor).toMatchObject({ rawBytes: 79, gzipBytes: 41 })
  expect(report.total.fileCount).toBe(fixture().length)
})

test('fails closed when a required route chunk cannot be attributed', () => {
  expect(() =>
    inspectClientBundle(fixture().filter(({ file }) => !file.startsWith('app-library-page-')))
  ).toThrow('Expected one App Library route chunk, found 0')
})

test('rejects a route that becomes part of the static startup graph', () => {
  const chunks = fixture().map((item) =>
    item.file === 'workspace-navigation-entry-main.js'
      ? { ...item, source: 'import "./shared-shell.js"; import "./src-dev.js";' }
      : item
  )

  expect(() => inspectClientBundle(chunks)).toThrow('statically loads the Dev View entry')
})

test('fails if a lazy editor chunk is added without route attribution', () => {
  const chunks = fixture().map((item) =>
    item.file === 'code-editor-main.js'
      ? {
          ...item,
          source:
            'import("./editor-mirror-main.js"); import("./file-stream-main.js"); import("./unattributed.js");',
        }
      : item
  )
  chunks.push(chunk('unattributed.js', 'export const extra = true;'))

  expect(() => inspectClientBundle(chunks)).toThrow(
    'Dev editor route dynamic chunk attribution changed'
  )
})

test('fails if an attributed editor child adds a nested lazy chunk', () => {
  const chunks = fixture().map((item) =>
    item.file === 'editor-mirror-main.js'
      ? { ...item, source: 'import("./nested.js"); export const mirror = true;' }
      : item
  )
  chunks.push(chunk('nested.js', 'export const nested = true;'))

  expect(() => inspectClientBundle(chunks)).toThrow(
    'Dev editor route dynamic chunk attribution changed in editor-mirror-main.js'
  )
})

test('fails closed when no other lazy Dev utility panes can be attributed', () => {
  const chunks = fixture().map((item) =>
    item.file === 'src-dev.js'
      ? { ...item, source: item.source.replace('import("./other-pane.js");', '') }
      : item
  )

  expect(() => inspectClientBundle(chunks)).toThrow(
    'Dev View entry has no dynamically attributed utility panes'
  )
})

test('enforces each route budget independently of the full-client total', () => {
  const report = inspectClientBundle(fixture())
  report.views.chat.rawBytes = CLIENT_BUNDLE_BUDGETS.views.chat.rawBytes + 1

  expect(() => assertClientBundleBudgets(report)).toThrow('Chat route exceeds raw byte budget')
})

test('enforces a separate budget for the aggregate of other lazy Dev panes', () => {
  const report = inspectClientBundle(fixture())
  report.views.devUtilityPanes.rawBytes = 168 * 1024 + 1

  expect(() => assertClientBundleBudgets(report)).toThrow(
    'Dev utility panes exceeds raw byte budget'
  )
})

test('retains aggregate raw, gzip, and file-count ceilings', () => {
  const overRaw = inspectClientBundle(fixture())
  overRaw.total.rawBytes = 2_350_001
  expect(() => assertClientBundleBudgets(overRaw)).toThrow('Total client JavaScript exceeds raw')

  const overGzip = inspectClientBundle(fixture())
  overGzip.total.gzipBytes = 700 * 1024 + 1
  expect(() => assertClientBundleBudgets(overGzip)).toThrow('Total client JavaScript exceeds gzip')

  const overFiles = inspectClientBundle(fixture())
  overFiles.total.fileCount = CLIENT_BUNDLE_BUDGETS.total.fileCount + 1
  expect(() => assertClientBundleBudgets(overFiles)).toThrow('Client JavaScript chunk-count budget')
})
