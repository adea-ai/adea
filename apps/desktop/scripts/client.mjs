// Builds the single UI the desktop shell serves: the web app's TanStack Start
// SPA output (`apps/web/dist-desktop/client`). There is no desktop-only client
// build. The cloud origin is validated here against the canonical
// `cloud-config.mjs` value and injected into the web build, so every origin
// consumer in the desktop lane derives from one literal.
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DESKTOP_TARGET_FILE, desktopBuildTarget, serializeDesktopTarget } from './cloud-config.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = dirname(dirname(dirname(here)))
const webRoot = join(repositoryRoot, 'apps', 'web')

// Only a release build (ADEA_DESKTOP_RELEASE_BUILD=true, set by the release
// workflow) defaults to the hosted origin. Every other build targets the local
// dev server unless a hosted origin is named and explicitly allowed. The one
// decision is recorded next to the client (DESKTOP_TARGET_FILE), so the shell
// that serves this client, packaged or not, reads it instead of inferring it.
const target = desktopBuildTarget({
  explicit: process.env.VITE_ADEA_CLOUD_ORIGIN ?? process.env.ADEA_CLOUD_ORIGIN,
  release: process.env.ADEA_DESKTOP_RELEASE_BUILD === 'true',
  allowHosted: process.env.ADEA_ALLOW_HOSTED_CLOUD,
})

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

// Workspace packages ship `dist` (their exports point at it) and the web build
// stages the public assets, so dependencies are prepared before bundling.
run('bunx', ['turbo', 'run', 'build', '--filter=@adea-ai/web^...'], { cwd: repositoryRoot })
run('bun', ['run', 'desktop:build'], {
  cwd: webRoot,
  env: { ...process.env, ADEA_DESKTOP_CLOUD_ORIGIN: target.cloudOrigin },
})
const clientRoot = join(webRoot, 'dist-desktop', 'client')
mkdirSync(clientRoot, { recursive: true })
writeFileSync(join(clientRoot, DESKTOP_TARGET_FILE), serializeDesktopTarget(target))
console.log(
  `desktop client: ${clientRoot} (${target.mode} build, cloud origin ${target.cloudOrigin})`
)
