import { createEffect, createMemo, createSignal, type Accessor } from 'solid-js'

/*
 * One stored width for every contextual workspace sidebar (Dev, Chat and
 * Virtual): one drag in any view resizes them all. The width lands on the
 * shared layout root as `--conventional-sidebar-width`, which the sidebar,
 * the toolbar and the Dev top bar's section alignment all read.
 */

export const SIDEBAR_WIDTH_STORAGE_KEY = 'adea:workspace-sidebar-width'
export const SIDEBAR_MIN_WIDTH = 208
export const SIDEBAR_MAX_WIDTH = 448
export const SIDEBAR_DEFAULT_WIDTH = 272
/** The keyboard resize step, in pixels. */
export const SIDEBAR_WIDTH_STEP = 16

export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)))
}

/**
 * The element that carries the width variable: the workspace frame, else a
 * standalone contextual shell, else the host's own root (`fallbackSelector`).
 */
export function sidebarWidthRootFor(
  sidebar: HTMLElement | null | undefined,
  fallbackSelector?: string
): HTMLElement | null {
  if (!sidebar) return null
  return (
    sidebar.closest<HTMLElement>('.workspace-frame') ??
    sidebar.closest<HTMLElement>('.workspace-shell--contextual') ??
    (fallbackSelector ? sidebar.closest<HTMLElement>(fallbackSelector) : null) ??
    null
  )
}

export function applySidebarWidth(root: HTMLElement, width: number): void {
  root.style.setProperty('--conventional-sidebar-width', `${clampSidebarWidth(width)}px`)
}

/** The persisted width, clamped; undefined when nothing usable is stored. */
export function readStoredSidebarWidth(): number | undefined {
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
  } catch {
    return undefined
  }
  const stored = Number(raw)
  if (raw === null || !Number.isFinite(stored) || stored <= 0) return undefined
  return clampSidebarWidth(stored)
}

export function persistSidebarWidth(width: number): void {
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clampSidebarWidth(width)))
  } catch {
    // Storage can be unavailable (private mode, blocked site data); the width
    // still applies for this session.
  }
}

export type SidebarWidthController = Readonly<{
  /** The current width, for the resize handle's value. */
  width: Accessor<number>
  /** The layout root the width variable is written to, once connected. */
  root: Accessor<HTMLElement | null>
  /** `ContextualSidebar.onSidebarElement`: tracks the inline aside. */
  onSidebarElement: (element: HTMLElement | undefined, mobile: boolean) => void
  /** `ContextualSidebar.onWidthChange`: applies a live drag. */
  onWidthChange: (width: number) => void
  /** `ContextualSidebar.onWidthCommit`: persists the settled width. */
  onWidthCommit: (width: number) => void
}>

/**
 * The resizable sidebar's width state. The inline panel is unmounted below
 * 48rem, so the layout root only becomes observable once the desktop aside
 * mounts (or after a narrow-to-wide reparent); the first paint at a narrow
 * viewport mounts and immediately detaches the inline aside before the media
 * query resolves, so only a connected node names the root. The persisted
 * width is restored as soon as that root exists.
 */
export function createSidebarWidth(
  options: Readonly<{ fallbackRootSelector?: string }> = {}
): SidebarWidthController {
  const [sidebar, setSidebar] = createSignal<HTMLElement>()
  const [width, setWidth] = createSignal(SIDEBAR_DEFAULT_WIDTH)
  const [rootTick, setRootTick] = createSignal(0)
  const root = createMemo(() => {
    const element = sidebar()
    void rootTick()
    return element?.isConnected ? sidebarWidthRootFor(element, options.fallbackRootSelector) : null
  })

  createEffect(() => {
    const element = root()
    if (!element) return
    const stored = readStoredSidebarWidth()
    if (stored === undefined) return
    applySidebarWidth(element, stored)
    setWidth(stored)
  })

  return {
    width,
    root,
    onSidebarElement: (element, mobile) => {
      if (mobile) return
      setSidebar(element)
      // Solid refs run before insertion; the root memo needs one nudge once
      // the aside is attached to observe its frame ancestor.
      if (element) queueMicrotask(() => setRootTick((tick) => tick + 1))
    },
    onWidthChange: (next) => {
      const element = root()
      if (!element) return
      const clamped = clampSidebarWidth(next)
      applySidebarWidth(element, clamped)
      setWidth(clamped)
    },
    onWidthCommit: persistSidebarWidth,
  }
}
