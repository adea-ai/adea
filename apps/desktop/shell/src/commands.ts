// Desktop command surface (the shell side of `apps/web/src/lib/desktop-bridge`).
// File-backed state under the app data directory; AES-GCM for anything that was
// keyring-protected under the previous shell. The observable command contract is
// unchanged — see docs/specs/desktop-auth.md and docs/specs/local-content.md for
// the behaviours these implement and the documented replacements.
//
// This registry sits behind the M10 channel gate (issue #33): the loopback
// server refuses any request that has not authenticated to the shell channel
// (see src/dev-runtime/channel/), so a handler here runs only for the app's
// own window. Privileged `dev.*` operations do NOT register here — they belong
// to the authenticated Dev Runtime channel under src/dev-runtime/.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { version as packagedVersion } from '../../package.json'
import { resolveCloudOrigin } from './cloud-proxy'
import { createUpdateManager } from './updates'

// Update flow: compare this build against the signed `latest.json` feed the
// release lane publishes on GitHub Releases and install newer releases in
// place (see updates.ts); when no signed feed exists (forks, releases older
// than the lane), fall back to reporting availability via the GitHub API with
// a releases-page handoff. Release Please bumps the desktop lane's package
// version with every release, so the running version is never restated by hand.
const APP_VERSION = process.env.ADEA_APP_VERSION ?? packagedVersion

// Local content identifiers are identities, never paths: the spec pins
// canonical UUIDs (docs/specs/local-content.md) and the transitional store
// already mints 128-bit hex ids, so the guard accepts exactly those two
// shapes. Every handler that turns an id into a filename re-checks the shape
// first, so a hostile id cannot escape the content directory.
const CONTENT_ID_PATTERN =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/

function contentId(value: unknown): string {
  const id = String(value ?? '')
  if (!CONTENT_ID_PATTERN.test(id)) throw new Error('invalid content id')
  return id
}

/**
 * Shell-side defense in depth for `desktop_auth_start`: the client validates
 * the full authorization URL (docs/specs/desktop-auth.md); the shell refuses
 * to open anything that is not a credential-free authorize URL on the one
 * canonical cloud origin.
 */
function isAcceptableAuthorizationUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const cloud = new URL(resolveCloudOrigin())
    return (
      parsed.origin === cloud.origin &&
      parsed.pathname === '/api/auth/desktop/authorize' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.hash === ''
    )
  } catch {
    return false
  }
}

export type BridgeResult = { ok: true; value: unknown } | { ok: false; error: string }

export function createCommandSurface(dataDir: string) {
  const stateDir = join(dataDir, 'desktop-state')
  const contentDir = join(dataDir, 'local-content')
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  mkdirSync(contentDir, { recursive: true, mode: 0o700 })

  const updates = createUpdateManager({ appVersion: APP_VERSION, dataDir })

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
      if (!isAcceptableAuthorizationUrl(url)) throw new Error('untrusted authorization url')
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
      const id =
        input.contentId === undefined ? randomBytes(16).toString('hex') : contentId(input.contentId)
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
      const id = contentId(input.contentId)
      const ref = contentIndex()[id]
      if (!ref) return null
      const plaintext = open(readFileSync(join(contentDir, `${id}.sealed`), 'utf8'))
      return { contentRef: ref, plaintext }
    },
    local_content_update: (args) => {
      const input = (args?.input ?? {}) as Record<string, unknown>
      const id = contentId(input.contentId)
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
      const id = contentId(input.contentId)
      const index = contentIndex()
      delete index[id]
      writeContentIndex(index)
      rmSync(join(contentDir, `${id}.sealed`), { force: true })
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
    desktop_update_check: () => updates.check(),
    desktop_update_status: () => updates.status(),
    desktop_update_install: (args) => updates.install(args),
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
