import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'
import { gzipSync } from 'node:zlib'
import { forbiddenClientModule, PRIVATE_ENV_NAMES } from './client-policy.mjs'
import {
  assertClientBundleBudgets,
  inspectClientBundle,
} from '../../../scripts/client-bundle-budgets.mjs'

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
// Production web output cannot use the native-only workspace bootstrap. Local
// development supports both lanes; the separate desktop build retains it.
const renderedModules = JSON.parse(
  await readFile(new URL('../dist/.checks/client-rendered-modules.json', import.meta.url), 'utf8')
)
if (
  !Array.isArray(renderedModules) ||
  renderedModules.length === 0 ||
  !renderedModules.every((id) => typeof id === 'string' && modules.includes(id))
)
  throw new Error('Missing or invalid rendered client module evidence')
const fixtureModules = renderedModules.filter((id) =>
  id.endsWith('/packages/dev-view/src/terminal/fixture-terminal-pane.tsx')
)
if (fixtureModules.length)
  throw new Error(`Test terminal fixture in production output: ${fixtureModules.join(', ')}`)
const desktopOnlyWorkspaceModules = renderedModules.filter(
  (id) =>
    id.endsWith('/apps/web/src/components/desktop-workspace-entry.tsx') ||
    id.endsWith('/apps/web/src/components/desktop-first-run-chat.tsx')
)
if (desktopOnlyWorkspaceModules.length)
  throw new Error(`Desktop-only workspace in web output: ${desktopOnlyWorkspaceModules.join(', ')}`)

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
const chunks = []
for (const path of await filesUnder(clientDirectory)) {
  if (!path.endsWith('.js')) continue
  const content = await readFile(path, 'utf8')
  for (const name of PRIVATE_ENV_NAMES) {
    if (content.includes(name))
      throw new Error(`Private configuration marker in client output: ${name}`)
  }
  chunks.push({
    file: relative(clientDirectory, path).replaceAll('\\', '/'),
    source: content,
    bytes: Buffer.byteLength(content),
    gzipBytes: gzipSync(content).byteLength,
  })
}
if (chunks.length === 0) throw new Error('No built client JavaScript found; run start:build first')
const bundle = inspectClientBundle(chunks)
assertClientBundleBudgets(bundle)
// Static workspace documents would allow an unexpected route to evade the
// per-request access check. This preview deliberately has no prerendered HTML.
const html = (await filesUnder(clientDirectory)).filter((path) => path.endsWith('.html'))
if (html.length) throw new Error(`Unexpected static HTML in gated preview: ${html.join(', ')}`)
console.log(
  JSON.stringify({
    clientJavaScriptFiles: bundle.total.fileCount,
    clientJavaScriptBytes: bundle.total.rawBytes,
    clientJavaScriptGzipBytes: bundle.total.gzipBytes,
    startup: bundle.startup,
    views: bundle.views,
    modules: modules.length,
  })
)
