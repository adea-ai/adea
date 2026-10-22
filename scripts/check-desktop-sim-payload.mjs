import { readdir, lstat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync, realpathSync } from 'node:fs'

export function simPayloadOffenders(paths) {
  return paths.filter((path) => {
    const normalized = path.replaceAll('\\', '/').toLowerCase()
    return (
      /(^|\/)assets\/agent-sim(\/|$)/.test(normalized) ||
      /(^|\/)(engine|character-designer|room-designer)\.(js|css)$/.test(normalized) ||
      // The repository asset boundary already forbids these engine formats anywhere, so the
      // desktop client may not carry one either, wherever it was moved to. The path is lowercased
      // above, so the match is case-insensitive: CHAIR.OBJ is the same offender as chair.obj.
      /\.(glb|gltf|fbx|obj|blend|ktx2|basis)$/.test(normalized) ||
      /(^|\/)basis_transcoder\.(js|wasm)$/.test(normalized)
    )
  })
}

export async function inspectClient(root) {
  const paths = []
  let bytes = 0
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const stat = await lstat(path)
      if (stat.isSymbolicLink()) throw new Error('Desktop client must not contain symlinks')
      if (stat.isDirectory()) await visit(path)
      else if (stat.isFile()) {
        paths.push(relative(root, path))
        bytes += stat.size
      }
    }
  }
  await visit(root)
  if (!paths.includes('index.html')) throw new Error('Desktop client is missing index.html')
  const offenders = simPayloadOffenders(paths)
  if (offenders.length) throw new Error(`Desktop contains Sim payload: ${offenders.join(', ')}`)
  return { files: paths.length, bytes, simPayloadFiles: 0 }
}

export function inspectArchive(archive) {
  const result = spawnSync('tar', ['--zstd', '-tf', archive], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.error || result.status !== 0)
    throw new Error('Could not list installed desktop archive')
  const paths = result.stdout.split('\n').filter(Boolean)
  if (!paths.includes('Adea.app/Contents/Resources/app/client/index.html')) {
    throw new Error('Installed desktop archive is missing client/index.html')
  }
  const offenders = simPayloadOffenders(paths)
  if (offenders.length) throw new Error(`Desktop contains Sim payload: ${offenders.join(', ')}`)
  return { files: paths.length, simPayloadFiles: 0 }
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const [mode, target] = process.argv.slice(2)
  try {
    if (!target || !['--client', '--archive'].includes(mode)) {
      throw new Error('usage: check-desktop-sim-payload.mjs <--client|--archive> PATH')
    }
    console.log(
      JSON.stringify(mode === '--client' ? await inspectClient(target) : inspectArchive(target))
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
