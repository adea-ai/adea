// Optional Agent Sim engine mount for the shell's loopback server. Official
// builds stage the private engine pack into the client itself
// (`scripts/pack-agent-sim.mjs`); plain checkouts ship no engine and the
// client's entitlement gate renders the offline fallback. Pointing
// `ADEA_AGENT_SIM_DIST` at a prepared engine pack lets a local or unpackaged
// shell serve the same `/assets/agent-sim/*` surface from disk, so the same
// gate (`packages/spatial-protocol/src/engine.ts`) resolves the engine.
import { existsSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'

const MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.bin': 'application/octet-stream',
  '.basis': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ktx2': 'image/ktx2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
}

const ENTRY_BASENAME = 'engine.js'
const MANIFEST_BASENAME = 'engine.json'
/** The URL prefix this module serves `packRoot` under. */
export const AGENT_SIM_MOUNT = '/assets/agent-sim/'

/** Serve one `/assets/agent-sim/*` path from the engine pack directory. */
export async function agentSimResponse(urlPath: string, packRoot: string): Promise<Response> {
  if (urlPath === `${AGENT_SIM_MOUNT}${MANIFEST_BASENAME}`) {
    // The pack lane writes the wrapped `{ engine: { entryUrl, version } }`
    // shape; the agent-sim repo's raw export carries `{ version }` only. Both
    // resolve to the same same-origin manifest the entitlement gate parses.
    let version: unknown
    try {
      const raw = JSON.parse(await Bun.file(join(packRoot, MANIFEST_BASENAME)).text())
      version =
        typeof (raw as { version?: unknown })?.version === 'string'
          ? (raw as { version: string }).version
          : (raw as { engine?: { version?: unknown } })?.engine?.version
    } catch {
      version = undefined
    }
    if (typeof version !== 'string' || version.length === 0) {
      return new Response(null, { status: 404 })
    }
    return Response.json({
      engine: { entryUrl: `${AGENT_SIM_MOUNT}${ENTRY_BASENAME}`, version },
    })
  }
  const rel = normalize(decodeURIComponent(urlPath.slice(AGENT_SIM_MOUNT.length))).replace(
    /^(\.\.[/\\])+/,
    ''
  )
  const filePath = join(packRoot, rel)
  if (!filePath.startsWith(packRoot)) return new Response(null, { status: 403 })
  if (!existsSync(filePath)) return new Response(null, { status: 404 })
  return new Response(await Bun.file(filePath).arrayBuffer(), {
    headers: { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' },
  })
}
