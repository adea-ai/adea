/**
 * The one post-close background lease a Task panel may leave behind, held
 * outside the panel so the board can cancel it without importing the panel
 * (and the board without pulling the panel's implementation into its chunk).
 */
let activeLease: (() => void) | undefined

/** True while an earlier close still owns the frame's post-close restoration. */
export function hasTaskBackgroundLease() {
  return activeLease !== undefined
}

/** Records the lease a closing panel now owns; `release` ends it. */
export function holdTaskBackgroundLease(release: () => void) {
  activeLease = release
}

/** Drops the record when `release` is still the active lease. */
export function dropTaskBackgroundLease(release: () => void) {
  if (activeLease === release) activeLease = undefined
}

/** Cancels the active post-close background lease (a new owner took over). */
export function cancelTaskBackgroundLease() {
  activeLease?.()
  activeLease = undefined
}
