// Durable cleanup journal: every cleanup transition is journaled before its
// side effect, and a restart replays the journal to resume idempotently or
// quarantine. Each append is fsynced before the caller proceeds, so a crash
// can only land between entries — never inside one.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'

import { nowIso } from '../authority'

export type JournalStepState = 'started' | 'completed' | 'rolled_back'

export type JournalEntry = Readonly<{
  jobId: string
  worktreeId: string
  seq: number
  /** Step identity is stable across retries: the same step of the same job
   *  never runs twice to completion. */
  step: string
  state: JournalStepState
  /** Digest of the step's inputs; a resumed step whose inputs changed is not
   *  the same step and must not be skipped. */
  inputDigest?: string
  result?: Readonly<Record<string, unknown>>
  at: string
}>

export type CleanupJournal = ReturnType<typeof createCleanupJournal>

export function createCleanupJournal(options: { file: string }) {
  const { file } = options
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })

  function append(entry: Omit<JournalEntry, 'at'>): JournalEntry {
    const full: JournalEntry = { ...entry, at: nowIso() }
    const handle = openSync(file, 'a', 0o600)
    try {
      writeSync(handle, `${JSON.stringify(full)}\n`)
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
    return full
  }

  function replay(): JournalEntry[] {
    try {
      const raw = readFileSync(file, 'utf8')
      const entries: JournalEntry[] = []
      for (const line of raw.split('\n')) {
        if (line.length === 0) continue
        try {
          entries.push(JSON.parse(line) as JournalEntry)
        } catch {
          // A torn final line (crash mid-append) replays as if the entry never
          // happened, which is the safe direction: the step reruns.
          continue
        }
      }
      return entries
    } catch {
      return []
    }
  }

  /** Steps of one job that completed with exactly these inputs, keyed by step
   *  name. A started-but-not-completed entry is deliberately absent: the step
   *  must rerun after a crash between its journal entries. */
  function completedSteps(
    jobId: string,
    inputDigests?: Record<string, string>
  ): Map<string, JournalEntry> {
    const done = new Map<string, JournalEntry>()
    for (const entry of replay()) {
      if (entry.jobId !== jobId || entry.state !== 'completed') continue
      if (inputDigests && entry.inputDigest !== inputDigests[entry.step]) continue
      done.set(entry.step, entry)
    }
    return done
  }

  function lastSeq(jobId: string): number {
    let seq = 0
    for (const entry of replay()) {
      if (entry.jobId === jobId) seq = Math.max(seq, entry.seq)
    }
    return seq
  }

  /** Latest durable state for each step, including a recorded rollback. */
  function latestSteps(jobId: string): Map<string, JournalEntry> {
    const latest = new Map<string, JournalEntry>()
    for (const entry of replay()) {
      if (entry.jobId === jobId) latest.set(entry.step, entry)
    }
    return latest
  }

  return Object.freeze({ append, replay, completedSteps, lastSeq, latestSteps })
}

export function digestOf(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('hex')
}

/** Run one journaled step. First completion executes `fn`; every later call
 *  with the same job/step/input digest replays the recorded result without
 *  repeating the side effect. */
export async function runJournaledStep<T extends Record<string, unknown>>(
  journal: CleanupJournal,
  input: {
    jobId: string
    worktreeId: string
    step: string
    stepInputs?: unknown
  },
  fn: () => Promise<T>
): Promise<T> {
  const inputDigest = input.stepInputs === undefined ? undefined : digestOf(input.stepInputs)
  const done = journal.completedSteps(
    input.jobId,
    inputDigest ? { [input.step]: inputDigest } : undefined
  )
  const prior = done.get(input.step)
  if (prior?.result) return prior.result as T

  const seq = journal.lastSeq(input.jobId) + 1
  journal.append({
    jobId: input.jobId,
    worktreeId: input.worktreeId,
    seq,
    step: input.step,
    state: 'started',
    ...(inputDigest ? { inputDigest } : {}),
  })
  const result = await fn()
  journal.append({
    jobId: input.jobId,
    worktreeId: input.worktreeId,
    seq: seq + 1,
    step: input.step,
    state: 'completed',
    ...(inputDigest ? { inputDigest } : {}),
    result,
  })
  return result
}
