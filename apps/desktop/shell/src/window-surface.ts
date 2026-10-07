// The glass appearance setting owns the whole native window: 'Frosted'
// creates the window see-through so the page's alpha-mixed background
// composites over the desktop instead of over an opaque chrome. Electrobun
// 2.0.1 sets transparency at window creation only (no runtime setter), so the
// value is read from the persisted workspace preferences at boot — the web
// mirrors it on every appearance change, and a change applies on relaunch.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function windowTransparentFor(dataDir: string, platform: string): boolean {
  if (platform !== 'darwin') return false
  try {
    const raw: unknown = JSON.parse(
      readFileSync(join(dataDir, 'desktop-state', 'preferences.json'), 'utf8')
    )
    return (raw as { windowSurface?: unknown }).windowSurface === 'frosted'
  } catch {
    // No preferences yet (or unreadable JSON): the default stays opaque.
    return false
  }
}
