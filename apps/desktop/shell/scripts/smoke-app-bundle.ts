import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractUpdateArchive } from '../src/updater'

/** Electrobun's stable build is an extractor; the smoke must run its installed payload. */
export async function resolveSmokeAppBundle(appBundle: string): Promise<{
  appBundle: string
  cleanup(): void
}> {
  if (existsSync(join(appBundle, 'Contents/MacOS/bun'))) return { appBundle, cleanup() {} }
  const resources = join(appBundle, 'Contents/Resources')
  const archives = existsSync(resources)
    ? readdirSync(resources).filter((name) => name.endsWith('.tar.zst'))
    : []
  if (archives.length !== 1) throw new Error('app bundle has no unique installed payload archive')
  const directory = mkdtempSync(join(tmpdir(), 'adea-supervision-payload-'))
  const cleanup = () => rmSync(directory, { recursive: true, force: true })
  try {
    const installed = await extractUpdateArchive(join(resources, archives[0]!), directory)
    if (!existsSync(join(installed, 'Contents/MacOS/bun')))
      throw new Error('installed payload has no bundled Bun runtime')
    return { appBundle: installed, cleanup }
  } catch (error) {
    cleanup()
    throw error
  }
}
