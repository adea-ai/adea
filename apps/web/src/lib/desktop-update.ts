// Desktop update surface for the browser app. On desktop the page is served by
// the Adea shell, which injects `window.__adeaDesktop` before the client boots
// (see apps/desktop/shell/src/bun/index.ts). apps/web must not depend on the
// desktop workspace, so the bridge shape is declared locally.

type DesktopShellBridge = {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>
}

declare global {
  interface Window {
    __adeaDesktop?: DesktopShellBridge
  }
}

function shell(): DesktopShellBridge {
  const bridge = typeof window !== 'undefined' ? window.__adeaDesktop : undefined
  if (!bridge) throw new Error('Adea desktop shell bridge is unavailable')
  return bridge
}

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return shell().invoke(cmd, args) as Promise<T>
}

export type DesktopUpdatePhase =
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'installed'
  | 'failed'

export type DesktopUpdate = {
  current_version: string
  available_version: string | null
  release_date: string | null
  release_notes: string | null
  changelog: string
  github_url: string
  phase: DesktopUpdatePhase
  downloaded_bytes: number
  total_bytes: number | null
  error: string | null
  restart_required: boolean
}

export function isDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && '__adeaDesktop' in window
}

export function getDesktopUpdateStatus(): Promise<DesktopUpdate> {
  return invoke<DesktopUpdate>('desktop_update_status')
}

export function checkDesktopUpdate(): Promise<DesktopUpdate> {
  return invoke<DesktopUpdate>('desktop_update_check')
}

export function installDesktopUpdate(expectedVersion: string): Promise<DesktopUpdate> {
  return invoke<DesktopUpdate>('desktop_update_install', {
    expectedVersion,
    approved: true,
    restart: true,
  })
}
