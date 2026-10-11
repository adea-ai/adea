import { describe, expect, test } from 'bun:test'

import {
  createUpdateDialogAdapter,
  type SharedDesktopUpdate,
  type VersionDialogAdapter,
} from '../src/internal/version-dialog-adapter'

const availableUpdate: SharedDesktopUpdate = {
  available_version: '0.62.0',
  changelog: '## Current release',
  current_version: '0.61.7',
  downloaded_bytes: 4096,
  error: null,
  github_url: 'https://github.com/adea-ai/adea/releases/tag/v0.62.0',
  phase: 'available',
  release_date: '2026-09-27T10:15:00Z',
  release_notes: '## New release',
  restart_required: false,
  total_bytes: 8192,
}

describe('VersionDialog update adapter', () => {
  test('maps the complete native update snapshot to the published UI contract', async () => {
    const calls: string[] = []
    const nativeAdapter: VersionDialogAdapter = {
      check: async () => {
        calls.push('check')
        return availableUpdate
      },
      getStatus: async () => {
        calls.push('status')
        return availableUpdate
      },
      install: async (expectedVersion) => {
        calls.push(`install:${expectedVersion}`)
        return {
          ...availableUpdate,
          available_version: null,
          current_version: '0.62.0',
          downloaded_bytes: 8192,
          error: 'signature verification failed',
          phase: 'failed',
          restart_required: false,
          total_bytes: 8192,
        }
      },
      isDesktopRuntime: () => true,
      pollIntervalMs: 500,
    }

    const adapter = createUpdateDialogAdapter(() => nativeAdapter)

    expect(adapter.isDesktopRuntime()).toBe(true)
    expect(adapter.pollIntervalMs).toBe(500)
    expect(await adapter.getStatus()).toEqual({
      availableVersion: '0.62.0',
      changelog: '## Current release',
      currentVersion: '0.61.7',
      downloadedBytes: 4096,
      error: null,
      phase: 'available',
      releaseDate: '2026-09-27T10:15:00Z',
      releaseNotes: '## New release',
      releaseUrl: 'https://github.com/adea-ai/adea/releases/tag/v0.62.0',
      restartRequired: false,
      totalBytes: 8192,
    })
    expect(await adapter.check()).toMatchObject({ phase: 'available', currentVersion: '0.61.7' })
    expect(await adapter.install('0.62.0')).toEqual({
      availableVersion: null,
      changelog: '## Current release',
      currentVersion: '0.62.0',
      downloadedBytes: 8192,
      error: 'signature verification failed',
      phase: 'failed',
      releaseDate: '2026-09-27T10:15:00Z',
      releaseNotes: '## New release',
      releaseUrl: 'https://github.com/adea-ai/adea/releases/tag/v0.62.0',
      restartRequired: false,
      totalBytes: 8192,
    })
    expect(calls).toEqual(['status', 'check', 'install:0.62.0'])
  })

  test('forwards native release links and their failures', async () => {
    const opened: string[] = []
    const nativeAdapter: VersionDialogAdapter = {
      check: async () => availableUpdate,
      getStatus: async () => availableUpdate,
      install: async () => availableUpdate,
      isDesktopRuntime: () => true,
      openExternal: async (url) => {
        opened.push(url)
      },
    }
    const adapter = createUpdateDialogAdapter(() => nativeAdapter)

    await adapter.openExternal?.(availableUpdate.github_url)
    expect(opened).toEqual([availableUpdate.github_url])

    const failure = new Error('native browser unavailable')
    const failingAdapter = createUpdateDialogAdapter(() => ({
      ...nativeAdapter,
      openExternal: async () => {
        throw failure
      },
    }))
    await expect(failingAdapter.openExternal?.(availableUpdate.github_url)).rejects.toBe(failure)
  })

  test('leaves external opening optional for legacy adapters', () => {
    const nativeAdapter: VersionDialogAdapter = {
      check: async () => availableUpdate,
      getStatus: async () => availableUpdate,
      install: async () => availableUpdate,
      isDesktopRuntime: () => false,
    }

    expect(createUpdateDialogAdapter(() => nativeAdapter).openExternal).toBeUndefined()
  })
})
