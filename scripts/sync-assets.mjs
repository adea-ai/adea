import { cp, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Stages the public scene manifests (tracked in
// packages/spatial-protocol/data, mirrored from the private agent-sim
// engine) into the ignored Next public-assets directory.
//
// The engine (models, textures, audio, runtime catalogs) lives in the
// private agent-sim repo and is never synced here: this step emits manifests
// only, so plain checkouts, CI lanes, and public builds stay green without
// credentials. The entitlement-gated engine remote resolves these same-origin
// manifest URLs at runtime (see @adea-ai/spatial-protocol manifests).

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const publicAssets = resolve(repoRoot, 'apps/web/public/assets')
const webRoot = resolve(repoRoot, 'apps/web')
// Build into a staging directory and swap it over the live tree with one
// rename(2). Staging MUST live outside apps/web/public: the desktop vite
// build sets publicDir to ../web/public and walks it recursively while the
// web build syncs, so a staging sibling inside public/ gets enumerated and
// then renamed away mid-copy (ENOENT). A same-directory rename is atomic,
// so concurrent readers only ever resolve public/assets to a complete old
// or complete new tree and never observe the staging names at all.
const stagingAssets = resolve(webRoot, `.assets.staging-${process.pid}`)
const backupAssets = resolve(webRoot, `.assets.backup-${process.pid}`)

// Reap staging/backup droppings orphaned by previously interrupted runs.
for (const entry of await readdir(webRoot).catch(() => [])) {
  if (/^\.assets\.(staging|backup)-\d+$/.test(entry)) {
    await rm(resolve(webRoot, entry), { recursive: true, force: true })
  }
}

const protocolData = resolve(repoRoot, 'packages/spatial-protocol/data')

await rm(stagingAssets, { recursive: true, force: true })
await mkdir(stagingAssets, { recursive: true })

for (const [scene, assetDirectory] of [
  ['hq-home', 'home'],
  ['hq-work', 'work'],
]) {
  await cp(resolve(protocolData, assetDirectory), resolve(stagingAssets, 'worlds', scene), {
    recursive: true,
    force: true,
  })
}

// Swap the complete staging tree over the live one. Readers concurrent with
// the sync only ever observe a complete tree (old or new).
await rm(backupAssets, { recursive: true, force: true })
try {
  await rename(publicAssets, backupAssets)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
await rename(stagingAssets, publicAssets)
await rm(backupAssets, { recursive: true, force: true })

console.log(`Synced HQ scene manifests to ${publicAssets}`)
