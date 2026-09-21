// Builds and runs the desktop shell (Electrobun 2.x: Bun main process + CEF).
// The single-UI client is built first (apps/web's TanStack Start SPA output),
// then the shell bundles it.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
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

// The Dev Runtime terminal sidecar is a bundled component (M10 #185): bundle
// its entry with the same toolchain into the directory the electrobun `copy`
// stage picks up, so the packaged .app carries the real sidecar artifact the
// component manifest resolves (shell/scripts/packaged-install.ts).
const sidecar = spawnSync(
  'bun',
  [
    'build',
    'src/dev-runtime/terminal/sidecar/entry.ts',
    '--outdir',
    'build/sidecar-dist',
    '--target=bun',
    '--minify',
  ],
  { cwd: shellRoot, stdio: 'inherit', env: process.env }
)
if (sidecar.status !== 0) process.exit(sidecar.status ?? 1)

const run = spawnSync('bunx', ['--bun', 'electrobun', mode === 'dev' ? 'dev' : 'build'], {
  cwd: shellRoot,
  stdio: 'inherit',
  env: process.env,
})
process.exit(run.status ?? 1)
