/*
 * Copyright (c) 2026 T3 Tools Inc.
 * Licensed under the MIT License.
 *
 * Annotation interaction model and picked-element payload validation,
 * substantially transcribed from t3code apps/desktop/src/preview/
 * AnnotationKeyboard.ts, PickedElementPayload.ts, and their test files
 * (MIT), revision 77bca8b2d76a1f42552e5eee7d277fcb1160347a. Validation is
 * intentionally tight: picked payloads come from untrusted page content, so
 * non-finite numbers and wrong-typed fields fail closed before anything
 * reaches a command body. See NOTICE and docs/research/dev-view-donor-audit.md.
 */

export type AnnotationSubmission = 'attach' | 'send'

/** Enter = attach, Cmd/Ctrl+Enter = send, Shift+Enter = newline, IME = null. */
export function resolveAnnotationSubmission(event: {
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly isComposing: boolean
}): AnnotationSubmission | null {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return null
  return event.metaKey || event.ctrlKey ? 'send' : 'attach'
}

/** Tools mirror the donor overlay: select, region, draw, erase. */
export type AnnotationTool = 'select' | 'marquee' | 'draw' | 'erase'

/** Plain v/r/d/e switches tools; Escape cancels the whole annotation session. */
export function resolveAnnotationShortcut(event: {
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
}): { kind: 'tool'; tool: AnnotationTool } | { kind: 'cancel' } | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null
  if (event.key === 'Escape') return { kind: 'cancel' }
  if (event.key === 'v' || event.key === 'V') return { kind: 'tool', tool: 'select' }
  if (event.key === 'r' || event.key === 'R') return { kind: 'tool', tool: 'marquee' }
  if (event.key === 'd' || event.key === 'D') return { kind: 'tool', tool: 'draw' }
  if (event.key === 'e' || event.key === 'E') return { kind: 'tool', tool: 'erase' }
  return null
}

// ── Picked element payload validation ───────────────────────────────────────

export interface PickedStackFrame {
  functionName: string | null
  fileName: string | null
  lineNumber: number | null
  columnNumber: number | null
}

export interface PickedElementPayload {
  pageUrl: string
  pageTitle: string | null
  tagName: string
  selector: string | null
  componentName: string | null
  htmlPreview: string
  styles: string
  pickedAt: string
  source: PickedStackFrame | null
  stack: PickedStackFrame[]
}

function isFramePayload(value: unknown): value is PickedStackFrame {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const frame = value as Record<string, unknown>
  return (
    (frame.functionName === null || typeof frame.functionName === 'string') &&
    (frame.fileName === null || typeof frame.fileName === 'string') &&
    (frame.lineNumber === null ||
      (typeof frame.lineNumber === 'number' && Number.isFinite(frame.lineNumber))) &&
    (frame.columnNumber === null ||
      (typeof frame.columnNumber === 'number' && Number.isFinite(frame.columnNumber)))
  )
}

export function isPickedElementPayload(value: unknown): value is PickedElementPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const payload = value as Record<string, unknown>
  return (
    typeof payload.pageUrl === 'string' &&
    (payload.pageTitle === null || typeof payload.pageTitle === 'string') &&
    typeof payload.tagName === 'string' &&
    (payload.selector === null || typeof payload.selector === 'string') &&
    (payload.componentName === null || typeof payload.componentName === 'string') &&
    typeof payload.htmlPreview === 'string' &&
    typeof payload.styles === 'string' &&
    typeof payload.pickedAt === 'string' &&
    (payload.source === null || isFramePayload(payload.source)) &&
    Array.isArray(payload.stack) &&
    payload.stack.every(isFramePayload)
  )
}

export interface AnnotationRegionRect {
  x: number
  y: number
  width: number
  height: number
}

export interface AnnotationElementEntry {
  id: string
  element: PickedElementPayload
  rect: AnnotationRegionRect
}

export interface PreviewAnnotationPayload {
  id: string
  pageUrl: string
  pageTitle: string | null
  comment: string
  createdAt: string
  /** The guest may never supply screenshots; the host captures. */
  screenshot: null
  elements: AnnotationElementEntry[]
  regions: { id: string; rect: AnnotationRegionRect }[]
  strokes: {
    id: string
    color: string
    width: number
    points: { x: number; y: number }[]
    bounds: AnnotationRegionRect
  }[]
  styleChanges: {
    targetId: string
    selector: string | null
    property: string
    previousValue: string
    value: string
  }[]
}

function isRect(value: unknown): value is AnnotationRegionRect {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const rect = value as Record<string, unknown>
  return (
    typeof rect.x === 'number' &&
    Number.isFinite(rect.x) &&
    typeof rect.y === 'number' &&
    Number.isFinite(rect.y) &&
    typeof rect.width === 'number' &&
    Number.isFinite(rect.width) &&
    typeof rect.height === 'number' &&
    Number.isFinite(rect.height)
  )
}

export function isPreviewAnnotationPayload(value: unknown): value is PreviewAnnotationPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const payload = value as Record<string, unknown>
  return (
    typeof payload.id === 'string' &&
    typeof payload.pageUrl === 'string' &&
    (payload.pageTitle === null || typeof payload.pageTitle === 'string') &&
    typeof payload.comment === 'string' &&
    typeof payload.createdAt === 'string' &&
    payload.screenshot === null &&
    Array.isArray(payload.elements) &&
    payload.elements.every((entry) => {
      if (typeof entry !== 'object' || entry === null) return false
      const item = entry as Record<string, unknown>
      return (
        typeof item.id === 'string' && isPickedElementPayload(item.element) && isRect(item.rect)
      )
    }) &&
    Array.isArray(payload.regions) &&
    payload.regions.every((entry) => {
      if (typeof entry !== 'object' || entry === null) return false
      const item = entry as Record<string, unknown>
      return typeof item.id === 'string' && isRect(item.rect)
    }) &&
    Array.isArray(payload.strokes) &&
    payload.strokes.every((entry) => {
      if (typeof entry !== 'object' || entry === null) return false
      const stroke = entry as Record<string, unknown>
      return (
        typeof stroke.id === 'string' &&
        typeof stroke.color === 'string' &&
        typeof stroke.width === 'number' &&
        Number.isFinite(stroke.width) &&
        Array.isArray(stroke.points) &&
        stroke.points.every((point) =>
          isRect({
            x: (point as { x: number }).x,
            y: (point as { y: number }).y,
            width: 1,
            height: 1,
          })
        ) &&
        isRect(stroke.bounds)
      )
    }) &&
    Array.isArray(payload.styleChanges) &&
    payload.styleChanges.every((entry) => {
      if (typeof entry !== 'object' || entry === null) return false
      const change = entry as Record<string, unknown>
      return (
        typeof change.targetId === 'string' &&
        (change.selector === null || typeof change.selector === 'string') &&
        typeof change.property === 'string' &&
        typeof change.previousValue === 'string' &&
        typeof change.value === 'string'
      )
    })
  )
}
