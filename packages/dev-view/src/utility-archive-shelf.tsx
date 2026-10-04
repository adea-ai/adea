import { onMount } from 'solid-js'

import type { SharedDevUtilityOwner } from './utility-owner'
import { ArchiveShelf } from './sidebar/archive-shelf'

/** The same shell-owned archive surface used in Dev, Chat, and Virtual. */
export function SharedUtilityArchiveShelf(props: { owner: SharedDevUtilityOwner }) {
  onMount(() => void props.owner.refreshArchiveShelf())

  return (
    <ArchiveShelf
      state={props.owner.archiveShelf()}
      handoffMessage={props.owner.archiveHandoffMessage()}
      onRestore={(runtimeSessionId) => void props.owner.restoreArchivedSession(runtimeSessionId)}
      onRequestDelete={props.owner.requestArchiveDelete}
      onCancelDelete={props.owner.cancelArchiveDelete}
      onConfirmDelete={props.owner.confirmArchiveDelete}
    />
  )
}
