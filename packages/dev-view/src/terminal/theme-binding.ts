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

/** Observe only the surface's bounded ancestor chain, never application content. */
export function observeTerminalTheme(
  surface: HTMLElement,
  apply: (theme: ITheme) => void
): () => void {
  const view = surface.ownerDocument.defaultView
  if (!view) return () => undefined
  let frame: number | undefined
  const update = () => {
    frame = undefined
    apply(terminalThemeFromStyles(view.getComputedStyle(surface)))
  }
  const observer = new view.MutationObserver(() => {
    if (frame === undefined) frame = view.requestAnimationFrame(update)
  })
  for (let ancestor: HTMLElement | null = surface; ancestor; ancestor = ancestor.parentElement)
    observer.observe(ancestor, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme', 'data-appearance', 'data-font'],
    })
  update()
  return () => {
    observer.disconnect()
    if (frame !== undefined) view.cancelAnimationFrame(frame)
  }
}
