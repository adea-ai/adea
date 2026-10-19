import { createSignal, getOwner, onCleanup, type Accessor } from 'solid-js'

/**
 * The host's native folder picker, composed as its own reactive unit.
 *
 * The picker is the host's OS boundary: it opens a native panel and answers with
 * one absolute path, with `null` when the user cancelled, or by rejecting when
 * the shell cannot open a panel at all. Three rules make it safe to compose:
 *
 * - a cancelled or failed pick leaves the typed path untouched, so the typed
 *   input stays the fallback in every one of those cases;
 * - a repeated request while a pick is in flight is ignored, so the host is
 *   asked exactly once;
 * - a completion that arrives after the form was torn down (a navigation, or
 *   the component unmounting) is ignored: a disposed form is never updated.
 *
 * The picker only fills the field. The path still goes through the Dev
 * Runtime's `dev.project.authorizeRoot`, so picking a folder never widens
 * authorization.
 */
export type ProjectFolderPicker = Readonly<{
  /** The path the input shows: what the user typed, or the last picked folder. */
  path: Accessor<string>
  /** True while a pick is in flight. */
  picking: Accessor<boolean>
  /** Asks the host for a folder. Never rejects and never throws. */
  choose(): Promise<void>
  /** Replaces the path; the host clears it once the path is authorized. */
  setPath(path: string): void
}>

export type ProjectFolderPickerOptions = Readonly<{
  /**
   * The host's picker, read when a pick is requested so a host that installs
   * one later is still honoured. It returns undefined when the host has none.
   */
  pickFolder?: () => Promise<string | null | undefined> | undefined
}>

export function createProjectFolderPicker(
  options: ProjectFolderPickerOptions
): ProjectFolderPicker {
  const [path, setPath] = createSignal('')
  const [picking, setPicking] = createSignal(false)
  let disposed = false
  // A picker created inside a component is disposed with it; one created
  // outside an owner has nothing to clean up.
  if (getOwner()) onCleanup(() => void (disposed = true))

  const choose = async (): Promise<void> => {
    // A repeated request while a pick is in flight never reaches the host.
    if (picking()) return
    const request = options.pickFolder?.()
    if (!request) return
    setPicking(true)
    const picked = await request.catch(() => undefined)
    // A completion that arrives after the form was torn down belongs to a form
    // that no longer exists, so it changes nothing.
    if (disposed) return
    setPicking(false)
    const pickedPath = typeof picked === 'string' ? picked.trim() : ''
    if (pickedPath !== '') setPath(pickedPath)
  }

  return { path, picking, choose, setPath }
}
