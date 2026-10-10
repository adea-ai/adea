/**
 * Workspace creation context (#1261) for the empty-state surface: who owns,
 * who can access, and where it lives — stated from existing contracts only,
 * never invented. Mirrors packages/workspace-nav/src/workspace-creation-context.ts;
 * both wordings are pinned by unit tests.
 */
export type WorkspaceCreationContext = Readonly<{
  /** Signed-in account label when the host knows it; omitted for guests/unknowns. */
  ownerLabel?: string
  /** Actual placement when the host knows it; unknown is labeled honestly. */
  placementLabel?: string
}>

export function describeWorkspaceCreationContext(context: WorkspaceCreationContext = {}): string {
  const owner =
    context.ownerLabel !== undefined && context.ownerLabel.trim() !== ''
      ? `Owned by ${context.ownerLabel.trim()}`
      : `You'll be the owner`
  const placement =
    context.placementLabel !== undefined && context.placementLabel.trim() !== ''
      ? `Located in ${context.placementLabel.trim()}`
      : `Location unknown`
  return `${owner} · Only you · ${placement}`
}
