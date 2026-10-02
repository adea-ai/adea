import { describe, expect, test } from 'bun:test'

import {
  SYNTHETIC_DOWNLOAD_CAP,
  SYNTHETIC_DOWNLOAD_TOTAL_BYTES,
  withSyntheticDownloadProgress,
  type DesktopUpdateSurface,
} from '../src/lib/desktop-update-progress'
import type { DesktopUpdate } from '../src/lib/desktop-update'

function snapshot(overrides: Partial<DesktopUpdate> = {}): DesktopUpdate {
  return {
    current_version: '1.0.0',
    available_version: '9.9.9',
    release_date: null,
    release_notes: null,
    changelog: '',
    github_url: 'https://github.com/adea-ai/adea/releases',
    phase: 'downloading',
    downloaded_bytes: 0,
    total_bytes: null,
    error: null,
    restart_required: false,
    ...overrides,
  }
}

/** Fake updater: answers from a mutable script, records getStatus reads. Its
 * install stays in flight until `settleInstall` is called, like a real one. */
function fakeUpdater(state: { update: DesktopUpdate }) {
  const reads: DesktopUpdate[] = []
  const installs: string[] = []
  let releaseInstall: ((update: DesktopUpdate) => void) | undefined
  const surface: DesktopUpdateSurface = {
    check: async () => state.update,
    getStatus: async () => {
      reads.push(state.update)
      return state.update
    },
    install: (expectedVersion) =>
      new Promise<DesktopUpdate>((resolve) => {
        installs.push(expectedVersion)
        releaseInstall = (update) => {
          state.update = update
          resolve(update)
        }
      }),
  }
  return {
    surface,
    reads,
    installs,
    settleInstall(update: DesktopUpdate) {
      releaseInstall?.(update)
    },
  }
}

describe('the synthetic download progress wrapper', () => {
  test('statuses outside a live install pass through untouched', async () => {
    const state = { update: snapshot({ phase: 'current', available_version: null }) }
    const updater = fakeUpdater(state)
    const wrapped = withSyntheticDownloadProgress(updater.surface, { now: () => 0 })
    const status = await wrapped.getStatus()
    expect(status.phase).toBe('current')
    expect(status.total_bytes).toBeNull()
    expect(updater.reads).toHaveLength(1)
  })

  test('an in-flight download advances along the curve and never regresses', async () => {
    const state = { update: snapshot() }
    const updater = fakeUpdater(state)
    let clock = 0
    const wrapped = withSyntheticDownloadProgress(updater.surface, { now: () => clock })

    const install = wrapped.install('9.9.9')
    const seen: number[] = []
    for (let step = 0; step < 12; step += 1) {
      clock += 1000
      const status = await wrapped.getStatus()
      expect(status.phase).toBe('downloading')
      expect(status.total_bytes).toBe(SYNTHETIC_DOWNLOAD_TOTAL_BYTES)
      const previous = seen.at(-1) ?? 0
      expect(status.downloaded_bytes).toBeGreaterThanOrEqual(previous)
      seen.push(status.downloaded_bytes)
    }
    // The curve visibly moves and stays below completion on its own.
    expect(seen[0]).toBeGreaterThan(0)
    expect(seen.at(-1)! / SYNTHETIC_DOWNLOAD_TOTAL_BYTES).toBeLessThanOrEqual(
      SYNTHETIC_DOWNLOAD_CAP
    )

    state.update = snapshot({ phase: 'installing' })
    clock += 1000
    expect((await wrapped.getStatus()).phase).toBe('installing')
    updater.settleInstall(snapshot({ phase: 'installed', restart_required: true }))
    expect(await install).toMatchObject({ phase: 'installed' })
    expect(updater.installs).toEqual(['9.9.9'])
    // After the install settles the wrapper stops posing entirely.
    state.update = snapshot({ phase: 'available' })
    clock += 1000
    expect((await wrapped.getStatus()).total_bytes).toBeNull()
  })

  test('real streaming progress takes over once it reaches the shown fraction', async () => {
    const state = { update: snapshot() }
    const updater = fakeUpdater(state)
    let clock = 0
    const wrapped = withSyntheticDownloadProgress(updater.surface, { now: () => clock })

    const install = wrapped.install('9.9.9')
    clock += 12_000 // about halfway along the curve
    const midway = await wrapped.getStatus()
    expect(midway.downloaded_bytes).toBeGreaterThan(0)

    // The real updater reports genuine bytes — but behind the shown fraction,
    // so the bar must not jump backwards to them yet.
    const realTotal = SYNTHETIC_DOWNLOAD_TOTAL_BYTES
    state.update = snapshot({ downloaded_bytes: 1000, total_bytes: realTotal })
    const behind = await wrapped.getStatus()
    expect(behind.total_bytes).toBe(SYNTHETIC_DOWNLOAD_TOTAL_BYTES)
    expect(behind.downloaded_bytes).toBeGreaterThanOrEqual(midway.downloaded_bytes)

    // Once real progress catches up, the real pair is passed through as-is.
    state.update = snapshot({
      downloaded_bytes: Math.round(realTotal * 0.99),
      total_bytes: realTotal,
    })
    const caughtUp = await wrapped.getStatus()
    expect(caughtUp.downloaded_bytes).toBe(Math.round(realTotal * 0.99))
    expect(caughtUp.total_bytes).toBe(realTotal)
    updater.settleInstall(snapshot({ phase: 'installed', restart_required: true }))
    await install
  })
})
