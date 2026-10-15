// Lazy xterm addons for the terminal pane (issue #396). The base terminal
// (xterm, fit, web links) is usable before either addon below is fetched:
// WebGL loads once the pane has mounted and DOM stays the renderer until it is
// active, and the search addon loads when search first opens. Both controllers
// are plain functions over a structural terminal so the load races (unmount
// mid-import, failed import, context loss, rapid search open/type/close) are
// unit-testable without a canvas.
import type { ITerminalAddon, Terminal } from '@xterm/xterm'
import type { ISearchOptions, SearchAddon } from '@xterm/addon-search'
import type { WebglAddon } from '@xterm/addon-webgl'

import type { RendererPolicy } from './renderer-policy'

type AddonHost = Pick<Terminal, 'loadAddon'>

// ── WebGL renderer ──────────────────────────────────────────────────────────

export type WebglAddonLike = ITerminalAddon & Pick<WebglAddon, 'onContextLoss'>

export type LazyWebglOptions = Readonly<{
  terminal: AddonHost
  policy: RendererPolicy
  /** Dynamic import of the WebGL addon module. */
  load: () => Promise<{ WebglAddon: new () => WebglAddonLike }>
  /** True once the pane has unmounted; nothing may attach after that. */
  isDisposed: () => boolean
  /** The policy snapshot changed (renderer or fallback state). */
  onPolicyChange: () => void
}>

/**
 * Loads the WebGL addon after the DOM terminal is already running. The policy
 * stays on DOM until an addon is actually active, so the renderer the pane
 * reports is the renderer drawing. Any failure leaves the DOM terminal as is.
 */
export async function attachLazyWebgl(options: LazyWebglOptions): Promise<void> {
  const { terminal, policy, load, isDisposed, onPolicyChange } = options
  if (isDisposed() || policy.snapshot().webglDisabled) return
  let module: Awaited<ReturnType<LazyWebglOptions['load']>>
  try {
    module = await load()
  } catch {
    if (isDisposed()) return
    policy.webglInitFailed('addon unavailable')
    onPolicyChange()
    return
  }
  // The pane can unmount while the chunk downloads; its terminal is disposed
  // by then, so the addon must never be constructed or loaded into it.
  if (isDisposed()) return

  const attach = (): boolean => {
    try {
      const addon = new module.WebglAddon()
      addon.onContextLoss(() => {
        const result = policy.contextLost()
        addon.dispose()
        onPolicyChange()
        if (!result.retryWebgl || isDisposed()) return
        if (attach()) {
          policy.webglRestored()
          onPolicyChange()
        }
      })
      terminal.loadAddon(addon)
      return true
    } catch {
      return false
    }
  }

  if (attach()) {
    policy.webglLoaded()
  } else {
    policy.webglInitFailed('addon unavailable')
  }
  onPolicyChange()
}

// ── Search ──────────────────────────────────────────────────────────────────

export type SearchAddonLike = ITerminalAddon &
  Pick<SearchAddon, 'findNext' | 'findPrevious' | 'clearDecorations' | 'onDidChangeResults'>

export type SearchIntent = Readonly<{
  open: boolean
  query: string
  caseSensitive: boolean
}>

export type LazySearchOptions = Readonly<{
  terminal: AddonHost
  /** Dynamic import of the search addon module, constructing one addon. */
  load: () => Promise<SearchAddonLike>
  isDisposed: () => boolean
  decorations: () => ISearchOptions['decorations']
  onResults: (results: { resultIndex: number; resultCount: number }) => void
  /** The addon could not be loaded while search was open. */
  onUnavailable: () => void
}>

/**
 * Owns the search addon's lifecycle. Callers report the latest search intent;
 * the controller never queues individual finds, so a chunk that arrives after
 * the user typed and closed again applies only the intent that is current when
 * it lands (nothing, if search is closed). A failed import is forgotten so the
 * next open or query change retries.
 */
export function createLazySearch(options: LazySearchOptions) {
  let addon: SearchAddonLike | undefined
  let loading: Promise<void> | undefined
  let intent: SearchIntent = { open: false, query: '', caseSensitive: false }
  let appliedKey: string | undefined

  function apply(): void {
    if (!addon || options.isDisposed()) return
    if (!intent.open || intent.query === '') {
      if (appliedKey !== undefined) addon.clearDecorations()
      appliedKey = undefined
      return
    }
    const key = `${intent.query}\u0000${intent.caseSensitive}`
    if (key === appliedKey) return
    appliedKey = key
    addon.findNext(intent.query, {
      caseSensitive: intent.caseSensitive,
      decorations: options.decorations(),
    })
  }

  function ensureLoaded(): void {
    if (addon || loading) return
    loading = (async () => {
      let loaded: SearchAddonLike | undefined
      try {
        loaded = await options.load()
      } catch {
        loaded = undefined
      }
      loading = undefined
      // The pane can unmount while the chunk downloads; never attach to (or
      // report on) a disposed terminal.
      if (options.isDisposed()) return
      if (loaded) {
        try {
          options.terminal.loadAddon(loaded)
          loaded.onDidChangeResults(options.onResults)
        } catch {
          loaded = undefined
        }
      }
      if (!loaded) {
        if (intent.open) options.onUnavailable()
        return
      }
      addon = loaded
      apply()
    })()
  }

  return {
    /** The addon, once it is loaded and attached. */
    current(): SearchAddonLike | undefined {
      return addon
    },
    /** Reports the latest intent; loads the addon on first open. */
    update(next: SearchIntent): void {
      intent = next
      if (next.open) ensureLoaded()
      apply()
    },
  }
}
