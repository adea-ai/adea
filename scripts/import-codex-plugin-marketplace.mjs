import { execFileSync } from 'node:child_process'
import { access, readFile, writeFile } from 'node:fs/promises'
import { dirname, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(process.argv[2] ?? '')
if (!process.argv[2])
  throw new Error('Usage: bun scripts/import-codex-plugin-marketplace.mjs /path/to/openai/plugins')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, 'packages/workspace-ui/src/codex-plugin-marketplace.generated.ts')
const marketplacePath = resolve(repository, '.agents/plugins/marketplace.json')
const marketplace = JSON.parse(await readFile(marketplacePath, 'utf8'))
const revision =
  process.env.CODEX_PLUGIN_REVISION ??
  execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim()

const allowedCategories = new Set([
  'Business & Operations',
  'Communication',
  'Creativity',
  'Data & Analytics',
  'Developer Tools',
  'Education & Research',
  'Finance',
  'Productivity',
  'Scientific Research',
  'Security',
])

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

function sourcePath(entry) {
  return entry.source?.source === 'local' && typeof entry.source.path === 'string'
    ? entry.source.path.replace(/^\.\//, '')
    : null
}

async function surfacesFor(pluginDirectory, manifest) {
  if (!pluginDirectory) return ['skill']
  const surfaces = []
  const candidates = [
    ['app', manifest?.apps, '.app.json'],
    ['mcp', manifest?.mcpServers, '.mcp.json'],
    ['skill', manifest?.skills, 'skills'],
    ['agent', manifest?.agents, 'agents'],
    ['command', manifest?.commands, 'commands'],
    ['hook', manifest?.hooks, 'hooks.json'],
  ]
  for (const [surface, declared, fallback] of candidates) {
    if (declared || (await exists(resolve(pluginDirectory, fallback)))) surfaces.push(surface)
  }
  return surfaces.length > 0 ? surfaces : ['skill']
}

const plugins = []
const logoUrls = {}
for (const entry of marketplace.plugins) {
  if (!allowedCategories.has(entry.category)) {
    throw new Error(`Unsupported Codex marketplace category: ${entry.category}`)
  }
  const relativePluginPath = sourcePath(entry)
  const pluginDirectory = relativePluginPath ? resolve(repository, relativePluginPath) : null
  const manifest = pluginDirectory
    ? await readJson(resolve(pluginDirectory, '.codex-plugin/plugin.json'))
    : null
  const surfaces = await surfacesFor(pluginDirectory, manifest)
  const mcp = pluginDirectory ? await readJson(resolve(pluginDirectory, '.mcp.json')) : null
  const serializedMcp = JSON.stringify(mcp ?? {})
  const interfaceMetadata = manifest?.interface ?? {}
  const displayName = interfaceMetadata.displayName || manifest?.name || entry.name
  const description =
    interfaceMetadata.shortDescription ||
    manifest?.description ||
    `${displayName} from the Codex official marketplace.`
  const sourceUrl = relativePluginPath
    ? `https://github.com/openai/plugins/tree/${revision}/${relativePluginPath}`
    : entry.source?.url
  const iconPath = interfaceMetadata.logo || interfaceMetadata.composerIcon
  if (relativePluginPath && typeof iconPath === 'string') {
    const normalizedIconPath = posix.normalize(
      posix.join(relativePluginPath, iconPath.replace(/^\.\//, ''))
    )
    logoUrls[entry.name] =
      `https://raw.githubusercontent.com/openai/plugins/${revision}/${normalizedIconPath}`
  }
  const capabilities = [
    ...(Array.isArray(interfaceMetadata.capabilities) ? interfaceMetadata.capabilities : []),
    ...surfaces.map(
      (surface) =>
        ({
          agent: 'Agent roles',
          app: 'App connector',
          command: 'Commands',
          hook: 'Hooks',
          mcp: 'MCP connector',
          skill: 'Skills',
        })[surface]
    ),
  ].filter((value, index, values) => value && values.indexOf(value) === index)

  plugins.push({
    auth:
      surfaces.includes('app') || surfaces.includes('mcp')
        ? /bearer_token_env_var|api[_-]?key/i.test(serializedMcp)
          ? 'api-key'
          : 'oauth'
        : 'workspace',
    authenticationPolicy: entry.policy?.authentication === 'ON_USE' ? 'on-use' : 'on-install',
    capabilities,
    category: entry.category,
    description,
    iconKey: `codex:${entry.name}`,
    id: entry.name,
    installationPolicy:
      entry.policy?.installation === 'INSTALLED_BY_DEFAULT'
        ? 'installed-by-default'
        : entry.policy?.installation === 'NOT_AVAILABLE'
          ? 'not-available'
          : 'available',
    kind: surfaces.includes('app') || surfaces.includes('mcp') ? 'connector' : 'skill',
    license: manifest?.license,
    name: displayName,
    ownership: 'public',
    publisher: interfaceMetadata.developerName || manifest?.author?.name || 'OpenAI',
    source: 'codex-official',
    sourceRevision: revision,
    sourceUrl,
    surfaces,
  })
}

const generated = `// Generated from openai/plugins at ${revision}.
// Refresh automatically with: bun run plugins:sync
import type { WorkspacePluginDefinition } from './platform'

export const codexPluginMarketplaceRevision = ${JSON.stringify(revision)}
export const codexPluginCatalog = Object.freeze(${JSON.stringify(plugins, null, 2)}) satisfies readonly WorkspacePluginDefinition[]
export const codexPluginLogoUrls: Readonly<Record<string, string>> = Object.freeze(${JSON.stringify(logoUrls, null, 2)})
`

await writeFile(output, generated)
execFileSync('bunx', ['prettier', '--write', output], { stdio: 'ignore' })
console.log(`Imported ${plugins.length} Codex marketplace plugins at ${revision} into ${output}`)
