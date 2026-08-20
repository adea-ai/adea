/** Shared geometry for the symmetrical HQ room gallery layout. */

export type RoomPlacement = readonly [
  id: string,
  position: readonly [number, number, number],
  quaternion: readonly [number, number, number, number],
  scale?: readonly [number, number, number],
];

export type RoomFootprintCategory = "3x3" | "6x3";
export type RoomGallerySlotKind = "square" | "rectangle";

export type RoomGalleryPlaceableSlot = Readonly<{
  id: string;
  category: RoomFootprintCategory;
  kind: RoomGallerySlotKind;
  x: number;
  z: number;
  width: number;
  depth: number;
  scale: readonly [number, number, number];
  quaternion: readonly [number, number, number, number];
}>;

/** Converts authored centimetres to the shared World metre coordinate space. */
export const ROOM_GALLERY_AUTHORED_UNIT_SCALE = 0.01;
/** Real-world scale: 600 authored units (6 m) render as exactly 6 m.
 *  The ithappy furniture models are authored in metres, so the environment
 *  uses the same 1:1 scale to keep everything consistent. */
export const ROOM_GALLERY_ENVIRONMENT_SCALE = 1.0;
export const ROOM_GALLERY_RUNTIME_SCALE =
  ROOM_GALLERY_AUTHORED_UNIT_SCALE * ROOM_GALLERY_ENVIRONMENT_SCALE;
export const ROOM_GALLERY_SQUARE_SIZE = 600;
export const ROOM_GALLERY_MERGED_ROOM_SIZE = { width: 1200, depth: 600 } as const;
export const ROOM_GALLERY_CENTRAL_ROOM_SIZE = { width: 1800, depth: 1212 } as const;
export const ROOM_GALLERY_EXTERIOR_WALL_THICKNESS = 24;
export const ROOM_GALLERY_INTERIOR_WALL_THICKNESS = 12;
/** Aligns the top external entry wall's inner edge with the hub's interior walls. */
export const ROOM_GALLERY_MAIN_ENTRY_WALL_SHIFT = ROOM_GALLERY_INTERIOR_WALL_THICKNESS;
/** Extends the two exterior wall spans beside the front walkway to close their seams. */
export const ROOM_GALLERY_PATHWAY_SIDE_WALL_EXTENSION = 6;
/** The raised concrete slab sits half a map unit above the grass surface. */
export const ROOM_GALLERY_FOUNDATION_SLAB_BASE_Y = 0;
export const ROOM_GALLERY_FOUNDATION_SLAB_HEIGHT = 6;
export const ROOM_GALLERY_FOUNDATION_TOP_Y =
  ROOM_GALLERY_FOUNDATION_SLAB_BASE_Y + ROOM_GALLERY_FOUNDATION_SLAB_HEIGHT;
/**
 * Keeps the top-room slab edges just inside the perpendicular exterior walls.
 * This removes coplanar slab/wall faces without changing the approved room
 * footprints or the wall dimensions.
 */
export const ROOM_GALLERY_FOUNDATION_SLAB_EDGE_INSET = 1;

const centralHalfWidth = ROOM_GALLERY_CENTRAL_ROOM_SIZE.width / 2;
const centralHalfDepth = ROOM_GALLERY_CENTRAL_ROOM_SIZE.depth / 2;
const squareHalfSize = ROOM_GALLERY_SQUARE_SIZE / 2;
const foundationHalfWidth = centralHalfWidth + ROOM_GALLERY_SQUARE_SIZE;
const foundationHalfDepth = centralHalfDepth + ROOM_GALLERY_MERGED_ROOM_SIZE.depth;
// Exterior walls sit fully outside the slab: their inner face aligns with the
// slab edge and their outer face defines the building envelope.
const buildingHalfWidth = foundationHalfWidth + ROOM_GALLERY_EXTERIOR_WALL_THICKNESS;
const buildingHalfDepth = foundationHalfDepth + ROOM_GALLERY_EXTERIOR_WALL_THICKNESS;
const grassBuffer = ROOM_GALLERY_EXTERIOR_WALL_THICKNESS * 2;

/** Exact outside edge of the building shell in the approved floor plan. */
export const ROOM_GALLERY_BUILDING_BOUNDS = {
  xMin: -buildingHalfWidth,
  xMax: buildingHalfWidth,
  zMin: -buildingHalfDepth,
  zMax: buildingHalfDepth,
  width: buildingHalfWidth * 2,
  depth: buildingHalfDepth * 2,
} as const;

/** The visual/collision map envelope, with two exterior-wall widths of grass. */
export const ROOM_GALLERY_BOUNDS = {
  xMin: ROOM_GALLERY_BUILDING_BOUNDS.xMin - grassBuffer,
  xMax: ROOM_GALLERY_BUILDING_BOUNDS.xMax + grassBuffer,
  zMin: ROOM_GALLERY_BUILDING_BOUNDS.zMin - grassBuffer,
  zMax: ROOM_GALLERY_BUILDING_BOUNDS.zMax + grassBuffer,
  width: ROOM_GALLERY_BUILDING_BOUNDS.width + grassBuffer * 2,
  depth: ROOM_GALLERY_BUILDING_BOUNDS.depth + grassBuffer * 2,
} as const;

/** Central room from the approved floor plan. */
export const ROOM_GALLERY_HUB = {
  xMin: -centralHalfWidth,
  xMax: centralHalfWidth,
  zMin: -centralHalfDepth,
  zMax: centralHalfDepth,
  width: ROOM_GALLERY_CENTRAL_ROOM_SIZE.width,
  depth: ROOM_GALLERY_CENTRAL_ROOM_SIZE.depth,
} as const;

/** Foundation slabs align exactly with the common room and every room slot.
 *
 * The open courtyard between the two top rectangles is intentionally not a
 * foundation slab. It remains part of the layer-1 grass/landscape space.
 */
export const ROOM_GALLERY_FOUNDATION_PIECES = [
  {
    id: "hub",
    kind: "hub",
    x: 0,
    z: 0,
    width: ROOM_GALLERY_HUB.width,
    depth: ROOM_GALLERY_HUB.depth,
  },
  {
    id: "top-left",
    kind: "rectangle",
    x: -centralHalfWidth,
    z: centralHalfDepth + squareHalfSize,
    width: ROOM_GALLERY_MERGED_ROOM_SIZE.width,
    depth: ROOM_GALLERY_MERGED_ROOM_SIZE.depth,
  },
  {
    id: "top-right",
    kind: "rectangle",
    x: centralHalfWidth,
    z: centralHalfDepth + squareHalfSize,
    width: ROOM_GALLERY_MERGED_ROOM_SIZE.width,
    depth: ROOM_GALLERY_MERGED_ROOM_SIZE.depth,
  },
  {
    id: "side-left-top",
    kind: "square",
    x: -centralHalfWidth - squareHalfSize,
    z: centralHalfDepth - squareHalfSize,
    width: ROOM_GALLERY_SQUARE_SIZE,
    depth: ROOM_GALLERY_SQUARE_SIZE,
  },
  {
    id: "side-left-bottom",
    kind: "square",
    x: -centralHalfWidth - squareHalfSize,
    z: -centralHalfDepth + squareHalfSize,
    width: ROOM_GALLERY_SQUARE_SIZE,
    depth: ROOM_GALLERY_SQUARE_SIZE,
  },
  {
    id: "side-right-top",
    kind: "square",
    x: centralHalfWidth + squareHalfSize,
    z: centralHalfDepth - squareHalfSize,
    width: ROOM_GALLERY_SQUARE_SIZE,
    depth: ROOM_GALLERY_SQUARE_SIZE,
  },
  {
    id: "side-right-bottom",
    kind: "square",
    x: centralHalfWidth + squareHalfSize,
    z: -centralHalfDepth + squareHalfSize,
    width: ROOM_GALLERY_SQUARE_SIZE,
    depth: ROOM_GALLERY_SQUARE_SIZE,
  },
  {
    id: "bottom-left",
    kind: "rectangle",
    x: -centralHalfWidth,
    z: -centralHalfDepth - squareHalfSize,
    width: ROOM_GALLERY_MERGED_ROOM_SIZE.width,
    depth: ROOM_GALLERY_MERGED_ROOM_SIZE.depth,
  },
  {
    id: "bottom-center",
    kind: "square",
    x: 0,
    z: -centralHalfDepth - squareHalfSize,
    width: ROOM_GALLERY_SQUARE_SIZE,
    depth: ROOM_GALLERY_SQUARE_SIZE,
  },
  {
    id: "bottom-right",
    kind: "rectangle",
    x: centralHalfWidth,
    z: -centralHalfDepth - squareHalfSize,
    width: ROOM_GALLERY_MERGED_ROOM_SIZE.width,
    depth: ROOM_GALLERY_MERGED_ROOM_SIZE.depth,
  },
] as const;

export const ROOM_GALLERY_DOORWAY_WIDTH = 120;
export const ROOM_GALLERY_OUTSIDE_DOORWAY_WIDTH = 240;
/** Protected editor clearance around every doorway, including the outside entry. */
export const ROOM_GALLERY_DOORWAY_CLEARANCE_DEPTH =
  ROOM_GALLERY_DOORWAY_WIDTH + ROOM_GALLERY_INTERIOR_WALL_THICKNESS * 2;

export type RoomGalleryDoorway = Readonly<{
  id: string;
  orientation: "horizontal" | "vertical";
  x: number;
  z: number;
  width: number;
}>;

/** Central-facing and adjacent-room doorways for every future room slot. */
export const ROOM_GALLERY_DOORWAYS: readonly RoomGalleryDoorway[] = [
  {
    id: "top-left",
    orientation: "horizontal",
    x: -centralHalfWidth + ROOM_GALLERY_SQUARE_SIZE / 2,
    z: centralHalfDepth,
    width: ROOM_GALLERY_DOORWAY_WIDTH,
  },
  {
    id: "top-left-side",
    orientation: "horizontal",
    x: -centralHalfWidth - squareHalfSize,
    z: centralHalfDepth,
    width: ROOM_GALLERY_DOORWAY_WIDTH,
  },
  {
    id: "top-right",
    orientation: "horizontal",
    x: centralHalfWidth - ROOM_GALLERY_SQUARE_SIZE / 2,
    z: centralHalfDepth,
    width: ROOM_GALLERY_DOORWAY_WIDTH,
  },
  {
    id: "top-right-side",
    orientation: "horizontal",
    x: centralHalfWidth + squareHalfSize,
    z: centralHalfDepth,
    width: ROOM_GALLERY_DOORWAY_WIDTH,
  },
  {
    id: "top-center-outside",
    orientation: "horizontal",
    x: 0,
    z: centralHalfDepth,
    width: ROOM_GALLERY_OUTSIDE_DOORWAY_WIDTH,
  },
  {
    id: "left-top",
    orientation: "vertical",
    x: -centralHalfWidth,
    z: centralHalfDepth - squareHalfSize,
    width: ROOM_GALLERY_DOORWAY_WIDTH,
  },
  {
    id: "left-bottom",
    orientation: "vertical",
    x: -centralHalfWidth,
    z: -centralHalfDepth + squareHalfSize,
    width: ROOM_GALLERY_DOORWAY_WIDTH,
  },
  {
    id: "right-top",
    orientation: "vertical",
    x: centralHalfWidth,
    z: centralHalfDepth - squareHalfSize,
    width: ROOM_GALLERY_DOORWAY_WIDTH,
  },
  {
    id: "right-bottom",
    orientation: "vertical",
    x: centralHalfWidth,
    z: -centralHalfDepth + squareHalfSize,
    width: ROOM_GALLERY_DOORWAY_WIDTH,
  },
  {
    id: "bottom-left",
    orientation: "horizontal",
    x: -centralHalfWidth + ROOM_GALLERY_SQUARE_SIZE / 2,
    z: -centralHalfDepth,
    width: ROOM_GALLERY_DOORWAY_WIDTH,
  },
  {
    id: "bottom-left-side",
    orientation: "horizontal",
    x: -centralHalfWidth - squareHalfSize,
    z: -centralHalfDepth,
    width: ROOM_GALLERY_DOORWAY_WIDTH,
  },
  {
    id: "bottom-center",
    orientation: "horizontal",
    x: 0,
    z: -centralHalfDepth,
    width: ROOM_GALLERY_DOORWAY_WIDTH,
  },
  {
    id: "bottom-right",
    orientation: "horizontal",
    x: centralHalfWidth - ROOM_GALLERY_SQUARE_SIZE / 2,
    z: -centralHalfDepth,
    width: ROOM_GALLERY_DOORWAY_WIDTH,
  },
  {
    id: "bottom-right-side",
    orientation: "horizontal",
    x: centralHalfWidth + squareHalfSize,
    z: -centralHalfDepth,
    width: ROOM_GALLERY_DOORWAY_WIDTH,
  },
];

export type RoomGalleryWallSegment = Readonly<{
  id: string;
  orientation: "horizontal" | "vertical";
  x: number;
  z: number;
  length: number;
  wallSide: "left" | "right" | "bottom" | "top";
  wallKind: "exterior" | "interior";
  thickness: number;
  wallPlacement: "inward" | "center";
}>;

function mergeWallIntervals(
  intervals: readonly (readonly [number, number])[],
): readonly (readonly [number, number])[] {
  const merged: [number, number][] = [];
  for (const [start, end] of [...intervals].sort(([a], [b]) => a - b)) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1] + ROOM_GALLERY_INTERIOR_WALL_THICKNESS) {
      previous[1] = Math.max(previous[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

function wallSegmentLabel(coordinate: number): string {
  return String(coordinate).replace("-", "m");
}

/** Unique structural wall spans derived from the foundation footprints.
 *
 * Shared room edges are merged into one span so the office wall shell cannot
 * duplicate coplanar geometry or create multiple colliders in the same seam.
 */
function buildRoomGalleryWallSegments(): readonly RoomGalleryWallSegment[] {
  const horizontal = new Map<number, [number, number][]>();
  const vertical = new Map<number, [number, number][]>();
  const add = (
    map: Map<number, [number, number][]>,
    coordinate: number,
    start: number,
    end: number,
  ) => {
    const intervals = map.get(coordinate) ?? [];
    intervals.push([start, end]);
    map.set(coordinate, intervals);
  };

  for (const { x, z, width, depth } of ROOM_GALLERY_FOUNDATION_PIECES) {
    add(horizontal, z - depth / 2, x - width / 2, x + width / 2);
    add(horizontal, z + depth / 2, x - width / 2, x + width / 2);
    add(vertical, x - width / 2, z - depth / 2, z + depth / 2);
    add(vertical, x + width / 2, z - depth / 2, z + depth / 2);
  }

  const segments: RoomGalleryWallSegment[] = [];
  for (const [z, intervals] of [...horizontal.entries()].sort(([a], [b]) => a - b)) {
    for (const [index, [start, end]] of mergeWallIntervals(intervals).entries()) {
      segments.push({
        id: `horizontal-${wallSegmentLabel(z)}-${index}`,
        orientation: "horizontal",
        x: (start + end) / 2,
        z,
        length: end - start,
        wallSide: z >= 0 ? "top" : "bottom",
        wallKind: z === -foundationHalfDepth || z === foundationHalfDepth ? "exterior" : "interior",
        thickness:
          z === -foundationHalfDepth || z === foundationHalfDepth
            ? ROOM_GALLERY_EXTERIOR_WALL_THICKNESS
            : ROOM_GALLERY_INTERIOR_WALL_THICKNESS,
        wallPlacement: "inward",
      });
    }
  }
  for (const [x, intervals] of [...vertical.entries()].sort(([a], [b]) => a - b)) {
    for (const [index, [start, end]] of mergeWallIntervals(intervals).entries()) {
      segments.push({
        id: `vertical-${wallSegmentLabel(x)}-${index}`,
        orientation: "vertical",
        x,
        z: (start + end) / 2,
        length: end - start,
        wallSide: x >= 0 ? "right" : "left",
        wallKind: x === -foundationHalfWidth || x === foundationHalfWidth ? "exterior" : "interior",
        thickness:
          x === -foundationHalfWidth || x === foundationHalfWidth
            ? ROOM_GALLERY_EXTERIOR_WALL_THICKNESS
            : ROOM_GALLERY_INTERIOR_WALL_THICKNESS,
        wallPlacement: "inward",
      });
    }
  }

  // The north courtyard is open to the outside. Split the long shared north
  // wall at the courtyard edges so the centered exterior double-door span and
  // the two courtyard-side walls use the approved 36 cm exterior thickness;
  // the room-divider spans on either side remain 12 cm interior walls.
  const courtyardXMin = -centralHalfWidth + ROOM_GALLERY_MERGED_ROOM_SIZE.width / 2;
  const courtyardXMax = centralHalfWidth - ROOM_GALLERY_MERGED_ROOM_SIZE.width / 2;
  const courtyardZMin = centralHalfDepth;
  const courtyardZMax = foundationHalfDepth;
  const courtyardSplitSegments = segments.flatMap((segment) => {
    if (segment.orientation === "horizontal" && Math.abs(segment.z - courtyardZMin) < 0.001) {
      const start = segment.x - segment.length / 2;
      const end = segment.x + segment.length / 2;
      const boundaries = [start, courtyardXMin, courtyardXMax, end]
        .filter(
          (value, index, values) =>
            value >= start && value <= end && values.indexOf(value) === index,
        )
        .sort((left, right) => left - right);
      return boundaries.slice(0, -1).map((left, index) => {
        const right = boundaries[index + 1];
        const external = left >= courtyardXMin - 0.001 && right <= courtyardXMax + 0.001;
        return {
          ...segment,
          id: `${segment.id}-courtyard-${index}`,
          x: (left + right) / 2,
          length: right - left,
          wallKind: external ? ("exterior" as const) : segment.wallKind,
          thickness: external ? ROOM_GALLERY_EXTERIOR_WALL_THICKNESS : segment.thickness,
        };
      });
    }
    if (
      segment.orientation === "vertical" &&
      (Math.abs(segment.x - courtyardXMin) < 0.001 ||
        Math.abs(segment.x - courtyardXMax) < 0.001) &&
      segment.z - segment.length / 2 >= courtyardZMin - 0.001 &&
      segment.z + segment.length / 2 <= courtyardZMax + 0.001
    ) {
      return [
        {
          ...segment,
          wallKind: "exterior" as const,
          thickness: ROOM_GALLERY_EXTERIOR_WALL_THICKNESS,
        },
      ];
    }
    return [segment];
  });

  // The plan leaves a single 12 cm interior wall between the paired bottom
  // rooms and between the paired side rooms. Collapse each close parallel
  // pair so two overlapping colliders are never emitted for one divider.
  const consumed = new Set<number>();
  const collapsed: RoomGalleryWallSegment[] = [];
  const spanOf = (segment: RoomGalleryWallSegment): readonly [number, number] =>
    segment.orientation === "horizontal"
      ? [segment.x - segment.length / 2, segment.x + segment.length / 2]
      : [segment.z - segment.length / 2, segment.z + segment.length / 2];
  for (let index = 0; index < courtyardSplitSegments.length; index += 1) {
    const first = courtyardSplitSegments[index];
    if (first.wallKind !== "interior" || consumed.has(index)) continue;
    const [firstStart, firstEnd] = spanOf(first);
    const partnerIndex = courtyardSplitSegments.findIndex((candidate, candidateIndex) => {
      if (
        candidateIndex <= index ||
        candidate.wallKind !== "interior" ||
        candidate.orientation !== first.orientation ||
        consumed.has(candidateIndex)
      )
        return false;
      const [candidateStart, candidateEnd] = spanOf(candidate);
      const coordinateGap =
        first.orientation === "horizontal"
          ? Math.abs(first.z - candidate.z)
          : Math.abs(first.x - candidate.x);
      return (
        coordinateGap <= Math.max(first.thickness, candidate.thickness) &&
        Math.abs(firstStart - candidateStart) < 0.001 &&
        Math.abs(firstEnd - candidateEnd) < 0.001
      );
    });
    if (partnerIndex < 0) continue;
    const second = courtyardSplitSegments[partnerIndex];
    consumed.add(index);
    consumed.add(partnerIndex);
    const coordinate =
      first.orientation === "horizontal" ? (first.z + second.z) / 2 : (first.x + second.x) / 2;
    collapsed.push({
      id:
        first.orientation === "horizontal"
          ? `${first.orientation}-${wallSegmentLabel(coordinate)}-${wallSegmentLabel(first.x)}-centered`
          : `${first.orientation}-${wallSegmentLabel(coordinate)}-${wallSegmentLabel(first.z)}-centered`,
      orientation: first.orientation,
      x: first.orientation === "horizontal" ? first.x : coordinate,
      z: first.orientation === "horizontal" ? coordinate : first.z,
      length: first.length,
      wallSide:
        first.orientation === "horizontal"
          ? coordinate >= 0
            ? "top"
            : "bottom"
          : coordinate >= 0
            ? "right"
            : "left",
      wallKind: "interior",
      thickness: ROOM_GALLERY_INTERIOR_WALL_THICKNESS,
      wallPlacement: "center",
    });
  }
  const structuralSegments = [
    ...courtyardSplitSegments.filter((_, index) => !consumed.has(index)),
    ...collapsed,
  ];
  const carve = (
    segment: RoomGalleryWallSegment,
    start: number,
    end: number,
    index: number,
  ): RoomGalleryWallSegment =>
    segment.orientation === "horizontal"
      ? { ...segment, id: `${segment.id}-part-${index}`, x: (start + end) / 2, length: end - start }
      : {
          ...segment,
          id: `${segment.id}-part-${index}`,
          z: (start + end) / 2,
          length: end - start,
        };
  const carvedSegments: RoomGalleryWallSegment[] = [];
  for (const segment of structuralSegments) {
    const spanStart =
      segment.orientation === "horizontal"
        ? segment.x - segment.length / 2
        : segment.z - segment.length / 2;
    const spanEnd =
      segment.orientation === "horizontal"
        ? segment.x + segment.length / 2
        : segment.z + segment.length / 2;
    const cuts = ROOM_GALLERY_DOORWAYS.filter(
      (doorway) =>
        doorway.orientation === segment.orientation &&
        Math.abs(
          (segment.orientation === "horizontal" ? doorway.z : doorway.x) -
            (segment.orientation === "horizontal" ? segment.z : segment.x),
        ) < 0.001,
    )
      .map(
        (doorway) =>
          [
            Math.max(
              spanStart,
              (segment.orientation === "horizontal" ? doorway.x : doorway.z) - doorway.width / 2,
            ),
            Math.min(
              spanEnd,
              (segment.orientation === "horizontal" ? doorway.x : doorway.z) + doorway.width / 2,
            ),
          ] as const,
      )
      .filter(([start, end]) => end > start)
      .sort(([a], [b]) => a - b);
    let cursor = spanStart;
    let partIndex = 0;
    for (const [cutStart, cutEnd] of cuts) {
      if (cutStart > cursor) carvedSegments.push(carve(segment, cursor, cutStart, partIndex++));
      cursor = Math.max(cursor, cutEnd);
    }
    if (cursor < spanEnd) carvedSegments.push(carve(segment, cursor, spanEnd, partIndex));
  }
  return carvedSegments;
}

export const ROOM_GALLERY_WALL_SEGMENTS = buildRoomGalleryWallSegments();

/** Full-height interior/exterior wall height in authored centimetres.
 * At runtime scale (0.005), 300 cm = 1.5 m — dollhouse-style half walls. */
export const ROOM_GALLERY_WALL_HEIGHT = 300;

/** Wall colors extracted from each room model's original wall material.
 * Used by scripts/add-hq-office-walls.mjs to color per-room wall segments.
 * Rooms without original walls use a warm neutral default. */
export const ROOM_WALL_COLORS: Readonly<Record<string, readonly [number, number, number]>> = {
  office: [1, 1, 1],
  "bedroom-modern": [1, 1, 1],
  "basketball-court": [0.85, 0.83, 0.78],
  "bedroom-cartoon": [1, 1, 1],
  "home-entrance": [0.429, 0.268, 0.035],
  "gaming-room": [0.8, 0.611, 0.441],
  "home-theatre": [0.678, 0.52, 0.406],
  "living-room": [0.13, 0.13, 0.13],
  pool: [0.85, 0.83, 0.78],
  "bedroom-basic": [0.85, 0.83, 0.78],
  dining: [0.8, 0.741, 0.528],
  kitchen: [0.85, 0.83, 0.78],
  lounge: [0.85, 0.83, 0.78],
  "tv-room": [1, 1, 1],
} as const;

/** Default wall color for rooms without an extracted color. */
export const ROOM_WALL_COLOR_DEFAULT: readonly [number, number, number] = [0.85, 0.83, 0.78];

/** Room-model scales that match the approved centimetre footprints.
 *
 * Room models are normalized to a 10 m × 10 m footprint (see
 * scripts/normalize-room-footprints.mjs). The X/Z scales convert from
 * the 10-unit model space to authored centimetres (60 → 600 cm for
 * square slots, 120 → 1200 cm for the long rectangle axis). The Y
 * scale mirrors the X scale so the room's authored height is carried
 * through the same centimetre-to-runtime conversion as the floor area.
 * A Y of 1 would leave the height in model-units, producing rooms that
 * are 100× flatter than intended at runtime. */
export const ROOM_GALLERY_SQUARE_SCALE = [60, 60, 60] as const;
export const ROOM_GALLERY_RECTANGLE_SCALE = [120, 120, 60] as const;
/** Backwards-compatible alias for callers that classify non-square slots. */
export const ROOM_GALLERY_HORIZONTAL_SCALE = ROOM_GALLERY_RECTANGLE_SCALE;

/** Symmetric room-slot centers around the hub. */
export const ROOM_GALLERY_SLOTS = {
  topRectangleX: centralHalfWidth,
  topRowZ: centralHalfDepth + squareHalfSize,
  sideX: centralHalfWidth + squareHalfSize,
  sideRowZ: centralHalfDepth - squareHalfSize,
  bottomRowZ: -centralHalfDepth - squareHalfSize,
  bottomRectangleX: centralHalfWidth,
  bottomCenterX: 0,
} as const;

/** Slot quaternions rotate each room so its door (the open +Z face) points
 * toward the gallery hub at the centre of the building. Room models have
 * walls on the back (-Z) and left (-X) faces and openings on the front
 * (+Z, door) and right (+X, adjacent room) faces.
 *
 * All rotations are exact 90° increments — no diagonal orientation. */
const topFacing = [0, 1, 0, 0] as const; // 180°: door faces -Z → hub
const leftFacing = [0, Math.SQRT1_2, 0, Math.SQRT1_2] as const; // +90°: door faces +X → hub
const rightFacing = [0, -Math.SQRT1_2, 0, Math.SQRT1_2] as const; // -90°: door faces -X → hub
const bottomFacing = [0, 0, 0, 1] as const; // 0°: door faces +Z → hub

const slotQuaternion = (id: string): readonly [number, number, number, number] =>
  id.startsWith("top-")
    ? topFacing
    : id.startsWith("side-left-")
      ? leftFacing
      : id.startsWith("side-right-")
        ? rightFacing
        : bottomFacing;

export const ROOM_GALLERY_PLACEABLE_SLOTS: readonly RoomGalleryPlaceableSlot[] =
  ROOM_GALLERY_FOUNDATION_PIECES.filter((piece) => piece.kind !== "hub").map((piece) => ({
    id: piece.id,
    category: piece.kind === "square" ? "3x3" : "6x3",
    kind: piece.kind,
    x: piece.x,
    z: piece.z,
    width: piece.width,
    depth: piece.depth,
    scale: piece.kind === "square" ? ROOM_GALLERY_SQUARE_SCALE : ROOM_GALLERY_RECTANGLE_SCALE,
    quaternion: slotQuaternion(piece.id),
  })) as readonly RoomGalleryPlaceableSlot[];
