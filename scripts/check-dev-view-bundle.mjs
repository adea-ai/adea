import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const assets = path.join(root, 'apps/web/dist/client/start-assets')

const DEV_ENTRY_MARKERS = ['Developer workspace panes', 'No runtime projects available.']
const DEV_LAYOUT_MARKER = 'terminal-bytes-v1 stream'
// The 84 KiB ratchet carries the named Wave K surfaces; keep it unchanged for
// both the Dev route entry and its nested central-layout renderer.
const DEV_CHUNK_BUDGET_BYTES = 84 * 1024

function dynamicImports(source) {
  const imports = []
  const pattern = /\bimport\s*\(\s*(?:'([^']+)'|"([^"]+)"|`([^`]+)`)\s*\)/g
  for (const match of source.matchAll(pattern)) imports.push(match[1] ?? match[2] ?? match[3])
  return imports
}

function staticImports(source) {
  const imports = new Set()
  for (const match of source.matchAll(/\bfrom\s*["']([^"']+)["']/g)) imports.add(match[1])
  for (const match of source.matchAll(/\bimport\s*["']([^"']+)["']/g)) imports.add(match[1])
  return [...imports]
}

function resolveRelativeChunk(importer, specifier) {
  if (!specifier.startsWith('.')) return undefined
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier))
  return resolved === '..' || resolved.startsWith('../') ? undefined : resolved
}

function findUniqueChunk(chunks, predicate, label) {
  const matches = chunks.filter(predicate)
  if (matches.length !== 1) throw new Error(`Expected one ${label} chunk, found ${matches.length}`)
  return matches[0]
}

function assertChunkBudget(chunk, label) {
  if (!Number.isSafeInteger(chunk.bytes) || chunk.bytes < 0) {
    throw new Error(`Invalid size for ${label} chunk ${chunk.file}: ${chunk.bytes}`)
  }
  if (chunk.bytes > DEV_CHUNK_BUDGET_BYTES) {
    throw new Error(
      `${label} chunk ${chunk.file} is ${chunk.bytes} bytes; budget is ${DEV_CHUNK_BUDGET_BYTES} bytes`
    )
  }
}

function assertNotEagerlyImported(chunks, entry, layout) {
  const chunksByFile = new Map(chunks.map((chunk) => [chunk.file, chunk]))
  const initial = chunks.filter(({ file }) =>
    /(?:workspace-mount|workspace-navigation-entry|client)-/.test(file)
  )
  const forbidden = new Map([
    [entry.file, 'Dev View entry'],
    [layout.file, 'Dev View layout renderer'],
  ])
  const pending = initial.map((chunk) => chunk.file)
  const visited = new Set()

  while (pending.length > 0) {
    const file = pending.pop()
    if (visited.has(file)) continue
    visited.add(file)

    const eagerKind = forbidden.get(file)
    if (eagerKind) throw new Error(`${file} eagerly imports ${eagerKind}`)

    const chunk = chunksByFile.get(file)
    if (!chunk) continue
    for (const specifier of staticImports(chunk.source)) {
      const resolved = resolveRelativeChunk(file, specifier)
      if (resolved && chunksByFile.has(resolved)) pending.push(resolved)
    }

    for (const marker of DEV_ENTRY_MARKERS) {
      if (chunk.source.includes(marker)) {
        throw new Error(`${file} eagerly contains Dev View implementation (${marker})`)
      }
    }
    if (chunk.source.includes(DEV_LAYOUT_MARKER)) {
      throw new Error(`${file} eagerly contains Dev View layout renderer`)
    }
    for (const forbiddenModule of ['@xterm/xterm', '@codemirror/', 'BrowserLane']) {
      if (chunk.source.includes(forbiddenModule))
        throw new Error(`${file} eagerly contains ${forbiddenModule}`)
    }
  }
}

/**
 * Inspect emitted Dev chunks by semantic markers rather than hashed filenames.
 * Both markers must remain unique, and the Dev entry must own the renderer's
 * dynamic import so a nested split cannot silently evade the 84 KiB ratchet.
 */
export function inspectDevViewChunks(chunks) {
  const entry = findUniqueChunk(
    chunks,
    ({ source }) => DEV_ENTRY_MARKERS.every((marker) => source.includes(marker)),
    'Dev View entry'
  )
  const layout = findUniqueChunk(
    chunks,
    ({ source }) => source.includes(DEV_LAYOUT_MARKER),
    'Dev View layout renderer'
  )

  if (entry.file === layout.file) {
    throw new Error('Dev View entry and layout renderer must remain separate lazy chunks')
  }
  const importsLayout = dynamicImports(entry.source).some(
    (specifier) => resolveRelativeChunk(entry.file, specifier) === layout.file
  )
  if (!importsLayout) {
    throw new Error(
      `Dev View entry chunk ${entry.file} does not dynamically import layout renderer ${layout.file}`
    )
  }

  assertChunkBudget(entry, 'Dev View entry')
  assertChunkBudget(layout, 'Dev View layout renderer')
  assertNotEagerlyImported(chunks, entry, layout)
  return { entry, layout }
}

async function main() {
  const files = await readdir(assets)
  const scripts = files.filter((file) => file.endsWith('.js'))
  const contents = await Promise.all(
    scripts.map(async (file) => ({
      file,
      source: await readFile(path.join(assets, file), 'utf8'),
      bytes: (await stat(path.join(assets, file))).size,
    }))
  )
  const { entry, layout } = inspectDevViewChunks(contents)
  console.log(
    `Dev View entry: ${entry.file} (${entry.bytes} bytes); layout renderer: ${layout.file} (${layout.bytes} bytes)`
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
