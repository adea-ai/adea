import type { ITheme } from '@xterm/xterm'

const ANSI_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const

/** Read already-resolved canonical roles; the renderer owns no palette engine. */
export function terminalThemeFromStyles(
  styles: Pick<CSSStyleDeclaration, 'getPropertyValue'>
): ITheme {
  const theme: ITheme = {}
  const read = (role: string) => styles.getPropertyValue(`--terminal-${role}`).trim() || undefined
  theme.background = read('background')
  theme.foreground = read('foreground')
  theme.cursor = read('cursor')
  theme.cursorAccent = theme.background
  theme.selectionBackground = read('selection')
  for (const name of ANSI_NAMES) {
    theme[name] = read(`ansi-${name}`)
    const brightName =
      `bright${name[0]!.toUpperCase()}${name.slice(1)}` as `bright${Capitalize<(typeof ANSI_NAMES)[number]>}`
    theme[brightName] = read(`ansi-bright-${name}`)
  }
  return theme
}

/** xterm consumes the shared code typography without defining a competing stack. */
export function terminalFontFromStyles(
  styles: Pick<CSSStyleDeclaration, 'fontFamily' | 'fontSize'>
): {
  fontFamily?: string
  fontSize?: number
} {
  const fontFamily = styles.fontFamily.trim() || undefined
  const size = Number.parseFloat(styles.fontSize)
  return { fontFamily, fontSize: Number.isFinite(size) && size > 0 ? size : undefined }
}

/** Wait for a selected web font before xterm measures and caches its glyphs. */
export function createTerminalFontBinding(
  fonts: Pick<FontFaceSet, 'check' | 'load'>,
  apply: (font: { fontFamily: string; fontSize: number }) => void
): {
  update: (styles: Pick<CSSStyleDeclaration, 'fontFamily' | 'fontSize'>) => void
  dispose: () => void
} {
  let revision = 0
  let requested: string | undefined
  let disposed = false
  return {
    update(styles) {
      const { fontFamily, fontSize } = terminalFontFromStyles(styles)
      if (!fontFamily || !fontSize || disposed) return
      const description = `${fontSize}px ${fontFamily}`
      if (description === requested) return
      requested = description
      const currentRevision = ++revision
      const commit = () => {
        if (!disposed && currentRevision === revision) apply({ fontFamily, fontSize })
      }
      if (fonts.check(description)) commit()
      // A failed optional font still uses its declared system fallback. A late
      // completion cannot undo a newer choice or touch a disposed terminal.
      else void fonts.load(description).then(commit, commit)
    },
    dispose() {
      disposed = true
      revision++
    },
  }
}

/** Observe only the surface's bounded ancestor chain, never application content. */
export function observeTerminalTheme(
  surface: HTMLElement,
  apply: (theme: ITheme, styles: CSSStyleDeclaration) => void
): () => void {
  const view = surface.ownerDocument.defaultView
  if (!view) return () => undefined
  let frame: number | undefined
  const update = () => {
    frame = undefined
    const styles = view.getComputedStyle(surface)
    apply(terminalThemeFromStyles(styles), styles)
  }
  const observer = new view.MutationObserver(() => {
    if (frame === undefined) frame = view.requestAnimationFrame(update)
  })
  for (let ancestor: HTMLElement | null = surface; ancestor; ancestor = ancestor.parentElement)
    observer.observe(ancestor, {
      attributes: true,
      attributeFilter: [
        'class',
        'style',
        'data-theme',
        'data-appearance',
        'data-font',
        'data-ui-font',
        'data-content-font',
        'data-code-font',
      ],
    })
  update()
  return () => {
    observer.disconnect()
    if (frame !== undefined) view.cancelAnimationFrame(frame)
  }
}
