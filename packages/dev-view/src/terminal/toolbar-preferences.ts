// Device-local terminal toolbar preferences: which header items show, whether
// command blocks render, and the shell a new terminal starts with. Preferences
// are a presentation default for this device; the host still decides which
// shells exist, and nothing here is authority over what a terminal runs.
import { createSignal } from 'solid-js'

export const TOOLBAR_ITEM_IDS = ['shell', 'worktree', 'cwd', 'integration', 'status'] as const
export type ToolbarItemId = (typeof TOOLBAR_ITEM_IDS)[number]

export type TerminalToolbarPreferences = Readonly<{
  /** Header items; absent or unknown keys fall back to visible. */
  items: Readonly<Record<ToolbarItemId, boolean>>
  /** The command-blocks list below the header. */
  blocks: boolean
  /** A ShellProfile id for new terminals; absent means the host default. */
  defaultShellProfileId?: string
}>

export const DEFAULT_TOOLBAR_PREFERENCES: TerminalToolbarPreferences = {
  items: { shell: true, worktree: true, cwd: true, integration: true, status: true },
  blocks: true,
}

const STORAGE_KEY = 'adea.dev.terminal.toolbar.v1'
const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export const TOOLBAR_ITEM_LABELS: Readonly<
  Record<ToolbarItemId | 'blocks', { label: string; hint?: string }>
> = {
  shell: { label: 'Shell' },
  worktree: { label: 'Worktree' },
  cwd: { label: 'Working directory' },
  integration: { label: 'Shell integration' },
  status: { label: 'Status' },
  blocks: { label: 'Command blocks', hint: 'Commands with exit code and duration' },
}

/** Tolerant parse: a damaged or hand-edited value never breaks the terminal. */
export function parseToolbarPreferences(
  raw: string | null | undefined
): TerminalToolbarPreferences {
  if (!raw) return DEFAULT_TOOLBAR_PREFERENCES
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return DEFAULT_TOOLBAR_PREFERENCES
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return DEFAULT_TOOLBAR_PREFERENCES
  const record = value as Record<string, unknown>
  const stored =
    record.items !== null && typeof record.items === 'object'
      ? (record.items as Record<string, unknown>)
      : {}
  const items = { ...DEFAULT_TOOLBAR_PREFERENCES.items }
  for (const id of TOOLBAR_ITEM_IDS) if (typeof stored[id] === 'boolean') items[id] = stored[id]
  const defaultShellProfileId =
    typeof record.defaultShellProfileId === 'string' &&
    PROFILE_ID.test(record.defaultShellProfileId)
      ? record.defaultShellProfileId
      : undefined
  return {
    items,
    blocks: typeof record.blocks === 'boolean' ? record.blocks : true,
    ...(defaultShellProfileId !== undefined ? { defaultShellProfileId } : {}),
  }
}

export function setToolbarItem(
  preferences: TerminalToolbarPreferences,
  id: ToolbarItemId,
  visible: boolean
): TerminalToolbarPreferences {
  return { ...preferences, items: { ...preferences.items, [id]: visible } }
}

export function setToolbarBlocks(
  preferences: TerminalToolbarPreferences,
  blocks: boolean
): TerminalToolbarPreferences {
  return { ...preferences, blocks }
}

export function setDefaultShellProfile(
  preferences: TerminalToolbarPreferences,
  profileId: string | undefined
): TerminalToolbarPreferences {
  const { defaultShellProfileId: _previous, ...rest } = preferences
  return profileId !== undefined && PROFILE_ID.test(profileId)
    ? { ...rest, defaultShellProfileId: profileId }
    : rest
}

/** Reset the toolbar layout; the device default shell is a separate choice. */
export function resetToolbar(preferences: TerminalToolbarPreferences): TerminalToolbarPreferences {
  return {
    ...DEFAULT_TOOLBAR_PREFERENCES,
    ...(preferences.defaultShellProfileId !== undefined
      ? { defaultShellProfileId: preferences.defaultShellProfileId }
      : {}),
  }
}

export function isDefaultToolbar(preferences: TerminalToolbarPreferences): boolean {
  return (
    preferences.blocks === DEFAULT_TOOLBAR_PREFERENCES.blocks &&
    TOOLBAR_ITEM_IDS.every((id) => preferences.items[id] === DEFAULT_TOOLBAR_PREFERENCES.items[id])
  )
}

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>

function browserStorage(): PreferenceStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

export function readToolbarPreferences(
  storage: PreferenceStorage | undefined = browserStorage()
): TerminalToolbarPreferences {
  try {
    return parseToolbarPreferences(storage?.getItem(STORAGE_KEY))
  } catch {
    return DEFAULT_TOOLBAR_PREFERENCES
  }
}

export function writeToolbarPreferences(
  preferences: TerminalToolbarPreferences,
  storage: PreferenceStorage | undefined = browserStorage()
): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(preferences))
  } catch {
    // Storage may be blocked or full: the preference holds for this page load.
  }
}

const [preferences, setPreferences] = createSignal<TerminalToolbarPreferences | undefined>()

/**
 * The shared device preferences. Every terminal pane reads the same signal, so
 * changing the toolbar in one pane updates the others without a reload.
 */
export function toolbarPreferences(): TerminalToolbarPreferences {
  const current = preferences()
  if (current) return current
  const loaded = readToolbarPreferences()
  setPreferences(loaded)
  return loaded
}

export function updateToolbarPreferences(
  change: (current: TerminalToolbarPreferences) => TerminalToolbarPreferences
): void {
  const next = change(toolbarPreferences())
  setPreferences(next)
  writeToolbarPreferences(next)
}

/** The saved default if the host still advertises it, else the host default. */
export function resolveDefaultShellProfileId(
  profiles: readonly { id: string }[],
  savedId: string | undefined
): string | undefined {
  return savedId !== undefined && profiles.some((profile) => profile.id === savedId)
    ? savedId
    : undefined
}
