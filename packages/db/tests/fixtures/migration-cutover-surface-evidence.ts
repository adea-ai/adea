/**
 * The positive control for the client surfaces a cutover must not change.
 *
 * The authorized member's search is the surface that proves the comparison is
 * not vacuous: a denied read is not an empty result, and only the exact
 * messages the fixture seeded can satisfy the control. The check is pure so it
 * can be exercised without a database.
 */

/** One surface projection: a real list, or the explicit denial sentinel. */
export type SurfaceSearchMessages = readonly string[] | 'denied'

export type AuthorizedMemberSearchSurface = Readonly<{
  searchMessages: SurfaceSearchMessages
}>

/**
 * Require the authorized member's search to return exactly the seeded messages.
 *
 * A denial is rejected first and by name: the sentinel is a string, so a
 * length check alone would count it as six results. An unavailable read and an
 * explicit denial stay different values, and neither satisfies this control.
 */
export function assertAuthorizedMemberSearch(
  surface: AuthorizedMemberSearchSurface,
  expectedMessageIds: readonly string[]
): void {
  if (surface.searchMessages === 'denied') {
    throw new Error('the authorized member search was denied; the positive control cannot hold')
  }
  const expected = [...expectedMessageIds].toSorted()
  const observed = [...surface.searchMessages].toSorted()
  if (observed.length !== expected.length || observed.some((id, index) => id !== expected[index])) {
    throw new Error(
      'the authorized member search did not return exactly the seeded fixture messages'
    )
  }
}
