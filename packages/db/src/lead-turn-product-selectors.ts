/** Selectors identify stored product rows; user/service strings are never authority. */
export function isLeadTurnProductSelector(
  controlPlaneWorkspaceId: string,
  intentId: string
): boolean {
  return (
    /^wsp_[0-9A-HJKMNP-TV-Z]{26}$/.test(controlPlaneWorkspaceId) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(intentId)
  )
}
