// macOS permission probes (issue #471): the registry's outcome mapping, the
// fixed-argv discipline, the settings deep-link table, and the two bridge
// commands, all against scripted runners — the host is never probed in tests
// and no fixture status can reach a production path (Dev Runtime spec,
// "macOS permissions onboarding").
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PROBE_TIMEOUT_MS,
  SETTINGS_PANES,
  createHostCommandRunner,
  createMacPermissionService,
  type HostCommandOutcome,
  type HostCommandRunner,
} from '../shell/src/desktop-permissions'
import { createCommandSurface } from '../shell/src/commands'
import { macPermissionIds } from '../../../packages/types/src/desktop-permissions'

function outcome(patch: Partial<HostCommandOutcome>): HostCommandOutcome {
  return { exitCode: 0, stdout: '', stderr: '', timedOut: false, spawnFailed: false, ...patch }
}

/** A runner that replays scripted outcomes in order and records every argv. */
function scriptedRunner(script: HostCommandOutcome[]): {
  run: HostCommandRunner
  argvCalls: readonly (readonly string[])[]
} {
  const argvCalls: string[][] = []
  return {
    argvCalls,
    run: async (argv) => {
      argvCalls.push([...argv])
      return script[argvCalls.length - 1] ?? outcome({})
    },
  }
}

const ACCESSIBILITY_ARGV = [
  '/usr/bin/osascript',
  '-e',
  'tell application "System Events" to count processes',
]
const AUTOMATION_ARGV = ['/usr/bin/osascript', '-e', 'tell application "Finder" to get name']

function stateFor(service: ReturnType<typeof createMacPermissionService>, id: string) {
  return service.snapshot({ force: true }).then((snapshot) => {
    const report = snapshot.permissions.find((entry) => entry.id === id)
    if (!report) throw new Error(`missing report for ${id}`)
    return report
  })
}

describe('macOS permission probes', () => {
  test('probes exactly the permissions this lane supports, with fixed argv', async () => {
    const runner = scriptedRunner([outcome({}), outcome({}), outcome({})])
    const service = createMacPermissionService({
      run: runner.run,
      platform: 'darwin',
      now: () => '2026-01-01T00:00:00.000Z',
    })
    const snapshot = await service.snapshot({ force: true })

    expect(snapshot.hostPlatform).toBe('macos')
    expect(snapshot.permissions.map((report) => report.id)).toEqual([...macPermissionIds])
    // Two real probes ran; the rest are typed-unavailable, never guessed.
    expect(runner.argvCalls).toEqual([ACCESSIBILITY_ARGV, AUTOMATION_ARGV])
    const byId = new Map(snapshot.permissions.map((report) => [report.id, report]))
    expect(byId.get('accessibility')?.state).toBe('granted')
    expect(byId.get('automation_apple_events')?.state).toBe('granted')
    for (const id of ['screen_recording', 'notifications', 'microphone'] as const) {
      const report = byId.get(id)
      expect(report?.state).toBe('unavailable')
      expect(report?.unavailableReason).toBe('capability_unavailable')
    }
  })

  test('classifies the assistive-access refusal as denied', async () => {
    const runner = scriptedRunner([
      outcome({
        exitCode: 1,
        stderr: '32:67: execution error: osascript is not allowed assistive access. (-25211)',
      }),
      outcome({}),
    ])
    const service = createMacPermissionService({ run: runner.run, platform: 'darwin' })
    const report = await stateFor(service, 'accessibility')
    expect(report.state).toBe('denied')
  })

  test('maps a probe killed at the deadline to not_determined (prompt pending)', async () => {
    const runner = scriptedRunner([
      outcome({ exitCode: null, timedOut: true }),
      outcome({ exitCode: null, timedOut: true }),
    ])
    const service = createMacPermissionService({ run: runner.run, platform: 'darwin' })
    const snapshot = await service.snapshot({ force: true })
    const byId = new Map(snapshot.permissions.map((entry) => [entry.id, entry]))
    expect(byId.get('accessibility')?.state).toBe('not_determined')
    expect(byId.get('automation_apple_events')?.state).toBe('not_determined')
  })

  test('classifies the Apple Events refusal as denied', async () => {
    const runner = scriptedRunner([
      outcome({}),
      outcome({
        exitCode: 1,
        stderr: 'execution error: Not authorized to send Apple events. (-1743)',
      }),
    ])
    const service = createMacPermissionService({ run: runner.run, platform: 'darwin' })
    const report = await stateFor(service, 'automation_apple_events')
    expect(report.state).toBe('denied')
  })

  test('an unrelated probe failure is typed capability_unavailable, never denied', async () => {
    const runner = scriptedRunner([
      outcome({ exitCode: 1, stderr: 'kern.osrundeps failed' }),
      outcome({ spawnFailed: true, exitCode: null }),
    ])
    const service = createMacPermissionService({ run: runner.run, platform: 'darwin' })
    const snapshot = await service.snapshot({ force: true })
    const byId = new Map(snapshot.permissions.map((report) => [report.id, report]))
    expect(byId.get('accessibility')?.state).toBe('unavailable')
    expect(byId.get('accessibility')?.unavailableReason).toBe('capability_unavailable')
    expect(byId.get('automation_apple_events')?.state).toBe('unavailable')
  })

  test('a non-macOS host reports every permission unsupported_platform, probing nothing', async () => {
    const runner = scriptedRunner([])
    const service = createMacPermissionService({ run: runner.run, platform: 'linux' })
    const snapshot = await service.snapshot({ force: true })
    expect(snapshot.hostPlatform).toBe('other')
    expect(runner.argvCalls).toEqual([])
    expect(snapshot.permissions.every((report) => report.state === 'unavailable')).toBe(true)
    expect(
      snapshot.permissions.every((report) => report.unavailableReason === 'unsupported_platform')
    ).toBe(true)
  })

  test('idle snapshots are single-flight; force re-runs the probe set', async () => {
    let calls = 0
    const service = createMacPermissionService({
      run: async () => {
        calls += 1
        return outcome({})
      },
      platform: 'darwin',
    })
    const first = service.snapshot()
    const second = service.snapshot()
    expect(await first).toBe(await second)
    expect(calls).toBe(2) // one per probed permission, not four
    await service.snapshot({ force: true })
    expect(calls).toBe(4)
  })

  test('openSettings opens only the fixed pane registered for a known id', async () => {
    const runner = scriptedRunner([outcome({})])
    const service = createMacPermissionService({ run: runner.run, platform: 'darwin' })
    const result = await service.openSettings('accessibility')
    expect(runner.argvCalls).toEqual([['/usr/bin/open', SETTINGS_PANES.accessibility]])
    expect(result).toEqual({
      permissionId: 'accessibility',
      settingsUrl: SETTINGS_PANES.accessibility,
    })
    expect(service.settingsUrl('screen_recording')).toBe(SETTINGS_PANES.screen_recording)
  })

  test('openSettings rejects unknown ids and opener failures without opening anything', async () => {
    const runner = scriptedRunner([outcome({ exitCode: 1, stderr: 'No application' })])
    const service = createMacPermissionService({ run: runner.run, platform: 'darwin' })
    expect(() => service.settingsUrl('terminal_computer_use')).toThrow('unknown permission id')
    await service.openSettings('terminal_computer_use').then(
      () => expect.unreachable(),
      (error: unknown) => expect(String(error)).toContain('unknown permission id')
    )
    await service.openSettings('accessibility').then(
      () => expect.unreachable(),
      (error: unknown) => expect(String(error)).toContain('could not open System Settings')
    )
    expect(runner.argvCalls.length).toBe(1)
  })

  test('every registered permission has a fixed deep link and probes declare a deadline', () => {
    expect(SETTINGS_PANES.accessibility).toBe(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
    )
    expect(SETTINGS_PANES.screen_recording).toBe(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    )
    expect(SETTINGS_PANES.notifications).toBe(
      'x-apple.systempreferences:com.apple.preference.notifications'
    )
    expect(SETTINGS_PANES.automation_apple_events).toBe(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation'
    )
    expect(SETTINGS_PANES.microphone).toBe(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
    )
    expect(PROBE_TIMEOUT_MS).toBeGreaterThan(0)
  })

  test('the production runner kills a hung probe at the deadline', async () => {
    // A real `sleep` proves the deadline is enforced end-to-end in this lane.
    const runner = createHostCommandRunner({ timeoutMs: 250 })
    const started = Date.now()
    const hung = await runner(['/bin/sleep', '30'])
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(hung.timedOut).toBe(true)
    const quick = await runner(['/bin/echo', 'ok'])
    expect(quick).toMatchObject({ exitCode: 0, spawnFailed: false })
    expect(quick.stdout.trim()).toBe('ok')
  }, 15_000)
})

describe('desktop shell permission commands', () => {
  test('desktop_permissions_snapshot surfaces the injected service through the bridge', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-shell-permissions-'))
    try {
      const calls: (boolean | undefined)[] = []
      const invoke = createCommandSurface(dataDir, {
        macPermissions: {
          snapshot: async (options) => {
            calls.push(options?.force)
            return {
              hostPlatform: 'macos',
              permissions: macPermissionIds.map((id) => ({
                id,
                state: 'unavailable' as const,
                unavailableReason: 'capability_unavailable' as const,
                probedAt: '2026-01-01T00:00:00.000Z',
              })),
              probedAt: '2026-01-01T00:00:00.000Z',
            }
          },
          openSettings: async () => {
            throw new Error('not expected in this test')
          },
          settingsUrl: () => '',
        },
      })
      const snapshot = await invoke('desktop_permissions_snapshot', {})
      expect(snapshot).toEqual({
        ok: true,
        value: expect.objectContaining({ hostPlatform: 'macos' }),
      })
      expect(calls).toEqual([false])
      await invoke('desktop_permissions_snapshot', { force: true })
      expect(calls).toEqual([false, true])
    } finally {
      rmSync(dataDir, { force: true, recursive: true })
    }
  })

  test('desktop_permissions_open_settings resolves through the service; failures degrade', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-shell-permissions-'))
    try {
      const requested: string[] = []
      const invoke = createCommandSurface(dataDir, {
        macPermissions: {
          snapshot: async () => {
            throw new Error('not expected in this test')
          },
          openSettings: async (permissionId) => {
            requested.push(permissionId)
            if (permissionId === 'broken') throw new Error('opener failed')
            return { permissionId: 'accessibility', settingsUrl: 'x-apple.systempreferences:test' }
          },
          settingsUrl: () => 'x-apple.systempreferences:test',
        },
      })
      await expect(
        invoke('desktop_permissions_open_settings', { permissionId: 'accessibility' })
      ).resolves.toEqual({
        ok: true,
        value: { permissionId: 'accessibility', settingsUrl: 'x-apple.systempreferences:test' },
      })
      await expect(
        invoke('desktop_permissions_open_settings', { permissionId: 'broken' })
      ).resolves.toEqual({ ok: false, error: 'opener failed' })
      expect(requested).toEqual(['accessibility', 'broken'])
    } finally {
      rmSync(dataDir, { force: true, recursive: true })
    }
  })

  test('the commands are registered on the default surface with production probes', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-shell-permissions-'))
    try {
      const invoke = createCommandSurface(dataDir)
      // Production composition probes the real host, so this test never calls
      // snapshot (no consent prompt during test runs); it only proves the
      // default surface wires the service by refusing an unknown id without
      // opening anything. openSettings is async, so its refusal resolves.
      await expect(
        invoke('desktop_permissions_open_settings', { permissionId: 'nope' })
      ).resolves.toEqual({ ok: false, error: 'unknown permission id' })
    } finally {
      rmSync(dataDir, { force: true, recursive: true })
    }
  })
})
