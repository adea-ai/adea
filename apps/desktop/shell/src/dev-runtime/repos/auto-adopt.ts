// Auto-adopt policy (owner request): a project bound by import or creation
// joins the repository registry without the manual Repositories-panel Adopt
// step, so the source-control sidebar lists gh/gitlab projects right away.
//
// The policy is deliberately tiny and total:
//  - Archived projects are ignored entirely — this path never mints a
//    registry record for one (owner requirement).
//  - The work is fire-and-forget: the command that bound the project has
//    already committed, and its reply must never wait on adoption or fail
//    with it. A slow or hanging proof cannot block anything.
//  - Every refusal is swallowed: a failed adoption (vanished checkout,
//    drifted root, stale race, `not_found` for a `dev.project.create`-bound
//    id with no binding) leaves the honest binding-only state that the
//    Repositories panel's manual Adopt (and its typed notices) exists for.
//  - It is an import/creation side effect, not a reconciler: nothing here
//    ever re-runs on load or sync, so removing a registry record is never
//    silently undone — only an explicit import/creation or a manual Adopt
//    proves a repository again.

/** The binding facts the policy reads; `Project` supplies both. */
export type AutoAdoptProject = Readonly<{
  lifecycle: ProjectLifecycle
  repoIds: readonly string[]
}>

type ProjectLifecycle = 'importing' | 'cloning' | 'scanning' | 'ready' | 'archived' | 'failed'

/**
 * Fire-and-forget adoption of every repository binding a project just
 * received, in binding order. `adopt` is the composition's seam onto the
 * repository registry's own `dev.repo.adopt` proof path — this module never
 * re-proves anything itself.
 */
export function autoAdoptBindings(
  project: AutoAdoptProject,
  adopt: (repoId: string) => Promise<unknown>
): void {
  // Owner requirement: archived projects are excluded from auto-adoption.
  if (project.lifecycle === 'archived') return
  void (async () => {
    for (const repoId of project.repoIds) {
      try {
        await adopt(repoId)
      } catch {
        // Best-effort by contract; the binding-only state stands.
      }
    }
  })()
}
