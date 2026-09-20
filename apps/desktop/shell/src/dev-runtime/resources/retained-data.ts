// Read-only retained-data accounting for the #424 breakdown.
//
// The projection joins the three owning slices' stores without touching any
// of them: terminal checkpoint segments under the owner-only runtime root,
// the browser lane's bounded screenshot retention, and the dependency-template
// cache's durable records. Every source is byte accounting only — no listing
// here can read, move, or delete retained bytes.
//
// Truthfulness bar: each source is independently best-effort, and a source
// that cannot be observed contributes nothing (absent, never zero). The
// template store is parsed with a pure read (a corrupt file is never renamed
// or rewritten from here); terminal history is `protected` because deletion
// only ever happens through the terminal's own re-proved delete path.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type {
  RetainedDataRecord,
  Scope,
  ScreenshotRef,
} from '../../../../../../packages/types/src/dev-runtime'

export type RetainedDataProjectionInput = Readonly<{
  scope: Scope
  /** Owner-only terminal runtime root; checkpoint segments live at
   *  `<runtimeRoot>/<terminalId>/seg-*.adt` (issue #396 layout). */
  runtimeRoot?: string
  /** The #422/#396 browser lane's screenshot store (read-only `list`). */
  screenshots?: Readonly<{ list(): readonly ScreenshotRef[] }>
  /** The dependency-template cache's durable records file (read-only). */
  templateRecordsPath?: string
  now?: () => number
  randomId?: () => string
}>

export type RetainedDataProjection = () => readonly RetainedDataRecord[]

const TERMINAL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SEGMENT_PATTERN = /^seg-\d+-\d+-\d+\.adt$/

/** Terminal checkpoint bytes for one terminal, or nothing when unobservable. */
function terminalCheckpointRecord(input: {
  runtimeRoot: string
  terminalId: string
  observedAt: string
  recordId: string
}): RetainedDataRecord | undefined {
  if (!TERMINAL_ID_PATTERN.test(input.terminalId)) return undefined
  const sessionDir = join(input.runtimeRoot, input.terminalId)
  let total = 0
  let segments = 0
  try {
    for (const name of readdirSync(sessionDir)) {
      if (!SEGMENT_PATTERN.test(name)) continue
      const stat = statSync(join(sessionDir, name))
      if (!stat.isFile()) continue
      total += stat.size
      segments += 1
    }
  } catch {
    return undefined
  }
  if (segments === 0) return undefined
  return {
    id: input.recordId,
    ownerId: input.terminalId,
    kind: 'terminal',
    byteLength: String(total),
    protected: true,
    observedAt: input.observedAt,
    label: `terminal checkpoint history (${segments} segment${segments === 1 ? '' : 's'})`,
  }
}

function screenshotRecords(input: {
  screenshots: Readonly<{ list(): readonly ScreenshotRef[] }>
  observedAt: string
  recordId: () => string
}): RetainedDataRecord[] {
  let refs: readonly ScreenshotRef[]
  try {
    refs = input.screenshots.list()
  } catch {
    return []
  }
  return refs.flatMap((ref) => {
    if (typeof ref.byteLength !== 'string') return []
    return [
      {
        id: input.recordId(),
        ownerId: ref.ownerId,
        kind: 'screenshot' as const,
        byteLength: ref.byteLength,
        protected: false,
        observedAt: input.observedAt,
        ...(ref.expiresAt !== undefined ? { expiresAt: ref.expiresAt } : {}),
        ...(ref.scope !== undefined ? { scope: ref.scope } : {}),
        label: `${ref.laneKind} screenshot (${ref.contentType})`,
      } satisfies RetainedDataRecord,
    ]
  })
}

type TemplateRecordShape = Readonly<{
  projectId?: unknown
  state?: unknown
  totalBytes?: unknown
  fileCount?: unknown
}>

/**
 * Pure read of the dependency-template cache's durable records: an envelope
 * `{ schemaVersion: 1, records: [...] }` whose ready entries carry their
 * promoted byte totals. Corruption or an unexpected shape contributes
 * nothing and mutates nothing (the owning cache owns recovery).
 */
function templateRecords(path: string): readonly TemplateRecordShape[] {
  if (!existsSync(path)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
  const envelope = parsed as { schemaVersion?: unknown; records?: unknown } | null
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    envelope.schemaVersion !== 1 ||
    !Array.isArray(envelope.records)
  )
    return []
  return envelope.records.filter(
    (entry): entry is TemplateRecordShape =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry)
  )
}

function templateRecord(input: {
  record: TemplateRecordShape
  observedAt: string
  recordId: () => string
}): RetainedDataRecord | undefined {
  const { record } = input
  if (record.state !== 'ready' || typeof record.totalBytes !== 'number' || record.totalBytes < 0)
    return undefined
  if (typeof record.projectId !== 'string') return undefined
  return {
    id: input.recordId(),
    ownerId: record.projectId,
    kind: 'dependency_template',
    byteLength: String(record.totalBytes),
    protected: false,
    observedAt: input.observedAt,
    ...(typeof record.fileCount === 'number'
      ? { label: `dependency template (${record.fileCount} files)` }
      : { label: 'dependency template' }),
  }
}

/**
 * The retained-data seam: one call returns the byte breakdown every source
 * could prove at read time. Absent sources are absent from the reply —
 * never zero, never fabricated.
 */
export function createRetainedDataProjection(
  input: RetainedDataProjectionInput
): RetainedDataProjection {
  const now = input.now ?? Date.now
  const randomId = input.randomId ?? (() => crypto.randomUUID())
  return () => {
    const observedAt = new Date(now()).toISOString()
    const records: RetainedDataRecord[] = []
    if (input.runtimeRoot) {
      let terminalIds: string[] = []
      try {
        terminalIds = readdirSync(input.runtimeRoot)
      } catch {
        terminalIds = []
      }
      for (const terminalId of terminalIds) {
        const record = terminalCheckpointRecord({
          runtimeRoot: input.runtimeRoot,
          terminalId,
          observedAt,
          recordId: randomId(),
        })
        if (record) records.push(record)
      }
    }
    if (input.screenshots) {
      records.push(
        ...screenshotRecords({ screenshots: input.screenshots, observedAt, recordId: randomId })
      )
    }
    if (input.templateRecordsPath) {
      for (const record of templateRecords(input.templateRecordsPath)) {
        const projected = templateRecord({ record, observedAt, recordId: randomId })
        if (projected) records.push(projected)
      }
    }
    return records
  }
}
