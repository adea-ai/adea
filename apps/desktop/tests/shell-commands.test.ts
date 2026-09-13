// The shell's command registry is the whole desktop surface: a name the client
// calls but this registry does not know fails at runtime. The per-command
// contract tests live in `scripts/desktop-*.test.ts`; this keeps the registry
// exercised from the desktop lane it belongs to.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
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
})
