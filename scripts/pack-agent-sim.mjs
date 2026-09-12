import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Stages the private Agent Sim engine pack into the shell's public assets so
// entitled deployments resolve the engine same-origin at
// `/assets/agent-sim/engine.json` (see packages/spatial-protocol/src/engine.ts
// for the guard contract).
//
// Enabled only when ADEA_AGENT_SIM_DIST points at a prepared engine pack
// directory: `engine.json` (`{ "version": "x.y.z" }`, entry `engine.js`) plus
// the engine bundle and runtime assets. The official release lane produces it
// by checking out the private agent-sim repo at the AGENT_SIM_REF variable;
// plain checkouts, forks, and CI lanes leave the variable unset and stay
// manifests-only, which is what keeps the sim out of unauthorized builds.

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const targetRoot = resolve(repoRoot, 'apps/web/public/assets/agent-sim')
const ENTRY_BASENAME = 'engine.js'

async function assertEnginePack(dist) {
  let manifest
  try {
    manifest = JSON.parse(await readFile(resolve(dist, 'engine.json'), 'utf8'))
  } catch {
    throw new Error(`Agent Sim pack at ${dist} must contain a parseable engine.json`)
  }
  const version =
    typeof manifest?.version === 'string' && manifest.version.length > 0
      ? manifest.version
      : manifest?.engine?.version
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`Agent Sim pack at ${dist} must declare an engine version in engine.json`)
  }
  const entry = resolve(dist, ENTRY_BASENAME)
  const entryStat = await stat(entry).catch(() => null)
  if (!entryStat?.isFile()) {
    throw new Error(`Agent Sim pack at ${dist} must contain ${ENTRY_BASENAME}`)
  }
  return version
}

/**
 * Stage an engine pack into the shell's public assets. Throws when `dist` is
 * misconfigured so official builds fail loudly instead of silently shipping
 * without the sim they promised.
 */
export async function stageAgentSimPack({ dist, log = console.log } = {}) {
  const version = await assertEnginePack(dist)
  await rm(targetRoot, { recursive: true, force: true })
  await mkdir(targetRoot, { recursive: true })
  await cp(dist, targetRoot, { recursive: true })
  await writeFile(
    resolve(targetRoot, 'engine.json'),
    JSON.stringify({ engine: { entryUrl: `/assets/agent-sim/${ENTRY_BASENAME}`, version } })
  )
  log(`Staged Agent Sim engine pack ${version} into ${targetRoot}`)
}

export async function packFromEnv({ log = console.log } = {}) {
  const dist = process.env.ADEA_AGENT_SIM_DIST
  if (!dist) {
    log('ADEA_AGENT_SIM_DIST not set; building manifests-only shell (no Agent Sim pack).')
    return false
  }
  await stageAgentSimPack({ dist: resolve(process.cwd(), dist), log })
  return true
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  packFromEnv().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
