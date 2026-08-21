"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import {
  modelsCharacterIds,
  modelsCharacterLabels,
  modelsCharacterIconUrls,
  isModelsCharacterId,
  modelsCustomCharacterIds,
  isModelsCustomCharacterId,
  getCustomCharacterLabel,
  modelsInteriorPropAssets,
  createAmbientAnimals,
  type AmbientAnimals,
} from "@agent-hq/models";
import { useSceneMusic } from "@agent-hq/audio";
import type { SceneManifest, SceneStartPosition } from "@agent-hq/asset-manifests";

import {
  ROOM_GALLERY_BOUNDS,
  ROOM_GALLERY_BUILDING_BOUNDS,
  ROOM_GALLERY_DOORWAYS,
  ROOM_GALLERY_DOORWAY_CLEARANCE_DEPTH,
  ROOM_GALLERY_EXTERIOR_WALL_THICKNESS,
  ROOM_GALLERY_FOUNDATION_PIECES,
  ROOM_GALLERY_FOUNDATION_TOP_Y,
  ROOM_GALLERY_HUB,
  ROOM_GALLERY_INTERIOR_WALL_THICKNESS,
  ROOM_GALLERY_MAIN_ENTRY_WALL_SHIFT,
  ROOM_GALLERY_OUTSIDE_DOORWAY_WIDTH,
  ROOM_GALLERY_PATHWAY_SIDE_WALL_EXTENSION,
  ROOM_GALLERY_RUNTIME_SCALE,
  ROOM_GALLERY_WALL_SEGMENTS,
} from "@agent-hq/rooms";
import type { RoomGalleryWallSegment } from "@agent-hq/rooms";
import type {
  SceneWaterVolume,
  StaticColliderConfig,
  SceneVisualUpdate,
  SceneDebugApi,
} from "@agent-hq/scene-runtime";
import { SceneWrapper } from "@agent-hq/scene-shell";
import { hqWorldPortals } from "./hq-world-portals";

const characterOptions = [
  ...modelsCharacterIds.map((id) => ({
    id,
    label: modelsCharacterLabels[id],
    iconUrl: modelsCharacterIconUrls[id],
  })),
  ...modelsCustomCharacterIds.map((id) => ({
    id,
    label: getCustomCharacterLabel(id) ?? id,
    iconUrl: undefined,
  })),
];

const galleryEnvironment = {
  background: 0x131923,
  hemisphereLight: { skyColor: 0xdde8ff, groundColor: 0x202832, intensity: 1.5 },
  directionalLights: [
    { color: 0xfff0d5, intensity: 2.2, position: [18, 24, -22], target: [0, 0, 0] },
  ],
} as const;

const hqSceneMapOptions = [
  {
    id: "hq-home",
    label: "Home",
    kind: "world" as const,
    href: "/?scene=home",
  },
  {
    id: "hq-work",
    label: "Work",
    kind: "world" as const,
    href: "/?scene=work",
  },
];

// Use the real-world HQ scale for every environment visual, collider,
// navigation bound, and camera bound. The environment is authored in
// centimetres (1 authored unit = 1 cm) and rendered at 1:1 scale, so
// 600 authored units = 6 m — a real room size that matches the models
// furniture models which are also authored in metres.
// The character scale uses the actual models model height (~1.75 m)
// with modelScale 1.0 — no multipliers or compensations needed.
const hqRuntimeScale = ROOM_GALLERY_RUNTIME_SCALE;
const hqCharacterScale = { height: 1.75, radius: 0.24, modelScale: 1.0 } as const;
const hqTopDownMovementSpeedFactor = 300 * hqRuntimeScale;
const hqFenceVisualHeight = 96;
const hqFenceColliderHeight = 240;
const hqExteriorVisualPadding = ROOM_GALLERY_EXTERIOR_WALL_THICKNESS * 4;
// Work's concrete is the sidewalk outside the fence. Extend the dirt beneath
// the fence footprint so no concrete strip appears on its inside edge.
const hqWorkFenceDirtOverlap = 8;
const hqMapBounds = ROOM_GALLERY_BOUNDS;
// Every approved HQ dimension is an exact multiple of the 12-unit interior
// wall. Using that structural unit keeps the editor grid aligned with room
// edges, door openings, and wall faces instead of introducing arbitrary gaps.
const hqRoomDesignerGridSize = ROOM_GALLERY_INTERIOR_WALL_THICKNESS;
const hqFrontGateWidth = ROOM_GALLERY_OUTSIDE_DOORWAY_WIDTH;
const hqFrontWalkwayWidth = ROOM_GALLERY_OUTSIDE_DOORWAY_WIDTH;
const hqFrontDoorInnerEdge = ROOM_GALLERY_HUB.zMax - ROOM_GALLERY_MAIN_ENTRY_WALL_SHIFT;
const hqSceneEditorLockedObjectPrefixes = [
  "GalleryFoundation-",
  "HQFoundationWall-",
  "GalleryGrassFloor",
  "hq-grass-map-plane",
  "hq-work-concrete-map-plane",
  "hq-work-interior-dirt",
  "hq-front-door-walkway",
  "hq-map-edge-fence",
  "hq-front-gate-",
] as const;
const hqRoomDesignerRegions = [
  // Indoor foundation slabs — each room is its own region.
  ...ROOM_GALLERY_FOUNDATION_PIECES.map(({ id, x, z, width, depth }) => ({
    id,
    x,
    z,
    width,
    depth,
  })),
  // Outdoor region: the entire area within the fence, so foliage and
  // outdoor items can be placed on the grass strip and courtyard. Wall
  // blocked rects and the walkway blocked rect prevent placement on
  // paths, walls, and structure.
  {
    id: "outdoor",
    x: 0,
    z: 0,
    width: ROOM_GALLERY_BOUNDS.width,
    depth: ROOM_GALLERY_BOUNDS.depth,
  },
];
const hqOuterHorizontalBoundary = Math.max(
  ...ROOM_GALLERY_WALL_SEGMENTS.filter(
    ({ orientation, wallKind }) => orientation === "horizontal" && wallKind === "exterior",
  ).map(({ z }) => Math.abs(z)),
);
const hqOuterVerticalBoundary = Math.max(
  ...ROOM_GALLERY_WALL_SEGMENTS.filter(
    ({ orientation, wallKind }) => orientation === "vertical" && wallKind === "exterior",
  ).map(({ x }) => Math.abs(x)),
);

// Keep editor collision rectangles in the same positions as the generated
// visual/collision walls. Exterior walls are shifted outward by half their
// thickness; using the unshifted segment center made the editor reserve an
// extra grid cell inside every thick perimeter wall.
const hqRoomDesignerBlockedRects = ROOM_GALLERY_WALL_SEGMENTS.map((segment) => {
  const isHorizontal = segment.orientation === "horizontal";
  const isExterior = segment.wallKind === "exterior";
  const offset = isExterior
    ? segment.thickness / 2
    : segment.wallPlacement === "center"
      ? 0
      : segment.thickness / 2;
  let x = isHorizontal
    ? segment.x
    : segment.x +
      (isExterior
        ? segment.wallSide === "left"
          ? -offset
          : offset
        : segment.wallSide === "left"
          ? offset
          : -offset);
  let z = isHorizontal
    ? segment.z +
      (isExterior
        ? segment.wallSide === "bottom"
          ? -offset
          : offset
        : segment.wallSide === "bottom"
          ? offset
          : -offset)
    : segment.z;
  let length = segment.length;

  if (isHorizontal && isExterior && Math.abs(segment.z - ROOM_GALLERY_HUB.zMax) < 0.001) {
    z -= ROOM_GALLERY_MAIN_ENTRY_WALL_SHIFT;
    length += ROOM_GALLERY_PATHWAY_SIDE_WALL_EXTENSION;
    x +=
      segment.x > 0
        ? -ROOM_GALLERY_PATHWAY_SIDE_WALL_EXTENSION / 2
        : ROOM_GALLERY_PATHWAY_SIDE_WALL_EXTENSION / 2;
  }

  const boundary = isHorizontal ? hqOuterVerticalBoundary : hqOuterHorizontalBoundary;
  const axisCenter = isHorizontal ? segment.x : segment.z;
  const spanStart = axisCenter - segment.length / 2;
  const spanEnd = axisCenter + segment.length / 2;
  const extendStart = isExterior && Math.abs(spanStart + boundary) < 0.001 ? segment.thickness : 0;
  const extendEnd = isExterior && Math.abs(spanEnd - boundary) < 0.001 ? segment.thickness : 0;
  if (extendStart || extendEnd) {
    const expandedStart = spanStart - extendStart;
    const expandedEnd = spanEnd + extendEnd;
    length = expandedEnd - expandedStart;
    if (isHorizontal) x = (expandedStart + expandedEnd) / 2;
    else z = (expandedStart + expandedEnd) / 2;
  }

  return {
    id: segment.id,
    x,
    z,
    width: isHorizontal ? length : segment.thickness,
    depth: isHorizontal ? segment.thickness : length,
  };
});
const hqRoomDesignerDoorwayRects = ROOM_GALLERY_DOORWAYS.map((doorway) => ({
  id: `doorway-clearance-${doorway.id}`,
  x: doorway.x,
  z: doorway.z,
  width:
    doorway.orientation === "horizontal" ? doorway.width : ROOM_GALLERY_DOORWAY_CLEARANCE_DEPTH,
  depth:
    doorway.orientation === "horizontal" ? ROOM_GALLERY_DOORWAY_CLEARANCE_DEPTH : doorway.width,
}));
// Block the front-door walkway so outdoor items can't be placed on the path.
const hqFrontWalkwayBlockedRect = {
  id: "front-walkway",
  x: 0,
  z: (hqFrontDoorInnerEdge + ROOM_GALLERY_BOUNDS.zMax) / 2,
  width: hqFrontWalkwayWidth,
  depth: ROOM_GALLERY_BOUNDS.zMax - hqFrontDoorInnerEdge,
};
const hqRoomDesignerPlayerPosition = { x: 0, z: ROOM_GALLERY_HUB.zMax + 120 } as const;
const hqRoomDesignerCatalog = [...modelsInteriorPropAssets].map((asset) => ({ ...asset }));
const hqClickNavigationBounds = {
  xMin: ROOM_GALLERY_BOUNDS.xMin + 30,
  xMax: ROOM_GALLERY_BOUNDS.xMax - 30,
  zMin: ROOM_GALLERY_BOUNDS.zMin + 30,
  zMax: ROOM_GALLERY_BOUNDS.zMax - 30,
} as const;
const hqPoolWaterVolumes = (sceneId: string): readonly SceneWaterVolume[] => [
  {
    zoneId: `${sceneId}-pool`,
    xMin: -3.73,
    xMax: 3.94,
    zMin: -0.09,
    zMax: 5,
    surfaceY: 1.7,
    forceSwimming: true,
  },
];

export const hqBoundaryColliders: readonly StaticColliderConfig[] = [
  {
    x: ROOM_GALLERY_BOUNDS.xMin,
    y: hqFenceColliderHeight / 2,
    z: 0,
    halfExtents: [
      ROOM_GALLERY_EXTERIOR_WALL_THICKNESS / 2,
      hqFenceColliderHeight / 2,
      ROOM_GALLERY_BOUNDS.depth / 2,
    ],
  },
  {
    x: ROOM_GALLERY_BOUNDS.xMax,
    y: hqFenceColliderHeight / 2,
    z: 0,
    halfExtents: [
      ROOM_GALLERY_EXTERIOR_WALL_THICKNESS / 2,
      hqFenceColliderHeight / 2,
      ROOM_GALLERY_BOUNDS.depth / 2,
    ],
  },
  {
    x: 0,
    y: hqFenceColliderHeight / 2,
    z: ROOM_GALLERY_BOUNDS.zMin,
    halfExtents: [
      ROOM_GALLERY_BOUNDS.width / 2,
      hqFenceColliderHeight / 2,
      ROOM_GALLERY_EXTERIOR_WALL_THICKNESS / 2,
    ],
  },
  // Leave the centered gate open while retaining the fence collider on both
  // sides of the property boundary.
  {
    x: ROOM_GALLERY_BOUNDS.xMin + (ROOM_GALLERY_BOUNDS.width - hqFrontGateWidth) / 4,
    y: hqFenceColliderHeight / 2,
    z: ROOM_GALLERY_BOUNDS.zMax,
    halfExtents: [
      (ROOM_GALLERY_BOUNDS.width - hqFrontGateWidth) / 4,
      hqFenceColliderHeight / 2,
      ROOM_GALLERY_EXTERIOR_WALL_THICKNESS / 2,
    ],
  },
  {
    x: ROOM_GALLERY_BOUNDS.xMax - (ROOM_GALLERY_BOUNDS.width - hqFrontGateWidth) / 4,
    y: hqFenceColliderHeight / 2,
    z: ROOM_GALLERY_BOUNDS.zMax,
    halfExtents: [
      (ROOM_GALLERY_BOUNDS.width - hqFrontGateWidth) / 4,
      hqFenceColliderHeight / 2,
      ROOM_GALLERY_EXTERIOR_WALL_THICKNESS / 2,
    ],
  },
];

type HqVisualTheme = "home" | "work";

type HqMaterialRole = "exterior" | "path" | "ground" | "sidewalk" | "floor" | "fence" | "wall";

function createHqMaterialTexture(
  url: string,
  repeatX: number,
  repeatY: number,
  colorTexture: boolean,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  if (colorTexture) texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createHqMaterial(
  theme: HqVisualTheme,
  role: HqMaterialRole,
  repeatX: number,
  repeatY: number,
): THREE.MeshStandardMaterial {
  const materialTheme = theme === "home" && role === "path" ? "work" : theme;
  const root =
    materialTheme === "home"
      ? "/assets/worlds/hq-home/materials"
      : "/assets/worlds/hq-work/materials";
  const stem =
    materialTheme === "home"
      ? {
          exterior: "grass",
          path: "rocks",
          ground: "grass",
          sidewalk: "rocks",
          floor: "wood-floor",
          fence: "wood-fence",
          wall: "concrete",
        }[role]
      : {
          exterior: "concrete",
          path: "concrete",
          ground: "ground",
          sidewalk: "concrete",
          floor: "tile",
          fence: "concrete",
          wall: "concrete",
        }[role];
  const colorExtension = materialTheme === "home" && stem !== "concrete" ? "jpg" : "png";
  const hasPbrMaps = materialTheme === "work" || stem === "wood-fence" || stem === "concrete";
  return new THREE.MeshStandardMaterial({
    map: createHqMaterialTexture(`${root}/${stem}-color.${colorExtension}`, repeatX, repeatY, true),
    ...(hasPbrMaps
      ? {
          normalMap: createHqMaterialTexture(`${root}/${stem}-normal.png`, repeatX, repeatY, false),
          roughnessMap: createHqMaterialTexture(
            `${root}/${stem}-roughness.png`,
            repeatX,
            repeatY,
            false,
          ),
        }
      : {}),
    roughness: 0.88,
    metalness: 0,
  });
}

function setupHqEnvironment(visual: THREE.Group, theme: HqVisualTheme): void {
  // SceneHost invokes visualSetup for entry and streamed zone assets. The
  // gallery foundation is the only layer that should receive the map-wide
  // environment; applying it to every room duplicates coplanar floors.
  if (!visual.getObjectByName("GalleryFoundation-hub")) return;
  const { width, depth } = ROOM_GALLERY_BOUNDS;
  const exteriorWidth = width + hqExteriorVisualPadding * 2;
  const exteriorDepth = depth + hqExteriorVisualPadding * 2;
  const isWork = theme === "work";

  const exteriorSurface = new THREE.Mesh(
    new THREE.PlaneGeometry(exteriorWidth, exteriorDepth),
    createHqMaterial(theme, "exterior", exteriorWidth / 96, exteriorDepth / 96),
  );
  exteriorSurface.name = isWork ? "hq-work-concrete-map-plane" : "hq-grass-map-plane";
  exteriorSurface.rotation.x = -Math.PI / 2;
  // Keep the layer-1 exterior surface visually below the foundation slab. The raw HQ scale
  // makes a 13 cm separation vulnerable to depth-buffer flicker in perspective.
  exteriorSurface.position.y = -0.5;
  const exteriorMaterial = exteriorSurface.material as THREE.MeshStandardMaterial;
  exteriorMaterial.polygonOffset = true;
  exteriorMaterial.polygonOffsetFactor = 4;
  exteriorMaterial.polygonOffsetUnits = 4;
  exteriorSurface.receiveShadow = true;
  visual.add(exteriorSurface);
  if (isWork) {
    const dirtSurface = new THREE.Mesh(
      new THREE.PlaneGeometry(width + hqWorkFenceDirtOverlap, depth + hqWorkFenceDirtOverlap),
      createHqMaterial(
        theme,
        "ground",
        (width + hqWorkFenceDirtOverlap) / 96,
        (depth + hqWorkFenceDirtOverlap) / 96,
      ),
    );
    dirtSurface.name = "hq-work-interior-dirt";
    dirtSurface.rotation.x = -Math.PI / 2;
    dirtSurface.position.y = -0.42;
    dirtSurface.receiveShadow = true;
    visual.add(dirtSurface);
  }
  const fence = new THREE.Group();
  fence.name = "hq-map-edge-fence";
  const material = isWork
    ? new THREE.MeshStandardMaterial({ color: 0x25313a, metalness: 0.35, roughness: 0.52 })
    : createHqMaterial(theme, "fence", width / 96, 1);
  const postMaterial = isWork
    ? new THREE.MeshStandardMaterial({ color: 0x87939b, metalness: 0.7, roughness: 0.34 })
    : material;
  const addSide = (horizontal: boolean, coordinate: number, gateWidth = 0) => {
    const length = horizontal ? width : depth;
    const railGeometry = horizontal
      ? new THREE.BoxGeometry(length, 5.6, 5.6)
      : new THREE.BoxGeometry(5.6, 5.6, length);
    for (const y of [22, 42]) {
      const addRail = (railLength: number, railCenter: number) => {
        if (railLength <= 0) return;
        const rail = new THREE.Mesh(
          horizontal ? new THREE.BoxGeometry(railLength, 5.6, 5.6) : railGeometry,
          material,
        );
        rail.name = "hq-map-edge-fence-rail";
        rail.position.set(horizontal ? railCenter : coordinate, y, horizontal ? coordinate : 0);
        fence.add(rail);
      };
      if (horizontal && gateWidth > 0) {
        const gateHalfWidth = gateWidth / 2;
        addRail(
          width / 2 - gateHalfWidth,
          ROOM_GALLERY_BOUNDS.xMin + (width / 2 - gateHalfWidth) / 2,
        );
        addRail(
          width / 2 - gateHalfWidth,
          ROOM_GALLERY_BOUNDS.xMax - (width / 2 - gateHalfWidth) / 2,
        );
      } else {
        addRail(length, horizontal ? 0 : coordinate);
      }
    }
    const postCount = horizontal ? 12 : 10;
    for (let index = 0; index < postCount; index += 1) {
      const progress = index / (postCount - 1);
      const postX = ROOM_GALLERY_BOUNDS.xMin + 0.2 + progress * (width - 0.4);
      if (horizontal && gateWidth > 0 && Math.abs(postX) < gateWidth / 2 + 4) continue;
      const post = new THREE.Mesh(new THREE.BoxGeometry(8, hqFenceVisualHeight, 8), postMaterial);
      post.name = "hq-map-edge-fence-post";
      post.position.set(
        horizontal ? postX : coordinate,
        hqFenceVisualHeight / 2,
        horizontal ? coordinate : ROOM_GALLERY_BOUNDS.zMin + 0.2 + progress * (depth - 0.4),
      );
      fence.add(post);
    }
  };
  addSide(true, ROOM_GALLERY_BOUNDS.zMin + 0.2);
  addSide(true, ROOM_GALLERY_BOUNDS.zMax - 0.2, hqFrontGateWidth);
  addSide(false, ROOM_GALLERY_BOUNDS.xMin + 0.2);
  addSide(false, ROOM_GALLERY_BOUNDS.xMax - 0.2);

  const gateZ = ROOM_GALLERY_BOUNDS.zMax - 0.2;
  const gatePostGeometry = new THREE.BoxGeometry(10, hqFenceVisualHeight + 8, 10);
  for (const x of [-hqFrontGateWidth / 2, hqFrontGateWidth / 2]) {
    const post = new THREE.Mesh(gatePostGeometry, postMaterial);
    post.name = "hq-front-gate-post";
    post.position.set(x, (hqFenceVisualHeight + 8) / 2, gateZ);
    fence.add(post);
  }
  const gateLeafGeometry = new THREE.BoxGeometry(hqFrontGateWidth / 2 - 8, 64, 4);
  for (const x of [-hqFrontGateWidth / 4, hqFrontGateWidth / 4]) {
    const leaf = new THREE.Mesh(gateLeafGeometry, material);
    leaf.name = "hq-front-gate-leaf";
    leaf.position.set(x, 32, gateZ - 1);
    fence.add(leaf);
  }

  const walkway = new THREE.Mesh(
    new THREE.BoxGeometry(
      hqFrontWalkwayWidth,
      0.25,
      ROOM_GALLERY_BOUNDS.zMax - hqFrontDoorInnerEdge,
    ),
    createHqMaterial(
      theme,
      isWork ? "sidewalk" : "path",
      hqFrontWalkwayWidth / 48,
      (ROOM_GALLERY_BOUNDS.zMax - hqFrontDoorInnerEdge) / 96,
    ),
  );
  walkway.name = "hq-front-door-walkway";
  // Keep the walkway's lower face above the dirt layer so perspective depth
  // testing cannot flicker where the concrete meets the earth.
  walkway.position.set(0, -0.05, (hqFrontDoorInnerEdge + ROOM_GALLERY_BOUNDS.zMax) / 2);
  const walkwayMaterial = walkway.material as THREE.MeshStandardMaterial;
  walkwayMaterial.polygonOffset = true;
  walkwayMaterial.polygonOffsetFactor = -2;
  walkwayMaterial.polygonOffsetUnits = -2;
  walkway.receiveShadow = true;
  visual.add(walkway);
  visual.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || !object.name.startsWith("GalleryFoundation-")) return;
    object.geometry.computeBoundingBox();
    const bounds = object.geometry.boundingBox;
    const size = bounds
      ? new THREE.Vector3().subVectors(bounds.max, bounds.min)
      : new THREE.Vector3(1, 1, 1);
    object.material = createHqMaterial(
      theme,
      "floor",
      Math.max(1, (size.x * object.scale.x) / 96),
      Math.max(1, (size.z * object.scale.z) / 96),
    );
  });
  visual.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || !object.name.startsWith("HQFoundationWall-")) return;
    object.material = new THREE.MeshStandardMaterial({
      color: 0x8a8a8a,
      roughness: 0.92,
      metalness: 0,
      side: THREE.DoubleSide,
    });
  });
  visual.add(fence);
}

/** Converts a structural wall segment into an axis-aligned bounding box.
 * Handles both "inward" (outer face at the segment coordinate, extending
 * toward the building center) and "center" (centered on the coordinate)
 * wall placements. */
function wallSegmentToAabb(segment: RoomGalleryWallSegment): {
  xMin: number;
  xMax: number;
  zMin: number;
  zMax: number;
} {
  const halfLen = segment.length / 2;
  const halfThick = segment.thickness / 2;
  if (segment.orientation === "horizontal") {
    const xMin = segment.x - halfLen;
    const xMax = segment.x + halfLen;
    let zMin: number;
    let zMax: number;
    if (segment.wallPlacement === "center") {
      zMin = segment.z - halfThick;
      zMax = segment.z + halfThick;
    } else {
      // "inward": outer face at z, extends toward building center.
      if (segment.z >= 0) {
        zMin = segment.z - segment.thickness;
        zMax = segment.z;
      } else {
        zMin = segment.z;
        zMax = segment.z + segment.thickness;
      }
    }
    return { xMin, xMax, zMin, zMax };
  } else {
    const zMin = segment.z - halfLen;
    const zMax = segment.z + halfLen;
    let xMin: number;
    let xMax: number;
    if (segment.wallPlacement === "center") {
      xMin = segment.x - halfThick;
      xMax = segment.x + halfThick;
    } else {
      // "inward": outer face at x, extends toward building center.
      if (segment.x >= 0) {
        xMin = segment.x - segment.thickness;
        xMax = segment.x;
      } else {
        xMin = segment.x;
        xMax = segment.x + segment.thickness;
      }
    }
    return { xMin, xMax, zMin, zMax };
  }
}

/** Pre-computed wall collision rectangles for ambient animals. */
const animalWallAabb = ROOM_GALLERY_WALL_SEGMENTS.map(wallSegmentToAabb);

export function HqRoomScene({
  initialCharacter,
  manifest,
  startPosition,
  cameraViewMode = "orthographic",
  onCameraViewModeChange,
  accountTargetId,
  cameraTargetId,
  roomDesignerTargetId,
}: {
  initialCharacter: string;
  manifest: SceneManifest;
  startPosition?: SceneStartPosition;
  cameraViewMode?: "perspective" | "orthographic";
  onCameraViewModeChange?: (viewMode: "perspective" | "orthographic") => void;
  accountTargetId?: string;
  cameraTargetId?: string;
  roomDesignerTargetId?: string;
}) {
  const [character, setCharacter] = useState(initialCharacter);
  const visualTheme: HqVisualTheme = manifest.id === "hq-work" ? "work" : "home";
  const setupEnvironment = useCallback(
    (visual: THREE.Group) => setupHqEnvironment(visual, visualTheme),
    [visualTheme],
  );
  useSceneMusic(manifest.id);

  // Ambient animals (dog + cat) roam the Home scene freely. The visualSetup
  // callback starts the async GLB load and adds them to the scene group; the
  // visualUpdate callback advances their animation mixers and steering each
  // frame. The ref holds the disposable handle for cleanup on unmount.
  const ambientAnimalsRef = useRef<AmbientAnimals | null>(null);
  const ambientAnimalsLoadingRef = useRef(false);
  // Physics-based collision check for animals. Set when the debug API becomes
  // available; applied to the animals once they finish loading. Stored in a
  // ref so the async animal load callback can access the latest value.
  const animalCollisionCheckRef = useRef<((x: number, y: number, z: number) => boolean) | null>(
    null,
  );
  const ambientAnimalsForHome = visualTheme === "home";
  const setupAmbientAnimals = useCallback(
    (visual: THREE.Group) => {
      if (!ambientAnimalsForHome) return;
      // Avoid double-loading: visualSetup fires once for the main scene and
      // again for each streamed zone. The loading flag prevents a second
      // async load from racing past the first.
      if (ambientAnimalsRef.current || ambientAnimalsLoadingRef.current) return;
      ambientAnimalsLoadingRef.current = true;
      const foundationTopY = ROOM_GALLERY_FOUNDATION_TOP_Y;
      // Constrain animals to the building interior (inside the exterior walls)
      // so they cannot wander onto the grass. Wall segment collision keeps them
      // from passing through interior walls.
      const buildingBounds = ROOM_GALLERY_BUILDING_BOUNDS;
      const halfWidth = buildingBounds.width / 2 - ROOM_GALLERY_EXTERIOR_WALL_THICKNESS;
      const halfDepth = buildingBounds.depth / 2 - ROOM_GALLERY_EXTERIOR_WALL_THICKNESS;
      // Animals are authored at real-world scale and the visual group is scaled
      // by hqRuntimeScale, so children inherit that scale. Counter-scale so the
      // animals render at their natural 1:1 size in world units.
      const animalScale = 1 / hqRuntimeScale;
      // Spawn each animal in the central hub room (guaranteed open space) so
      // they never start inside a wall.
      const hub = ROOM_GALLERY_HUB;
      const rand = (min: number, max: number) => min + Math.random() * (max - min);
      const randomPos = (): [number, number, number] => [
        rand(hub.xMin + 60, hub.xMax - 60),
        foundationTopY,
        rand(hub.zMin + 60, hub.zMax - 60),
      ];
      createAmbientAnimals(visual, [
        {
          id: "dog",
          position: randomPos(),
          scale: 1.0 * animalScale,
          wanderBounds: { centerX: 0, centerZ: 0, halfWidth, halfDepth },
          walls: animalWallAabb,
        },
        {
          id: "cat",
          position: randomPos(),
          scale: 1.0 * animalScale,
          wanderBounds: { centerX: 0, centerZ: 0, halfWidth, halfDepth },
          walls: animalWallAabb,
        },
      ])
        .then((animals) => {
          ambientAnimalsRef.current = animals;
          // Apply the physics collision check if the debug API beat us to it.
          if (animalCollisionCheckRef.current)
            animals.setCollisionCheck(animalCollisionCheckRef.current);
        })
        .catch((cause) => {
          console.warn(
            `[Agent HQ] ambient animals unavailable: ${cause instanceof Error ? cause.message : cause}`,
          );
        })
        .finally(() => {
          ambientAnimalsLoadingRef.current = false;
        });
    },
    [ambientAnimalsForHome],
  );
  const updateAmbientAnimals = useCallback<SceneVisualUpdate>((_scene, delta) => {
    ambientAnimalsRef.current?.update(delta);
  }, []);

  useEffect(
    () => () => {
      ambientAnimalsRef.current?.dispose();
      ambientAnimalsRef.current = null;
      animalCollisionCheckRef.current = null;
    },
    [],
  );

  // Once the scene's physics world is available, switch the ambient animals
  // from the fallback AABB wall check to the same Rapier colliders the player
  // uses. This keeps animals from clipping through walls, furniture, and any
  // other solid geometry. The callback fires on initial mount and after each
  // scene recreation (e.g. character switch), so the animals always re-attach.
  const handleDebugApiReady = useCallback(
    (api: SceneDebugApi) => {
      if (!ambientAnimalsForHome) return;
      const groundY = ROOM_GALLERY_FOUNDATION_TOP_Y * hqRuntimeScale;
      // Match the player's collision radius so animals respect the same wall
      // clearance as the character. Using a smaller radius let animals sneak
      // into tight spaces and then get stuck twitching against the wall.
      const animalHeight = 0.3; // metres — centre of the query ball above floor
      const animalRadius = hqCharacterScale.radius; // same as player
      const check = (xAuthored: number, _yAuthored: number, zAuthored: number): boolean => {
        const wx = xAuthored * hqRuntimeScale;
        const wz = zAuthored * hqRuntimeScale;
        const wy = groundY + animalHeight;
        return !api.isBallCollisionFree(wx, wy, wz, animalRadius);
      };
      animalCollisionCheckRef.current = check;
      ambientAnimalsRef.current?.setCollisionCheck(check);
    },
    [ambientAnimalsForHome],
  );

  const handleCharacterChange = (nextCharacter: string) => {
    if (!isModelsCharacterId(nextCharacter) && !isModelsCustomCharacterId(nextCharacter)) return;
    setCharacter(nextCharacter);
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("character", nextCharacter);
    window.history.replaceState(null, "", nextUrl);
  };

  return (
    <SceneWrapper
      manifest={manifest}
      startPosition={startPosition}
      character={character}
      onCharacterChange={handleCharacterChange}
      characterOptions={characterOptions}
      accountTargetId={accountTargetId}
      cameraTargetId={cameraTargetId}
      roomDesignerTargetId={roomDesignerTargetId}
      cameraViewMode={cameraViewMode}
      onCameraViewModeChange={onCameraViewModeChange}
      characterScale={hqCharacterScale}
      sceneScale={hqRuntimeScale}
      orthographicClickOnly
      orthographicMovementSpeedFactor={hqTopDownMovementSpeedFactor}
      enableClickNavigation
      clickNavigationBounds={hqClickNavigationBounds}
      clickNavigationIndicatorScale={80}
      cameraBounds={hqMapBounds}
      // Keep the full HQ envelope quick to traverse while giving the shared
      // World-sized avatar enough screen presence in the fixed top-down view.
      orthographicHalfHeight={720}
      orthographicPitch={-0.9}
      waterVolumes={manifest.zones?.length ? hqPoolWaterVolumes(manifest.id) : undefined}
      deferCharacterDetails={false}
      environment={galleryEnvironment}
      teleportBooths={false}
      enableSceneEditor
      sceneEditorAvailable
      sceneEditorLockedObjectPrefixes={hqSceneEditorLockedObjectPrefixes}
      roomDesignerAvailable
      enableRoomDesigner
      roomDesignerSceneScale={hqRuntimeScale}
      roomDesignerGroundY={ROOM_GALLERY_FOUNDATION_TOP_Y}
      roomDesignerGridSize={hqRoomDesignerGridSize}
      roomDesignerMapBounds={{
        id: "hq-map",
        x: 0,
        z: 0,
        width: ROOM_GALLERY_BOUNDS.width,
        depth: ROOM_GALLERY_BOUNDS.depth,
      }}
      roomDesignerRegions={hqRoomDesignerRegions}
      roomDesignerBlockedRects={[...hqRoomDesignerBlockedRects, hqFrontWalkwayBlockedRect]}
      roomDesignerDoorwayRects={hqRoomDesignerDoorwayRects}
      roomDesignerCatalog={hqRoomDesignerCatalog}
      roomDesignerPlayerPosition={hqRoomDesignerPlayerPosition}
      enablePropColliders
      roomDesignerNormalOrthographicHalfHeight={720}
      // Design mode gives the catalog panel enough map clearance to place
      // props in the rightmost rooms. Gameplay keeps the tighter 720 framing.
      roomDesignerDesignOrthographicHalfHeight={1320}
      roomDesignerBackdropColor={visualTheme === "home" ? 0x668b59 : 0x778086}
      // Design-only ground extension; camera bounds and gameplay collision
      // remain locked to hqMapBounds.
      roomDesignerBackdropPadding={840}
      keepZoneCollisionsActive
      staticColliders={hqBoundaryColliders}
      collideAdditionalVisualLayers={false}
      visualSetup={(visual) => {
        setupEnvironment(visual);
        setupAmbientAnimals(visual);
      }}
      visualUpdate={updateAmbientAnimals}
      mapOptions={hqSceneMapOptions}
      portals={hqWorldPortals(visualTheme === "home" ? "hq-home" : "hq-work")}
      materialOverrides={
        manifest.zones?.length
          ? [
              {
                name: "PoolWaterSurface",
                color: 0x0b8fc4,
                opacity: 0.78,
                transparent: true,
                depthWrite: false,
                side: "double",
              },
            ]
          : undefined
      }
      onDebugApiReady={handleDebugApiReady}
    />
  );
}
