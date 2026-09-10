import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { forbiddenClientModule, PRIVATE_ENV_NAMES } from './client-policy.mjs'

const clientDirectory = fileURLToPath(new URL('./dist/client/', import.meta.url))
const modules = JSON.parse(
  await readFile(new URL('./.checks/client-modules.json', import.meta.url), 'utf8')
)
if (!Array.isArray(modules) || modules.length === 0)
  throw new Error('Missing client module evidence')
if (!modules.every((id) => typeof id === 'string'))
  throw new Error('Invalid client module evidence')
const forbidden = modules.filter(forbiddenClientModule)
if (forbidden.length) throw new Error(`Server dependencies in client: ${forbidden.join(', ')}`)

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
