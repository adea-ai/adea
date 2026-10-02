import { createSignal, onCleanup, onMount, Show, type JSX } from 'solid-js'

import type { AgentSimEngineSurface } from '@adea-ai/spatial'
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
 *
 * `surface` selects one of the pack's cold designer entries instead of the
 * HQ entry. It rides the exact same entitlement check; a pack without the
 * surface renders `fallback` like any other unavailable deployment.
 */
export function VirtualView(props: {
  fallback: JSX.Element
  surface?: AgentSimEngineSurface
  /** Extra mount options forwarded to the engine entry (`character`, `onClose`). */
  mountOptions?: { character?: string; onClose?: () => void }
}) {
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
        const mount = await loadAgentSimEngine(entitlement.manifest, { surface: props.surface })
        if (cancelled || !container()) return
        mounted = await mount({
          container: container()!,
          engine: entitlement.manifest,
          character: props.mountOptions?.character,
          onClose: props.mountOptions?.onClose,
        })
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
