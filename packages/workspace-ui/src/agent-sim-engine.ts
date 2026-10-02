import {
  agentSimEngineManifestUrl,
  isLocalDevHost,
  isOfficialAgentSimWebOrigin,
  parseAgentSimEngineManifest,
  type AgentSimEngineManifest,
  type AgentSimEngineSurface,
} from '@adea-ai/spatial'

/**
 * Entitlement outcome for the Agent Sim engine remote.
 *
 * - entitled: an official deployment (packed desktop build, or the engine
 *   remote served from an official web origin) — load and mount it.
 * - refused: a web origin that is not ours. The guard refuses before any
 *   engine bytes are fetched, so forked sites cannot proxy the sim.
 * - unavailable: no packed engine manifest was found (plain checkouts and
 *   fork builds). Renders the offline fallback.
 */
export type AgentSimEntitlement =
  | { state: 'entitled'; manifest: AgentSimEngineManifest }
  | { state: 'refused' }
  | { state: 'unavailable' }

export type AgentSimPlatform = 'desktop' | 'web'

export type ManifestFetcher = (url: string, init?: RequestInit) => Promise<Response>

export type AgentSimMount = { unmount(): void }

/** Mount API the private engine entry must register on `window.__adeaAgentSim`. */
export type AgentSimRuntimeGlobal = {
  mount(options: {
    container: HTMLElement
    engine: AgentSimEngineManifest
    /** Character id or serialized configuration decorating the mounted surface. */
    character?: string
  }): Promise<AgentSimMount>
}

export function isDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && '__adeaDesktop' in window
}

async function fetchEngineManifest(
  origin: string,
  fetchImpl: ManifestFetcher,
  timeoutMs: number
): Promise<AgentSimEngineManifest | null> {
  try {
    const response = await fetchImpl(agentSimEngineManifestUrl(origin), {
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null
    const parsed = parseAgentSimEngineManifest(await response.json(), origin)
    return parsed.ok ? parsed.manifest : null
  } catch {
    return null
  }
}

/**
 * Decide whether this deployment may load the Agent Sim engine, purely from
 * the packed manifest and the deployment origin. See
 * `@adea-ai/spatial` engine docs for the guard's threat model:
 * forked websites are refused by host, forked builds by missing manifest.
 */
export async function resolveAgentSimEngine(
  platform: AgentSimPlatform,
  origin: string,
  fetchImpl: ManifestFetcher = fetch,
  timeoutMs = 8_000
): Promise<AgentSimEntitlement> {
  const manifest = await fetchEngineManifest(origin, fetchImpl, timeoutMs)
  if (!manifest) return { state: 'unavailable' }
  if (platform === 'desktop') return { state: 'entitled', manifest }
  let hostname: string
  try {
    hostname = new URL(origin).hostname
  } catch {
    return { state: 'refused' }
  }
  if (!isOfficialAgentSimWebOrigin(origin) && !isLocalDevHost(hostname)) {
    return { state: 'refused' }
  }
  return { state: 'entitled', manifest }
}

/**
 * Inject an engine entry module and resolve once it has registered itself.
 *
 * Without a `surface`, the HQ entry loads and must register
 * `window.__adeaAgentSim`. With a surface, the pack's cold entry for that
 * surface loads instead and must register
 * `window.adeaAgentSimSurfaces[surface]`; packs that don't ship the surface
 * reject here, and the caller renders its offline fallback.
 */
export function loadAgentSimEngine(
  manifest: AgentSimEngineManifest,
  options: { surface?: AgentSimEngineSurface; targetWindow?: Pick<Window, 'document'> } = {}
): Promise<AgentSimRuntimeGlobal['mount']> {
  const { surface, targetWindow = window } = options
  const entryUrl = surface ? manifest.surfaces?.[surface] : manifest.entryUrl
  if (!entryUrl) {
    return Promise.reject(
      new Error(`Agent Sim pack does not ship the ${surface ?? 'engine'} surface`)
    )
  }
  return new Promise((resolve, reject) => {
    const script = targetWindow.document.createElement('script')
    script.type = 'module'
    script.src = entryUrl
    script.addEventListener('error', () =>
      reject(new Error('Agent Sim engine entry failed to load'))
    )
    script.addEventListener('load', () => {
      // The registry lives on the same window the script was injected into.
      const globalWindow = targetWindow as typeof window & {
        __adeaAgentSim?: AgentSimRuntimeGlobal
        adeaAgentSimSurfaces?: Partial<Record<AgentSimEngineSurface, AgentSimRuntimeGlobal>>
      }
      const runtime = surface
        ? globalWindow.adeaAgentSimSurfaces?.[surface]
        : globalWindow.__adeaAgentSim
      if (typeof runtime?.mount !== 'function') {
        reject(new Error('Agent Sim engine entry did not register a mount API'))
        return
      }
      resolve(runtime.mount)
    })
    targetWindow.document.head.appendChild(script)
  })
}
