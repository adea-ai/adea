// Credential delivery for workspace connections (ADR 0012).
//
// A resolved workspace connection reaches a child process ONLY through that
// child's own environment, built here at spawn time from a `VaultSecret` the
// resolver just unsealed. Nothing here persists, logs, or returns the secret
// to a command reply; the env object lives exactly as long as the spawn call.
//
// - git: an inline, secret-free credential helper is configured through
//   `GIT_CONFIG_COUNT` (never argv). Its first entry empties the helper list —
//   so the device keychain or a `gh` git-credential helper can never answer
//   instead of the workspace binding — and its second answers `get` for the
//   bound host only, from child-only variables.
// - gh / glab: their documented token variables (`GH_TOKEN` /
//   `GH_ENTERPRISE_TOKEN`, `GITLAB_TOKEN`) for the one child that needs them.
// - A device default (no binding) adds nothing: the child keeps the existing
//   device behaviour (keychain, `gh auth`, `glab auth`, SSH agent).
import type { VaultSecret } from '../vault'
import { runGit } from '../worktrees/git-run'

export type GitHostingResolution =
  | Readonly<{
      connection: 'workspace'
      host: string
      credentialRefId: string
      credentialKind: 'git_https' | 'github_token' | 'ssh_key' | 'other'
      secret: VaultSecret
    }>
  | Readonly<{ connection: 'device_default'; host: string }>

/** The child-only variables the inline git credential helper reads. */
export const GIT_CONNECTION_ENV_KEYS = [
  'ADEA_GIT_CONNECTION_HOST',
  'ADEA_GIT_CONNECTION_USERNAME',
  'ADEA_GIT_CONNECTION_TOKEN',
] as const

// Answers `get` only for the bound host (git writes `host=<host>` on the
// helper's stdin); every other host and action gets no answer at all.
const GIT_CREDENTIAL_HELPER =
  '!f() { test "$1" = get || exit 0; h=; while IFS= read -r l; do case "$l" in host=*) h="${l#host=}";; esac; done; test "$h" = "$ADEA_GIT_CONNECTION_HOST" || exit 0; echo "username=$ADEA_GIT_CONNECTION_USERNAME"; echo "password=$ADEA_GIT_CONNECTION_TOKEN"; }; f'

/** GitHub accepts any username with a token; GitLab expects `oauth2`. */
function tokenUsername(host: string, kind: string): string {
  return host === 'github.com' || kind === 'github_token' ? 'x-access-token' : 'oauth2'
}

/** Env additions for one credentialed git child (https transport only). The
 *  first config entry empties the accumulated helper list (an empty
 *  `credential.helper` clears every helper read so far, URL-scoped ones
 *  included), so the device keychain or a `gh auth setup-git` helper can never
 *  answer instead of the workspace binding. */
export function gitTransportEnv(
  resolution: GitHostingResolution
): Record<string, string> | undefined {
  if (resolution.connection !== 'workspace') return undefined
  return {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: GIT_CREDENTIAL_HELPER,
    ADEA_GIT_CONNECTION_HOST: resolution.host,
    ADEA_GIT_CONNECTION_USERNAME: tokenUsername(resolution.host, resolution.credentialKind),
    ADEA_GIT_CONNECTION_TOKEN: resolution.secret.reveal(),
  }
}

/** Env additions for one `gh` child bound to a workspace connection. */
export function ghTokenEnv(resolution: GitHostingResolution): Record<string, string> | undefined {
  if (resolution.connection !== 'workspace') return undefined
  return resolution.host === 'github.com'
    ? { GH_TOKEN: resolution.secret.reveal() }
    : { GH_ENTERPRISE_TOKEN: resolution.secret.reveal(), GH_HOST: resolution.host }
}

/** Env additions for one `glab` child bound to a workspace connection. */
export function glabTokenEnv(resolution: GitHostingResolution): Record<string, string> | undefined {
  if (resolution.connection !== 'workspace') return undefined
  return { GITLAB_TOKEN: resolution.secret.reveal(), GITLAB_HOST: resolution.host }
}

/** The `--hostname <host>` a gh/glab argv names, if any. */
export function hostnameArg(args: readonly string[]): string | undefined {
  const index = args.indexOf('--hostname')
  const host = index >= 0 ? args[index + 1] : undefined
  return typeof host === 'string' && host.length > 0 ? host.toLowerCase() : undefined
}

export type RemoteTransport = Readonly<{ host: string; transport: 'https' | 'ssh' }>

/** Parse a configured remote URL into its host and transport. Local paths,
 *  file URLs, and anything unparseable return undefined (no network host, so
 *  no connection applies). */
export function parseRemoteTransport(url: string): RemoteTransport | undefined {
  const trimmed = url.trim()
  if (trimmed.length === 0 || trimmed.length > 2048 || /\s/.test(trimmed)) return undefined
  const scheme = trimmed.match(/^([a-z][a-z0-9+.-]*):\/\//i)
  if (scheme) {
    const protocol = scheme[1]!.toLowerCase()
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      return undefined
    }
    const host = (parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname).toLowerCase()
    if (host.length === 0) return undefined
    if (protocol === 'https' || protocol === 'http') return { host, transport: 'https' }
    if (protocol === 'ssh' || protocol === 'git+ssh') {
      return { host: parsed.hostname.toLowerCase(), transport: 'ssh' }
    }
    return undefined
  }
  // scp-like `user@host:path` (no scheme, a colon before any slash).
  const scp = trimmed.match(/^(?:[^@/]+@)?([^:/]+):(?!\/\/)/)
  if (scp) return { host: scp[1]!.toLowerCase(), transport: 'ssh' }
  return undefined
}

/** The host/transport of a remote given by name (read from config, never
 *  `remote get-url`, so insteadOf rewrites cannot mask the true host) or by
 *  URL. */
export async function remoteTransportOf(
  canonicalRoot: string,
  remote: string
): Promise<RemoteTransport | undefined> {
  if (remote.includes('://') || /^[^/]+:/.test(remote)) return parseRemoteTransport(remote)
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(remote)) return undefined
  const configured = await runGit(['config', '--get', `remote.${remote}.url`], {
    cwd: canonicalRoot,
  }).catch(() => undefined)
  if (!configured || configured.exitCode !== 0) return undefined
  return parseRemoteTransport(configured.stdout)
}

/** Resolves the env one credentialed git child needs for `remote` in the
 *  active workspace, or undefined for the device default / a local remote. */
export type GitRemoteEnvResolver = (input: {
  canonicalRoot: string
  remote: string
  operation: string
}) => Promise<Record<string, string> | undefined>

export function createGitRemoteEnvResolver(
  resolve: (input: {
    host: string
    operation: string
    transport?: 'https' | 'ssh'
  }) => GitHostingResolution
): GitRemoteEnvResolver {
  return async ({ canonicalRoot, remote, operation }) => {
    const transport = await remoteTransportOf(canonicalRoot, remote)
    if (!transport) return undefined
    return gitTransportEnv(
      resolve({ host: transport.host, operation, transport: transport.transport })
    )
  }
}
