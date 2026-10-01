import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputDirectory = process.argv.includes('--desktop') ? 'dist-desktop' : 'dist'
const generatedManifestPath = resolve(webRoot, 'node_modules/.cache/adea-ui-tailwind-sources.json')
const renderedReportPath = resolve(webRoot, outputDirectory, '.checks/client-rendered-modules.json')
const packageLink = resolve(webRoot, 'node_modules/@adea-ai/ui')

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot read ${label} at ${path}: ${error.message}`, { cause: error })
  }
}

const [generatedSources, renderedModules, uiPackageRoot] = await Promise.all([
  readJson(generatedManifestPath, 'generated shared UI source manifest'),
  readJson(renderedReportPath, 'rendered client module report'),
  realpath(packageLink),
])

if (!Array.isArray(generatedSources) || !generatedSources.every((path) => typeof path === 'string'))
  throw new Error('Generated shared UI source manifest must be an array of package-relative paths')
if (!Array.isArray(renderedModules) || !renderedModules.every((path) => typeof path === 'string'))
  throw new Error('Rendered client module report must be an array of portable module ids')

const sortedSources = [...generatedSources].toSorted()
if (new Set(generatedSources).size !== generatedSources.length)
  throw new Error('Generated shared UI source manifest contains duplicate paths')
if (generatedSources.some((path, index) => path !== sortedSources[index]))
  throw new Error('Generated shared UI source manifest is not sorted deterministically')

for (const source of generatedSources) {
  if (!source.startsWith('src/') || isAbsolute(source) || source.split(/[\\/]/).includes('..'))
    throw new Error(`Generated UI source path is not portable or package-relative: ${source}`)
  const absolutePath = resolve(uiPackageRoot, source)
  const packageRelativePath = relative(uiPackageRoot, absolutePath)
  if (packageRelativePath === '..' || packageRelativePath.startsWith(`..${sep}`))
    throw new Error(`Generated UI source path escapes the installed package: ${source}`)
  try {
    if (!(await stat(absolutePath)).isFile()) throw new Error('not a file')
  } catch {
    throw new Error(`Generated UI source file is missing from the installed package: ${source}`)
  }
}

const renderedUiSources = renderedModules
  .filter((id) => id.startsWith('<dependencies>/@adea-ai/ui/src/'))
  .map((id) => id.slice('<dependencies>/@adea-ai/ui/'.length))
  .toSorted()
if (renderedUiSources.length === 0)
  throw new Error(
    `Rendered client report contains no published shared UI source modules (${outputDirectory})`
  )

const availableSources = new Set(generatedSources)
const missing = renderedUiSources.filter((source) => !availableSources.has(source))
if (missing.length) {
  throw new Error(
    `Tailwind source discovery missed rendered shared UI modules in ${outputDirectory}:\n${missing.map((path) => `- ${path}`).join('\n')}`
  )
}

console.log(
  `Verified ${renderedUiSources.length} rendered shared UI modules against ${generatedSources.length} Tailwind sources (${outputDirectory}).`
)
