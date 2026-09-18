// Per-lane console/network/crash/policy diagnostics: a bounded ring with
// cursor paging. Console text and network URLs are untrusted page content —
// they are stored bounded, never interpreted, and never promoted into
// commands. Ring discipline mirrors the spec's event bounds (64 KiB strings,
// page max 500).
import type { BrowserDiagnostic } from '../../../../../../packages/types/src/dev-runtime'

export type DiagnosticEntry = BrowserDiagnostic

const MAX_ENTRIES = 2000
const MAX_MESSAGE_LENGTH = 4096
const MAX_PAGE = 500

export function createLaneDiagnostics() {
  const entries: DiagnosticEntry[] = []
  let nextOrdinal = 0

  function append(
    level: BrowserDiagnostic['level'],
    category: BrowserDiagnostic['category'],
    message: string
  ): DiagnosticEntry {
    const bounded =
      message.length > MAX_MESSAGE_LENGTH
        ? `${message.slice(0, MAX_MESSAGE_LENGTH - 1)}\u2026`
        : message
    const entry: DiagnosticEntry = {
      id: `diag-${(nextOrdinal += 1)}`,
      level,
      category,
      message: bounded,
      observedAt: new Date().toISOString(),
    }
    entries.push(entry)
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
    return entry
  }

  return {
    console(level: BrowserDiagnostic['level'], message: string) {
      return append(level, 'console', message)
    },
    network(level: BrowserDiagnostic['level'], message: string) {
      return append(level, 'network', message)
    },
    crash(message: string) {
      return append('error', 'crash', message)
    },
    policy(message: string) {
      return append('warning', 'policy', message)
    },
    page(
      cursor?: string,
      limit?: number
    ): {
      items: readonly DiagnosticEntry[]
      nextCursor?: string
    } {
      const pageSize = Math.min(Math.max(limit ?? 100, 1), MAX_PAGE)
      const offset = cursor ? Number.parseInt(cursor, 10) || 0 : 0
      if (offset >= entries.length) return { items: [] }
      const items = entries.slice(offset, offset + pageSize)
      const nextCursor = offset + pageSize < entries.length ? String(offset + pageSize) : undefined
      return { items, nextCursor }
    },
    size(): number {
      return entries.length
    },
  }
}

export type LaneDiagnostics = ReturnType<typeof createLaneDiagnostics>
