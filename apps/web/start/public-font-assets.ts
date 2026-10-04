import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** Public assets owned by the published UI package, including linked Bun installs. */
export function publicFontAssetDirectories(): string[] {
  const appRequire = createRequire(import.meta.url)
  const uiRequire = createRequire(appRequire.resolve('@adea-ai/ui/package.json'))
  return ['space-grotesk', 'jetbrains-mono', 'geist', 'geist-mono'].map((family) =>
    realpathSync(
      join(dirname(uiRequire.resolve(`@fontsource-variable/${family}/package.json`)), 'files')
    )
  )
}
