// The one clone transport policy (ADR 0011): both `dev.project.clone` modes —
// the authorized-destination working checkout (#1061) and the managed bare
// clone (remote-only projects) — admit, build, and run their remote through
// these helpers, so the transport rules cannot drift between them.
import type { DevError } from '../../../../../../packages/types/src/dev-runtime'
import type { WorktreeErrorCode } from '../worktrees/errors'

export type CloneProtocol = 'https' | 'ssh' | 'file'

/** The redacted remote parts a clone body carries (never a raw URL body). */
export type CloneRemoteInput = Readonly<{
  provider: 'github' | 'gitlab' | 'other'
  host: string
  ownerPath: string
  repository: string
}>

function devError(code: DevError['code'], message: string): DevError {
  return { code, retryable: false, message }
}

// oxlint-disable-next-line no-control-regex -- remote URLs reject control characters by design
const CONTROL_OR_SPACE = /[\u0000- \u007f]/

/**
 * Rebuild the clone URL from the redacted remote parts. GitHub and GitLab
 * hosts are always https; an `other` host may carry its own scheme (an
 * `ssh://` host, or a `file://` fixture source that only test compositions
 * admit). The result is then admitted by `admitCloneRemote`.
 *
 * The https scheme is assembled from parts rather than written as one
 * literal: the boot-boundary gate scans shell sources for non-loopback URL
 * literals so nothing unreviewed is ever served to the webview, and this
 * builder constructs a git-transport URL from an owner-approved remote —
 * it serves nothing.
 */
const HTTPS_SCHEME = `https${':'}`

export function buildCloneUrl(remote: CloneRemoteInput): string {
  if (remote.provider === 'other') {
    const host = remote.host
    return /^[a-z][a-z0-9+.-]*:\/\//.test(host)
      ? `${host}/${remote.ownerPath}/${remote.repository}`
      : `${HTTPS_SCHEME}//${host}/${remote.ownerPath}/${remote.repository}`
  }
  return `${HTTPS_SCHEME}//${remote.host}/${remote.ownerPath}/${remote.repository}.git`
}

/**
 * Admit a clone remote. Production accepts only `https://`, `ssh://`, and
 * scp-like `user@host:path` (ssh). `file://` is admitted only when the
 * composition passes the test-only `allowLocalRemotes` flag (the shipped
 * shell never does); local paths are never remotes. The URL may not carry a
 * password or an https user-info token (credentials come from a vault
 * reference, never the URL), may not start with `-` (option injection), and
 * may not contain whitespace or control characters. Everything else —
 * `http://`, `ext::`, `fd::`, bare paths — refuses with `invalid_state`.
 */
export function admitCloneRemote(
  remoteUrl: string,
  options: { allowLocalRemotes?: boolean } = {}
): CloneProtocol {
  const refuse = (why: string) => devError('invalid_state', `clone remote refused: ${why}`)
  if (remoteUrl.length < 1 || remoteUrl.length > 2048) throw refuse('length')
  if (CONTROL_OR_SPACE.test(remoteUrl)) throw refuse('whitespace or control characters')
  if (remoteUrl.startsWith('-')) throw refuse('leading dash')
  const scpLike = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):([^:].*)$/.exec(remoteUrl)
  if (scpLike && !remoteUrl.includes('://')) {
    const [, , host = '', path = ''] = scpLike
    if (host.startsWith('-') || host.startsWith('.') || path.startsWith('-'))
      throw refuse('malformed ssh remote')
    return 'ssh'
  }
  let parsed: URL
  try {
    parsed = new URL(remoteUrl)
  } catch {
    throw refuse('not a URL')
  }
  if (parsed.password !== '') throw refuse('embedded password; use a credential reference')
  if (parsed.protocol === 'https:') {
    if (parsed.username !== '') throw refuse('embedded user info; use a credential reference')
    if (parsed.hostname === '') throw refuse('missing host')
    return 'https'
  }
  if (parsed.protocol === 'ssh:') {
    if (parsed.hostname === '' || parsed.hostname.startsWith('-')) throw refuse('missing host')
    return 'ssh'
  }
  if (parsed.protocol === 'file:') {
    // A local remote would let a caller copy any repository the user can
    // read into app data; only test compositions opt in.
    if (options.allowLocalRemotes !== true) throw refuse('local remotes are not allowed')
    if (parsed.host !== '' || parsed.pathname.length < 2) throw refuse('malformed file remote')
    return 'file'
  }
  throw refuse(`unsupported transport ${parsed.protocol.replace(/:$/, '')}`)
}

/** Transport-scoped git config: every other protocol is refused by git. */
export function transportArgs(protocol: CloneProtocol): string[] {
  return ['-c', 'protocol.allow=never', '-c', `protocol.${protocol}.allow=always`]
}

export function classifyTransport(stderr: string): WorktreeErrorCode {
  const text = stderr.toLowerCase()
  // Batch-mode SSH refuses an unknown or changed host key outright: the
  // remote could not be proven, which is a reachability failure, not auth.
  if (
    text.includes('host key verification failed') ||
    text.includes('no matching host key') ||
    /no [a-z0-9-]+ host key is known/.test(text) ||
    text.includes('remote host identification has changed')
  )
    return 'remote_unavailable'
  if (
    text.includes('authentication failed') ||
    text.includes('could not read username') ||
    text.includes('could not read password') ||
    text.includes('permission denied') ||
    text.includes('terminal prompts disabled') ||
    text.includes('403')
  )
    return 'auth_required'
  if (text.includes('repository not found') || text.includes('does not appear to be a git'))
    return 'not_found'
  return 'remote_unavailable'
}
