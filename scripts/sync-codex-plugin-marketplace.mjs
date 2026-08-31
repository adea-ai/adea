import { execFileSync } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const upstream = 'https://github.com/openai/plugins.git'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const importer = resolve(root, 'scripts/import-codex-plugin-marketplace.mjs')
const cachedCatalog = resolve(
  root,
  'packages/workspace-ui/src/codex-plugin-marketplace.generated.ts'
)
const temporaryRoot = await mkdtemp(join(tmpdir(), 'agent-hq-codex-plugins-'))
const repository = resolve(temporaryRoot, 'repository')

async function cachedCatalogExists() {
  try {
    await access(cachedCatalog)
    return true
  } catch {
    return false
  }
}

async function syncWithGit() {
  execFileSync('git', ['clone', '--depth=1', '--quiet', upstream, repository], {
    stdio: 'inherit',
  })
  return execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim()
}

async function syncWithGitHubArchive() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'agent-hq-plugin-sync',
  }
  const commitResponse = await fetch('https://api.github.com/repos/openai/plugins/commits/main', {
    headers,
  })
  if (!commitResponse.ok) {
    throw new Error(`GitHub commit lookup failed with ${commitResponse.status}`)
  }
  const { sha } = await commitResponse.json()
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error('GitHub commit lookup returned an invalid revision')
  }

  const archiveResponse = await fetch(
    `https://api.github.com/repos/openai/plugins/tarball/${sha}`,
    { headers }
  )
  if (!archiveResponse.ok) {
    throw new Error(`GitHub archive download failed with ${archiveResponse.status}`)
  }
  const archive = resolve(temporaryRoot, 'plugins.tar.gz')
  await writeFile(archive, new Uint8Array(await archiveResponse.arrayBuffer()))
  await mkdir(repository)
  execFileSync('tar', ['-xzf', archive, '-C', repository, '--strip-components=1'], {
    stdio: 'inherit',
  })
  return sha
}

try {
  let revision
  try {
    revision = await syncWithGit()
  } catch (gitError) {
    console.warn(`Codex plugin git sync failed; trying GitHub archive: ${gitError.message}`)
    await rm(repository, { force: true, recursive: true })
    revision = await syncWithGitHubArchive()
  }

  execFileSync(process.execPath, [importer, repository], {
    env: { ...process.env, CODEX_PLUGIN_REVISION: revision },
    stdio: 'inherit',
  })
} catch (error) {
  if (!(await cachedCatalogExists())) throw error
  console.warn(
    `Codex plugin sync unavailable; using the cached generated catalog: ${error.message}`
  )
} finally {
  await rm(temporaryRoot, { force: true, recursive: true })
}
