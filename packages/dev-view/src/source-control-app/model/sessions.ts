/*
 * Pull request ↔ Adea session link. A pull request belongs to the Adea
 * session whose worktree has its head branch checked out in the same
 * repository. The link is derived from the runtime's worktree and session
 * read models every sync; nothing is persisted, and a pull request opened
 * outside Adea simply has no session.
 */
import type { GitHubPullRequestSummary } from '@adea-ai/types/dev-runtime'

import type { LinkedSession, PullRequestView } from './types'

export type WorktreeFact = Readonly<{
  id: string
  repoId?: string
  headRef?: string
  archived: boolean
}>

export type SessionFact = Readonly<{
  id: string
  projectId: string
  worktreeId: string
  displayName?: string
  lifecycle: string
  archived: boolean
}>

/** The ref a worktree reports, without a `refs/heads/` prefix. */
function branchOf(ref: string | undefined): string | undefined {
  if (ref === undefined) return undefined
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
}

const lifecycleRank: Record<string, number> = {
  active: 0,
  ready: 1,
  preparing: 2,
  disconnected: 3,
}

export function indexSessions(
  worktrees: readonly WorktreeFact[],
  sessions: readonly SessionFact[]
): ReadonlyMap<string, LinkedSession> {
  const byWorktree = new Map<string, SessionFact>()
  for (const session of sessions) {
    if (session.archived) continue
    const current = byWorktree.get(session.worktreeId)
    // Prefer the live session when a worktree hosted several.
    if (
      current === undefined ||
      (lifecycleRank[session.lifecycle] ?? 9) < (lifecycleRank[current.lifecycle] ?? 9)
    )
      byWorktree.set(session.worktreeId, session)
  }
  const index = new Map<string, LinkedSession>()
  for (const worktree of worktrees) {
    const branch = branchOf(worktree.headRef)
    if (worktree.archived || worktree.repoId === undefined || branch === undefined) continue
    const session = byWorktree.get(worktree.id)
    if (session === undefined) continue
    index.set(`${worktree.repoId}\u0000${branch}`, {
      runtimeSessionId: session.id,
      projectId: session.projectId,
      worktreeId: worktree.id,
      title: session.displayName ?? branch,
      lifecycle: session.lifecycle,
    })
  }
  return index
}

export function linkPullRequest(
  pr: GitHubPullRequestSummary,
  sessions: ReadonlyMap<string, LinkedSession>
): PullRequestView {
  // A fork's head branch name can collide with a local branch; only a head
  // in the base repository can be the branch an Adea worktree pushed.
  const session = pr.crossRepository ? undefined : sessions.get(`${pr.repoId}\u0000${pr.headRef}`)
  return {
    ...pr,
    authorIsAgent: pr.author?.kind === 'bot' || session !== undefined,
    ...(session ? { session } : {}),
  }
}
