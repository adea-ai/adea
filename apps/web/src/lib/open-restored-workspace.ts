/**
 * Opens the workspace a restore just created, from the workspace details dialog.
 *
 * The open waits on two things the person can walk away from: a refresh of the workspace list
 * (when the restore's own refresh failed) and the switch's authorisation. If they close the
 * dialog, reopen it, or move to another workspace in the meantime, the open is stale: it
 * navigates nowhere and reports false, so a late answer never pulls them into a workspace they
 * stopped asking for. `cancel()` retires every open still in flight (the dialog closed).
 */
export type RestoredWorkspaceOpener = Readonly<{
  /** `stillAsked` is true while the dialog that asked is open on the workspace it asked from. */
  open(workspaceId: string, stillAsked: () => boolean): Promise<boolean>
  cancel(): void
}>

export function createRestoredWorkspaceOpener<W extends { id: string }>(options: {
  /** The workspaces already loaded. */
  loaded: () => readonly W[] | undefined
  /** Asks the server for the list again; the restored workspace may only show up here. */
  refetch: () => Promise<readonly W[] | undefined>
  /** Switches to the workspace unless `isCurrent()` is false when it is about to land. */
  switchTo: (workspace: W, isCurrent: () => boolean) => Promise<boolean>
  /** Runs once the switch landed: closes the dialog. */
  onOpened: () => void
}): RestoredWorkspaceOpener {
  let latest = 0
  return {
    cancel() {
      latest += 1
    },
    async open(workspaceId, stillAsked) {
      const request = ++latest
      const isCurrent = () => request === latest && stillAsked()
      const find = (list: readonly W[] | undefined) => list?.find(({ id }) => id === workspaceId)
      const restored = find(options.loaded()) ?? find(await options.refetch())
      if (!restored || !isCurrent()) return false
      if (!(await options.switchTo(restored, isCurrent))) return false
      options.onOpened()
      return true
    },
  }
}
