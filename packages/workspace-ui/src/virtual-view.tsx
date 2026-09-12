'use client'

import { useEffect, useRef, useState } from 'react'

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
export function VirtualView({ fallback }: Readonly<{ fallback: React.ReactNode }>) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [phase, setPhase] = useState<VirtualViewPhase>('checking')

  useEffect(() => {
    let cancelled = false
    let mounted: { unmount(): void } | null = null

    void (async () => {
      const platform: AgentSimPlatform = isDesktopRuntime() ? 'desktop' : 'web'
      const entitlement = await resolveAgentSimEngine(platform, window.location.origin)
      if (cancelled) return
      if (entitlement.state !== 'entitled' || !containerRef.current) {
        setPhase('unavailable')
        return
      }
      setPhase('mounting')
      try {
        const mount = await loadAgentSimEngine(entitlement.manifest)
        if (cancelled || !containerRef.current) return
        mounted = await mount({ container: containerRef.current, engine: entitlement.manifest })
        if (cancelled) {
          mounted.unmount()
          return
        }
        setPhase('mounted')
      } catch {
        if (!cancelled) setPhase('unavailable')
      }
    })()

    return () => {
      cancelled = true
      mounted?.unmount()
    }
  }, [])

  if (phase === 'mounted') {
    return <div ref={containerRef} className="virtual-view-engine" data-agent-sim-active="true" />
  }
  if (phase === 'checking' || phase === 'mounting') {
    return <div ref={containerRef} className="virtual-view-engine" aria-hidden="true" />
  }
  return <>{fallback}</>
}
