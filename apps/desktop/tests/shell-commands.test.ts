// The shell's command registry is the whole desktop surface: a name the client
// calls but this registry does not know fails at runtime. The per-command
// contract tests live in `scripts/desktop-*.test.ts`; this keeps the registry
// exercised from the desktop lane it belongs to.
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCommandSurface } from '../shell/src/commands'
import { SETTINGS_PANES, createMacPermissionService } from '../shell/src/desktop-permissions'
import {
  downloadUpdateArchive,
  extractUpdateArchive,
  updateErrorMessage,
} from '../shell/src/updater'

describe('desktop shell command surface', () => {
  test('the update channel family reads, validates, and persists shell-side', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-shell-commands-'))
    try {
      const invoke = createCommandSurface(dataDir)
      // Default stable: the file does not exist yet.
      expect(invoke('desktop_update_channel')).toEqual({ ok: true, value: 'stable' })
      expect(existsSync(join(dataDir, 'desktop-state', 'update-channel.json'))).toBe(false)

      expect(invoke('desktop_update_channel_save', { channel: 'pre-release' })).toEqual({
        ok: true,
        value: 'pre-release',
      })
      expect(invoke('desktop_update_channel')).toEqual({ ok: true, value: 'pre-release' })
      expect(
        JSON.parse(readFileSync(join(dataDir, 'desktop-state', 'update-channel.json'), 'utf8'))
      ).toEqual({ channel: 'pre-release' })

      // A corrupted or hostile stored value degrades to stable rather than
      // poisoning the update manager's channel accessor.
      writeFileSync(join(dataDir, 'desktop-state', 'update-channel.json'), '{"channel":"beta"}')
      expect(invoke('desktop_update_channel')).toEqual({ ok: true, value: 'stable' })

      const rejected = invoke('desktop_update_channel_save', { channel: 'beta' })
      expect(rejected).toEqual({ ok: false, error: 'unknown update channel' })
      expect(invoke('desktop_update_channel_save', {})).toEqual({
        ok: false,
        error: 'unknown update channel',
      })
    } finally {
      rmSync(dataDir, { force: true, recursive: true })
    }
  })

  test('accepts only the ephemeral Chat presentation hint through the guarded command surface', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-shell-commands-'))
    const updates: Array<string | undefined> = []
    try {
      const invoke = createCommandSurface(dataDir, {
        onChatPresentation: (focusedSessionId) => updates.push(focusedSessionId),
      })

      expect(
        invoke('desktop_chat_presentation', { focusedSessionId: 'runtime-session-id' })
      ).toEqual({ ok: true, value: null })
      expect(invoke('desktop_chat_presentation', {})).toEqual({ ok: true, value: null })
      expect(invoke('desktop_chat_presentation', { focusedSessionId: ['not-a-session'] })).toEqual({
        ok: true,
        value: null,
      })
      expect(invoke('desktop_chat_presentation', { focusedSessionId: 'a'.repeat(129) })).toEqual({
        ok: true,
        value: null,
      })
      expect(updates).toEqual(['runtime-session-id', undefined, undefined, undefined])
    } finally {
      rmSync(dataDir, { force: true, recursive: true })
    }
  })

  test('round-trips the local content and preferences families', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-shell-commands-'))
    try {
      const invoke = createCommandSurface(dataDir)
      const created = invoke('local_content_create', {
        input: {
          contentType: 'task_objective',
          plaintext: 'Keep this private',
          sensitivity: 'restricted',
          storagePolicy: 'local_authority',
          synchronizationPolicy: 'local_only',
          workspaceId: 'workspace-1',
        },
      })
      expect(created.ok).toBe(true)
      const contentId = (created as { ok: true; value: { id: string } }).value.id
      const read = invoke('local_content_read', {
        input: { contentId, workspaceId: 'workspace-1' },
      })
      expect(read).toEqual({
        ok: true,
        value: expect.objectContaining({ plaintext: 'Keep this private' }),
      })
      const searched = invoke('local_content_search', {
        input: { query: 'private', workspaceId: 'workspace-1' },
      })
      expect(searched).toEqual({
        ok: true,
        value: [expect.objectContaining({ contentId })],
      })

      expect(
        invoke('desktop_preferences_save', {
          preferences: { dictationLocale: 'en-US', version: 1 },
        })
      ).toEqual({ ok: true, value: null })
      expect(invoke('desktop_preferences_load')).toEqual({
        ok: true,
        value: { dictationLocale: 'en-US', version: 1 },
      })
    } finally {
      rmSync(dataDir, { force: true, recursive: true })
    }
  })

  test('refuses unknown commands instead of evaluating them', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-shell-commands-'))
    try {
      const invoke = createCommandSurface(dataDir)
      expect(invoke('desktop_surprise')).toEqual({
        error: 'unknown command: desktop_surprise',
        ok: false,
      })
    } finally {
      rmSync(dataDir, { force: true, recursive: true })
    }
  })

  test('deep-links the screen-recording repair to the exact Screen Capture pane', async () => {
    // The permissions row's "Open System Settings" affordance must land on the
    // Screen Recording pane, never generic Settings and never a client-supplied
    // URL. This exercises the registry entry with the real desktop-permissions
    // service behind it (only the host runner is scripted), so a dropped
    // command registration or a drifted anchor fails here.
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-shell-commands-'))
    const argvCalls: Array<readonly string[]> = []
    try {
      const invoke = createCommandSurface(dataDir, {
        macPermissions: createMacPermissionService({
          platform: 'darwin',
          run: async (argv) => {
            argvCalls.push(argv)
            return { exitCode: 0, stdout: '', stderr: '', timedOut: false, spawnFailed: false }
          },
        }),
      })

      await expect(
        invoke('desktop_permissions_open_settings', { permissionId: 'screen_recording' })
      ).resolves.toEqual({
        ok: true,
        value: { permissionId: 'screen_recording', settingsUrl: SETTINGS_PANES.screen_recording },
      })
      expect(argvCalls).toEqual([['/usr/bin/open', SETTINGS_PANES.screen_recording]])
      expect(SETTINGS_PANES.screen_recording).toBe(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
      )

      // An unknown id is refused before the opener runs, so no client string
      // ever reaches argv.
      await expect(
        invoke('desktop_permissions_open_settings', { permissionId: 'nope' })
      ).resolves.toEqual({ ok: false, error: 'unknown permission id' })
      expect(argvCalls).toHaveLength(1)
    } finally {
      rmSync(dataDir, { force: true, recursive: true })
    }
  })

  test('accepts an ephemeral chat-presentation hint without exposing it as command authority', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-shell-commands-'))
    const received: Array<string | undefined> = []
    try {
      const invoke = createCommandSurface(dataDir, {
        onChatPresentation: (focusedSessionId) => received.push(focusedSessionId),
      })
      expect(invoke('desktop_chat_presentation', { focusedSessionId: 'session-1' })).toEqual({
        ok: true,
        value: null,
      })
      expect(invoke('desktop_chat_presentation', { focusedSessionId: 'x'.repeat(129) })).toEqual({
        ok: true,
        value: null,
      })
      expect(invoke('desktop_chat_presentation', { focusedSessionId: '' })).toEqual({
        ok: true,
        value: null,
      })
      expect(invoke('desktop_chat_presentation', { focusedSessionId: 42 })).toEqual({
        ok: true,
        value: null,
      })
      expect(received).toEqual(['session-1', undefined, undefined, undefined])
    } finally {
      rmSync(dataDir, { force: true, recursive: true })
    }
  })

  test('reports the packaged app version instead of a placeholder', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-shell-commands-'))
    try {
      const invoke = createCommandSurface(dataDir)
      const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8'))
      expect(invoke('adea_app_version')).toEqual({ ok: true, value: manifest.version })
    } finally {
      rmSync(dataDir, { force: true, recursive: true })
    }
  })

  test('compares the running version against the signed update feed', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-shell-commands-'))
    const original = globalThis.fetch
    try {
      const invoke = createCommandSurface(dataDir)
      const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8'))
      const bumped = bumpPatch(manifest.version)
      // A well-formed feed entry (the shell validates the manifest before it
      // ever considers the GitHub API fallback).
      globalThis.fetch = (async () =>
        Response.json({
          version: bumped,
          platform: process.platform,
          arch: process.arch,
          url: `https://github.com/adea-ai/adea/releases/download/v${bumped}/Adea-v${bumped}-macos-arm64.app.tar.zst`,
          sha256: 'a'.repeat(64),
          signature: 'c2ln',
          notes: 'A release',
          publishedAt: '2026-09-13T00:00:00Z',
        })) as typeof fetch
      const available = (await invoke('desktop_update_check')) as {
        ok: true
        value: Record<string, unknown>
      }
      expect(available.ok).toBe(true)
      expect(available.value).toMatchObject({
        available_version: bumped,
        current_version: manifest.version,
        github_url: `https://github.com/adea-ai/adea/releases/tag/v${bumped}`,
        phase: 'available',
        restart_required: false,
      })

      globalThis.fetch = (async () =>
        Response.json({
          version: manifest.version,
          platform: process.platform,
          arch: process.arch,
          url: 'https://github.com/adea-ai/adea/releases/download/v0/Adea.app.tar.zst',
          sha256: 'a'.repeat(64),
          signature: 'c2ln',
        })) as typeof fetch
      const current = (await invoke('desktop_update_check')) as {
        ok: true
        value: Record<string, unknown>
      }
      expect(current.value).toMatchObject({
        available_version: null,
        current_version: manifest.version,
        phase: 'current',
      })
    } finally {
      globalThis.fetch = original
      rmSync(dataDir, { force: true, recursive: true })
    }
  })

  test('reports an explicit failed phase when the update feed is unreachable', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-shell-commands-'))
    const original = globalThis.fetch
    try {
      globalThis.fetch = (async () => {
        throw new Error('offline')
      }) as typeof fetch
      const invoke = createCommandSurface(dataDir)
      const failed = (await invoke('desktop_update_status')) as {
        ok: true
        value: Record<string, unknown>
      }
      expect(failed.value).toMatchObject({
        available_version: null,
        error: 'offline',
        phase: 'failed',
      })
    } finally {
      globalThis.fetch = original
      rmSync(dataDir, { force: true, recursive: true })
    }
  })

  test('uses a generic failure message for unreadable update errors', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-shell-commands-'))
    const original = globalThis.fetch
    try {
      globalThis.fetch = (async () => {
        throw { message: '[object Object]', token: 'must not reach the UI' }
      }) as typeof fetch
      const invoke = createCommandSurface(dataDir)
      const failed = (await invoke('desktop_update_status')) as {
        ok: true
        value: Record<string, unknown>
      }
      expect(failed.value).toMatchObject({
        error: 'The update failed. Please try again.',
        phase: 'failed',
      })
      expect(JSON.stringify(failed.value)).not.toContain('must not reach the UI')
    } finally {
      globalThis.fetch = original
      rmSync(dataDir, { force: true, recursive: true })
    }
  })

  test('keeps the archive path invisible until the download is complete', async () => {
    // The extractor reads this path as soon as the download returns; a writer
    // that streams straight into it can hand over a partially flushed file,
    // which surfaces to the user as "the downloaded update archive could not
    // be extracted". The scratch name must be the only one on disk mid-stream.
    const workDir = mkdtempSync(join(tmpdir(), 'adea-update-download-'))
    const payload = new TextEncoder().encode('archive-bytes')
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(payload),
    })
    const destination = join(workDir, 'Adea-test-update.tar.zst')
    const seenDuringStream: boolean[] = []
    try {
      const result = await downloadUpdateArchive(
        `http://127.0.0.1:${server.port}/archive`,
        destination,
        { onProgress: () => seenDuringStream.push(existsSync(destination)) }
      )
      expect(result.sha256).toBe(createHash('sha256').update(payload).digest('hex'))
      expect(result.bytes).toBe(payload.byteLength)
      expect(seenDuringStream.length).toBeGreaterThan(0)
      expect(seenDuringStream.some(Boolean)).toBe(false)
      expect(readFileSync(destination)).toEqual(Buffer.from(payload))
      expect(existsSync(`${destination}.partial`)).toBe(false)
    } finally {
      void server.stop(true)
      rmSync(workDir, { force: true, recursive: true })
    }
  })

  test('fails the install with a reported reason instead of a silent no-op', async () => {
    // End-to-end shape of the reported bug: the feed offers an update, the
    // transfer is rejected, and the client must receive a `failed` phase
    // carrying the reason — a payload the dialog can render. The precise
    // failure (checksum / extraction / apply) depends on how the transfer is
    // corrupt; what the user must never get is a status that looks unchanged.
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-shell-commands-'))
    const original = globalThis.fetch
    try {
      const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8'))
      const bumped = bumpPatch(manifest.version)
      let fetchCount = 0
      const transferFailure = 'the update download was rejected safely'
      globalThis.fetch = (async () => {
        if (fetchCount++ > 0) throw { safe: { message: transferFailure } }
        const archive = new TextEncoder().encode('not a tar archive')
        return Response.json({
          version: bumped,
          platform: process.platform,
          arch: process.arch,
          url: `https://github.com/adea-ai/adea/releases/download/v${bumped}/Adea-v${bumped}-macos-arm64.app.tar.zst`,
          sha256: createHash('sha256').update(archive).digest('hex'),
          signature: 'c2ln',
          notes: null,
          publishedAt: '2026-09-14T00:00:00Z',
        })
      }) as typeof fetch
      const invoke = createCommandSurface(dataDir)
      const checked = (await invoke('desktop_update_check')) as { ok: true; value: unknown }
      expect(checked.value).toMatchObject({ phase: 'available', available_version: bumped })

      const installed = (await invoke('desktop_update_install', {
        approved: true,
        expectedVersion: bumped,
        restart: false,
      })) as { ok: true; value: Record<string, unknown> }
      expect(installed.value.phase).toBe('failed')
      expect(installed.value.error).toBe(transferFailure)
    } finally {
      globalThis.fetch = original
      rmSync(dataDir, { force: true, recursive: true })
    }
  })

  test('ignores update errors with an unreadable message getter', () => {
    const error = new Error('placeholder')
    Object.defineProperty(error, 'message', {
      configurable: true,
      get() {
        throw { safe: { message: 'unreadable error details' } }
      },
    })

    let message: string | undefined
    expect(() => {
      message = updateErrorMessage(error)
    }).not.toThrow()
    expect(message).toBeUndefined()
  })

  test('rejects a truncated archive unless it is the extracted bundle', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'adea-update-extract-'))
    try {
      const archivePath = join(workDir, 'broken.tar.zst')
      Bun.write(archivePath, new TextEncoder().encode('not zstd'))
      await expect(extractUpdateArchive(archivePath, join(workDir, 'out'))).rejects.toThrow(
        /could not be (?:de)?compressed/
      )
    } finally {
      rmSync(workDir, { force: true, recursive: true })
    }
  })

  test('extracts zstd archives without relying on a PATH zstd program', async () => {
    // macOS bsdtar implements `--zstd` by executing an external `zstd`
    // program, which the launchd PATH of a Dock-launched app does not
    // contain — updates could never extract on machines without a Homebrew
    // zstd. The extractor must decompress with the bundle's own zig-zstd
    // (or an explicit zstd) and then untar the plain tar.
    const workDir = mkdtempSync(join(tmpdir(), 'adea-update-extract-'))
    try {
      const payloadDir = join(workDir, 'Adea.app', 'Contents', 'Resources', 'app')
      mkdirSync(join(workDir, 'Adea.app', 'Contents', 'MacOS'), { recursive: true })
      mkdirSync(join(workDir, 'Adea.app', 'Contents', 'Resources'), { recursive: true })
      writeFileSync(join(workDir, 'Adea.app', 'Contents', 'MacOS', 'launcher'), '')
      writeFileSync(
        join(workDir, 'Adea.app', 'Contents', 'Resources', 'main.js'),
        'process.exit(0)'
      )
      mkdirSync(payloadDir, { recursive: true })
      writeFileSync(join(payloadDir, 'index.js'), 'export {}')
      const tarPath = join(workDir, 'archive.tar')
      // Fixture builders degrade like the rg probe does: a missing tar or
      // zstd on a restricted PATH skips the round-trip assertion (Bun
      // spawnSync throws ENOENT instead of returning a nonzero exit) while
      // the strategy pinning below stays asserted on every lane.
      let tarOk = false
      try {
        tarOk =
          Bun.spawnSync(['tar', '-cf', tarPath, '-C', workDir, 'Adea.app'], {
            stderr: 'pipe',
          }).exitCode === 0
      } catch {
        tarOk = false
      }
      const archivePath = join(workDir, 'archive.tar.zst')
      let roundTrip = false
      if (tarOk) {
        try {
          roundTrip =
            Bun.spawnSync(['zstd', '-f', tarPath, '-o', archivePath], {
              stderr: 'pipe',
            }).exitCode === 0
        } catch {
          roundTrip = false
        }
      }
      if (!roundTrip) {
        // The suite pins the strategy below; decompression itself is
        // exercised wherever a zstd implementation exists (dev and CI do).
        console.warn('no zstd on PATH; skipping the round-trip assertion')
      } else {
        const out = await extractUpdateArchive(archivePath, join(workDir, 'out'))
        expect(out).toBe(join(workDir, 'out', 'Adea.app'))
      }
      // The bundle-relative tool is the mechanism, not a PATH lookup.
      const source = readFileSync(join(import.meta.dir, '../shell/src/updater.ts'), 'utf8')
      expect(source).toContain("join(dirname(process.execPath), 'zig-zstd')")
      expect(source).not.toContain("'tar', '--zstd'")
    } finally {
      rmSync(workDir, { force: true, recursive: true })
    }
  })
})

function bumpPatch(version: string): string {
  const [major = '0', minor = '0', patch = '0'] = version.replace(/^v/, '').split('.')
  return `${major}.${minor}.${Number(patch) + 1}`
}
