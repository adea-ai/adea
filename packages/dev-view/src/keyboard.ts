/**
 * Centrally registered Dev keyboard shortcuts. Every handler is registered on
 * one target and removed on dispose so a pane unmount can never leak global
 * listeners into terminal/editor keymaps. Shortcuts ignore editable targets.
 */
export type DevShortcutActions = {
  toggleFocusMode(): void
  /** Moves the focused center leaf relative to its reading-order neighbor. */
  moveFocusedPane(input: { step: 1 | -1; direction: 'row' | 'column' }): void
}

export function isEditableTarget(target: EventTarget | null): boolean {
  // Duck-typed so the same module runs in Bun tests without DOM globals.
  const element = target as { tagName?: unknown; isContentEditable?: unknown } | null
  if (!element || typeof element !== 'object') return false
  const tag = typeof element.tagName === 'string' ? element.tagName.toLowerCase() : ''
  return (
    tag === 'input' || tag === 'textarea' || tag === 'select' || element.isContentEditable === true
  )
}

export type DevShortcut = Readonly<{
  id: string
  test(event: KeyboardEvent): boolean
  run(event: KeyboardEvent): void
}>

export function devShortcuts(actions: DevShortcutActions): readonly DevShortcut[] {
  return [
    {
      id: 'dev.focus-mode',
      test: (event) =>
        (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey
          ? event.key.toLowerCase() === 'f'
          : false,
      run: (event) => {
        event.preventDefault()
        actions.toggleFocusMode()
      },
    },
    {
      id: 'dev.pane-move',
      test: (event) =>
        (event.metaKey || event.ctrlKey) && event.altKey && !event.shiftKey
          ? event.key.startsWith('Arrow')
          : false,
      run: (event) => {
        event.preventDefault()
        if (event.key === 'ArrowRight') actions.moveFocusedPane({ step: 1, direction: 'row' })
        else if (event.key === 'ArrowLeft') actions.moveFocusedPane({ step: -1, direction: 'row' })
        else if (event.key === 'ArrowDown')
          actions.moveFocusedPane({ step: 1, direction: 'column' })
        else if (event.key === 'ArrowUp') actions.moveFocusedPane({ step: -1, direction: 'column' })
      },
    },
  ]
}

export function createDevKeyboardController(options: {
  target: EventTarget
  actions: DevShortcutActions
}): { dispose(): void } {
  const shortcuts = devShortcuts(options.actions)
  const handler = (event: Event) => {
    const keyEvent = event as KeyboardEvent
    if (keyEvent.repeat || isEditableTarget(keyEvent.target)) return
    const shortcut = shortcuts.find((candidate) => candidate.test(keyEvent))
    if (shortcut) shortcut.run(keyEvent)
  }
  options.target.addEventListener('keydown', handler)
  return {
    dispose() {
      options.target.removeEventListener('keydown', handler)
    },
  }
}
