import { expect, test } from 'bun:test'

import {
  platformModifierKey,
  settingsShortcutLabel,
  workspaceHelpShortcuts,
} from '../../src/keyboard-shortcuts'

test('settings and help shortcuts match the active operating system modifier', () => {
  expect(settingsShortcutLabel('MacIntel')).toBe('⌘,')
  expect(settingsShortcutLabel('Win32')).toBe('Ctrl,')

  const macShortcuts = workspaceHelpShortcuts('MacIntel')
  const windowsShortcuts = workspaceHelpShortcuts('Win32')
  expect(macShortcuts.find(({ label }) => label === 'Open settings')?.keys).toEqual(['⌘', ','])
  expect(windowsShortcuts.find(({ label }) => label === 'Open settings')?.keys).toEqual([
    'Ctrl',
    ',',
  ])
  expect(platformModifierKey('Linux x86_64')).toBe('Ctrl')
})

test('help lists only shortcuts that the workspace shell registers', () => {
  expect(workspaceHelpShortcuts('MacIntel').map(({ label }) => label)).toEqual([
    'Open search',
    'Open settings',
    'Search the current conversation',
    'Mark all conversations read',
    'Mark the current conversation unread',
    'Focus the message composer',
    'Select the next channel',
    'Select the previous channel',
  ])
})
