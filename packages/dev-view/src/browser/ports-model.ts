/*
 * Copyright (c) 2026 T3 Tools Inc.
 * Licensed under the MIT License.
 *
 * Ports menu merge logic, substantially transcribed from t3code
 * apps/web/src/components/preview/useDiscoveredLocalServers.ts and its test
 * file (MIT), revision 77bca8b2d76a1f42552e5eee7d277fcb1160347a. React hook
 * seams were replaced with a pure merge the Solid pane consumes; ownership
 * comes from Adea's port records, and only Adea-owned loopback services are
 * previewable (issue #422: no LAN surface, unknown owners are display-only).
 * See NOTICE and docs/research/dev-view-donor-audit.md.
 */

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1'])

export function isLoopbackHost(host: string): boolean {
  const value = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  return LOOPBACK_HOSTS.has(value) || value === '::1'
}

export type DiscoveredLoopbackServer = Readonly<{
  host: string
  port: number
  url: string
  processName: string | null
  owner: 'adea' | 'external' | 'unknown'
  health: 'listening' | 'unconfirmed' | 'stale'
  runtimeSessionId?: string
  preview?: Readonly<{
    browserLaneId: string
    url: string
  }>
}>

export type PreviewableServer = DiscoveredLoopbackServer & {
  readonly source: 'scanner' | 'configured'
  readonly requestedUrl: string
}

/** Configured loopback URLs (project dev-server config), parsed strictly. */
function parseConfiguredUrl(raw: string): URL | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (!isLoopbackHost(url.hostname)) return null
    return url
  } catch {
    return null
  }
}

/** localhost, 127.0.0.1, 0.0.0.0, and ::1 all collapse to one key (t3code). */
export function canonicalKey(host: string, port: number): string {
  return `${isLoopbackHost(host.toLowerCase()) ? 'loopback' : host.toLowerCase()}:${port}`
}

export function mergeServers(input: {
  readonly scanner: readonly DiscoveredLoopbackServer[]
  readonly configuredUrls: readonly string[]
}): readonly PreviewableServer[] {
  const visibleByServer = new Map<string, PreviewableServer>()

  for (const raw of input.configuredUrls) {
    const url = parseConfiguredUrl(raw)
    if (!url) continue
    const port =
      url.port.length > 0 ? Number.parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80
    if (!Number.isFinite(port) || port <= 0) continue
    const key = canonicalKey(url.hostname, port)
    if (visibleByServer.has(key)) continue
    visibleByServer.set(key, {
      host: url.hostname,
      port,
      url: raw,
      processName: null,
      owner: 'unknown',
      health: 'listening',
      source: 'configured',
      requestedUrl: raw,
    })
  }

  for (const server of input.scanner) {
    const key = canonicalKey(server.host, server.port)
    const configured = visibleByServer.get(key)
    if (configured && configured.source === 'configured') {
      visibleByServer.set(key, {
        ...server,
        source: 'configured',
        requestedUrl: configured.requestedUrl,
      })
      continue
    }
    visibleByServer.set(key, {
      ...server,
      source: 'scanner',
      requestedUrl: server.url,
    })
  }

  return [...visibleByServer.values()].toSorted((left, right) => {
    if (left.source !== right.source) return left.source === 'configured' ? -1 : 1
    return left.port - right.port
  })
}

/**
 * A row is actionable only when it is a proven Adea-owned, healthy loopback
 * service; stale and unknown rows stay visible but inert.
 */
export function isPreviewableRow(row: PreviewableServer): boolean {
  return row.owner === 'adea' && row.health === 'listening'
}
