import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const webRoot = resolve(repositoryRoot, 'apps/web')

function run(args, cwd, env = process.env) {
  const result = spawnSync('bun', args, { cwd, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

// Cloudflare Workers deployment build for the TanStack Start host.
//
// Frozen install + workspace dependency builds mirror the previous OpenNext
// lane (turbo's dependsOn covers every other lane, but the deploy workflow
// invokes this script directly). `vite build` then produces the Worker entry
// and client assets under apps/web/dist. The repository ships manifests only;
// the spatial engine lives in the private agent-sim repo and is delivered
// through the entitlement-gated engine remote, so this lane needs no asset
// credentials.
run(['install', '--frozen-lockfile'], repositoryRoot)

const webManifest = JSON.parse(readFileSync(resolve(webRoot, 'package.json'), 'utf8'))
const workspaceDepFilters = Object.keys({
  ...webManifest.dependencies,
  ...webManifest.devDependencies,
})
  .filter((name) => name.startsWith('@adea-ai/'))
  .map((name) => `--filter=${name}`)
run(['x', 'turbo', 'run', 'build', ...workspaceDepFilters], repositoryRoot)

// Stamp the deployment commit SHA into the bundle so scene telemetry keeps
// release attribution without a hosting provider (the old platform's
// commit-SHA variable is gone). The client bundle reads it through the
// build-time public-env allowlist (NEXT_PUBLIC_DEPLOY_GIT_COMMIT_SHA; see
// vite.config.ts and start/client-policy.mjs), and DEPLOY_GIT_COMMIT_SHA
// remains available to the worker at runtime. An explicit value always
// wins; when git is unavailable the variables stay unset and telemetry
// simply omits release metadata.
if (!process.env.DEPLOY_GIT_COMMIT_SHA) {
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
  const sha = revision.error || revision.status !== 0 ? '' : revision.stdout.trim()
  if (sha) process.env.DEPLOY_GIT_COMMIT_SHA = sha
}
if (process.env.DEPLOY_GIT_COMMIT_SHA && !process.env.NEXT_PUBLIC_DEPLOY_GIT_COMMIT_SHA) {
  process.env.NEXT_PUBLIC_DEPLOY_GIT_COMMIT_SHA = process.env.DEPLOY_GIT_COMMIT_SHA
}

run(['run', '--cwd', webRoot, 'build'])

// The deployment wrangler.jsonc points at the built worker entry and client
// assets, expressed relative to apps/web. Values must stay byte-stable for a
// given build so repeatable CI lanes do not produce noise diffs.
const generatedWrangler = resolve(webRoot, 'dist/server/wrangler.json')
if (!existsSync(generatedWrangler)) {
  throw new Error(`Missing generated Worker manifest: ${generatedWrangler}`)
}
const generated = JSON.parse(readFileSync(generatedWrangler, 'utf8'))
const configPath = resolve(webRoot, 'wrangler.jsonc')
let configText = readFileSync(configPath, 'utf8')
configText = configText.replace(/"main":\s*"[^"]+"/, `"main": "${relativeToWeb(generated.main)}"`)
configText = configText.replace(
  /"directory":\s*"[^"]+"/,
  `"directory": "${relativeToWeb(generated.assets.directory)}"`
)
writeFileSync(configPath, configText)

/**
 * The generated manifest records paths relative to its own directory
 * (dist/server); deployment paths must be relative to apps/web.
 * @param {string} target path as recorded in the generated manifest
 */
function relativeToWeb(target) {
  const fromManifest = resolve(dirname(generatedWrangler), target)
  return relative(webRoot, fromManifest).replaceAll('\\', '/')
}
