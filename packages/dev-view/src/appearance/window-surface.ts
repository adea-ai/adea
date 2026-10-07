// The desktop mirror for the glass appearance setting. The appearance editor
// persists its surface to localStorage (device-local), but the native window
// is the shell's: it reads the mirrored value from the persisted workspace
// preferences at boot. The host (apps/web, desktop only) registers the
// transport — dev-view stays platform-agnostic and calls the seam.
export type WindowSurface = 'theme' | 'frosted' | 'opaque'

type WindowSurfaceMirror = (surface: WindowSurface) => void

let mirror: WindowSurfaceMirror | undefined

export function registerWindowSurfaceMirror(next: WindowSurfaceMirror): void {
  mirror = next
}

export function mirrorWindowSurface(surface: WindowSurface): void {
  mirror?.(surface)
}
