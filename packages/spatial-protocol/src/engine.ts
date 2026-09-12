/**
 * Entitlement gate and loading contract for the Agent Sim engine.
 *
 * The engine (models, textures, audio, runtime code) lives in the private
 * agent-sim repo and never ships in this public one. The shell may only
 * resolve the engine remote when the deployment is entitled to it:
 *
 * - Web: the site is served from an official Adea domain (adea.dev /
 *   adea.io, including subdomains). Forked deployments on other origins
 *   are refused before any engine fetch happens.
 * - Desktop / any build: an official build packs the engine into its own
 *   assets at build time (see scripts/pack-agent-sim.mjs, wired into the
 *   release lanes). The pack writes a manifest at a well-known same-origin
 *   URL; plain checkouts and fork builds simply do not have it.
 *
 * Both signals are checked; the engine is fetched only when both pass, so
 * copying engine assets into a forked website still fails the host gate.
 */

export const OFFICIAL_AGENT_SIM_WEB_HOSTS = ['adea.dev', 'adea.io'] as const

/** Known-public hostname suffixes never treated as official even if they embed an official host. */
const NON_OFFICIAL_SUFFIXES = ['.local', '.localhost', '.internal']
const OFFICIAL_LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]']

export type AgentSimWebPlatform = 'web' | 'desktop'

export type AgentSimEngineManifest = {
  /**
   * Same-origin ES module URL of the engine entry. The entry must register
   * the `window.__adeaAgentSim` mount API documented in the package README
   * before its load event resolves.
   */
  entryUrl: string
  /** Engine pack version (agent-sim repo release). Diagnostics only. */
  version: string
}

/** Well-known same-origin URL the official pack lane writes the manifest to. */
export function agentSimEngineManifestUrl(origin: string): string {
  return new URL('/assets/agent-sim/engine.json', origin).toString()
}

/**
 * Parse and validate an engine manifest fetched from a trusted origin.
 * Rejects payloads that would point the loader off the deployment's own
 * origin — the engine ships with the site, never from third parties.
 */
export function parseAgentSimEngineManifest(
  value: unknown,
  origin: string
): { ok: true; manifest: AgentSimEngineManifest } | { ok: false } {
  if (typeof value !== 'object' || value === null) return { ok: false }
  const entryUrl = (value as { engine?: { entryUrl?: unknown } }).engine?.entryUrl
  const version = (value as { engine?: { version?: unknown } }).engine?.version
  if (typeof entryUrl !== 'string' || entryUrl.length === 0) return { ok: false }
  if (typeof version !== 'string' || version.length === 0) return { ok: false }
  let resolved: URL
  try {
    resolved = new URL(entryUrl, origin)
  } catch {
    return { ok: false }
  }
  if (resolved.origin !== new URL(origin).origin) return { ok: false }
  if (!resolved.pathname.endsWith('.js')) return { ok: false }
  return { ok: true, manifest: { entryUrl: resolved.toString(), version } }
}

/**
 * Whether a web origin is an official Adea deployment allowed to resolve the
 * Agent Sim engine remote. Desktop builds skip this check: they are gated by
 * the packed engine manifest instead.
 */
export function isOfficialAgentSimWebOrigin(origin: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  if (NON_OFFICIAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false
  return OFFICIAL_AGENT_SIM_WEB_HOSTS.some(
    (official) => host === official || host.endsWith(`.${official}`)
  )
}

/**
 * Hosts where a developer runs the shell locally. Local development is
 * entitled only when the engine was explicitly packed into the local build
 * (engine manifest present); the host check alone never entitles it.
 */
export function isLocalDevHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return OFFICIAL_LOCAL_HOSTS.includes(host) || host.endsWith('.localhost')
}
