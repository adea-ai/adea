import {
  ROOM_GALLERY_BOUNDS,
  ROOM_GALLERY_DOORWAYS,
  ROOM_GALLERY_DOORWAY_CLEARANCE_DEPTH,
  ROOM_GALLERY_FOUNDATION_PIECES,
  ROOM_GALLERY_FOUNDATION_TOP_Y,
  ROOM_GALLERY_HUB,
  ROOM_GALLERY_INTERIOR_WALL_THICKNESS,
  ROOM_GALLERY_MAIN_ENTRY_WALL_SHIFT,
  ROOM_GALLERY_OUTSIDE_DOORWAY_WIDTH,
  ROOM_GALLERY_PATHWAY_SIDE_WALL_EXTENSION,
  ROOM_GALLERY_RUNTIME_SCALE,
  ROOM_GALLERY_WALL_SEGMENTS,
} from '@agent-hq/interior/room-config'
import type { RoomDesignerRect } from './room-designer'

/** Room Designer's authored map and placement constraints for the HQ gallery. */
export const hqRoomDesignerSceneScale = ROOM_GALLERY_RUNTIME_SCALE
export const hqRoomDesignerGroundY = ROOM_GALLERY_FOUNDATION_TOP_Y
export const hqRoomDesignerGridSize = ROOM_GALLERY_INTERIOR_WALL_THICKNESS
export const hqRoomDesignerMapBounds: RoomDesignerRect = {
  id: 'hq-map',
  x: 0,
  z: 0,
  width: ROOM_GALLERY_BOUNDS.width,
  depth: ROOM_GALLERY_BOUNDS.depth,
}
export const hqRoomDesignerRegions: readonly RoomDesignerRect[] =
  ROOM_GALLERY_FOUNDATION_PIECES.map(({ id, x, z, width, depth }) => ({ id, x, z, width, depth }))

const hqOuterHorizontalBoundary = Math.max(
  ...ROOM_GALLERY_WALL_SEGMENTS.filter(
    ({ orientation, wallKind }) => orientation === 'horizontal' && wallKind === 'exterior'
  ).map(({ z }) => Math.abs(z))
)
const hqOuterVerticalBoundary = Math.max(
  ...ROOM_GALLERY_WALL_SEGMENTS.filter(
    ({ orientation, wallKind }) => orientation === 'vertical' && wallKind === 'exterior'
  ).map(({ x }) => Math.abs(x))
)

// Keep editor collision rectangles in the same positions as the generated
// visual/collision walls. Exterior walls are shifted outward by half their
// thickness; using the unshifted segment center made the editor reserve an
// extra grid cell inside every thick perimeter wall.
export const hqRoomDesignerBlockedRects: readonly RoomDesignerRect[] =
  ROOM_GALLERY_WALL_SEGMENTS.map((segment) => {
    const isHorizontal = segment.orientation === 'horizontal'
    const isExterior = segment.wallKind === 'exterior'
    const offset = isExterior
      ? segment.thickness / 2
      : segment.wallPlacement === 'center'
        ? 0
        : segment.thickness / 2
    let x = isHorizontal
      ? segment.x
      : segment.x +
        (isExterior
          ? segment.wallSide === 'left'
            ? -offset
            : offset
          : segment.wallSide === 'left'
            ? offset
            : -offset)
    let z = isHorizontal
      ? segment.z +
        (isExterior
          ? segment.wallSide === 'bottom'
            ? -offset
            : offset
          : segment.wallSide === 'bottom'
            ? offset
            : -offset)
      : segment.z
    let length = segment.length

    if (isHorizontal && isExterior && Math.abs(segment.z - ROOM_GALLERY_HUB.zMax) < 0.001) {
      z -= ROOM_GALLERY_MAIN_ENTRY_WALL_SHIFT
      length += ROOM_GALLERY_PATHWAY_SIDE_WALL_EXTENSION
      x +=
        segment.x > 0
          ? -ROOM_GALLERY_PATHWAY_SIDE_WALL_EXTENSION / 2
          : ROOM_GALLERY_PATHWAY_SIDE_WALL_EXTENSION / 2
    }

    const boundary = isHorizontal ? hqOuterVerticalBoundary : hqOuterHorizontalBoundary
    const axisCenter = isHorizontal ? segment.x : segment.z
    const spanStart = axisCenter - segment.length / 2
    const spanEnd = axisCenter + segment.length / 2
    const extendStart = isExterior && Math.abs(spanStart + boundary) < 0.001 ? segment.thickness : 0
    const extendEnd = isExterior && Math.abs(spanEnd - boundary) < 0.001 ? segment.thickness : 0
    if (extendStart || extendEnd) {
      const expandedStart = spanStart - extendStart
      const expandedEnd = spanEnd + extendEnd
      length = expandedEnd - expandedStart
      if (isHorizontal) x = (expandedStart + expandedEnd) / 2
      else z = (expandedStart + expandedEnd) / 2
    }

    return {
      id: segment.id,
      x,
      z,
      width: isHorizontal ? length : segment.thickness,
      depth: isHorizontal ? segment.thickness : length,
    }
  })

export const hqRoomDesignerDoorwayRects: readonly RoomDesignerRect[] = ROOM_GALLERY_DOORWAYS.map(
  (doorway) => ({
    id: `doorway-clearance-${doorway.id}`,
    x: doorway.x,
    z: doorway.z,
    width:
      doorway.orientation === 'horizontal' ? doorway.width : ROOM_GALLERY_DOORWAY_CLEARANCE_DEPTH,
    depth:
      doorway.orientation === 'horizontal' ? ROOM_GALLERY_DOORWAY_CLEARANCE_DEPTH : doorway.width,
  })
)

export const hqRoomDesignerPlayerPosition = {
  x: 0,
  z: ROOM_GALLERY_HUB.zMax - 120,
} as const
export const hqRoomDesignerNormalOrthographicHalfHeight = 720
export const hqRoomDesignerDesignOrthographicHalfHeight = 1320
export const hqRoomDesignerBackdropColor = 0x171717
export const hqRoomDesignerBackdropPadding = 840

export const hqRoomDesignerFrontWalkwayBlockedRect: RoomDesignerRect = {
  id: 'front-walkway',
  x: 0,
  z: (ROOM_GALLERY_HUB.zMax - ROOM_GALLERY_MAIN_ENTRY_WALL_SHIFT + ROOM_GALLERY_BOUNDS.zMax) / 2,
  width: ROOM_GALLERY_OUTSIDE_DOORWAY_WIDTH,
  depth: ROOM_GALLERY_BOUNDS.zMax - (ROOM_GALLERY_HUB.zMax - ROOM_GALLERY_MAIN_ENTRY_WALL_SHIFT),
}
