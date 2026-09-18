// M10 #30: executable resolution and bounded version probing.
//
// The resolution order and existence-only install probe translate Zeron's
// Rust driver detection (`crates/harness/src/lib.rs` node-version-manager
// bins, `claude/mod.rs` resolve_claude_executable, `acp/mod.rs`
// find_on_paths): an explicit override wins, then PATH, then known
// HOME-relative and absolute install locations. Detection is a filesystem
// probe, never a spawn.
//
// Hard boundaries, all spec-bounded (1 MiB probe output, 64 KiB record,
// 10 seconds): the version probe runs one fixed-argv child of the resolved
// absolute path — no shell text — and kills it on timeout or output overflow.
// Probe output never enters diagnostics; only a classified code does.
import { spawn } from 'node:child_process'

export const VERSION_PROBE_TIMEOUT_MS = 10_000
export const VERSION_PROBE_MAX_BYTES = 1024 * 1024
export const VERSION_RECORD_MAX_BYTES = 64 * 1024

export type DiscoveryEnv = Readonly<Record<string, string | undefined>>

export type PathProbe = Readonly<{
  /** True when the path resolves to an existing regular file (follows links). */
  isRegularFile: (path: string) => boolean
  /** Resolved real path, or null when the link is broken or resolution fails. */
  realPath: (path: string) => string | null
}>

export type VersionProbeResult =
  | Readonly<{ ok: true; version: string }>
  | Readonly<{
      ok: false
      code:
        | 'version_probe_failed'
        | 'version_probe_timeout'
        | 'version_probe_overflow'
        | 'permission_denied'
    }>

export type VersionProbe = (
  executable: string,
  argv: readonly string[]
) => Promise<VersionProbeResult>

export type ResolvedExecutable =
  | Readonly<{
      found: true
      identity: string
      label: string
      source: 'override' | 'path' | 'known'
    }>
  | Readonly<{ found: false }>

function splitPathList(value: string | undefined): string[] {
  if (!value) return []
  return value.split(':').filter((part) => part.length > 0)
}

/** Node version managers shape PATH in shell init, which a GUI launch never
 *  runs; their fixed bin directories are probed explicitly (Zeron semantics). */
export function nodeVersionManagerBins(env: DiscoveryEnv, home: string | undefined): string[] {
  if (!home) return []
  const dirs: string[] = []
  const fnmRoots = [
    env.FNM_DIR,
    `${home}/.local/share/fnm`,
    `${home}/Library/Application Support/fnm`,
    `${home}/.fnm`,
  ]
  for (const root of fnmRoots) if (root) dirs.push(`${root}/aliases/default/bin`)
  dirs.push(
    `${home}/.volta/bin`,
    `${home}/.bun/bin`,
    `${home}/Library/pnpm`,
    `${home}/.local/share/pnpm`
  )
  // nvm keeps one bin per installed version; probe them newest-last so the
  // default alias-style locations above win earlier.
  const nvmVersions = `${home}/.nvm/versions/node`
  for (const version of env.NVM_VERSIONS?.split(':') ?? []) {
    if (version) dirs.push(`${nvmVersions}/${version}/bin`)
  }
  return dirs
}

/**
 * Resolve the first existing regular file for one family spec, in override →
 * PATH → HOME-relative → absolute → version-manager-bin order. The label is
 * the executable simple name plus a coarse redacted source hint — never a
 * path.
 */
export function resolveExecutable(options: {
  spec: {
    executableNames: readonly string[]
    envOverride: string
    homeRelativePaths: readonly string[]
    absolutePaths: readonly string[]
  }
  env: DiscoveryEnv
  probe: PathProbe
}): ResolvedExecutable {
  const { spec, env, probe } = options
  const home = env.HOME
  const override = env[spec.envOverride]
  if (override && override.length > 0) {
    if (!probe.isRegularFile(override)) return { found: false }
    const identity = probe.realPath(override) ?? override
    return {
      found: true,
      identity,
      label: `${spec.executableNames[0] ?? 'harness'} (override)`,
      source: 'override',
    }
  }

  const pathDirs = splitPathList(env.PATH)
  const homeDirs = home ? spec.homeRelativePaths.map((relative) => `${home}/${relative}`) : []
  const absoluteDirs = [...spec.absolutePaths]
  const managerDirs = nodeVersionManagerBins(env, home)
  const searched = [...pathDirs, ...homeDirs, ...absoluteDirs, ...managerDirs]

  for (const directory of searched) {
    for (const name of spec.executableNames) {
      const candidate = `${directory}/${name}`
      // An unreadable directory must not abort the whole search: skip and
      // keep probing the remaining locations.
      let present: boolean
      try {
        present = probe.isRegularFile(candidate)
      } catch {
        continue
      }
      if (!present) continue
      const identity = probe.realPath(candidate)
      // A candidate that exists but cannot be resolved to a real path is a
      // broken install (dangling symlink): skip it rather than adopt an
      // identity we cannot prove.
      if (identity === null) continue
      const fromPath = pathDirs.includes(directory)
      return {
        found: true,
        identity,
        label: `${name} (${fromPath ? 'path' : labelScope(directory, home, spec.absolutePaths)})`,
        source: fromPath ? 'path' : 'known',
      }
    }
  }
  return { found: false }
}

/** Coarse redacted source hint for a resolved directory — never a path. */
function labelScope(
  directory: string,
  home: string | undefined,
  absolutePaths: readonly string[]
): string {
  if (home !== undefined && directory.startsWith(`${home}/`)) return 'home'
  if (absolutePaths.includes(directory)) return 'system'
  return 'version-manager'
}

/** Extract the first dotted-numeric version token from probe output. */
export function parseVersionOutput(output: string): string | null {
  const firstLine = output.slice(0, VERSION_RECORD_MAX_BYTES).split(/\r?\n/, 1)[0] ?? ''
  const match = firstLine.match(/\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?/)
  return match ? match[0] : null
}

function versionParts(version: string): number[] {
  return version
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0))
}

/**
 * Compare dotted-numeric versions; non-numeric suffixes compare shorter-first.
 * Returns a negative number when `candidate` is older than `minimum`.
 */
export function compareVersions(candidate: string, minimum: string): number {
  const candidateParts = versionParts(candidate)
  const minimumParts = versionParts(minimum)
  const length = Math.max(candidateParts.length, minimumParts.length)
  for (let index = 0; index < length; index += 1) {
    const left = candidateParts[index] ?? 0
    const right = minimumParts[index] ?? 0
    if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

/**
 * Default version probe: one fixed-argv child process of the resolved
 * absolute path with a 10-second timeout and a 1 MiB output ceiling. Only the
 * parsed version crosses back; output bytes and stderr never leave this
 * function so they cannot enter diagnostics, logs, or inventory state.
 */
export function spawnVersionProbe(
  executable: string,
  argv: readonly string[]
): Promise<VersionProbeResult> {
  return new Promise((resolve) => {
    let settled = false
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(executable, [...argv], {
        stdio: ['ignore', 'pipe', 'ignore'],
        // The child inherits only what the probe needs: locale-stable output
        // and its own absolute path needs no PATH lookup.
        env: { PATH: process.env.PATH ?? '', LANG: 'C' },
      })
    } catch (error) {
      resolve({
        ok: false,
        code:
          (error as NodeJS.ErrnoException).code === 'EACCES'
            ? 'permission_denied'
            : 'version_probe_failed',
      })
      return
    }

    const timeout = setTimeout(() => {
      finish({ ok: false, code: 'version_probe_timeout' })
      child.kill('SIGKILL')
    }, VERSION_PROBE_TIMEOUT_MS)

    let bytes = 0
    let text = ''
    let overflow = false

    function finish(result: VersionProbeResult): void {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(result)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes > VERSION_PROBE_MAX_BYTES) {
        overflow = true
        finish({ ok: false, code: 'version_probe_overflow' })
        child.kill('SIGKILL')
        return
      }
      text += chunk.toString('utf8')
      if (text.length > VERSION_RECORD_MAX_BYTES) text = text.slice(0, VERSION_RECORD_MAX_BYTES)
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        code: error.code === 'EACCES' ? 'permission_denied' : 'version_probe_failed',
      })
    })
    child.on('close', (code) => {
      if (settled) return
      if (overflow) return
      if (code !== 0) {
        finish({ ok: false, code: 'version_probe_failed' })
        return
      }
      const version = parseVersionOutput(text)
      finish(version === null ? { ok: false, code: 'version_probe_failed' } : { ok: true, version })
    })
  })
}
