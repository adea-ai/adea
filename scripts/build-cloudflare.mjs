import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
