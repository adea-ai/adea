// Pure view model for the History pane's "All sessions" scope (#716): turns the
// scan's sessions, runs and bounded event windows into per-session groups of
// matches (or the most recent prompts when nothing is typed), with the counts
// and caps the pane states honestly. Search itself stays in
// `searchConversationHistory`; nothing here is stored or indexed.
import type { HarnessRun, RuntimeEvent } from '@adea-ai/types/dev-runtime'

import {
  searchConversationHistory,
  type ConversationSearchRow,
} from '../chat/search/conversation-search-model'
import { harnessStatusLabel } from '../agents/harness-status-model'
import type { AllSessionsScan } from './all-sessions-scan'
import { isResumable, resumeReason, type RunHistoryRow } from './run-history-model'
import { newestRun } from './turns-model'

export const RESULT_PAGE = 50
/** The most rows one search shows; a narrower query is the way to the rest. */
export const RESULT_CAP = 1_000
const RECENT_PER_SESSION = 3
const SEARCH_PAGE_LIMIT = 500

type BlockedReason = Exclude<RunHistoryRow['resumeReason'], 'available'>

export const RESUME_BLOCKED_COPY: Record<BlockedReason, string> = {
  cancelled: 'This run was cancelled and cannot be resumed',
  non_terminal: 'This run is still active',
  missing_start: 'This run has no recorded start to resume from',
  unknown_state: 'This run’s state is unknown, so it cannot be resumed',
}

/** A resume refused before it reached the runtime, with the reason to show. */
export class ResumeRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResumeRefusedError'
  }
}

export type ResumeTarget = Readonly<{
  runtimeSessionId: string
  projectId: string
  title: string
  harnessRunId: string
  /** Position of the run in the session's run history, oldest first. */
  runNumber: number
  runGeneration: number
  stateLabel: string
  startedAt?: string
  /** The generation a resume starts. */
  nextGeneration: number
}>

export type SessionResume =
  | Readonly<{ kind: 'available'; target: ResumeTarget }>
  | Readonly<{ kind: 'blocked'; reason: string }>

export type SessionGroup = Readonly<{
  runtimeSessionId: string
  title: string
  /** Matches in this session over the whole result (recent prompts: rows shown). */
  matches: number
  rows: readonly ConversationSearchRow[]
  resume?: SessionResume
}>

export type AllSessionsView = Readonly<{
  mode: 'recent' | 'results'
  groups: readonly SessionGroup[]
  /** Matches over every session, before the page and the cap. */
  total: number
  /** Rows shown after the page limit and the cap. */
  shown: number
  /** More matches exist than the cap allows showing. */
  capped: boolean
  searched: number
  partial: boolean
}>

function sessionResume(
  scan: AllSessionsScan,
  runtimeSessionId: string,
  title: string
): SessionResume | undefined {
  const runs = scan.runs.filter((run) => run.runtimeSessionId === runtimeSessionId)
  const run = newestRun(runs)
  if (!run) return undefined
  if (!isResumable(run)) {
    return { kind: 'blocked', reason: RESUME_BLOCKED_COPY[resumeReason(run) as BlockedReason] }
  }
  const session = scan.sessions.find((candidate) => candidate.id === runtimeSessionId)
  if (!session) return undefined
  const history = runs.toSorted((left, right) => left.generation - right.generation)
  return {
    kind: 'available',
    target: {
      runtimeSessionId,
      projectId: session.projectId,
      title,
      harnessRunId: run.id,
      runNumber: history.findIndex((candidate) => candidate.id === run.id) + 1,
      runGeneration: run.generation,
      stateLabel: harnessStatusLabel(run.state),
      ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
      nextGeneration: Math.max(...runs.map((candidate: HarnessRun) => candidate.generation)) + 1,
    },
  }
}

/**
 * `overrides` replaces a session's scanned window with fresher events, e.g. the
 * live feed of the session the pane is bound to.
 */
export function buildAllSessionsView(
  scan: AllSessionsScan,
  query: string,
  count: number,
  overrides?: ReadonlyMap<string, readonly RuntimeEvent[]>
): AllSessionsView {
  const events = overrides ? new Map([...scan.events, ...overrides]) : scan.events
  const searching = query.trim().length > 0
  const input = {
    sessions: scan.sessions,
    runs: searching ? scan.runs : [],
    events,
    query,
    ...(searching ? {} : { kinds: ['prompt' as const] }),
  }
  const wanted = searching ? Math.min(Math.max(count, 1), RESULT_CAP) : SEARCH_PAGE_LIMIT
  const rows: ConversationSearchRow[] = []
  let cursor: string | undefined
  let total = 0
  let sessionMatches: ReadonlyMap<string, number> = new Map()
  for (;;) {
    const page = searchConversationHistory({
      ...input,
      limit: Math.min(SEARCH_PAGE_LIMIT, wanted - rows.length),
      ...(cursor ? { cursor } : {}),
    })
    if (cursor === undefined) {
      total = page.totalMatches
      sessionMatches = page.sessionMatches
    }
    rows.push(...page.items)
    cursor = page.nextCursor
    if (!cursor || rows.length >= wanted) break
  }
  const grouped = new Map<string, ConversationSearchRow[]>()
  for (const row of rows) {
    const list = grouped.get(row.runtimeSessionId) ?? []
    if (searching || list.length < RECENT_PER_SESSION) list.push(row)
    grouped.set(row.runtimeSessionId, list)
  }
  const groups = [...grouped].map(([runtimeSessionId, list]): SessionGroup => {
    const title = list[0]!.title
    const resume = sessionResume(scan, runtimeSessionId, title)
    return {
      runtimeSessionId,
      title,
      matches: searching ? (sessionMatches.get(runtimeSessionId) ?? list.length) : list.length,
      rows: list,
      ...(resume ? { resume } : {}),
    }
  })
  return {
    mode: searching ? 'results' : 'recent',
    groups,
    total: searching ? total : groups.reduce((sum, group) => sum + group.rows.length, 0),
    shown: groups.reduce((sum, group) => sum + group.rows.length, 0),
    capped: searching && total > RESULT_CAP,
    searched: scan.searched,
    partial: scan.partial,
  }
}
