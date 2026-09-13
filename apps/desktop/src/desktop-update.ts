import { invoke } from './platform/bridge'

export type DesktopUpdate = Readonly<{
  available_version: string | null
  changelog: string
  current_version: string
  downloaded_bytes: number
  error: string | null
  github_url: string
  phase:
    | 'idle'
    | 'checking'
    | 'current'
    | 'available'
    | 'downloading'
    | 'installing'
    | 'installed'
    | 'failed'
  release_date: string | null
  release_notes: string | null
  restart_required: boolean
  total_bytes: number | null
}>

export function getDesktopUpdateStatus() {
  return invoke<DesktopUpdate>('desktop_update_status')
}

export function checkDesktopUpdate() {
  return invoke<DesktopUpdate>('desktop_update_check')
}

export function installDesktopUpdate(expectedVersion: string) {
  return invoke<DesktopUpdate>('desktop_update_install', {
    approved: true,
    expectedVersion,
    restart: true,
  })
}
