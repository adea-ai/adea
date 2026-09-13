// Builds the single UI the desktop shell serves: the web app's TanStack Start
// SPA output (`apps/web/dist-desktop/client`). There is no desktop-only client
// build. The cloud origin is validated here against the canonical
// `cloud-config.mjs` value and injected into the web build, so every origin
// consumer in the desktop lane derives from one literal.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_CLOUD_ORIGIN, normalizeDesktopCloudOrigin } from './cloud-config.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = dirname(dirname(dirname(here)))
const webRoot = join(repositoryRoot, 'apps', 'web')

const cloudOrigin = normalizeDesktopCloudOrigin(
  process.env.VITE_ADEA_CLOUD_ORIGIN ?? process.env.ADEA_CLOUD_ORIGIN ?? DEFAULT_CLOUD_ORIGIN
)

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

// Workspace packages ship `dist` (their exports point at it) and the web build
// stages the public assets, so dependencies are prepared before bundling.
run('bunx', ['turbo', 'run', 'build', '--filter=@adea-ai/web^...'], { cwd: repositoryRoot })
run('bun', ['run', 'desktop:build'], {
  cwd: webRoot,
  env: { ...process.env, ADEA_DESKTOP_CLOUD_ORIGIN: cloudOrigin },
})
console.log(
  `desktop client: ${join(webRoot, 'dist-desktop', 'client')} (cloud origin ${cloudOrigin})`
)
