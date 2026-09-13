// The shell's command registry is the whole desktop surface: a name the client
// calls but this registry does not know fails at runtime. The per-command
// contract tests live in `scripts/desktop-*.test.ts`; this keeps the registry
// exercised from the desktop lane it belongs to.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCommandSurface } from '../shell/src/commands'

describe('desktop shell command surface', () => {
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
})

function bumpPatch(version: string): string {
  const [major = '0', minor = '0', patch = '0'] = version.replace(/^v/, '').split('.')
  return `${major}.${minor}.${Number(patch) + 1}`
}
