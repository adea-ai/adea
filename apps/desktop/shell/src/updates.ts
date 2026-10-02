// The desktop update family: feed polling, in-place install, and the manual
// fallback. Lives outside `commands.ts` so the whole flow is testable without
// the full command registry (scripts/desktop-update-boundary.test.ts).
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  downloadUpdateArchive,
  extractUpdateArchive,
  installedRuntimeSha256,
  parseUpdateManifest,
  resolveUpdateAssetUrl,
  stageUpdateSwap,
  updateFeedUrl,
  updateErrorMessage,
  verifySlimSignature,
  verifyUpdateSignature,
  type UpdateManifest,
} from './updater'

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'installed'
  | 'failed'

/** Mirrors `DesktopUpdate` in apps/web/src/lib/desktop-update.ts. */
export type UpdateStatus = {
  current_version: string
  available_version: string | null
  release_date: string | null
  release_notes: string | null
  changelog: string
  github_url: string
  phase: UpdatePhase
  downloaded_bytes: number
  total_bytes: number | null
  error: string | null
  restart_required: boolean
}

/** Bounds every outbound availability request; a hung feed or GitHub API
 * connection must never wedge the update state machine mid-check. */
const CHECK_TIMEOUT_MS = 10_000
/** A release-asset download that advances no bytes for this long is stalled. */
const DOWNLOAD_STALL_MS = 20_000
/** Hard cap for one download attempt, however slow-but-alive the stream is. */
const DOWNLOAD_MAX_MS = 15 * 60_000

/**
 * The installed changelog: the repository's full release history, staged next
 * to the bundled main process by `electrobun.config.ts` (running from the
 * repository reads the workspace root instead). Read once and cached; a
 * missing file degrades to an empty changelog rather than failing the update
 * surface.
 */
let installedChangelogCache: string | null = null
function installedChangelog(): string {
  if (installedChangelogCache !== null) return installedChangelogCache
  for (const candidate of [
    join(import.meta.dir, '../CHANGELOG.md'),
    join(import.meta.dir, '../../../../CHANGELOG.md'),
  ]) {
    try {
      if (existsSync(candidate)) {
        installedChangelogCache = readFileSync(candidate, 'utf8')
        return installedChangelogCache
      }
    } catch {
      // Try the next candidate; an unreadable changelog is not fatal.
    }
  }
  installedChangelogCache = ''
  return installedChangelogCache
}

/** The update channel an installation follows. */
export type UpdateChannel = 'stable' | 'pre-release' | 'dev'

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return value === 'stable' || value === 'pre-release' || value === 'dev'
}

const RELEASES_API_URL = 'https://api.github.com/repos/adea-ai/adea/releases?per_page=30'
/** Daily pre-releases keep the plain tag shape; dev builds are never promoted. */
const PRE_RELEASE_TAG = /^v\d+\.\d+\.\d+$/
const DEV_TAG = /^v\d+\.\d+\.\d+-dev\.\d+$/

/**
 * The manifest URL for an opt-in channel. GitHub has no `releases/latest`
 * equivalent that tracks pre-releases, so the channel resolves the newest
 * matching release through the API and reads that release's signed manifest.
 * The API only discovers the tag: the manifest itself comes from the same
 * release-download path the parser guards, and every signature check applies
 * exactly as it does on the stable feed.
 */
export async function resolveChannelFeedUrl(
  channel: Exclude<UpdateChannel, 'stable'>,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const response = await fetchImpl(RELEASES_API_URL, {
    headers: { accept: 'application/vnd.github+json' },
  })
  if (!response.ok) throw new Error(`github releases ${response.status}`)
  const releases = (await response.json()) as Array<{
    tag_name?: unknown
    draft?: unknown
    prerelease?: unknown
  }>
  const tagPattern = channel === 'dev' ? DEV_TAG : PRE_RELEASE_TAG
  for (const release of releases) {
    const tag = String(release.tag_name ?? '')
    if (release.draft === false && release.prerelease === true && tagPattern.test(tag)) {
      return `https://github.com/adea-ai/adea/releases/download/${tag}/latest.json`
    }
  }
  throw new Error(`no ${channel} release is published yet`)
}

/**
 * Parse a version in the update grammar into `[major, minor, patch, dev]`,
 * where a release carries no dev counter and sorts after every dev build of
 * its own triple (Infinity makes that ordering fall out of the tuple compare).
 * Unparseable versions return null so the caller can fall back.
 */
function parseUpdateVersion(version: string): [number, number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-dev\.(\d+))?$/.exec(version.trim())
  if (!match) return null
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    match[4] === undefined ? Infinity : Number(match[4]),
  ]
}

/**
 * Semver ordering for everything the update grammar produces: `x.y.z` and the
 * dev builds `x.y.z-dev.N`. A dev build sorts below its own release
 * (`0.75.0-dev.1 < 0.75.0`) and above every earlier build of its anchor, so
 * the next stable always wins over the dev line anchored at its predecessor.
 * Unparseable versions fall back to the historic numeric-triple comparison —
 * a malformed version must never wedge the state machine.
 */
export function versionLessThan(a: string, b: string): boolean {
  const pa = parseUpdateVersion(a)
  const pb = parseUpdateVersion(b)
  if (pa && pb) {
    for (let i = 0; i < 4; i++) {
      if (pa[i] !== pb[i]) return pa[i]! < pb[i]!
    }
    return false
  }
  const fallbackA = a
    .replace(/^v/, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0)
  const fallbackB = b
    .replace(/^v/, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((fallbackB[i] ?? 0) !== (fallbackA[i] ?? 0))
      return (fallbackB[i] ?? 0) > (fallbackA[i] ?? 0)
  }
  return false
}

function releaseTagUrl(version: string): string {
  return `https://github.com/adea-ai/adea/releases/tag/v${version}`
}

/**
 * The release lane attaches this platform's installable archive to the
 * release (`Adea-<tag>-macos-arm64.app.tar.zst`, tag with its `v`). The
 * GitHub API fallback cannot see the signed feed, so it must use the asset
 * list as its installability signal: a freshly published release exists
 * before its archives and feed are attached, and releases older than the
 * lane never carry them. Without this gate the shell announced "update
 * available" the moment the tag existed, and the install click could only
 * hand off to the releases page.
 */
function releaseHasInstallableAsset(
  tag: string,
  assets: ReadonlyArray<{ name?: unknown } | undefined> | undefined
): boolean {
  if (!Array.isArray(assets)) return false
  const expected = `Adea-${tag}-macos-arm64.app.tar.zst`
  return assets.some((asset) => asset?.name === expected)
}

/** Staging entry names this module owns inside `<dataDir>/updates`. */
const EXTRACTED_PREFIX = 'extracted-'

/** Best-effort removal: a stale-file problem must not fail an update. */
function removeQuietly(path: string, recursive: boolean): void {
  try {
    rmSync(path, { force: true, recursive })
  } catch {
    /* left behind; the next install prunes it again */
  }
}

/**
 * Drop the staging leftovers of installs that are no longer live: the
 * `extracted-<version>` payload directories and any abandoned `.partial`
 * download.
 *
 * A successful install removes its own payload from the apply script, but an
 * install interrupted between extraction and staging — a killed process, a
 * forced quit — never reaches that step, and neither case reaches the
 * archive cleanup below. Without this the directory grows by one fully
 * extracted bundle per update for the life of the install, which is how a
 * twelve-update history left multiple gigabytes behind.
 *
 * Only strictly older versions are removed: the payload for `keepVersion` is
 * the one an install may be using, and the updater only ever moves forward.
 * An unparseable directory name cannot be a live install, so it is removed.
 *
 * Cleanup is best effort and never throws — a stale-file problem must not be
 * what fails an otherwise good update.
 */
export function pruneStaleUpdateArtifacts(updatesDir: string, keepVersion: string): void {
  let entries: string[]
  try {
    entries = readdirSync(updatesDir)
  } catch {
    return // nothing has ever been staged here
  }
  for (const entry of entries) {
    const path = join(updatesDir, entry)
    if (entry.endsWith('.partial')) {
      removeQuietly(path, false)
      continue
    }
    if (!entry.startsWith(EXTRACTED_PREFIX)) continue
    const version = entry.slice(EXTRACTED_PREFIX.length)
    if (version === keepVersion || !versionLessThan(version, keepVersion)) continue
    removeQuietly(path, true)
  }
}

export function createUpdateManager(input: {
  appVersion: string
  dataDir: string
  onExit?: (exitInMs: number) => void
  /** Test seam: the installed runtime hash (otherwise computed from the running bundle). */
  runtimeSha256?: string
  /** Test seam: bounds each availability request (default 10s). */
  checkTimeoutMs?: number
  /** The channel this installation follows; read per check so a settings
   * change takes effect without a restart. Defaults to stable. */
  channel?: () => UpdateChannel
}) {
  const { appVersion, dataDir } = input
  const checkTimeoutMs = input.checkTimeoutMs ?? CHECK_TIMEOUT_MS
  const onExit = input.onExit ?? ((ms: number) => setTimeout(() => process.exit(0), ms))

  let update: UpdateStatus = {
    current_version: appVersion,
    available_version: null,
    release_date: null,
    release_notes: null,
    changelog: installedChangelog(),
    github_url: 'https://github.com/adea-ai/adea/releases',
    phase: 'idle',
    downloaded_bytes: 0,
    total_bytes: null,
    error: null,
    restart_required: false,
  }
  let pendingManifest: UpdateManifest | null = null
  // Memoized hash of the installed runtime binaries (computed lazily, only
  // when a slim-capable update is on offer).
  let runtimeHash: string | null | undefined
  // One check in flight at a time; tracked so a wedged 'checking' phase is
  // recognizable as stalled (nothing actually running) and can recover.
  let inFlight: Promise<UpdateStatus> | null = null

  function snapshot(next: Partial<UpdateStatus>): UpdateStatus {
    update = { ...update, ...next }
    return update
  }

  function failed(error: unknown): UpdateStatus {
    return snapshot({
      phase: 'failed',
      available_version: null,
      error: updateErrorMessage(error) ?? 'The update failed. Please try again.',
      downloaded_bytes: 0,
      total_bytes: null,
    })
  }

  /** The fallback availability check for releases that predate the signed feed. */
  async function checkForUpdateViaReleasesPage(): Promise<UpdateStatus> {
    try {
      const res = await fetch('https://api.github.com/repos/adea-ai/adea/releases/latest', {
        headers: { accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(checkTimeoutMs),
      })
      if (!res.ok) throw new Error(`github ${res.status}`)
      const release = (await res.json()) as {
        tag_name?: string
        body?: string
        html_url?: string
        published_at?: string
        draft?: boolean
        prerelease?: boolean
        assets?: ReadonlyArray<{ name?: unknown } | undefined>
      }
      const tag = String(release.tag_name ?? '')
      const availableVersion = tag.replace(/^v/, '')
      // Only announce an update this shell could actually install: a newer
      // release without the platform archive (not published yet, or older
      // than the lane) stays quiet. The release page stays reachable through
      // the dialog's "View releases" handoff either way.
      const installable = releaseHasInstallableAsset(tag, release.assets)
      const available = installable && versionLessThan(appVersion, availableVersion)
      return snapshot({
        phase: available ? 'available' : 'current',
        available_version: available ? availableVersion : null,
        release_date: release.published_at ?? null,
        release_notes: release.body ?? null,
        github_url: release.html_url ?? 'https://github.com/adea-ai/adea/releases',
        error: null,
        restart_required: false,
      })
    } catch (error) {
      return failed(error)
    }
  }

  function check(): Promise<UpdateStatus> {
    if (inFlight) return inFlight
    inFlight = runCheck().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  async function runCheck(): Promise<UpdateStatus> {
    snapshot({ phase: 'checking', error: null })
    const channel = input.channel?.() ?? 'stable'
    try {
      // An explicit feed override (tests, staging) wins over the channel; the
      // stable channel reads the moving `releases/latest` manifest, the opt-in
      // channels resolve their newest release first.
      const feedUrl = channel === 'stable' ? updateFeedUrl() : await resolveChannelFeedUrl(channel)
      const res = await fetch(feedUrl, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(checkTimeoutMs),
      })
      if (!res.ok) throw new Error(`update feed ${res.status}`)
      const parsed = parseUpdateManifest(await res.json())
      if (!parsed.ok) throw new Error(`update feed invalid: ${parsed.reason}`)
      const manifest = parsed.manifest
      if (!versionLessThan(appVersion, manifest.version)) {
        pendingManifest = null
        return snapshot({
          phase: 'current',
          available_version: null,
          release_date: manifest.publishedAt,
          release_notes: manifest.notes,
          github_url: releaseTagUrl(manifest.version),
          restart_required: false,
        })
      }
      pendingManifest = manifest
      return snapshot({
        phase: 'available',
        available_version: manifest.version,
        release_date: manifest.publishedAt,
        release_notes: manifest.notes,
        github_url: releaseTagUrl(manifest.version),
        error: null,
        restart_required: false,
      })
    } catch (error) {
      // No usable signed feed (forks, releases older than the lane): the
      // stable channel reports availability from the GitHub API and keeps the
      // manual handoff. Opt-in channels must never fall back to the stable
      // feed — an install that chose dev would be offered stable releases,
      // silently leaving the channel it opted into.
      if (channel !== 'stable') return failed(error)
      update = await checkForUpdateViaReleasesPage()
      return update
    }
  }

  async function install(args?: Record<string, unknown>): Promise<UpdateStatus> {
    if (args?.approved !== true) {
      return failed(new Error('the update was not approved'))
    }
    const manifest = pendingManifest
    if (!manifest) {
      // No signed feed entry (forks, releases older than the lane): hand the
      // user to the releases page instead of a dead-end error.
      try {
        Bun.spawn(['open', 'https://github.com/adea-ai/adea/releases'])
      } catch {
        /* best effort */
      }
      return failed(new Error('no in-app update is pending; download the latest release manually'))
    }
    if (typeof args.expectedVersion === 'string' && args.expectedVersion !== manifest.version) {
      return failed(new Error('the pending update has changed; check for updates again'))
    }
    try {
      snapshot({
        phase: 'downloading',
        available_version: manifest.version,
        error: null,
        downloaded_bytes: 0,
        total_bytes: null,
      })
      // Slim path: when the release was built against the same CEF framework
      // this bundle already carries, only the app layer downloads and
      // overlays — no framework re-download, no launcher reinstall.
      let useSlim = false
      if (manifest.slim && manifest.runtime) {
        runtimeHash ??= input.runtimeSha256 ?? (await installedRuntimeSha256())
        useSlim = runtimeHash === manifest.runtime.sha256
      }
      const updatesDir = join(dataDir, 'updates')
      // Clear what earlier installs left behind before adding this one's
      // payload to the same directory.
      pruneStaleUpdateArtifacts(updatesDir, manifest.version)
      const slim = useSlim ? manifest.slim : null
      const archivePath = join(
        updatesDir,
        slim ? `Adea-${manifest.version}-update.tar.zst` : `Adea-${manifest.version}.app.tar.zst`
      )
      const downloadTarget = slim
        ? resolveUpdateAssetUrl(slim.url)
        : resolveUpdateAssetUrl(manifest.url)
      // A release-CDN connection can stall mid-stream; a watchdog aborts when
      // no bytes arrive for a while, converting a forever-'downloading' wedge
      // into a clean failed state the user can retry.
      const downloadController = new AbortController()
      let lastProgressAt = Date.now()
      const watchdog = setInterval(() => {
        if (Date.now() - lastProgressAt > DOWNLOAD_STALL_MS) {
          downloadController.abort(new Error('update download stalled'))
        }
      }, 2_000)
      const overallCap = setTimeout(() => {
        downloadController.abort(new Error('update download exceeded the time limit'))
      }, DOWNLOAD_MAX_MS)
      let sha256: string
      try {
        const downloaded = await downloadUpdateArchive(downloadTarget, archivePath, {
          onProgress: (bytes, total) => {
            lastProgressAt = Date.now()
            snapshot({ downloaded_bytes: bytes, total_bytes: total })
          },
          signal: downloadController.signal,
        })
        sha256 = downloaded.sha256
      } catch (error) {
        rmSync(`${archivePath}.partial`, { force: true })
        clearInterval(watchdog)
        clearTimeout(overallCap)
        throw error
      }
      clearInterval(watchdog)
      clearTimeout(overallCap)
      if (slim) {
        if (sha256 !== slim.sha256) {
          rmSync(archivePath, { force: true })
          throw new Error('the downloaded update failed its checksum')
        }
        if (!verifySlimSignature(manifest)) {
          rmSync(archivePath, { force: true })
          throw new Error('the downloaded update failed its signature check')
        }
      } else {
        if (sha256 !== manifest.sha256) {
          rmSync(archivePath, { force: true })
          throw new Error('the downloaded update failed its checksum')
        }
        if (!verifyUpdateSignature(manifest)) {
          rmSync(archivePath, { force: true })
          throw new Error('the downloaded update failed its signature check')
        }
      }
      snapshot({ phase: 'installing' })
      const newAppPath = await extractUpdateArchive(
        archivePath,
        join(updatesDir, `extracted-${manifest.version}`),
        useSlim ? 'slim' : 'full'
      )
      rmSync(archivePath, { force: true })
      const staged = stageUpdateSwap({
        newAppPath,
        dataDir,
        skipApply: process.env.ADEA_UPDATE_SKIP_APPLY === '1',
        mode: useSlim ? 'slim' : 'full',
      })
      if ('error' in staged) {
        // In-place install is impossible here (dev run, unsupported
        // platform): hand off to the releases page so the user is not stuck.
        try {
          Bun.spawn(['open', releaseTagUrl(manifest.version)])
        } catch {
          /* best effort */
        }
        throw new Error(staged.error)
      }
      snapshot({ phase: 'installed', restart_required: true })
      if (args.restart !== false) {
        // Detached so it outlives this process: it waits for the shell to
        // exit, stops the old launcher, swaps the bundle, and relaunches.
        Bun.spawn(['sh', staged.scriptPath], {
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
        })
        // Let the invoke response flush before the apply script proceeds.
        onExit(500)
      }
      return update
    } catch (error) {
      return failed(error)
    }
  }

  return {
    check,
    status: (): UpdateStatus | Promise<UpdateStatus> => {
      // A 'checking' snapshot with nothing in flight is a stall left behind by
      // an interrupted check (crash, unbounded fetch before the timeout
      // landed): re-run instead of serving the spinner forever.
      if (update.phase === 'idle' || (update.phase === 'checking' && !inFlight)) return check()
      return update
    },
    install,
  }
}
