import { ApiClientError } from '@adea-ai/api-client'

/**
 * What restoring an archived project does, from the promotion contract only: the project row goes
 * back to active at the revision the owner saw, and its archived conversations come back with it.
 * Visibility is unchanged, so it returns for exactly the people who could see it before. A local
 * repository binding is device state that archiving from Dev removes and restore never recreates.
 */
export function restoreConsequences(): readonly string[] {
  return [
    'It returns to the sidebar for everyone who can see it, with its conversations.',
    'Who can see it does not change.',
    'If it was archived from Dev, its local repository binding was removed. Add the repository again to work on it on this device.',
  ]
}

/** Maps a refused restore to a retry the owner can act on; a stale revision is never forced. */
export function restoreFailureMessage(failure: unknown): string {
  if (failure instanceof ApiClientError) {
    if (failure.code === 'project_conflict')
      return 'This project changed since it was listed. The list has been refreshed. Review it and restore again.'
    if (failure.status === 404 || failure.status === 403)
      return 'This project is unavailable or cannot be restored by you. The list has been refreshed.'
    if (failure.status === 401) return 'Sign in again to restore this project.'
  }
  return 'The project could not be restored. Try again.'
}
