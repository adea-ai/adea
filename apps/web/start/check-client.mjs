import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { forbiddenClientModule, PRIVATE_ENV_NAMES } from './client-policy.mjs'

const clientDirectory = fileURLToPath(new URL('../dist/client/', import.meta.url))
const modules = JSON.parse(
  await readFile(new URL('../dist/.checks/client-modules.json', import.meta.url), 'utf8')
)
if (!Array.isArray(modules) || modules.length === 0)
  throw new Error('Missing client module evidence')
if (!modules.every((id) => typeof id === 'string'))
  throw new Error('Invalid client module evidence')
const forbidden = modules.filter(forbiddenClientModule)
if (forbidden.length) throw new Error(`Server dependencies in client: ${forbidden.join(', ')}`)
// The trimZodLocales Vite plugin narrows zod's locales barrel to English; a
// dependency update that routes around it must be caught here, not in a
// bundle-diff review.
const extraLocales = modules.filter(
  (id) =>
    /zod.*\/v4\/locales\/[^/]+\.js$/.test(id) && !id.endsWith('/en.js') && !id.endsWith('/index.js')
)
if (extraLocales.length)
  throw new Error(`Non-English zod locales in client graph: ${extraLocales.join(', ')}`)

async function filesUnder(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await filesUnder(path)))
    else files.push(path)
  }
  return files
}
let javascriptBytes = 0
let count = 0
for (const path of await filesUnder(clientDirectory)) {
  if (!path.endsWith('.js')) continue
  const content = await readFile(path, 'utf8')
  for (const name of PRIVATE_ENV_NAMES) {
    if (content.includes(name))
      throw new Error(`Private configuration marker in client output: ${name}`)
  }
  javascriptBytes += Buffer.byteLength(content)
  count++
}
if (!count) throw new Error('No built client JavaScript found; run start:build first')
// Budgets ratchet down as the audit shrinks the bundle: ~7% headroom over
// the current ~935KB / 45 files. A barrel import or a heavyweight
// dependency trips this before it ships.
//
// 2026-09-18 audit (#425): 46 files / ~999KB on main left 0.5KB of runway;
// the ratchet moves to 1,020,000 for the appearance composition port. The
// delta is the donor-ported appearance dialog + its painters and helpers
// (+9.4KB), all inside the lazy `appearance` chunk that only loads when the
// dialog opens — the eager shell is unchanged, and the chunk count is flat.
// Raised from 1_020_000 when the M12 feature surface landed intentionally
// lazy chunks: editor-mirror (CodeMirror, ~312kB), source-control (~17kB),
// resources (~12kB), files (~9kB), permissions (~8kB), agents/history. The
// per-chunk dev-view budget (check-dev-view-bundle) still guards eager bloat.
//
// 2026-09-23 (#302, the M16 persistence boundary): 1,597,600 left 2,400 bytes
// of runway, and the boundary — a validated read/quarantine helper plus the
// conventional-workspace state validator — cost 3,168 bytes across the chunks
// that use it. The raise is the deliberate decision ADR 0010's first gate asks
// for (the M15 lane measured it; this gate caught it), not silent growth.
//
// 2026-09-25 (#686, browsing from the published product index): the index
// adapter — reshaping the marketplace's deduplicated product index into the
// catalog the existing mapper consumes, plus the digest-verified loader for it —
// cost 1_072 bytes and fits the runway above. Recorded because the trade is the
// same shape as #646's: ~1 KB of eager bundle in exchange for the marketplace
// reading a 716 KB index instead of parsing a 26 MB catalog on every refresh,
// verified against the digest integrity.json already states.
// 2026-09-25 (#646, the cookie-import surface): this gate caught the last
// 4,999 bytes — 1,605,000 left no runway once the panel and its model landed.
// The surface gives the #610 capability the only path a person has to it
// (sources → preview → confirm), costs 5.0KB minified, and lands inside the
// lazy Dev View chunk: the eager shell is untouched, the chunk count is flat,
// and check-dev-view-bundle still measures the Dev View chunk on its own.
const CLIENT_JS_BUDGET_BYTES = 1_612_000
// Raised from 50 when the #399 stream/hunk residues landed as further
// intentional lazy chunks: files-pane grew the quick-open dialog (17kB
// chunk, still lazy), stream-transport rides its own module, and the hunk
// affordances stayed inside the existing lazy source-control chunk. The
// byte budget above still guards total size and check-dev-view-bundle
// still guards eager bloat; this counts only files.
const CLIENT_JS_FILE_BUDGET = 72
if (javascriptBytes > CLIENT_JS_BUDGET_BYTES)
  throw new Error(
    `Client JavaScript budget exceeded: ${javascriptBytes} > ${CLIENT_JS_BUDGET_BYTES} bytes`
  )
if (count > CLIENT_JS_FILE_BUDGET)
  throw new Error(`Client chunk-count budget exceeded: ${count} > ${CLIENT_JS_FILE_BUDGET} files`)
// Static workspace documents would allow an unexpected route to evade the
// per-request access check. This preview deliberately has no prerendered HTML.
const html = (await filesUnder(clientDirectory)).filter((path) => path.endsWith('.html'))
if (html.length) throw new Error(`Unexpected static HTML in gated preview: ${html.join(', ')}`)
console.log(
  JSON.stringify({
    clientJavaScriptFiles: count,
    clientJavaScriptBytes: javascriptBytes,
    modules: modules.length,
  })
)
