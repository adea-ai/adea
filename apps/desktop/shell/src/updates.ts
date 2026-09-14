// The desktop update family: feed polling, in-place install, and the manual
// fallback. Lives outside `commands.ts` so the whole flow is testable without
// the full command registry (scripts/desktop-update-boundary.test.ts).
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  downloadUpdateArchive,
  extractUpdateArchive,
  installedFrameworkSha256,
  parseUpdateManifest,
  resolveUpdateAssetUrl,
  stageUpdateSwap,
  updateFeedUrl,
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

export function versionLessThan(a: string, b: string): boolean {
  const pa = a
    .replace(/^v/, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0)
  const pb = b
    .replace(/^v/, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pb[i] ?? 0) !== (pa[i] ?? 0)) return (pb[i] ?? 0) > (pa[i] ?? 0)
  }
  return false
}

function releaseTagUrl(version: string): string {
  return `https://github.com/adea-ai/adea/releases/tag/v${version}`
}

export function createUpdateManager(input: {
  appVersion: string
  dataDir: string
  onExit?: (exitInMs: number) => void
  /** Test seam: the installed CEF framework hash (otherwise computed from the running bundle). */
  frameworkSha256?: string
}) {
  const { appVersion, dataDir } = input
  const onExit = input.onExit ?? ((ms: number) => setTimeout(() => process.exit(0), ms))

  let update: UpdateStatus = {
    current_version: appVersion,
    available_version: null,
    release_date: null,
    release_notes: null,
    changelog: '',
    github_url: 'https://github.com/adea-ai/adea/releases',
    phase: 'idle',
    downloaded_bytes: 0,
    total_bytes: null,
    error: null,
    restart_required: false,
  }
  let pendingManifest: UpdateManifest | null = null
  // Memoized hash of the installed CEF framework binary (computed lazily,
  // only when a slim-capable update is on offer).
  let frameworkHash: string | null | undefined

  function snapshot(next: Partial<UpdateStatus>): UpdateStatus {
    update = { ...update, ...next }
    return update
  }

  function failed(error: unknown): UpdateStatus {
    return snapshot({
      phase: 'failed',
      available_version: null,
      error: error instanceof Error ? error.message : String(error),
      downloaded_bytes: 0,
      total_bytes: null,
    })
  }

  /** The fallback availability check for releases that predate the signed feed. */
  async function checkForUpdateViaReleasesPage(): Promise<UpdateStatus> {
    try {
      const res = await fetch('https://api.github.com/repos/adea-ai/adea/releases/latest', {
        headers: { accept: 'application/vnd.github+json' },
      })
      if (!res.ok) throw new Error(`github ${res.status}`)
      const release = (await res.json()) as {
        tag_name?: string
        body?: string
        html_url?: string
        published_at?: string
        draft?: boolean
        prerelease?: boolean
      }
      const tag = String(release.tag_name ?? '')
      const availableVersion = tag.replace(/^v/, '')
      const available = versionLessThan(appVersion, availableVersion)
      return snapshot({
        phase: available ? 'available' : 'current',
        available_version: available ? availableVersion : null,
        release_date: release.published_at ?? null,
        release_notes: release.body ?? null,
        changelog: release.body ?? '',
        github_url: release.html_url ?? 'https://github.com/adea-ai/adea/releases',
        error: null,
        restart_required: false,
      })
    } catch (error) {
      return failed(error)
    }
  }

  async function check(): Promise<UpdateStatus> {
    snapshot({ phase: 'checking', error: null })
    try {
      const res = await fetch(updateFeedUrl(), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
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
          changelog: manifest.notes ?? '',
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
        changelog: manifest.notes ?? '',
        github_url: releaseTagUrl(manifest.version),
        error: null,
        restart_required: false,
      })
    } catch {
      // No usable signed feed (forks, releases older than the lane): report
      // availability from the GitHub API and keep the manual handoff.
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
      // this bundle already carries, only the ~1MB app layer downloads and
      // overlays — no 117MB framework re-download, no launcher reinstall.
      let useSlim = false
      if (manifest.slim && manifest.framework) {
        frameworkHash ??= input.frameworkSha256 ?? (await installedFrameworkSha256())
        useSlim = frameworkHash === manifest.framework.sha256
      }
      const updatesDir = join(dataDir, 'updates')
      const slim = useSlim ? manifest.slim : null
      const archivePath = join(
        updatesDir,
        slim ? `Adea-${manifest.version}-update.tar.zst` : `Adea-${manifest.version}.app.tar.zst`
      )
      const downloadTarget = slim
        ? resolveUpdateAssetUrl(slim.url)
        : resolveUpdateAssetUrl(manifest.url)
      const { sha256 } = await downloadUpdateArchive(downloadTarget, archivePath, {
        onProgress: (downloaded, total) =>
          snapshot({ downloaded_bytes: downloaded, total_bytes: total }),
      })
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
    status: (): UpdateStatus | Promise<UpdateStatus> =>
      update.phase === 'idle' ? check() : update,
    install,
  }
}
