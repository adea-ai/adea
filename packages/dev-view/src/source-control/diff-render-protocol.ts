/*
 * Off-main-thread diff render protocol (#677, the #399 residue box "diff
 * parsing/rendering runs off the main thread"). The messages are pure data —
 * `DiffHunk` pages in, rendered per-hunk line payloads out — so the same
 * shapes are structured-cloneable across `postMessage` and directly testable
 * at the model level without a DOM or a real worker.
 */
import type { DiffHunk } from '@adea-ai/types/dev-runtime'
import type { RenderedDiffLine } from './source-control-model'

/** One hunk's rendered body (the pane draws its own hunk bar, so the meta
 *  header line is intentionally not part of the payload). */
export type RenderedHunk = Readonly<{
  /** The hunk's index in the flat diff page the request carried. */
  index: number
  lines: readonly RenderedDiffLine[]
  /** The hunk hit the render budget and its tail was cut. */
  truncated: boolean
}>

export type RenderedFileGroup = Readonly<{
  path: string
  hunks: readonly RenderedHunk[]
}>

export type DiffRenderRequest = Readonly<{
  id: number
  hunks: readonly DiffHunk[]
  budgetLines: number
}>

export type DiffRenderSuccess = Readonly<{
  id: number
  ok: true
  files: readonly RenderedFileGroup[]
}>

export type DiffRenderFailure = Readonly<{
  id: number
  ok: false
}>

export type DiffRenderReply = DiffRenderSuccess | DiffRenderFailure

/** Structural reply validation: a malformed frame is refused, never trusted. */
export function isDiffRenderReply(value: unknown): value is DiffRenderReply {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { id?: unknown; ok?: unknown }
  return typeof candidate.id === 'number' && typeof candidate.ok === 'boolean'
}
