/*
 * Pins the lane-kind display labels (app-bugs audit: "Mini preview shows the
 * raw lane kind"). Every wire kind must project to its designed label — the
 * raw identifier never reaches a surface as display text.
 */
import { describe, expect, test } from 'bun:test'

import { LANE_KIND_LABEL } from '../src/browser/lane-kind-label'

const WIRE_KINDS = ['human_embedded', 'task_owned', 'user_context'] as const

describe('lane kind labels', () => {
  test('every wire kind has a designed label and nothing else', () => {
    expect(Object.keys(LANE_KIND_LABEL).toSorted()).toEqual([...WIRE_KINDS].toSorted())
  })

  test('labels are nonblank and humanized, never the raw kind', () => {
    for (const kind of WIRE_KINDS) {
      const label = LANE_KIND_LABEL[kind]
      expect(label.length).toBeGreaterThan(0)
      expect(label).not.toBe(kind)
      expect(label).not.toMatch(/_/)
    }
  })
})
