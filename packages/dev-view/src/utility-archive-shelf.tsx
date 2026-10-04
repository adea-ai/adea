import { createEffect, createSignal, onMount } from 'solid-js'

import type { SharedDevUtilityOwner } from './utility-owner'
import { ArchiveShelf } from './sidebar/archive-shelf'

/**
 * The same shell-owned archive surface used in Dev, Chat, and Virtual.
 *
 * The first load races the canonical binding: a mount-time load that a
 * binding or view transition fenced off is discarded and the shelf would sit
 * in its initial loading state forever. Expanding the shelf therefore
 * (re)requests the load, and while it stays expanded every view or binding
 * transition reloads it for the new scope — refreshArchiveShelf fences
 * re-entrantly, so a superseded in-flight load simply loses.
 */
export function SharedUtilityArchiveShelf(props: { owner: SharedDevUtilityOwner }) {
  const owner = props.owner
  const [expanded, setExpanded] = createSignal(false)
  onMount(() => void owner.refreshArchiveShelf())
  createEffect(() => {
    // Track the owner context revision so a view or binding transition while
    // the shelf is open reloads the listing for the new scope.
    void owner.context().revision
    if (expanded()) void owner.refreshArchiveShelf()
  })

  return (
    <ArchiveShelf
      state={owner.archiveShelf()}
      handoffMessage={owner.archiveHandoffMessage()}
      onExpanded={setExpanded}
      onRestore={(runtimeSessionId) => void owner.restoreArchivedSession(runtimeSessionId)}
      onRequestDelete={owner.requestArchiveDelete}
      onCancelDelete={owner.cancelArchiveDelete}
      onConfirmDelete={owner.confirmArchiveDelete}
    />
  )
}
