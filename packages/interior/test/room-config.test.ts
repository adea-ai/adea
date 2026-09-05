import { describe, expect, test } from 'bun:test'
import {
  ROOM_GALLERY_BOUNDS,
  ROOM_GALLERY_PERIMETER_BOUNDS,
  ROOM_GALLERY_PERIMETER_SIDEWALK_DEPTH,
} from '../src/room-config'

describe('HQ perimeter sidewalk', () => {
  test('surrounds every fence edge with the same authored padding', () => {
    const padding = ROOM_GALLERY_PERIMETER_SIDEWALK_DEPTH

    expect(ROOM_GALLERY_PERIMETER_BOUNDS).toEqual({
      xMin: ROOM_GALLERY_BOUNDS.xMin - padding,
      xMax: ROOM_GALLERY_BOUNDS.xMax + padding,
      zMin: ROOM_GALLERY_BOUNDS.zMin - padding,
      zMax: ROOM_GALLERY_BOUNDS.zMax + padding,
      width: ROOM_GALLERY_BOUNDS.width + padding * 2,
      depth: ROOM_GALLERY_BOUNDS.depth + padding * 2,
    })
  })
})
