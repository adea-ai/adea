/*
 * Annotation surface model (#718): normalized region geometry, keyboard
 * nudging, and the disable-with-reason matrix. The model is DOM-free on
 * purpose so the surface's interaction rules are testable without a renderer.
 */
import { describe, expect, test } from 'bun:test'

import type { BrowserAnnotation } from '@adea-ai/types/dev-runtime'
import {
  MIN_REGION_SPAN,
  NUDGE_STEP,
  annotationDisabledReason,
  annotationRequest,
  clamp01,
  describeAnnotationResult,
  describeDraft,
  dragRegion,
  isRegionSubmittable,
  nudgeRegion,
} from '../src/browser/annotation-surface-model'

const fullAvailability = {
  serviceReady: true,
  targetsLoading: false,
  hasLane: true,
  laneState: 'ready' as const,
  laneKind: 'task_owned' as const,
  automationOwner: 'human_takeover' as const,
  hasPageTarget: true,
}

describe('region geometry', () => {
  test('normalizes a drag in any direction into a nonnegative top-left rect', () => {
    const draggedRight = dragRegion({ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.6 })
    expect(draggedRight).toEqual({ kind: 'rect', x: 0.1, y: 0.2, width: 0.3, height: 0.4 })
    const draggedLeft = dragRegion({ x: 0.4, y: 0.6 }, { x: 0.1, y: 0.2 })
    expect(draggedLeft).toEqual({ kind: 'rect', x: 0.1, y: 0.2, width: 0.3, height: 0.4 })
  })

  test('clamps pointer coordinates outside the frame', () => {
    expect(clamp01(-0.5)).toBe(0)
    expect(clamp01(1.5)).toBe(1)
    const dragged = dragRegion({ x: -0.5, y: -0.5 }, { x: 1.5, y: 1.5 })
    expect(dragged).toEqual({ kind: 'rect', x: 0, y: 0, width: 1, height: 1 })
  })

  test('a stray click below the span threshold is not a region', () => {
    const region = dragRegion({ x: 0.5, y: 0.5 }, { x: 0.504, y: 0.504 })
    expect(isRegionSubmittable(region)).toBe(false)
    expect(isRegionSubmittable(dragRegion({ x: 0.5, y: 0.5 }, { x: 0.53, y: 0.53 }))).toBe(true)
    expect(MIN_REGION_SPAN).toBeGreaterThan(0)
  })
})

describe('keyboard adjustment', () => {
  const draft = { kind: 'rect' as const, x: 0.4, y: 0.4, width: 0.2, height: 0.2 }

  test('arrows move the region and clamp at the frame edges', () => {
    expect(nudgeRegion(draft, 'left').x).toBeCloseTo(0.4 - NUDGE_STEP)
    expect(nudgeRegion(draft, 'down').y).toBeCloseTo(0.4 + NUDGE_STEP)
    const atEdge = { ...draft, x: 0.9 }
    expect(nudgeRegion(atEdge, 'right').x).toBe(0.8)
  })

  test('shift+arrows resize from the trailing edge without collapsing below the threshold', () => {
    const shrunk = nudgeRegion(draft, 'left', { resize: true })
    expect(shrunk.width).toBeCloseTo(draft.width - NUDGE_STEP)
    const collapsed = nudgeRegion({ ...draft, width: MIN_REGION_SPAN }, 'left', {
      resize: true,
    })
    expect(collapsed.width).toBe(MIN_REGION_SPAN)
    const grown = nudgeRegion(draft, 'right', { resize: true })
    expect(grown.width).toBeCloseTo(draft.width + NUDGE_STEP)
    const atEdge = { ...draft, x: 0.9, width: 0.1 }
    expect(nudgeRegion(atEdge, 'right', { resize: true }).width).toBe(0.1)
  })
})

describe('availability reasons', () => {
  test('a servable lane has no reason', () => {
    expect(annotationDisabledReason(fullAvailability)).toBeUndefined()
  })

  test('each unservable state states its reason', () => {
    expect(annotationDisabledReason({ ...fullAvailability, serviceReady: false })).toMatch(
      /unavailable/
    )
    expect(annotationDisabledReason({ ...fullAvailability, hasLane: false })).toMatch(/lane/)
    expect(annotationDisabledReason({ ...fullAvailability, laneKind: 'human_embedded' })).toMatch(
      /cannot serve captures/
    )
    expect(annotationDisabledReason({ ...fullAvailability, laneState: 'crashed' })).toMatch(
      /crashed/
    )
    expect(annotationDisabledReason({ ...fullAvailability, automationOwner: 'agent' })).toMatch(
      /agent-owned/
    )
    expect(annotationDisabledReason({ ...fullAvailability, targetsLoading: true })).toMatch(
      /loading/
    )
    expect(annotationDisabledReason({ ...fullAvailability, hasPageTarget: false })).toMatch(
      /no page target/
    )
  })
})

describe('request binding', () => {
  test('a region draft maps to the strict rect annotation body and lane resource', () => {
    const request = annotationRequest({
      lane: { id: 'lane-1', generation: 3 },
      target: { id: 'target-9' },
      draft: { kind: 'rect', x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    })
    expect(request.operation).toBe('dev.browser.annotate')
    expect(request.body).toEqual({
      browserLaneId: 'lane-1',
      expectedGeneration: 3,
      targetId: 'target-9',
      annotation: { targetId: 'target-9', kind: 'rect', x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    })
    expect(request.resource).toEqual({ kind: 'browser_lane', id: 'lane-1', generation: 3 })
  })

  test('a note draft maps to a bounded text annotation at its anchor', () => {
    const request = annotationRequest({
      lane: { id: 'lane-1', generation: 3 },
      target: { id: 'target-9' },
      draft: { kind: 'text', x: 0.25, y: 0.5, text: 'This heading overlaps its badge.' },
    })
    expect(request.body.annotation).toEqual({
      targetId: 'target-9',
      kind: 'text',
      x: 0.25,
      y: 0.5,
      text: 'This heading overlaps its badge.',
    })
  })
})

describe('speech', () => {
  test('the draft announcement describes geometry or anchor', () => {
    expect(describeDraft(undefined)).toMatch(/No region/)
    expect(describeDraft({ kind: 'rect', x: 0.1, y: 0.2, width: 0.3, height: 0.4 })).toMatch(
      /10,20 — 30 by 40 percent/
    )
    expect(describeDraft({ kind: 'text', x: 0.25, y: 0.5, text: 'note' })).toMatch(/25,50 percent/)
  })

  test('the result line names the annotation and the screenshot it is bound to', () => {
    const result = {
      targetId: 'target-9',
      kind: 'rect',
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.4,
      id: 'annotation-0001-abcd',
      screenshotId: 'screenshot-0002-ef90',
      createdAt: '2026-10-03T00:00:00.000Z',
    } as BrowserAnnotation
    expect(describeAnnotationResult(result)).toMatch(
      /Region 10,20 30×40% · annotation annotati bound to screenshot screensh/
    )
  })
})
