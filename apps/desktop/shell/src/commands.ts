// Desktop command surface (the shell side of `apps/web/src/lib/desktop-bridge`).
// File-backed state under the app data directory; AES-GCM for anything that was
// keyring-protected under the previous shell. The observable command contract is
// unchanged — see docs/specs/desktop-auth.md and docs/specs/local-content.md for
// the behaviours these implement and the documented replacements.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { version as packagedVersion } from '../../package.json'
import {
  downloadUpdateArchive,
  extractUpdateArchive,
  parseUpdateManifest,
  resolveUpdateAssetUrl,
  stageUpdateSwap,
  updateFeedUrl,
  verifyUpdateSignature,
  type UpdateManifest,
} from './updater'

// Update flow: compare this build against the signed `latest.json` feed the
// release lane publishes on GitHub Releases and install newer releases in
// place; when no signed feed exists (forks, releases older than the lane),
// fall back to reporting availability via the GitHub API with a releases-page
// handoff. Release Please bumps the desktop lane's package version with every
// release, so the running version is never restated by hand.
const APP_VERSION = process.env.ADEA_APP_VERSION ?? packagedVersion

/** Mirrors `DesktopUpdate` in apps/web/src/lib/desktop-update.ts. */
type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'installed'
  | 'failed'

type UpdateStatus = {
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

function versionLessThan(a: string, b: string): boolean {
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
    const available = versionLessThan(APP_VERSION, availableVersion)
    return {
      current_version: APP_VERSION,
      available_version: available ? availableVersion : null,
      release_date: release.published_at ?? null,
      release_notes: release.body ?? null,
      changelog: release.body ?? '',
      github_url: release.html_url ?? 'https://github.com/adea-ai/adea/releases',
      phase: available ? 'available' : 'current',
      downloaded_bytes: 0,
      total_bytes: null,
      error: null,
      restart_required: false,
    }
  } catch (error) {
    return {
      current_version: APP_VERSION,
      available_version: null,
      release_date: null,
      release_notes: null,
      changelog: '',
      github_url: 'https://github.com/adea-ai/adea/releases',
      phase: 'failed',
      downloaded_bytes: 0,
      total_bytes: null,
      error: error instanceof Error ? error.message : String(error),
      restart_required: false,
    }
  }
}

export type BridgeResult = { ok: true; value: unknown } | { ok: false; error: string }

export function createCommandSurface(dataDir: string) {
  const stateDir = join(dataDir, 'desktop-state')
  const contentDir = join(dataDir, 'local-content')
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  mkdirSync(contentDir, { recursive: true, mode: 0o700 })

  // In-memory update state. The version dialog is the only consumer, and a
  // restart replaces the process, so persistence buys nothing.
  let update: UpdateStatus = {
    current_version: APP_VERSION,
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

  function updateSnapshot(next: Partial<UpdateStatus>): UpdateStatus {
    update = { ...update, ...next }
    return update
  }

  function updateFailed(error: unknown): UpdateStatus {
    return updateSnapshot({
      phase: 'failed',
      available_version: null,
      error: error instanceof Error ? error.message : String(error),
      downloaded_bytes: 0,
      total_bytes: null,
    })
  }

  async function checkForSignedUpdate(): Promise<UpdateStatus> {
    updateSnapshot({ phase: 'checking', error: null })
    try {
      const res = await fetch(updateFeedUrl(), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      })
      if (!res.ok) throw new Error(`update feed ${res.status}`)
      const parsed = parseUpdateManifest(await res.json())
      if (!parsed.ok) throw new Error(`update feed invalid: ${parsed.reason}`)
      const manifest = parsed.manifest
      if (!versionLessThan(APP_VERSION, manifest.version)) {
        pendingManifest = null
        return updateSnapshot({
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
      return updateSnapshot({
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
      const fallback = await checkForUpdateViaReleasesPage()
      update = fallback
      return update
    }
  }

  async function installPendingUpdate(args?: Record<string, unknown>): Promise<UpdateStatus> {
    if (args?.approved !== true) {
      return updateFailed(new Error('the update was not approved'))
    }
    const manifest = pendingManifest
    if (
      !manifest ||
      (typeof args.expectedVersion === 'string' && args.expectedVersion !== manifest.version)
    ) {
      return updateFailed(new Error('the pending update has changed; check for updates again'))
    }
    try {
      updateSnapshot({
        phase: 'downloading',
        available_version: manifest.version,
        error: null,
        downloaded_bytes: 0,
        total_bytes: null,
      })
      const updatesDir = join(dataDir, 'updates')
      const archivePath = join(updatesDir, `Adea-${manifest.version}.app.tar.zst`)
      const { sha256 } = await downloadUpdateArchive(
        resolveUpdateAssetUrl(manifest.url),
        archivePath,
        {
          onProgress: (downloaded, total) =>
            updateSnapshot({ downloaded_bytes: downloaded, total_bytes: total }),
        }
      )
      if (sha256 !== manifest.sha256) {
        rmSync(archivePath, { force: true })
        throw new Error('the downloaded update failed its checksum')
      }
      if (!verifyUpdateSignature(manifest)) {
        rmSync(archivePath, { force: true })
        throw new Error('the downloaded update failed its signature check')
      }
      updateSnapshot({ phase: 'installing' })
      const newAppPath = await extractUpdateArchive(
        archivePath,
        join(updatesDir, `extracted-${manifest.version}`)
      )
      rmSync(archivePath, { force: true })
      const staged = stageUpdateSwap({
        newAppPath,
        dataDir,
        skipApply: process.env.ADEA_UPDATE_SKIP_APPLY === '1',
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
      updateSnapshot({ phase: 'installed', restart_required: true })
      if (args.restart !== false) {
        // Detached so it outlives this process: it waits for the shell to
        // exit, stops the old launcher, swaps the bundle, and relaunches.
        Bun.spawn(['sh', staged.scriptPath], {
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
        })
        // Let the invoke response flush before the apply script proceeds.
        setTimeout(() => process.exit(0), 500)
      }
      return update
    } catch (error) {
      return updateFailed(error)
    }
  }

  const keyFile = join(stateDir, 'device.key')
  function deviceKey(): Buffer {
    if (!existsSync(keyFile)) {
      writeFileSync(keyFile, randomBytes(32), { mode: 0o600 })
      chmodSync(keyFile, 0o600)
    }
    return readFileSync(keyFile)
  }

  function seal(plaintext: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', deviceKey(), iv)
    const sealed = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64')
  }

  function open(sealedBase64: string): string {
    const raw = Buffer.from(sealedBase64, 'base64')
    const iv = raw.subarray(0, 12)
    const tag = raw.subarray(12, 28)
    const body = raw.subarray(28)
    const decipher = createDecipheriv('aes-256-gcm', deviceKey(), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  }

  function readJson(name: string): unknown {
    try {
      return JSON.parse(readFileSync(join(stateDir, name), 'utf8'))
    } catch {
      return null
    }
  }
  function writeJson(name: string, value: unknown): void {
    writeFileSync(join(stateDir, name), JSON.stringify(value ?? null), { mode: 0o600 })
  }
  function readSecret(name: string): unknown {
    try {
      return JSON.parse(open(readFileSync(join(stateDir, name), 'utf8')))
    } catch {
      return null
    }
  }
  function writeSecret(name: string, value: unknown): void {
    writeFileSync(join(stateDir, name), seal(JSON.stringify(value ?? null)), { mode: 0o600 })
  }
  function clear(name: string): void {
    try {
      rmSync(join(stateDir, name))
    } catch {
      /* absent */
    }
  }

  const contentIndexFile = join(contentDir, 'index.json')
  type ContentRef = Record<string, unknown> & { id: string; workspaceId: string }
  function contentIndex(): Record<string, ContentRef> {
    try {
      return JSON.parse(readFileSync(contentIndexFile, 'utf8'))
    } catch {
      return {}
    }
  }
  function writeContentIndex(index: Record<string, ContentRef>): void {
    writeFileSync(contentIndexFile, JSON.stringify(index), { mode: 0o600 })
  }

  const handlers: Record<string, (args?: Record<string, unknown>) => unknown> = {
    desktop_user_session_load: () => readSecret('session.sealed'),
    desktop_user_session_save: (args) => {
      writeSecret('session.sealed', args?.session)
      return null
    },
    desktop_user_session_clear: () => {
      clear('session.sealed')
      return null
    },
    desktop_auth_attempt_load: () => readSecret('auth-attempt.sealed'),
    desktop_auth_attempt_save: (args) => {
      writeSecret('auth-attempt.sealed', args?.attempt)
      return null
    },
    desktop_auth_attempt_clear: () => {
      clear('auth-attempt.sealed')
      return null
    },
    desktop_auth_start: (args) => {
      const url = String(args?.authorizationUrl ?? '')
      if (!url) throw new Error('missing authorization url')
      // Open the trusted sign-in page in the system browser; the callback
      // arrives through the URL-scheme handler (release-pipeline registration).
      Bun.spawn(['open', url])
      return null
    },
    desktop_auth_take_callback: () => {
      const callback = readJson('auth-callback.json') as string | null
      if (callback) clear('auth-callback.json')
      return callback
    },
    desktop_temporary_workspace_load: () => readSecret('temporary-workspace.sealed'),
    desktop_temporary_workspace_save: (args) => {
      writeSecret('temporary-workspace.sealed', args?.credential)
      return null
    },
    desktop_temporary_workspace_clear: () => {
      clear('temporary-workspace.sealed')
      return null
    },
    desktop_preferences_load: () => readJson('preferences.json'),
    desktop_preferences_save: (args) => {
      writeJson('preferences.json', args?.preferences)
      return null
    },
    local_content_authorize_workspace: () => null,
    local_content_create: (args) => {
      const input = (args?.input ?? {}) as Record<string, unknown>
      const id = String(input.contentId ?? randomBytes(16).toString('hex'))
      const now = new Date().toISOString()
      const ref = {
        id,
        workspaceId: String(input.workspaceId ?? ''),
        contentType: input.contentType,
        taskId: input.taskId,
        messageId: input.messageId,
        revision: 1,
        digestSha256: '',
        sensitivity: input.sensitivity,
        storagePolicy: input.storagePolicy,
        synchronizationPolicy: input.synchronizationPolicy,
        availability: 'available',
        schemaVersion: 1,
        keyVersion: 1,
        createdAt: now,
        updatedAt: now,
      }
      writeFileSync(join(contentDir, `${id}.sealed`), seal(String(input.plaintext ?? '')), {
        mode: 0o600,
      })
      const index = contentIndex()
      index[id] = ref
      writeContentIndex(index)
      return ref
    },
    local_content_read: (args) => {
      const input = (args?.input ?? {}) as Record<string, unknown>
      const id = String(input.contentId ?? '')
      const ref = contentIndex()[id]
      if (!ref) return null
      const plaintext = open(readFileSync(join(contentDir, `${id}.sealed`), 'utf8'))
      return { contentRef: ref, plaintext }
    },
    local_content_update: (args) => {
      const input = (args?.input ?? {}) as Record<string, unknown>
      const id = String(input.contentId ?? '')
      const index = contentIndex()
      const ref = index[id]
      if (!ref) return null
      if (typeof input.plaintext === 'string') {
        writeFileSync(join(contentDir, `${id}.sealed`), seal(input.plaintext), { mode: 0o600 })
      }
      ref.revision = Number(ref.revision ?? 1) + 1
      ref.updatedAt = new Date().toISOString()
      writeContentIndex(index)
      return ref
    },
    local_content_delete: (args) => {
      const input = (args?.input ?? {}) as Record<string, unknown>
      const id = String(input.contentId ?? '')
      const index = contentIndex()
      delete index[id]
      writeContentIndex(index)
      clear(join('..', 'local-content', `${id}.sealed`))
      return null
    },
    local_content_search: (args) => {
      const input = (args?.input ?? {}) as Record<string, unknown>
      const query = String(input.query ?? '').toLowerCase()
      const results: Array<Record<string, unknown>> = []
      for (const ref of Object.values(contentIndex())) {
        if (input.workspaceId && ref.workspaceId !== input.workspaceId) continue
        try {
          const plaintext = open(readFileSync(join(contentDir, `${ref.id}.sealed`), 'utf8'))
          if (!query || plaintext.toLowerCase().includes(query)) {
            results.push({
              contentId: ref.id,
              contentType: ref.contentType,
              messageId: ref.messageId,
              taskId: ref.taskId,
              snippet: plaintext.slice(0, 160),
            })
          }
        } catch {
          /* unreadable entry */
        }
      }
      return results
    },
    local_content_health: () => ({ ok: true }),
    local_content_rotate_key: () => {
      clear('device.key')
      return null
    },
    desktop_update_check: () => checkForSignedUpdate(),
    desktop_update_status: () => (update.phase === 'idle' ? checkForSignedUpdate() : update),
    desktop_update_install: (args) => installPendingUpdate(args),
    desktop_transcription_permission: () => 'denied',
    desktop_transcription_start: () => {
      throw new Error('transcription is not available in this shell yet')
    },
    desktop_transcription_cancel: () => null,
    // Local capability health. The shell has no native prerequisites to probe
    // in this lane yet, so the snapshot is an honest empty result.
    capability_snapshot: () => ({
      ageMs: 0,
      capabilities: [],
      reProbeFloorMs: 30_000,
      servedFromCache: false,
    }),
    // App metadata for the client's version surface.
    adea_app_version: () => APP_VERSION,
  }

  return function invoke(
    cmd: string,
    args?: Record<string, unknown>
  ): BridgeResult | Promise<BridgeResult> {
    const handler = handlers[cmd]
    if (!handler) return { ok: false, error: `unknown command: ${cmd}` }
    try {
      const result = handler(args)
      return result instanceof Promise
        ? result.then(
            (value) => ({ ok: true, value: value ?? null }) as BridgeResult,
            (error) =>
              ({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              }) as BridgeResult
          )
        : { ok: true, value: result ?? null }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
