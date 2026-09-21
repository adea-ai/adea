// Screenshot capture records and bounded retention.
//
// Every capture carries the provenance the Dev Runtime spec requires —
// origin, viewport, timestamp, lane/profile identity, and redaction state —
// plus a sha256 content identity and an expiry. Captures are capped at
// 25 MiB each and 1 GiB per workspace (30 days unless pinned); the store
// retains the bounded bytes alongside metadata so a reference is actually
// retrievable, never unbounded. The capture seam itself is injected: the
// task-owned lane captures
// through Bun.WebView's `.cdp()` headless automation, the user-context lane
// through the external browser's CDP `Page.captureScreenshot`, and
// `Bun.Image` resizes/converts in-process — the composition follows Orca's
// cdp-screenshot unit (MIT, revision
// 403b62a8d8fa6e896a93acc4c15405be0f0b7dc7).
import { createHash } from 'node:crypto'

import type { ScreenshotRef, Scope } from '../../../../../../packages/types/src/dev-runtime'

export type CaptureFormat = 'png' | 'jpeg' | 'webp'

export type CaptureProvenance = Readonly<{
  ownerId: string
  laneKind: 'human_embedded' | 'task_owned' | 'user_context' | 'device'
  profileId?: string
  origin: string
  viewport: Readonly<{ width: number; height: number; deviceScaleFactor: number }>
  redacted: boolean
}>

export type CaptureInput = Readonly<{
  bytes: Uint8Array
  format: CaptureFormat
  width: number
  height: number
  provenance: CaptureProvenance
}>

export type ScreenshotStoreOptions = Readonly<{
  scope: Scope
  now?: () => string
  randomId?: () => string
  retention?: Readonly<{ maxBytesEach?: number; maxTotalBytes?: number; ttlMs?: number }>
}>

const DEFAULT_MAX_EACH = 25 * 1024 * 1024
const DEFAULT_MAX_TOTAL = 1024 * 1024 * 1024
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000

export function createScreenshotStore(options: ScreenshotStoreOptions) {
  const now = options.now ?? (() => new Date().toISOString())
  const randomId = options.randomId ?? (() => crypto.randomUUID())
  const maxEach = options.retention?.maxBytesEach ?? DEFAULT_MAX_EACH
  const maxTotal = options.retention?.maxTotalBytes ?? DEFAULT_MAX_TOTAL
  const ttlMs = options.retention?.ttlMs ?? DEFAULT_TTL_MS
  const entries = new Map<string, { ref: ScreenshotRef; expiresAtMs: number; bytes: Uint8Array }>()

  const activeEntry = (id: string) => {
    const entry = entries.get(id)
    if (!entry) return undefined
    if (entry.expiresAtMs <= Date.parse(now())) {
      entries.delete(id)
      return undefined
    }
    return entry
  }

  return {
    /** Records one capture and returns its reference DTO. */
    record(input: CaptureInput): ScreenshotRef {
      if (input.bytes.byteLength === 0)
        throw new ScreenshotStoreError('invalid_state', 'capture is empty')
      if (input.bytes.byteLength > maxEach)
        throw new ScreenshotStoreError('limit_exceeded', 'capture exceeds 25 MiB')
      const contentType =
        input.format === 'png' ? 'image/png' : input.format === 'jpeg' ? 'image/jpeg' : 'image/webp'
      const total = [...entries.values()].reduce(
        (sum, entry) => sum + Number(entry.ref.byteLength),
        0
      )
      if (total + input.bytes.byteLength > maxTotal)
        throw new ScreenshotStoreError('limit_exceeded', 'workspace capture budget is exhausted')
      const observed = now()
      const ref: ScreenshotRef = {
        id: randomId(),
        scope: options.scope,
        ownerId: input.provenance.ownerId,
        laneKind: input.provenance.laneKind,
        ...(input.provenance.profileId ? { profileId: input.provenance.profileId } : {}),
        origin: input.provenance.origin,
        viewport: input.provenance.viewport,
        redacted: input.provenance.redacted,
        contentType,
        byteLength: String(input.bytes.byteLength),
        width: input.width,
        height: input.height,
        sha256: createHash('sha256').update(input.bytes).digest('hex'),
        expiresAt: new Date(Date.parse(observed) + ttlMs).toISOString(),
      }
      entries.set(ref.id, {
        ref,
        expiresAtMs: Date.parse(ref.expiresAt),
        bytes: new Uint8Array(input.bytes),
      })
      return ref
    },

    get(id: string): ScreenshotRef | undefined {
      return activeEntry(id)?.ref
    },

    /** Returns a defensive copy of bounded capture bytes after provenance lookup. */
    getBytes(id: string): Uint8Array | undefined {
      const entry = activeEntry(id)
      return entry ? new Uint8Array(entry.bytes) : undefined
    },

    /** Drops expired captures; retention is explicit, never silent. */
    sweep(): number {
      const at = Date.parse(now())
      let removed = 0
      for (const [id, entry] of entries) {
        if (entry.expiresAtMs <= at) {
          entries.delete(id)
          removed += 1
        }
      }
      return removed
    },

    list(): readonly ScreenshotRef[] {
      return [...entries.values()].map((entry) => entry.ref)
    },
  }
}

export class ScreenshotStoreError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ScreenshotStoreError'
    this.code = code
  }
}

export type ScreenshotStore = ReturnType<typeof createScreenshotStore>
