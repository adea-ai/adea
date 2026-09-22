import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const assets = path.join(root, 'apps/web/dist/client/start-assets')
const files = await readdir(assets)
const scripts = files.filter((file) => file.endsWith('.js'))
const contents = await Promise.all(
  scripts.map(async (file) => ({ file, source: await readFile(path.join(assets, file), 'utf8') }))
)
const devChunks = contents.filter(({ source }) => source.includes('terminal-bytes-v1 stream'))
if (devChunks.length !== 1) {
  throw new Error(`Expected one lazy Dev View chunk, found ${devChunks.length}`)
}
const devChunk = devChunks[0]
const devBytes = (await stat(path.join(assets, devChunk.file))).size
// The ratchet: 70 KiB held through the M12 build-out, but F3's hunk staging +
// quick-open landed the chunk at 71,600 bytes (80 bytes of headroom) and the
// Wave K product surfaces (live browser frames, terminal UX depth, owner-
// journey hardening) would blow that wall immediately. 84 KiB carries them;
// the eager-shell prohibition below stays the real guard. Re-tighten after
// Wave K if the landed surfaces allow.
if (devBytes > 84 * 1024) {
  throw new Error(`Dev View chunk is ${devBytes} bytes; budget is 86016 bytes`)
}
const initial = contents.filter(({ file }) =>
  /(?:workspace-mount|workspace-navigation-entry|client)-/.test(file)
)
for (const { file, source } of initial) {
  if (source.includes('terminal-bytes-v1 stream'))
    throw new Error(`${file} eagerly contains Dev View implementation`)
  for (const forbidden of ['@xterm/xterm', '@codemirror/', 'BrowserLane']) {
    if (source.includes(forbidden)) throw new Error(`${file} eagerly contains ${forbidden}`)
  }
}
console.log(`Dev View lazy chunk: ${devChunk.file} (${devBytes} bytes)`)
