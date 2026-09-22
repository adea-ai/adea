// Shell-event parsing for the terminal pane (issue #396): the OSC 7 cwd URL
// and the standard OSC 133 prompt markers that legitimately arrive in the
// pane's own byte stream.
//
// Authority boundary (Dev Runtime spec, "Shell integration and input" /
// "Terminal UX"): command boundaries are proven only by the Adea-installed
// authenticated wrapper; the host verifies their MAC before any byte reaches
// the renderer. Sequences parsed here arrive UNAUTHENTICATED in the display
// stream, so they never open, close, or annotate command blocks. OSC 7 feeds
// a cwd display hint (clearly a convenience, never authority), and OSC 133
// markers only feed the typed integration detector that tells the user which
// shell-integration features are actually live.
export type Osc133Event =
  | { kind: 'prompt-start' }
  | { kind: 'command-start' }
  | { kind: 'output-start' }
  | { kind: 'output-end'; exitCode?: number }

/** The cwd display hint derived from OSC 7. */
export type Osc7Cwd = Readonly<{ cwd: string; host?: string }>

const MAX_OSC7_PAYLOAD = 1024

/**
 * Parses an OSC 7 payload into a cwd display hint. Accepts the conventional
 * `file://[host]/absolute/path` URL (percent-decoded) and a bare absolute
 * path. Anything else — relative paths, other schemes, empty or oversize
 * payloads — is typed rejection, never a guess.
 */
export function parseOsc7Cwd(payload: string): Osc7Cwd | null {
  if (payload.length === 0 || payload.length > MAX_OSC7_PAYLOAD) return null
  if (payload.startsWith('file:')) {
    let url: URL
    try {
      url = new URL(payload)
    } catch {
      return null
    }
    if (url.protocol !== 'file:') return null
    const pathname = url.pathname
    if (!pathname.startsWith('/')) return null
    let decoded: string
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      return null
    }
    // decodeURIComponent can emit NULs from %00; a cwd containing control
    // characters is hostile display data.
    // oxlint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(decoded)) return null
    const host = url.hostname === '' ? undefined : url.hostname
    return { cwd: decoded, host }
  }
  // Bare absolute path form (some shells emit it without the file URL).
  if (!payload.startsWith('/')) return null
  // oxlint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(payload)) return null
  return { cwd: payload }
}

/**
 * Parses a standard OSC 133 payload (`A` prompt start, `B` command start,
 * `C` output start, `D[;exit]` output end). The pane uses the result ONLY to
 * detect that the user's shell emits its own unauthenticated markers — see
 * the authority boundary above.
 */
export function parseOsc133Marker(payload: string): Osc133Event | null {
  if (payload === 'A') return { kind: 'prompt-start' }
  if (payload === 'B') return { kind: 'command-start' }
  if (payload === 'C') return { kind: 'output-start' }
  if (payload === 'D') return { kind: 'output-end' }
  if (payload.startsWith('D;')) {
    const raw = payload.slice(2)
    if (!/^-?\d{1,4}$/.test(raw)) return null
    const exitCode = Number.parseInt(raw, 10)
    if (!Number.isSafeInteger(exitCode)) return null
    return { kind: 'output-end', exitCode }
  }
  return null
}
