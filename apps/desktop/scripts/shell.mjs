// Builds and runs the desktop shell (Electrobun 2.x: Bun main process + CEF).
// The single-UI client is built first (apps/web's TanStack Start SPA output),
// then the shell bundles it.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = dirname(here)
const shellRoot = join(desktopRoot, 'shell')
const mode = process.argv[2] ?? 'build'

if (mode !== 'dev' && mode !== 'build') {
  console.error('usage: bun scripts/shell.mjs <dev|build>')
  process.exit(1)
}

if (!existsSync(join(shellRoot, 'node_modules', 'electrobun'))) {
  console.log('installing shell dependencies…')
  const install = spawnSync('bun', ['install'], { cwd: shellRoot, stdio: 'inherit' })
  if (install.status !== 0) process.exit(install.status ?? 1)
}

// The single-UI client must exist before the shell bundles it.
const client = spawnSync('bun', ['run', 'shell:client:build'], {
  cwd: desktopRoot,
  stdio: 'inherit',
})
if (client.status !== 0) process.exit(client.status ?? 1)

const run = spawnSync('bunx', ['--bun', 'electrobun', mode === 'dev' ? 'dev' : 'build'], {
  cwd: shellRoot,
  stdio: 'inherit',
  env: process.env,
})
if (mode === 'build') stampAppIcons(shellRoot)

// Electrobun's bundle ships no app icon; stamp the HQ icon into every produced
// .app so Finder/Dock show Adea branding instead of the generic template icon.
function stampAppIcons(shellRoot) {
  const buildDir = join(shellRoot, 'build')
  if (!existsSync(buildDir)) return
  const icon = join(desktopRoot, 'shell', 'branding', 'icon.icns')
  if (!existsSync(icon)) return
  for (const envDir of readdirSync(buildDir)) {
    const resources = join(buildDir, envDir, 'Adea.app', 'Contents', 'Resources')
    if (existsSync(resources)) copyFileSync(icon, join(resources, 'AppIcon.icns'))
  }
}
process.exit(run.status ?? 1)
