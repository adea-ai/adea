/*
 * Copyright (c) 2026 T3 Tools Inc.
 * Licensed under the MIT License.
 *
 * Annotation surface model for the browser pane (#718). The wire contract is
 * normalized coordinates — `BrowserAnnotationInput` carries x/y/width/height
 * as 0..1 fractions of the page viewport — so this model works in that space
 * end to end and the pane never touches pixels: the spec keeps BrowserPane
 * closed to image projection while captures record `redacted: false`, so the
 * surface is a viewport-shaped frame, not a screenshot. Drag and keyboard
 * region semantics follow the t3code annotation interaction model already
 * transcribed in annotation-model.ts (MIT, revision
 * 77bca8b2d76a1f42552e5eee7d277fcb1160347a); the tool set is smaller than the
 * donor's because the wire kind is what bounds it: region (rect) and note
 * (text) submit, everything else has no wire representation. See NOTICE and
 * docs/research/dev-view-donor-audit.md.
 */

import type { BrowserAnnotation, BrowserLane, BrowserLaneState } from '@adea-ai/types/dev-runtime'

export type AnnotationPoint = Readonly<{ x: number; y: number }>

export type AnnotationRectDraft = Readonly<{
  kind: 'rect'
  x: number
  y: number
  width: number
  height: number
}>

export type AnnotationNoteDraft = Readonly<{
  kind: 'text'
  x: number
  y: number
  text: string
}>

export type AnnotationDraft = AnnotationRectDraft | AnnotationNoteDraft

/** The two surface tools; only wire-backed kinds are offered. */
export type AnnotationSurfaceTool = 'region' | 'note'

/** A drag shorter than this in either axis is a stray click, not a region. */
export const MIN_REGION_SPAN = 0.01

/** Arrow-key nudge step, as a fraction of the frame. */
export const NUDGE_STEP = 0.01

/** Alt+arrow fine step, for precise region edges. */
export const NUDGE_FINE_STEP = 0.002

export const MAX_NOTE_LENGTH = 4096

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** Geometry rounds to four decimals: pointer math and nudge steps are float
 * noisy, and the wire carries cleaner fractions for it. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

/**
 * The region between two normalized pointer points, drag direction agnostic:
 * the draft always carries a nonnegative width/height with the top-left
 * corner in x/y.
 */
export function dragRegion(start: AnnotationPoint, current: AnnotationPoint): AnnotationRectDraft {
  const x = Math.min(start.x, current.x)
  const y = Math.min(start.y, current.y)
  return {
    kind: 'rect',
    x: round4(clamp01(x)),
    y: round4(clamp01(y)),
    width: round4(clamp01(Math.abs(current.x - start.x))),
    height: round4(clamp01(Math.abs(current.y - start.y))),
  }
}

/** A drag narrower than the threshold in either axis is not a region. */
export function isRegionSubmittable(draft: AnnotationRectDraft): boolean {
  return draft.width >= MIN_REGION_SPAN && draft.height >= MIN_REGION_SPAN
}

function moveRect(draft: AnnotationRectDraft, dx: number, dy: number): AnnotationRectDraft {
  const x = clamp01(draft.x + dx)
  const y = clamp01(draft.y + dy)
  return {
    ...draft,
    x: round4(Math.min(x, 1 - draft.width)),
    y: round4(Math.min(y, 1 - draft.height)),
  }
}

function resizeRect(draft: AnnotationRectDraft, dw: number, dh: number): AnnotationRectDraft {
  return {
    ...draft,
    width: round4(clamp01(Math.max(MIN_REGION_SPAN, Math.min(draft.width + dw, 1 - draft.x)))),
    height: round4(clamp01(Math.max(MIN_REGION_SPAN, Math.min(draft.height + dh, 1 - draft.y)))),
  }
}

/**
 * Arrow-key adjustment: arrows move the region, Shift+arrows grow or shrink
 * it from the bottom-right edge. Movement that would leave the frame clamps
 * instead of wrapping, so the draft stays inside the viewport at every step.
 */
export function nudgeRegion(
  draft: AnnotationRectDraft,
  key: 'up' | 'down' | 'left' | 'right',
  options: { resize?: boolean; step?: number } = {}
): AnnotationRectDraft {
  const step = options.step ?? NUDGE_STEP
  const direction = key === 'up' || key === 'left' ? -1 : 1
  if (options.resize) {
    return key === 'left' || key === 'right'
      ? resizeRect(draft, step * direction, 0)
      : resizeRect(draft, 0, step * direction)
  }
  return key === 'left' || key === 'right'
    ? moveRect(draft, step * direction, 0)
    : moveRect(draft, 0, step * direction)
}

export type AnnotationAvailability = Readonly<{
  serviceReady: boolean
  targetsLoading: boolean
  hasLane: boolean
  laneState?: BrowserLaneState
  laneKind?: BrowserLane['kind']
  automationOwner?: BrowserLane['automationOwner']
  hasPageTarget: boolean
}>

/**
 * Why the annotate control cannot serve the active lane, or undefined when it
 * can. Everything here is known before the command is issued: the packaged
 * human-embedded lane is refused by the engine (`capability_unavailable`)
 * because Electrobun exposes no CDP handle for it, a crashed or closing lane
 * has no frame to annotate, an agent-owned lane is not the human's to mark,
 * and without a page target there is nothing to capture at submit time.
 */
export function annotationDisabledReason(availability: AnnotationAvailability): string | undefined {
  if (!availability.serviceReady) return 'Browser lanes are unavailable on this host.'
  if (!availability.hasLane) return 'Create and select a browser lane first.'
  if (availability.laneKind === 'human_embedded')
    return 'This lane kind cannot serve captures on this host.'
  if (
    availability.laneState === 'crashed' ||
    availability.laneState === 'closing' ||
    availability.laneState === 'closed'
  )
    return `The lane is ${availability.laneState}; it cannot serve a frame.`
  if (availability.automationOwner === 'agent')
    return 'The lane is agent-owned — take over to annotate it.'
  if (availability.targetsLoading) return 'Lane targets are still loading.'
  if (!availability.hasPageTarget) return 'The active lane has no page target to annotate.'
  return undefined
}

export type AnnotationRequestContext = Readonly<{
  lane: Readonly<{ id: string; generation: number }>
  target: Readonly<{ id: string }>
  draft: AnnotationDraft
}>

/** The strict-decoder-conformant body plus resource binding for a draft. */
export function annotationRequest(context: AnnotationRequestContext): {
  operation: 'dev.browser.annotate'
  body: Record<string, unknown>
  resource: { kind: 'browser_lane'; id: string; generation: number }
} {
  const annotation =
    context.draft.kind === 'rect'
      ? {
          targetId: context.target.id,
          kind: 'rect' as const,
          x: context.draft.x,
          y: context.draft.y,
          width: context.draft.width,
          height: context.draft.height,
        }
      : {
          targetId: context.target.id,
          kind: 'text' as const,
          x: context.draft.x,
          y: context.draft.y,
          text: context.draft.text,
        }
  return {
    operation: 'dev.browser.annotate',
    body: {
      browserLaneId: context.lane.id,
      expectedGeneration: context.lane.generation,
      targetId: context.target.id,
      annotation,
    },
    resource: { kind: 'browser_lane', id: context.lane.id, generation: context.lane.generation },
  }
}

/** Spoken/printed form of a pending draft, for the live region. */
export function describeDraft(draft: AnnotationDraft | undefined): string {
  if (!draft) return 'No region marked yet.'
  if (draft.kind === 'rect')
    return (
      `Region at ${Math.round(draft.x * 100)},${Math.round(draft.y * 100)} — ` +
      `${Math.round(draft.width * 100)} by ${Math.round(draft.height * 100)} percent of the frame.`
    )
  return `Note anchored at ${Math.round(draft.x * 100)},${Math.round(draft.y * 100)} percent.`
}

/** Result line: the annotation is only useful through its bound screenshot. */
export function describeAnnotationResult(result: BrowserAnnotation): string {
  const where =
    result.kind === 'rect'
      ? `Region ${Math.round(result.x * 100)},${Math.round(result.y * 100)} ` +
        `${Math.round((result.width ?? 0) * 100)}×${Math.round((result.height ?? 0) * 100)}%`
      : result.kind === 'text'
        ? 'Note'
        : `Point ${Math.round(result.x * 100)},${Math.round(result.y * 100)}`
  return (
    `${where} · annotation ${result.id.slice(0, 8)} bound to screenshot ` +
    `${result.screenshotId.slice(0, 8)}`
  )
}
