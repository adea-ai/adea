import type { UpdateAdapter, UpdateState } from '@adea-ai/ui/components/composites/update-dialog'

export type SharedDesktopUpdate = Readonly<{
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

/** Native updater contract retained for existing Adea callers. */
export type VersionDialogAdapter = Readonly<{
  check(): Promise<SharedDesktopUpdate>
  getStatus(): Promise<SharedDesktopUpdate>
  install(expectedVersion: string): Promise<SharedDesktopUpdate>
  isDesktopRuntime(): boolean
}>

function toUpdateState(update: SharedDesktopUpdate): UpdateState {
  return {
    availableVersion: update.available_version,
    changelog: update.changelog,
    currentVersion: update.current_version,
    downloadedBytes: update.downloaded_bytes,
    error: update.error,
    phase: update.phase,
    releaseDate: update.release_date,
    releaseNotes: update.release_notes,
    releaseUrl: update.github_url,
    restartRequired: update.restart_required,
    totalBytes: update.total_bytes,
  }
}

/** @internal Bridges Adea's native snake_case snapshot to the public UI state. */
export function createUpdateDialogAdapter(
  getNativeAdapter: () => VersionDialogAdapter
): UpdateAdapter {
  return {
    check: async () => toUpdateState(await getNativeAdapter().check()),
    getStatus: async () => toUpdateState(await getNativeAdapter().getStatus()),
    install: async (expectedVersion) =>
      toUpdateState(await getNativeAdapter().install(expectedVersion)),
    isDesktopRuntime: () => getNativeAdapter().isDesktopRuntime(),
  }
}
