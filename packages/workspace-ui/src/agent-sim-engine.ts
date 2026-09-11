import {
  agentSimEngineManifestUrl,
  isLocalDevHost,
  isOfficialAgentSimWebOrigin,
  parseAgentSimEngineManifest,
  type AgentSimEngineManifest,
} from '@adea-ai/spatial-protocol'

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
  mount(options: { container: HTMLElement; engine: AgentSimEngineManifest }): Promise<AgentSimMount>
}

export function isDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
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
 * `@adea-ai/spatial-protocol` engine docs for the guard's threat model:
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

/** Inject the engine entry module and resolve once it has registered itself. */
export function loadAgentSimEngine(
  manifest: AgentSimEngineManifest,
  targetWindow: Pick<Window, 'document'> = window
): Promise<AgentSimRuntimeGlobal['mount']> {
  return new Promise((resolve, reject) => {
    const script = targetWindow.document.createElement('script')
    script.type = 'module'
    script.src = manifest.entryUrl
    script.addEventListener('error', () =>
      reject(new Error('Agent Sim engine entry failed to load'))
    )
    script.addEventListener('load', () => {
      const runtime = (window as typeof window & { __adeaAgentSim?: AgentSimRuntimeGlobal })
        .__adeaAgentSim
      if (typeof runtime?.mount !== 'function') {
        reject(new Error('Agent Sim engine entry did not register a mount API'))
        return
      }
      resolve(runtime.mount)
    })
    targetWindow.document.head.appendChild(script)
  })
}
