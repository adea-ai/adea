import { describe, expect, test } from 'bun:test'
import type { DevCommand, DevReply, Scope, ShellProfile } from '@adea-ai/types/dev-runtime'

import { listShellProfiles } from '../src/terminal/shell-profiles'
import {
  DEFAULT_TOOLBAR_PREFERENCES,
  isDefaultToolbar,
  parseToolbarPreferences,
  readToolbarPreferences,
  resetToolbar,
  resolveDefaultShellProfileId,
  setDefaultShellProfile,
  setToolbarBlocks,
  setToolbarItem,
  writeToolbarPreferences,
} from '../src/terminal/toolbar-preferences'

const ZSH = '00000000-0000-4000-8000-00000000d001'
const BASH = '00000000-0000-4000-8000-00000000d002'

function memoryStorage(initial?: string) {
  let value = initial ?? null
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next
    },
    value: () => value,
  }
}

describe('toolbar preferences', () => {
  test('default to every item visible with blocks on and no saved shell', () => {
    expect(parseToolbarPreferences(null)).toEqual(DEFAULT_TOOLBAR_PREFERENCES)
    expect(isDefaultToolbar(DEFAULT_TOOLBAR_PREFERENCES)).toBe(true)
    expect(DEFAULT_TOOLBAR_PREFERENCES.defaultShellProfileId).toBeUndefined()
  })

  test('toggle items, blocks and the default shell without mutating the input', () => {
    const hidden = setToolbarItem(DEFAULT_TOOLBAR_PREFERENCES, 'cwd', false)
    expect(hidden.items.cwd).toBe(false)
    expect(DEFAULT_TOOLBAR_PREFERENCES.items.cwd).toBe(true)
    expect(isDefaultToolbar(hidden)).toBe(false)
    expect(setToolbarBlocks(hidden, false).blocks).toBe(false)
    const saved = setDefaultShellProfile(hidden, BASH)
    expect(saved.defaultShellProfileId).toBe(BASH)
    expect(setDefaultShellProfile(saved, undefined).defaultShellProfileId).toBeUndefined()
    expect(setDefaultShellProfile(saved, 'not-a-uuid').defaultShellProfileId).toBeUndefined()
  })

  test('reset restores the layout but keeps the device default shell', () => {
    const changed = setDefaultShellProfile(
      setToolbarBlocks(setToolbarItem(DEFAULT_TOOLBAR_PREFERENCES, 'status', false), false),
      BASH
    )
    const reset = resetToolbar(changed)
    expect(isDefaultToolbar(reset)).toBe(true)
    expect(reset.defaultShellProfileId).toBe(BASH)
  })

  test('round-trip through storage and tolerate damaged values', () => {
    const storage = memoryStorage()
    const preferences = setDefaultShellProfile(
      setToolbarItem(DEFAULT_TOOLBAR_PREFERENCES, 'worktree', false),
      ZSH
    )
    writeToolbarPreferences(preferences, storage)
    expect(readToolbarPreferences(storage)).toEqual(preferences)
    for (const damaged of [
      '{',
      '[]',
      '"x"',
      '{"items":5,"blocks":"no","defaultShellProfileId":7}',
    ]) {
      expect(parseToolbarPreferences(damaged)).toEqual(DEFAULT_TOOLBAR_PREFERENCES)
    }
  })

  test('storage that throws never breaks the toolbar', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(readToolbarPreferences(blocked)).toEqual(DEFAULT_TOOLBAR_PREFERENCES)
    expect(() => writeToolbarPreferences(DEFAULT_TOOLBAR_PREFERENCES, blocked)).not.toThrow()
  })

  test('a saved shell the host no longer advertises falls back to the host default', () => {
    const profiles = [{ id: ZSH }, { id: BASH }]
    expect(resolveDefaultShellProfileId(profiles, BASH)).toBe(BASH)
    expect(resolveDefaultShellProfileId(profiles, '00000000-0000-4000-8000-00000000d00f')).toBe(
      undefined
    )
    expect(resolveDefaultShellProfileId(profiles, undefined)).toBe(undefined)
  })
})

const reply = (command: DevCommand, value: unknown): DevReply =>
  ({ ok: true, value, commandId: command.commandId }) as unknown as DevReply

describe('listShellProfiles', () => {
  const scope: Scope = {
    accountId: '00000000-0000-4000-8000-000000000001',
    workspaceId: '00000000-0000-4000-8000-000000000002',
    runtimeNodeId: '00000000-0000-4000-8000-000000000003',
  }
  const profile = { id: ZSH, label: 'zsh' } as unknown as ShellProfile
  test('returns the advertised profiles', async () => {
    const commands: DevCommand[] = []
    const profiles = await listShellProfiles({
      scope,
      execute: async (command) => {
        commands.push(command)
        return reply(command, { items: [profile] })
      },
    })
    expect(profiles).toEqual([profile])
    expect(commands[0]!.operation).toBe('dev.terminal.shellProfiles')
  })

  test('is empty on refusal, a thrown transport or an aborted read', async () => {
    expect(
      await listShellProfiles({
        scope,
        execute: async () => ({ ok: false, error: { code: 'unavailable' } }) as unknown as DevReply,
      })
    ).toEqual([])
    expect(
      await listShellProfiles({
        scope,
        execute: async () => {
          throw new Error('down')
        },
      })
    ).toEqual([])
    const controller = new AbortController()
    controller.abort()
    expect(
      await listShellProfiles({
        scope,
        signal: controller.signal,
        execute: async (command) => reply(command, { items: [profile] }),
      })
    ).toEqual([])
  })
})
