'use client'

import { createSignal, onCleanup, onMount, Show, type JSX } from 'solid-js'

import {
  isDesktopRuntime,
  loadAgentSimEngine,
  resolveAgentSimEngine,
  type AgentSimPlatform,
} from './agent-sim-engine'

type VirtualViewPhase = 'checking' | 'unavailable' | 'mounting' | 'mounted'

/**
 * The virtual view surface. Renders `fallback` unless this deployment is
 * entitled to the Agent Sim engine and the engine mounts successfully.
 * Entitlement is the public repo's guard: only official web domains and
 * builds that pack the private engine get the sim; everything else renders
 * the offline fallback without fetching engine bytes.
 */
export function VirtualView(props: { fallback: JSX.Element }) {
  const [container, setContainer] = createSignal<HTMLDivElement>()
  const [phase, setPhase] = createSignal<VirtualViewPhase>('checking')

  onMount(() => {
    let cancelled = false
    let mounted: { unmount(): void } | null = null

    void (async () => {
      const platform: AgentSimPlatform = isDesktopRuntime() ? 'desktop' : 'web'
      const entitlement = await resolveAgentSimEngine(platform, window.location.origin)
      if (cancelled) return
      if (entitlement.state !== 'entitled' || !container()) {
        setPhase('unavailable')
        return
      }
      setPhase('mounting')
      try {
        const mount = await loadAgentSimEngine(entitlement.manifest)
        if (cancelled || !container()) return
        mounted = await mount({ container: container()!, engine: entitlement.manifest })
        if (cancelled) {
          mounted.unmount()
          return
        }
        setPhase('mounted')
      } catch {
        if (!cancelled) setPhase('unavailable')
      }
    })()

    onCleanup(() => {
      cancelled = true
      mounted?.unmount()
    })
  })

  return (
    <Show when={phase() !== 'unavailable'} fallback={props.fallback}>
      <div
        ref={setContainer}
        class="virtual-view-engine"
        data-agent-sim-active={phase() === 'mounted' ? 'true' : undefined}
        aria-hidden={phase() === 'mounted' ? undefined : 'true'}
      />
    </Show>
  )
}
