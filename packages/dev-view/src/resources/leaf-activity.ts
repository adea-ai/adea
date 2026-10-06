/*
 * Pure sidebar-leaf activity (ADR 0011): one worktree leaf summarizes the
 * harness runs of the runtime sessions bound to it. "Needs you" is not a
 * session field — it is observed on the run (`awaiting_input` /
 * `awaiting_approval`), exactly as the Activity pane reads it — so the leaf
 * reuses the activity model's state sets rather than inventing its own.
 */
import type { HarnessRun, RuntimeSession } from '@adea-ai/types/dev-runtime'

import { ATTENTION_STATES, RUNNING_STATES } from './activity-model'

export type LeafActivity = 'needs_you' | 'running' | 'idle'

/**
 * The activity of a leaf whose sessions are `sessions`: `needs_you` when any
 * of their runs waits on the user, else `running` when any is
 * resolving/starting/working, else `idle`. Runs of other sessions are
 * ignored; terminal and unknown run states never count as activity.
 */
export function leafActivity(
  runs: readonly Pick<HarnessRun, 'runtimeSessionId' | 'state'>[],
  sessions: readonly Pick<RuntimeSession, 'id'>[]
): LeafActivity {
  const sessionIds = new Set(sessions.map((session) => session.id))
  let running = false
  for (const run of runs) {
    if (!sessionIds.has(run.runtimeSessionId)) continue
    if (ATTENTION_STATES.has(run.state)) return 'needs_you'
    if (RUNNING_STATES.has(run.state)) running = true
  }
  return running ? 'running' : 'idle'
}
