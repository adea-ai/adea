// Durable boot-adoption diagnostics (issue #1039): the terminal lane's sidecar
// adoption used to fail with only a console line — and a Finder/GUI launch
// never even surfaces that line — leaving "the spawn either never fired or
// died before any output" unnameable. This journal records, owner-only and
// bounded, the facts that name the failing step: the adoption attempt's shape,
// each spawn (argv, environment KEY NAMES — never values — cwd, pid), the
// child's exit, the endpoint publish watch, and the adoption outcome.
//
// It mirrors the launch/exit record journal's patterns (`records.ts`):
// append-only JSON lines under `<dataDir>/dev-runtime/supervision/`, owner-only
// dir/file modes from creation, retention bounded with an atomic rewrite, and
// diagnostics that never throw — a boot that cannot journal still boots.
//
// Multiple in-process writers (the process adapter, the dev fallback plan, the
// boot adoption seam) append to the same file; entries are single lines and
// every writer is append-only, so no writer owns authoritative state.
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export const BOOT_ADOPTION_JOURNAL_FILE = 'boot-adoption.jsonl'

/** The retention bound. A boot appends a handful of entries; the engine's
 *  crash-loop policy (5 failures / 10 minutes) bounds the pathological rate.
 *  The file is trimmed back to `TRIM_TO_LINES` when it exceeds `MAX_LINES`. */
const MAX_LINES = 400
const TRIM_TO_LINES = 200

/** What a spawn looked like. Environment is recorded as key names only: the
 *  allowlist's shape is the diagnostic (which host keys and declared
 *  additions the child received), never its values. */
export type SpawnFacts = {
  argv: readonly string[]
  envKeys: readonly string[]
  cwd: string | null
}

export type BootAdoptionEntry =
  | {
      kind: 'adoption-attempt'
      at: string
      /** Which plan ran: `packaged` (engine-spawned) or `dev` (dev fallback). */
      mode: string
      supervisorPresent: boolean
      executableIdentity: string
    }
  | ({ kind: 'spawn'; at: string; mode: string; pid: number } & SpawnFacts)
  | ({ kind: 'spawn-failed'; at: string; mode: string; error: string } & SpawnFacts)
  | { kind: 'spawn-exit'; at: string; pid: number; exitCode: number | null; afterMs: number | null }
  | {
      kind: 'endpoint-watch'
      at: string
      found: boolean
      waitedMs: number
      /** The child's fate when the watch failed — the nameable step. */
      detail?: string
    }
  | { kind: 'adoption-outcome'; at: string; ok: boolean; code?: string; detail: string }

export type BootAdoptionJournal = {
  /** Appends one entry; never throws (diagnostics never fail a boot). */
  append(entry: BootAdoptionEntry): void
  /** The journal's absolute path (surfaced in failure messages). */
  path(): string
}

/** The journal lives beside the supervision engine's launch/exit records so
 *  one directory holds the whole boot-adoption story. */
export function bootAdoptionJournalPath(dataDir: string): string {
  return join(dataDir, 'dev-runtime', 'supervision', BOOT_ADOPTION_JOURNAL_FILE)
}

function lineCount(path: string): number {
  const raw = readFileSync(path, 'utf8')
  if (raw.length === 0) return 0
  return raw.split('\n').filter((line) => line.length > 0).length
}

/** Keeps only the most recent `TRIM_TO_LINES` lines (atomic rewrite, mirroring
 *  the record journal's prune). Returns the new line count, or null when the
 *  file is unreadable (the caller treats diagnostics as best-effort). */
function trimToBound(path: string): number | null {
  try {
    const lines = readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
    if (lines.length <= MAX_LINES) return lines.length
    const kept = lines.slice(lines.length - TRIM_TO_LINES)
    const tempPath = `${path}.tmp`
    writeFileSync(tempPath, `${kept.join('\n')}\n`, { mode: 0o600 })
    renameSync(tempPath, path)
    return kept.length
  } catch {
    return null
  }
}

/**
 * Create (or reopen) the boot-adoption journal under the data dir. The
 * directory and file are owner-only from creation (creation modes do not
 * tighten permissions on an existing journal, so the modes are reasserted).
 * Every write is best-effort: an unwritable location degrades to a no-op
 * journal whose path still names where the evidence would have been.
 */
export function createBootAdoptionJournal(dataDir: string): BootAdoptionJournal {
  const path = bootAdoptionJournalPath(dataDir)
  const dir = join(path, '..')
  let lines: number | null = null
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    if (!existsSync(path)) writeFileSync(path, '', { mode: 0o600 })
    chmodSync(path, 0o600)
    // A journal left beyond the bound by a previous run is trimmed here, so
    // creation is always within retention.
    const counted = trimToBound(path)
    lines = counted ?? lineCount(path)
  } catch {
    lines = null
  }
  let appends = 0
  return {
    append(entry: BootAdoptionEntry): void {
      if (lines === null) return
      try {
        appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
        appends += 1
        // Recount and trim periodically; any writer's trim bounds the file.
        if (appends % 32 === 0) {
          const counted = trimToBound(path)
          if (counted !== null) lines = counted
        }
      } catch {
        /* diagnostics never fail the boot */
      }
    },
    path(): string {
      return path
    },
  }
}

/** Owner-only mode assertions used by tests. */
export function bootAdoptionJournalModes(dataDir: string): { dirMode: number; fileMode: number } {
  const path = bootAdoptionJournalPath(dataDir)
  return {
    dirMode: statSync(join(path, '..')).mode & 0o777,
    fileMode: statSync(path).mode & 0o777,
  }
}
