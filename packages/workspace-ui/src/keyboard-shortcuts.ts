export type WorkspaceShortcut = Readonly<{ label: string; keys: readonly string[] }>

export function platformModifierKey(platform?: string): '⌘' | 'Ctrl' {
  const browserPlatform = platform ?? (typeof navigator === 'undefined' ? '' : navigator.platform)
  return /Mac|iPhone|iPad|iPod/i.test(browserPlatform) ? '⌘' : 'Ctrl'
}

export function settingsShortcutLabel(platform?: string): string {
  return `${platformModifierKey(platform)},`
}

export function workspaceHelpShortcuts(platform?: string): WorkspaceShortcut[] {
  const modifier = platformModifierKey(platform)
  const alternate = modifier === '⌘' ? '⌥' : 'Alt'
  return [
    { label: 'Open search', keys: [modifier, 'K'] },
    { label: 'Open settings', keys: [modifier, ','] },
    { label: 'Search the current conversation', keys: [modifier, 'F'] },
    { label: 'Mark all conversations read', keys: [modifier, 'Shift', 'A'] },
    { label: 'Mark the current conversation unread', keys: [modifier, 'Shift', 'U'] },
    { label: 'Focus the message composer', keys: [modifier, 'Shift', 'M'] },
    { label: 'Select the next channel', keys: [alternate, '↓'] },
    { label: 'Select the previous channel', keys: [alternate, '↑'] },
  ]
}
