import path from 'node:path'
import { gzipSync } from 'node:zlib'

// Route-aware limits are based on the production workspace build recorded in
// docs/decisions/0010-performance-budgets-and-gates.md. The aggregate cap still
// catches total payload growth; the startup and view caps stop lazy features
// from consuming startup headroom without being downloaded on initial load.
export const CLIENT_BUNDLE_BUDGETS = {
  total: { rawBytes: 2_350_000, gzipBytes: 700 * 1024, fileCount: 84 },
  startup: { rawBytes: 720 * 1024, gzipBytes: 230 * 1024 },
  views: {
    virtual: { rawBytes: 14 * 1024, gzipBytes: 6 * 1024 },
    chat: { rawBytes: 176 * 1024, gzipBytes: 56 * 1024 },
    appLibrary: { rawBytes: 6 * 1024, gzipBytes: 3 * 1024 },
    devShell: { rawBytes: 128 * 1024, gzipBytes: 40 * 1024 },
    devUtilityPanes: { rawBytes: 168 * 1024, gzipBytes: 56 * 1024 },
    devTerminal: { rawBytes: 768 * 1024, gzipBytes: 192 * 1024 },
    devEditor: { rawBytes: 512 * 1024, gzipBytes: 160 * 1024 },
  },
}

const DEV_ENTRY_MARKERS = ['Developer workspace panes', 'No runtime projects available.']
const DEV_LAYOUT_MARKER = 'terminal-bytes-v1 stream'

function chunkName(file) {
  return path.posix.basename(file)
}

function uniqueChunk(chunks, predicate, label) {
  const matches = chunks.filter(predicate)
  if (matches.length !== 1) throw new Error(`Expected one ${label} chunk, found ${matches.length}`)
  return matches[0]
}

function chunkByPrefix(chunks, prefix, label) {
  return uniqueChunk(chunks, ({ file }) => chunkName(file).startsWith(prefix), label)
}

function staticImports(source) {
  const imports = new Set()
  for (const match of source.matchAll(/\bfrom\s*["']([^"']+)["']/g)) imports.add(match[1])
  for (const match of source.matchAll(/\bimport\s*["']([^"']+)["']/g)) imports.add(match[1])
  return [...imports]
}

function dynamicImports(source) {
  const imports = new Set()
  const pattern = /\bimport\s*\(\s*(?:'([^']+)'|"([^"]+)"|`([^`]+)`)/g
  for (const match of source.matchAll(pattern)) imports.add(match[1] ?? match[2] ?? match[3])
  return [...imports]
}

function resolveRelativeChunk(importer, specifier) {
  if (!specifier.startsWith('.')) return undefined
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier))
  return resolved === '..' || resolved.startsWith('../') ? undefined : resolved
}

function staticClosure(roots, chunksByFile) {
  const pending = roots.map(({ file }) => file)
  const visited = new Set()

  while (pending.length > 0) {
    const file = pending.pop()
    if (visited.has(file)) continue
    const chunk = chunksByFile.get(file)
    if (!chunk) throw new Error(`Missing JavaScript chunk ${file}`)
    visited.add(file)

    for (const specifier of staticImports(chunk.source)) {
      const resolved = resolveRelativeChunk(file, specifier)
      if (!resolved) continue
      if (chunksByFile.has(resolved)) {
        pending.push(resolved)
      } else if (resolved.endsWith('.js')) {
        throw new Error(`${file} statically imports missing JavaScript chunk ${resolved}`)
      }
    }
  }

  return visited
}

function assertDynamicRouteClosure(
  roots,
  expectedTargetsByFile,
  ignoredFiles,
  chunksByFile,
  label
) {
  for (const file of staticClosure(roots, chunksByFile)) {
    if (ignoredFiles.has(file)) continue
    const chunk = chunksByFile.get(file)
    const actualTargets = new Set(
      dynamicImports(chunk.source)
        .map((specifier) => resolveRelativeChunk(chunk.file, specifier))
        .filter((target) => target && chunksByFile.has(target))
    )
    const expectedTargets = new Set(expectedTargetsByFile.get(file) ?? [])
    if (
      actualTargets.size !== expectedTargets.size ||
      [...actualTargets].some((target) => !expectedTargets.has(target))
    ) {
      throw new Error(
        `${label} dynamic chunk attribution changed in ${file}: expected ${[...expectedTargets].toSorted().join(', ')}, found ${[...actualTargets].toSorted().join(', ')}`
      )
    }
  }
}

function measure(files, chunksByFile) {
  let rawBytes = 0
  let gzipBytes = 0
  for (const file of files) {
    const chunk = chunksByFile.get(file)
    rawBytes += chunk.bytes
    gzipBytes += chunk.gzipBytes
  }
  return {
    rawBytes,
    gzipBytes,
    fileCount: files.size,
    files: [...files].toSorted(),
  }
}

function routeDelta(label, roots, startupFiles, chunksByFile, additionallyExcluded = new Set()) {
  for (const root of roots) {
    if (startupFiles.has(root.file)) {
      throw new Error(`${root.file} statically loads the ${label} entry`)
    }
  }
  const routeFiles = staticClosure(roots, chunksByFile)
  return measure(
    new Set(
      [...routeFiles].filter((file) => !startupFiles.has(file) && !additionallyExcluded.has(file))
    ),
    chunksByFile
  )
}

/**
 * Measure the initial workspace graph and the incremental static graph for
 * each built-in view. Dynamic imports remain lazy and count only when their
 * view or pane is opened; shared startup chunks are charged once to startup.
 */
export function inspectClientBundle(input) {
  if (!Array.isArray(input) || input.length === 0)
    throw new Error('Missing built client JavaScript chunks')

  const chunks = input.map((chunk) => {
    if (
      !chunk ||
      typeof chunk.file !== 'string' ||
      typeof chunk.source !== 'string' ||
      !Number.isSafeInteger(chunk.bytes) ||
      chunk.bytes < 0
    ) {
      throw new Error('Invalid client JavaScript chunk metadata')
    }
    const gzipBytes = chunk.gzipBytes ?? gzipSync(chunk.source).byteLength
    if (!Number.isSafeInteger(gzipBytes) || gzipBytes < 0)
      throw new Error(`Invalid gzip size for client chunk ${chunk.file}`)
    return { ...chunk, gzipBytes }
  })
  const chunksByFile = new Map(chunks.map((chunk) => [chunk.file, chunk]))
  if (chunksByFile.size !== chunks.length) throw new Error('Duplicate client JavaScript chunk path')

  const startupRoots = [
    chunkByPrefix(chunks, 'client-', 'client bootstrap'),
    chunkByPrefix(chunks, 'workspace-mount-', 'workspace mount'),
    chunkByPrefix(chunks, 'workspace-navigation-entry-', 'workspace navigation entry'),
  ]
  const startupFiles = staticClosure(startupRoots, chunksByFile)

  const virtualRoot = chunkByPrefix(chunks, 'workspace-shell-', 'Virtual view')
  const chatRoot = chunkByPrefix(chunks, 'conventional-workspace-entry-', 'Chat view')
  const libraryRoot = chunkByPrefix(chunks, 'app-library-page-', 'App Library route')
  const devEntry = uniqueChunk(
    chunks,
    ({ source }) => DEV_ENTRY_MARKERS.every((marker) => source.includes(marker)),
    'Dev View entry'
  )
  const devLayout = uniqueChunk(
    chunks,
    ({ source }) => source.includes(DEV_LAYOUT_MARKER),
    'Dev View layout renderer'
  )
  const terminalPane = chunkByPrefix(chunks, 'terminal-pane-', 'Dev terminal pane')
  const runtimeTerminalPane = chunkByPrefix(
    chunks,
    'runtime-terminal-pane-',
    'runtime terminal pane'
  )
  const codeEditor = chunkByPrefix(chunks, 'code-editor-', 'Dev code editor')
  const editorMirror = chunkByPrefix(chunks, 'editor-mirror-', 'Dev editor renderer')
  const fileStream = chunkByPrefix(chunks, 'file-stream-', 'Dev editor file stream')
  const devUtilityPaneRoots = dynamicImports(devEntry.source)
    .map((specifier) => resolveRelativeChunk(devEntry.file, specifier))
    .filter(
      (file) =>
        file &&
        chunksByFile.has(file) &&
        ![devLayout.file, runtimeTerminalPane.file, codeEditor.file].includes(file)
    )
    .map((file) => chunksByFile.get(file))
  if (devUtilityPaneRoots.length === 0) {
    throw new Error('Dev View entry has no dynamically attributed utility panes')
  }
  assertDynamicRouteClosure(
    [runtimeTerminalPane, terminalPane],
    new Map([[runtimeTerminalPane.file, [terminalPane.file]]]),
    new Set([...startupFiles, devEntry.file]),
    chunksByFile,
    'Dev terminal route'
  )
  assertDynamicRouteClosure(
    [codeEditor, editorMirror, fileStream],
    new Map([[codeEditor.file, [editorMirror.file, fileStream.file]]]),
    new Set([...startupFiles, devEntry.file]),
    chunksByFile,
    'Dev editor route'
  )

  const views = {
    virtual: routeDelta('Virtual view', [virtualRoot], startupFiles, chunksByFile),
    chat: routeDelta('Chat view', [chatRoot], startupFiles, chunksByFile),
    appLibrary: routeDelta('App Library route', [libraryRoot], startupFiles, chunksByFile),
    devShell: routeDelta('Dev View', [devEntry, devLayout], startupFiles, chunksByFile),
    devUtilityPanes: routeDelta(
      'Dev utility panes',
      devUtilityPaneRoots,
      startupFiles,
      chunksByFile,
      new Set([
        ...staticClosure([devEntry, devLayout, terminalPane, runtimeTerminalPane], chunksByFile),
        ...staticClosure([devEntry, devLayout, codeEditor, editorMirror, fileStream], chunksByFile),
      ])
    ),
    devTerminal: routeDelta(
      'Dev terminal route',
      [devEntry, devLayout, terminalPane, runtimeTerminalPane],
      startupFiles,
      chunksByFile
    ),
    devEditor: routeDelta(
      'Dev code editor route',
      [devEntry, devLayout, codeEditor, editorMirror, fileStream],
      startupFiles,
      chunksByFile
    ),
  }

  const total = measure(new Set(chunks.map(({ file }) => file)), chunksByFile)
  return {
    startup: measure(startupFiles, chunksByFile),
    views,
    total: { rawBytes: total.rawBytes, gzipBytes: total.gzipBytes, fileCount: total.fileCount },
  }
}

function assertByteBudget(label, measurement, budget) {
  if (measurement.rawBytes > budget.rawBytes) {
    throw new Error(
      `${label} exceeds raw byte budget: ${measurement.rawBytes} > ${budget.rawBytes} bytes`
    )
  }
  if (measurement.gzipBytes > budget.gzipBytes) {
    throw new Error(
      `${label} exceeds gzip byte budget: ${measurement.gzipBytes} > ${budget.gzipBytes} bytes`
    )
  }
}

export function assertClientBundleBudgets(report) {
  assertByteBudget('Workspace startup', report.startup, CLIENT_BUNDLE_BUDGETS.startup)
  assertByteBudget('Virtual route', report.views.virtual, CLIENT_BUNDLE_BUDGETS.views.virtual)
  assertByteBudget('Chat route', report.views.chat, CLIENT_BUNDLE_BUDGETS.views.chat)
  assertByteBudget(
    'App Library route',
    report.views.appLibrary,
    CLIENT_BUNDLE_BUDGETS.views.appLibrary
  )
  assertByteBudget('Dev View shell', report.views.devShell, CLIENT_BUNDLE_BUDGETS.views.devShell)
  assertByteBudget(
    'Dev utility panes',
    report.views.devUtilityPanes,
    CLIENT_BUNDLE_BUDGETS.views.devUtilityPanes
  )
  assertByteBudget(
    'Dev terminal route',
    report.views.devTerminal,
    CLIENT_BUNDLE_BUDGETS.views.devTerminal
  )
  assertByteBudget(
    'Dev code editor route',
    report.views.devEditor,
    CLIENT_BUNDLE_BUDGETS.views.devEditor
  )
  if (report.total.rawBytes > CLIENT_BUNDLE_BUDGETS.total.rawBytes) {
    throw new Error(
      `Total client JavaScript exceeds raw byte budget: ${report.total.rawBytes} > ${CLIENT_BUNDLE_BUDGETS.total.rawBytes} bytes`
    )
  }
  if (report.total.gzipBytes > CLIENT_BUNDLE_BUDGETS.total.gzipBytes) {
    throw new Error(
      `Total client JavaScript exceeds gzip byte budget: ${report.total.gzipBytes} > ${CLIENT_BUNDLE_BUDGETS.total.gzipBytes} bytes`
    )
  }
  if (report.total.fileCount > CLIENT_BUNDLE_BUDGETS.total.fileCount) {
    throw new Error(
      `Client JavaScript chunk-count budget exceeded: ${report.total.fileCount} > ${CLIENT_BUNDLE_BUDGETS.total.fileCount} files`
    )
  }
}
