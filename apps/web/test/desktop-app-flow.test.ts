/*
 * Fresh-install desktop app flows.
 *
 * Three surfaces a fresh install exercises before any account exists:
 *
 * - the folder picker at the OS boundary: the renderer asks the shell for a
 *   native folder and the typed path stays the fallback whenever the shell
 *   cannot answer;
 * - the runtime detection that decides whether the desktop-only surfaces are
 *   offered at all;
 * - the App Library preference persistence a fresh profile starts from, and
 *   what the recorded preferences mean for the destinations that resolve.
 *
 * The OS boundary is mocked: the shell is the injected `window.__adeaDesktop`
 * bridge, and the App Library record is the profile-local storage the renderer
 * owns. No native app, no keychain prompt, no browser and no account are
 * involved.
 */
import { afterEach, describe, expect, test } from 'bun:test'

import {
  defaultRailPreferences,
  readRailPreferences,
  writeRailPreferences,
} from '@adea-ai/workspace-ui/rail-preferences'
import {
  enabledWorkspaceApps,
  resolveWorkspaceApp,
  setWorkspaceAppEnabled,
} from '@adea-ai/workspace-ui/workspace-apps'

import { isDesktopRuntime, pickDesktopFolder, type DesktopShell } from '../src/lib/desktop-bridge'

const originalWindow = (globalThis as { window?: unknown }).window

afterEach(() => {
  ;(globalThis as { window?: unknown }).window = originalWindow
})

/** The shell bridge, as the desktop shell injects it before the client boots. */
function installShell(invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>) {
  const commands: string[] = []
  const bridge = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      commands.push(cmd)
      return invoke(cmd, args)
    },
    listen: async () => () => undefined,
  } as unknown as DesktopShell
  ;(globalThis as { window?: unknown }).window = { __adeaDesktop: bridge }
  return { commands }
}

/** A window without a shell bridge: the web lane, or a shell that has not injected one. */
function installWindowWithoutShell() {
  ;(globalThis as { window?: unknown }).window = {}
}

/** No window at all: a server-rendered surface. */
function installNoWindow() {
  ;(globalThis as { window?: unknown }).window = undefined
}

/** The profile-local storage a renderer owns, as a byte map the App Library writes into. */
function profileStorage(bytes: Map<string, string> = new Map()) {
  return {
    bytes,
    storage: {
      getItem: (key: string) => bytes.get(key) ?? null,
      setItem: (key: string, value: string) => void bytes.set(key, value),
    },
  }
}

describe('desktop folder flow', () => {
  test('a picked folder reaches the flow through the native picker command', async () => {
    const { commands } = installShell(async () => ({
      paths: ['/Users/me/Developer/project'],
    }))

    expect(await pickDesktopFolder()).toBe('/Users/me/Developer/project')
    expect(commands).toEqual(['desktop_folder_pick'])
  })

  test('the shell disables multiple selection, so the renderer takes the first path', async () => {
    installShell(async () => ({ paths: ['/first', '/second'] }))

    expect(await pickDesktopFolder()).toBe('/first')
  })

  test('a cancelled pick resolves null and leaves the typed path as the fallback', async () => {
    installShell(async () => ({ paths: [] }))

    expect(await pickDesktopFolder()).toBeNull()
  })

  test('a shell without a native picker resolves null', async () => {
    installShell(async () => {
      throw new Error('folder_picker_unavailable')
    })

    expect(await pickDesktopFolder()).toBeNull()
  })

  test('a shell that predates the command resolves null', async () => {
    installShell(async () => {
      throw new Error('unknown command: desktop_folder_pick')
    })

    expect(await pickDesktopFolder()).toBeNull()
  })

  test('an empty or non-string path resolves null', async () => {
    installShell(async () => ({ paths: [''] }))
    expect(await pickDesktopFolder()).toBeNull()

    installShell(async () => ({ paths: [42] }))
    expect(await pickDesktopFolder()).toBeNull()
  })

  test('a missing shell bridge resolves null instead of rejecting', async () => {
    // The picker is documented to resolve null whenever the shell cannot answer, so
    // the typed path stays the fallback. A shell whose bridge has not been injected
    // yet is that case: it must fail closed, not reject into the flow.
    installWindowWithoutShell()
    expect(await pickDesktopFolder()).toBeNull()

    installNoWindow()
    expect(await pickDesktopFolder()).toBeNull()
  })
})

describe('desktop runtime detection', () => {
  test('the desktop surfaces are offered only when the shell bridge is injected', () => {
    installShell(async () => ({}))
    expect(isDesktopRuntime()).toBe(true)

    installWindowWithoutShell()
    expect(isDesktopRuntime()).toBe(false)

    installNoWindow()
    expect(isDesktopRuntime()).toBe(false)
  })
})

describe('fresh-install App Library preference persistence', () => {
  test('a fresh profile has no record and resolves the default destinations', () => {
    const { storage } = profileStorage()

    const preferences = readRailPreferences(storage)

    expect(preferences).toEqual(defaultRailPreferences)
    expect(enabledWorkspaceApps(preferences).map((app) => app.id)).toEqual(['chat', 'dev'])
    // A destination the profile never enabled resolves to the default surface
    // instead of leaving the App Library without a destination.
    expect(resolveWorkspaceApp(preferences, 'chat')?.id).toBe('chat')
    expect(resolveWorkspaceApp(preferences, 'kanban')?.id).toBe('chat')
  })

  test('a profile without any storage degrades to the default destinations', () => {
    expect(readRailPreferences(undefined)).toEqual(defaultRailPreferences)
    expect(resolveWorkspaceApp(readRailPreferences(undefined), 'dev')?.id).toBe('dev')
  })

  test('the recorded preferences survive a relaunch and decide the destinations', () => {
    const { bytes, storage } = profileStorage()

    writeRailPreferences(storage, setWorkspaceAppEnabled(defaultRailPreferences, 'dev', false))

    // A relaunch: a new profile over the same persisted bytes.
    const relaunched = profileStorage(bytes)
    const preferences = readRailPreferences(relaunched.storage)

    expect(preferences.hidden).toEqual(['dev'])
    expect(enabledWorkspaceApps(preferences).map((app) => app.id)).toEqual(['chat'])
    // The hidden destination is still reachable through the App Library: the request
    // resolves to an enabled surface instead of leaving the flow without one.
    expect(resolveWorkspaceApp(preferences, 'dev')?.id).toBe('chat')
    expect(resolveWorkspaceApp(preferences, 'chat')?.id).toBe('chat')
  })

  test('a profile whose storage is denied keeps the default destinations', () => {
    const denied = {
      getItem: () => {
        throw new Error('storage denied')
      },
      setItem: () => {
        throw new Error('storage denied')
      },
    }

    expect(readRailPreferences(denied)).toEqual(defaultRailPreferences)
    expect(() => writeRailPreferences(denied, defaultRailPreferences)).not.toThrow()
    expect(resolveWorkspaceApp(defaultRailPreferences, 'chat')?.id).toBe('chat')
  })
})
