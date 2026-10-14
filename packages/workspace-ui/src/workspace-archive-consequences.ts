/**
 * What archiving an optional workspace does, stated from the archive contract only.
 *
 * Archive stamps the workspace record: it leaves every member's list and the workspace stops
 * opening or admitting new work until the owner reopens it. It deletes nothing, cancels nothing
 * and does not erase history, links, jobs or artifacts; permanent deletion is a separate,
 * currently unavailable operation. The member count is the only live fact, read from the member
 * list; while it is unread or unreadable the copy names every member rather than guessing a number.
 */
export type ArchiveMemberCount =
  | Readonly<{ state: 'loading' }>
  | Readonly<{ state: 'unavailable' }>
  | Readonly<{ state: 'known'; total: number }>

export function archiveAudienceLine(members: ArchiveMemberCount): string {
  if (members.state !== 'known') return 'Every member loses access until you reopen it.'
  const others = Math.max(0, members.total - 1)
  if (others === 0) return 'Only you have access to it, so no one else is affected.'
  return `${others === 1 ? '1 other member loses' : `${others} other members lose`} access until you reopen it.`
}

export function archiveConsequences(members: ArchiveMemberCount): readonly string[] {
  return [
    archiveAudienceLine(members),
    'No one can start new work in it while it is archived. Work that is already running is not cancelled.',
    'Nothing is erased. Its history, links, jobs and artifacts are kept, and reopening restores them.',
    'Permanent deletion stays unavailable until cleanup is verified.',
  ]
}
