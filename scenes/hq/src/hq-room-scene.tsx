"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import * as THREE from "three";
import {
  characterIds,
  characterLabels,
  characterIconUrls,
  isCharacterId,
  customCharacterIds,
  isCustomCharacterId,
  getCustomCharacterLabel,
  configurableCharacterId,
  getCharacterConfiguration,
  isCharacterConfigurationId,
  serializeCharacterConfiguration,
  type CharacterConfiguration,
} from "@agent-hq/characters/runtime";
import type { AmbientAnimals } from "@agent-hq/pets";
import { landscapeHorizonBackgrounds } from "@agent-hq/landscape/backgrounds";
import { useSceneMusic } from "@agent-hq/audio";
import type { SceneManifest, SceneStartPosition } from "@agent-hq/asset-manifests";

import {
  ROOM_GALLERY_BOUNDS,
  ROOM_GALLERY_BUILDING_BOUNDS,
  ROOM_GALLERY_EXTERIOR_WALL_THICKNESS,
  ROOM_GALLERY_FOUNDATION_TOP_Y,
  ROOM_GALLERY_HUB,
  ROOM_GALLERY_MAIN_ENTRY_WALL_SHIFT,
  ROOM_GALLERY_OUTSIDE_DOORWAY_WIDTH,
  ROOM_GALLERY_PERIMETER_BOUNDS,
  ROOM_GALLERY_PERIMETER_SIDEWALK_DEPTH,
  ROOM_GALLERY_RUNTIME_SCALE,
  ROOM_GALLERY_WALL_SEGMENTS,
} from "@agent-hq/interior/room-config";
import type { RoomGalleryWallSegment } from "@agent-hq/interior/room-config";
import type {
  SceneWaterVolume,
  StaticColliderConfig,
  SceneVisualUpdate,
  SceneDebugApi,
} from "@agent-hq/scene-runtime";
import { SceneWrapper } from "@agent-hq/scene-shell";
import { hqWorldPortals } from "./hq-world-portals";

const characterOptions = [
  ...characterIds.map((id) => ({
    id,
    label: characterLabels[id],
    iconUrl: characterIconUrls[id],
  })),
  ...customCharacterIds.map((id) => ({
    id,
    label: getCustomCharacterLabel(id) ?? id,
    iconUrl: undefined,
  })),
];

const galleryEnvironments = {
  home: {
    background: 0x0a0a0a,
    backgroundTextureUrl: landscapeHorizonBackgrounds.home,
    // Render the horizon in clip space so it never pans or rotates with the
    // perspective follow camera.
    backgroundTextureMapping: "2d",
    backgroundTextureOffset: [0, -0.04],
    backgroundTexturePerspectiveOnly: true,
    hemisphereLight: { skyColor: 0xdde8ff, groundColor: 0x202832, intensity: 1.5 },
    directionalLights: [
      { color: 0xfff0d5, intensity: 2.2, position: [18, 24, -22], target: [0, 0, 0] },
    ],
  },
  work: {
    background: 0x0a0a0a,
    backgroundTextureUrl: landscapeHorizonBackgrounds.work,
    // Render the horizon in clip space so it never pans or rotates with the
    // perspective follow camera.
    backgroundTextureMapping: "2d",
    backgroundTextureOffset: [0, -0.04],
    backgroundTexturePerspectiveOnly: true,
    hemisphereLight: { skyColor: 0xdde8ff, groundColor: 0x202832, intensity: 1.5 },
    directionalLights: [
      { color: 0xfff0d5, intensity: 2.2, position: [18, 24, -22], target: [0, 0, 0] },
    ],
  },
} as const;

// Use the real-world HQ scale for every environment visual, collider,
// navigation bound, and camera bound. The environment is authored in
// centimetres (1 authored unit = 1 cm) and rendered at 1:1 scale, so
// 600 authored units = 6 m — a real room size that matches the models
// furniture models which are also authored in metres.
// The character scale uses the actual model height (~1.35 m)
// with modelScale 1.0 — no multipliers or compensations needed.
const hqRuntimeScale = ROOM_GALLERY_RUNTIME_SCALE;
export const hqCharacterScale = { height: 1.35, radius: 0.24, modelScale: 1.0 } as const;
const hqTopDownMovementSpeedFactor = 300 * hqRuntimeScale;
const hqFenceVisualHeight = 96;
const hqFenceColliderHeight = 240;
const hqExteriorVisualPadding = ROOM_GALLERY_PERIMETER_SIDEWALK_DEPTH;
// Work's concrete is the sidewalk outside the fence. Extend the dirt beneath
// the fence footprint so no concrete strip appears on its inside edge.
const hqWorkFenceDirtOverlap = 8;
const hqFrontGateWidth = ROOM_GALLERY_OUTSIDE_DOORWAY_WIDTH;
const hqFrontWalkwayWidth = ROOM_GALLERY_OUTSIDE_DOORWAY_WIDTH;
const hqFrontDoorInnerEdge = ROOM_GALLERY_HUB.zMax - ROOM_GALLERY_MAIN_ENTRY_WALL_SHIFT;
const hqSceneEditorLockedObjectPrefixes = [
  "GalleryFoundation-",
  "HQFoundationWall-",
  "GalleryGrassFloor",
  "hq-grass-map-plane",
  "hq-work-dirt-map-plane",
  "hq-work-interior-dirt",
  "hq-front-door-walkway",
  "hq-front-sidewalk",
  "hq-perimeter-sidewalk",
  "hq-front-roadway",
  "hq-front-road-marking-",
  "hq-map-edge-fence",
  "hq-front-gate-",
] as const;
const hqClickNavigationBounds = {
  xMin: ROOM_GALLERY_BOUNDS.xMin + 30,
  xMax: ROOM_GALLERY_BOUNDS.xMax - 30,
  zMin: ROOM_GALLERY_BOUNDS.zMin + 30,
  zMax: ROOM_GALLERY_BOUNDS.zMax - 30,
} as const;
// The full-bleed canvas sits beneath the top bar. Include the sidewalk outside
// every fence edge, then extend only the front edge farther for the street;
// movement and collision bounds remain the actual property envelope.
const hqCameraTopPadding = 600;
// Keep the rear sidewalk above the bottom camera controls in normal view.
const hqBackSidewalkDepth = ROOM_GALLERY_PERIMETER_SIDEWALK_DEPTH * 2;
// Extend the visual ground beyond the map so both gameplay and the separate
// Room Designer scene have a themed surface outside the property. The extra
// margin covers the designer's wider orthographic framing at tall viewports.
const hqGroundVisualPadding = 1200;
const hqCameraBounds = {
  ...ROOM_GALLERY_PERIMETER_BOUNDS,
  zMin: ROOM_GALLERY_BOUNDS.zMin - hqBackSidewalkDepth,
  zMax: ROOM_GALLERY_BOUNDS.zMax + hqCameraTopPadding,
} as const;
const hqOrthographicHalfHeight = 720;
// Use the camera-only top envelope for a simple streetscape: matching
// sidewalks on both edges of the roadway. These layers are visual only; the
// property envelope remains the gameplay navigation and collision boundary.
const hqFrontSidewalkDepth = ROOM_GALLERY_PERIMETER_SIDEWALK_DEPTH;
// Fill the normal front camera envelope between two equal sidewalk strips and
// keep the visible roadway bounded by those two equal sidewalk strips.
const hqFrontRoadVisibleDepth = Math.max(0, hqCameraTopPadding - hqFrontSidewalkDepth * 2);
const hqFrontRoadDepth = hqFrontRoadVisibleDepth;
const hqFrontRoadWidth =
  ROOM_GALLERY_BOUNDS.width + (hqCameraTopPadding + hqGroundVisualPadding) * 2;
const hqEggshellWallColor = 0xe9e2d7;
const hqExteriorWallPrefixes = ROOM_GALLERY_WALL_SEGMENTS.filter(
  ({ wallKind }) => wallKind === "exterior",
).map(({ id }) => `HQFoundationWall-${id}`);
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
  // Keep the fence collider split around the rendered gate, then add a
  // matching center collider below so the closed gate cannot be walked through.
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
  {
    // The rendered gate leaves close the opening, so keep a matching static
    // collider across the center instead of leaving a walk-through gap.
    x: 0,
    y: hqFenceColliderHeight / 2,
    z: ROOM_GALLERY_BOUNDS.zMax,
    halfExtents: [
      hqFrontGateWidth / 2,
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
  const materialTheme = theme;
  // Keep each scene's exterior texture aligned with its visual theme: Home
  // uses grass while Work uses dirt for the surrounding yards.
  const root =
    materialTheme === "home"
      ? "/assets/worlds/hq-home/materials"
      : "/assets/worlds/hq-work/materials";
  const stem =
    role === "exterior"
      ? materialTheme === "home"
        ? "grass"
        : "ground"
      : materialTheme === "home"
        ? {
            exterior: "grass",
            path: "concrete",
            ground: "grass",
            sidewalk: "concrete",
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
  const materialExtension = "webp";
  const hasPbrMaps =
    (materialTheme === "work" && stem !== "grass") || stem === "wood-fence" || stem === "concrete";
  return new THREE.MeshStandardMaterial({
    map: createHqMaterialTexture(
      `${root}/${stem}-color.${materialExtension}`,
      repeatX,
      repeatY,
      true,
    ),
    ...(hasPbrMaps
      ? {
          normalMap: createHqMaterialTexture(
            `${root}/${stem}-normal.${materialExtension}`,
            repeatX,
            repeatY,
            false,
          ),
          roughnessMap: createHqMaterialTexture(
            `${root}/${stem}-roughness.${materialExtension}`,
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

function createHqMaterialFactory(theme: HqVisualTheme) {
  const materials = new Map<string, THREE.MeshStandardMaterial>();

  return (role: HqMaterialRole, repeatX: number, repeatY: number) => {
    const key = `${role}:${repeatX}:${repeatY}`;
    const cached = materials.get(key);
    if (cached) return cached;

    const material = createHqMaterial(theme, role, repeatX, repeatY);
    materials.set(key, material);
    return material;
  };
}

function setupHqEnvironment(visual: THREE.Group, theme: HqVisualTheme): void {
  // SceneHost invokes visualSetup for entry and streamed zone assets. The
  // HQ currently loads a single entry scene with no streamed zones, so the
  // map-wide environment belongs directly on that loaded visual root.
  const { width, depth } = ROOM_GALLERY_BOUNDS;
  // Cover the full normal camera and Room Designer backdrop envelopes. The
  // authored property remains bounded by its fence; this larger surface is
  // only the visual ground beneath the surrounding neighbor yards.
  const exteriorMinZ = ROOM_GALLERY_BOUNDS.zMin - hqGroundVisualPadding;
  const exteriorMaxZ = ROOM_GALLERY_BOUNDS.zMax + hqGroundVisualPadding;
  const exteriorWidth = Math.max(
    width + hqExteriorVisualPadding * 2,
    hqFrontRoadWidth,
    width + hqGroundVisualPadding * 2,
  );
  const exteriorDepth = exteriorMaxZ - exteriorMinZ;
  const isWork = theme === "work";
  const getMaterial = createHqMaterialFactory(theme);
  const configureEnvironmentPlane = (mesh: THREE.Mesh) => {
    // The Room Designer backdrop is added after the authored scene. Render
    // these ground layers after it so the themed surface remains visible.
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = 1;
    if (!Array.isArray(mesh.material)) {
      mesh.material.side = THREE.DoubleSide;
      mesh.material.needsUpdate = true;
    }
  };

  const exteriorSurface = new THREE.Mesh(
    new THREE.PlaneGeometry(exteriorWidth, exteriorDepth),
    getMaterial("exterior", exteriorWidth / 96, exteriorDepth / 96),
  );
  exteriorSurface.name = isWork ? "hq-work-dirt-map-plane" : "hq-grass-map-plane";
  configureEnvironmentPlane(exteriorSurface);
  // Keep the layer-1 exterior surface visually below the foundation slab. The raw HQ scale
  // makes a 13 cm separation vulnerable to depth-buffer flicker in perspective.
  exteriorSurface.position.y = -0.5;
  exteriorSurface.position.z = (exteriorMinZ + exteriorMaxZ) / 2;
  const exteriorMaterial = exteriorSurface.material as THREE.MeshStandardMaterial;
  exteriorMaterial.polygonOffset = true;
  exteriorMaterial.polygonOffsetFactor = 4;
  exteriorMaterial.polygonOffsetUnits = 4;
  exteriorSurface.receiveShadow = true;
  visual.add(exteriorSurface);

  const createSidewalkMaterial = (sidewalkWidth: number, sidewalkDepth: number) => {
    const material = getMaterial("sidewalk", sidewalkWidth / 96, sidewalkDepth / 96);
    material.polygonOffset = true;
    material.polygonOffsetFactor = -4;
    material.polygonOffsetUnits = -4;
    return material;
  };
  const frontSidewalk = new THREE.Mesh(
    new THREE.PlaneGeometry(hqFrontRoadWidth, hqFrontSidewalkDepth),
    createSidewalkMaterial(hqFrontRoadWidth, hqFrontSidewalkDepth),
  );
  frontSidewalk.name = "hq-front-sidewalk";
  configureEnvironmentPlane(frontSidewalk);
  frontSidewalk.position.set(0, -0.46, ROOM_GALLERY_BOUNDS.zMax + hqFrontSidewalkDepth / 2);
  frontSidewalk.receiveShadow = true;
  visual.add(frontSidewalk);

  const addPerimeterSidewalk = (
    name: string,
    sidewalkWidth: number,
    sidewalkDepth: number,
    x: number,
    z: number,
  ) => {
    const sidewalk = new THREE.Mesh(
      new THREE.PlaneGeometry(sidewalkWidth, sidewalkDepth),
      createSidewalkMaterial(sidewalkWidth, sidewalkDepth),
    );
    sidewalk.name = `hq-perimeter-sidewalk-${name}`;
    configureEnvironmentPlane(sidewalk);
    sidewalk.position.set(x, -0.46, z);
    sidewalk.receiveShadow = true;
    visual.add(sidewalk);
  };
  addPerimeterSidewalk(
    "back",
    ROOM_GALLERY_PERIMETER_BOUNDS.width,
    hqBackSidewalkDepth,
    0,
    ROOM_GALLERY_BOUNDS.zMin - hqBackSidewalkDepth / 2,
  );
  addPerimeterSidewalk(
    "left",
    hqFrontSidewalkDepth,
    ROOM_GALLERY_BOUNDS.depth,
    ROOM_GALLERY_BOUNDS.xMin - hqFrontSidewalkDepth / 2,
    0,
  );
  addPerimeterSidewalk(
    "right",
    hqFrontSidewalkDepth,
    ROOM_GALLERY_BOUNDS.depth,
    ROOM_GALLERY_BOUNDS.xMax + hqFrontSidewalkDepth / 2,
    0,
  );

  const roadway = new THREE.Mesh(
    new THREE.PlaneGeometry(hqFrontRoadWidth, hqFrontRoadDepth),
    new THREE.MeshStandardMaterial({ color: 0x171a1d, roughness: 0.94, metalness: 0 }),
  );
  roadway.name = "hq-front-roadway";
  configureEnvironmentPlane(roadway);
  roadway.position.set(
    0,
    -0.44,
    ROOM_GALLERY_BOUNDS.zMax + hqFrontSidewalkDepth + hqFrontRoadDepth / 2,
  );
  const roadwayMaterial = roadway.material as THREE.MeshStandardMaterial;
  roadwayMaterial.polygonOffset = true;
  roadwayMaterial.polygonOffsetFactor = -4;
  roadwayMaterial.polygonOffsetUnits = -4;
  roadway.receiveShadow = true;
  visual.add(roadway);

  const farSidewalk = new THREE.Mesh(
    new THREE.PlaneGeometry(hqFrontRoadWidth, hqFrontSidewalkDepth),
    createSidewalkMaterial(hqFrontRoadWidth, hqFrontSidewalkDepth),
  );
  farSidewalk.name = "hq-front-sidewalk-far";
  configureEnvironmentPlane(farSidewalk);
  farSidewalk.position.set(
    0,
    -0.46,
    ROOM_GALLERY_BOUNDS.zMax + hqFrontSidewalkDepth + hqFrontRoadDepth + hqFrontSidewalkDepth / 2,
  );
  farSidewalk.receiveShadow = true;
  visual.add(farSidewalk);

  const roadMarkingMaterial = new THREE.MeshStandardMaterial({
    color: 0xf4c542,
    roughness: 0.62,
    metalness: 0,
  });
  // Keep the center lines in the normal gameplay portion of the road, rather
  // than extending them into the surrounding textured ground.
  const roadCenterZ = ROOM_GALLERY_BOUNDS.zMax + hqFrontSidewalkDepth + hqFrontRoadVisibleDepth / 2;
  for (const offset of [-14, 14]) {
    const marking = new THREE.Mesh(
      new THREE.PlaneGeometry(hqFrontRoadWidth - 96, 6),
      roadMarkingMaterial,
    );
    marking.name = "hq-front-road-marking-center";
    configureEnvironmentPlane(marking);
    // Keep markings above the scaled road plane so the depth buffer does not hide them.
    marking.position.set(0, 10, roadCenterZ + offset);
    marking.receiveShadow = true;
    visual.add(marking);
  }
  if (isWork) {
    const dirtSurface = new THREE.Mesh(
      new THREE.PlaneGeometry(width + hqWorkFenceDirtOverlap, depth + hqWorkFenceDirtOverlap),
      getMaterial(
        "ground",
        (width + hqWorkFenceDirtOverlap) / 96,
        (depth + hqWorkFenceDirtOverlap) / 96,
      ),
    );
    dirtSurface.name = "hq-work-interior-dirt";
    configureEnvironmentPlane(dirtSurface);
    dirtSurface.position.y = -0.42;
    dirtSurface.receiveShadow = true;
    visual.add(dirtSurface);
  }
  const fence = new THREE.Group();
  fence.name = "hq-map-edge-fence";
  const material = isWork
    ? new THREE.MeshStandardMaterial({ color: 0x25313a, metalness: 0.35, roughness: 0.52 })
    : getMaterial("fence", width / 96, 1);
  const postMaterial = isWork
    ? new THREE.MeshStandardMaterial({ color: 0x87939b, metalness: 0.7, roughness: 0.34 })
    : material;
  const addSide = (horizontal: boolean, coordinate: number, gateWidth = 0) => {
    const length = horizontal ? width : depth;
    const railGeometry = horizontal
      ? new THREE.BoxGeometry(length, 5.6, 5.6)
      : new THREE.BoxGeometry(5.6, 5.6, length);
    for (const y of [24, 72]) {
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
    getMaterial(
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
    object.material = getMaterial(
      "floor",
      Math.max(1, (size.x * object.scale.x) / 96),
      Math.max(1, (size.z * object.scale.z) / 96),
    );
  });
  const eggshellMaterial = new THREE.MeshStandardMaterial({
    color: hqEggshellWallColor,
    roughness: 0.9,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  visual.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || !object.name.startsWith("HQFoundationWall-")) return;
    const isExteriorWall = hqExteriorWallPrefixes.some((prefix) => object.name.startsWith(prefix));
    object.material = isExteriorWall
      ? new THREE.MeshStandardMaterial({
          color: 0x8a8a8a,
          roughness: 0.92,
          metalness: 0,
          side: THREE.DoubleSide,
        })
      : eggshellMaterial;
  });

  visual.traverse((object) => {
    if (
      !(object instanceof THREE.Mesh) ||
      !hqExteriorWallPrefixes.some((prefix) => object.name.startsWith(prefix))
    ) {
      return;
    }

    object.geometry.computeBoundingBox();
    const bounds = object.geometry.boundingBox;
    if (!bounds) return;
    const size = new THREE.Vector3().subVectors(bounds.max, bounds.min);
    const width = size.x * Math.abs(object.scale.x);
    const height = size.y * Math.abs(object.scale.y);
    const depth = size.z * Math.abs(object.scale.z);
    const horizontal = width >= depth;
    const halfThickness = (horizontal ? depth : width) / 2;
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(horizontal ? width : depth, height),
      eggshellMaterial,
    );
    panel.name = `hq-eggshell-interior-${object.name}`;
    panel.position.copy(object.position);
    if (horizontal) {
      const facesNorth = object.position.z < 0;
      panel.position.z += facesNorth ? halfThickness + 0.5 : -halfThickness - 0.5;
      panel.rotation.y = facesNorth ? 0 : Math.PI;
    } else {
      const facesEast = object.position.x < 0;
      panel.position.x += facesEast ? halfThickness + 0.5 : -halfThickness - 0.5;
      panel.rotation.y = facesEast ? Math.PI / 2 : -Math.PI / 2;
    }
    panel.receiveShadow = true;
    visual.add(panel);
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
  accountLabel,
  accountAuthenticated,
  accountBusy,
  accountMusicControl,
  onAccountSignIn,
  onAccountSignOut,
  showAccountDrawer,
  cameraTargetId,
  roomDesignerTargetId,
  onOpenRoomDesigner,
  characterDesignerTargetId,
  sceneEditorTargetId,
  sceneOverlay,
  debugApiRef,
  assignedPropsEnabled = true,
  enablePropColliders = true,
  enableCharacterDesigner = true,
  allowCameraViewModeChange = true,
  showOnScreenControls = true,
  enableClickNavigation = true,
  cameraWheelZoomEnabled = true,
  ktx2Enabled = false,
  enableSceneEditor = true,
  enableAmbientAnimals = true,
  deferCharacterDetails = true,
  loadDeferredCharacterDetails = true,
}: {
  initialCharacter: string;
  manifest: SceneManifest;
  startPosition?: SceneStartPosition;
  cameraViewMode?: "perspective" | "orthographic";
  onCameraViewModeChange?: (viewMode: "perspective" | "orthographic") => void;
  accountTargetId?: string;
  accountLabel?: string;
  accountAuthenticated?: boolean;
  accountBusy?: boolean;
  accountMusicControl?: ReactNode;
  onAccountSignIn?: () => void;
  onAccountSignOut?: () => void;
  showAccountDrawer?: boolean;
  cameraTargetId?: string;
  roomDesignerTargetId?: string;
  onOpenRoomDesigner?: () => void;
  characterDesignerTargetId?: string;
  sceneEditorTargetId?: string;
  sceneOverlay?: ReactNode;
  debugApiRef?: MutableRefObject<SceneDebugApi | null>;
  assignedPropsEnabled?: boolean;
  enablePropColliders?: boolean;
  enableCharacterDesigner?: boolean;
  allowCameraViewModeChange?: boolean;
  showOnScreenControls?: boolean;
  enableClickNavigation?: boolean;
  cameraWheelZoomEnabled?: boolean;
  /** HQ currently uses WebP/external textures and does not need a KTX2 transcoder. */
  ktx2Enabled?: boolean;
  /** Keep the development-only object editor out of dedicated scene mounts. */
  enableSceneEditor?: boolean;
  /** Ambient pets are optional decoration and stay off dedicated scene mounts. */
  enableAmbientAnimals?: boolean;
  /** Defer the animation-only runtime asset until the first scene frame. */
  deferCharacterDetails?: boolean;
  /** Allow deferred animation loading after the scene becomes playable. */
  loadDeferredCharacterDetails?: boolean;
}) {
  const initialCharacterConfiguration = getCharacterConfiguration(initialCharacter);
  const initialCharacterId = isCharacterConfigurationId(initialCharacter)
    ? configurableCharacterId
    : initialCharacter;
  const [character, setCharacter] = useState(initialCharacterId);
  const [characterConfiguration, setCharacterConfiguration] = useState<
    CharacterConfiguration | undefined
  >(initialCharacterConfiguration);
  const visualTheme: HqVisualTheme = manifest.id === "hq-work" ? "work" : "home";
  const setupEnvironment = useCallback(
    (visual: THREE.Group) => setupHqEnvironment(visual, visualTheme),
    [visualTheme],
  );
  useSceneMusic(manifest.id);

  // Ambient animals (dog + cat) are optional decoration. Start their dynamic
  // module and GLBs only after the first playable scene frame so they cannot
  // delay the HQ entrance path. The ref holds the disposable handle for
  // cleanup on unmount.
  const ambientAnimalsRef = useRef<AmbientAnimals | null>(null);
  const ambientAnimalsLoadingRef = useRef(false);
  const ambientAnimalsStartTimerRef = useRef<number | null>(null);
  const ambientAnimalsMountedRef = useRef(false);
  // Physics-based collision check for animals. Set when the debug API becomes
  // available; applied to the animals once they finish loading. Stored in a
  // ref so the async animal load callback can access the latest value.
  const animalCollisionCheckRef = useRef<((x: number, y: number, z: number) => boolean) | null>(
    null,
  );
  const ambientAnimalsForHome = enableAmbientAnimals && visualTheme === "home";
  const setupAmbientAnimals = useCallback(
    (parent: THREE.Object3D) => {
      if (!ambientAnimalsForHome || !ambientAnimalsMountedRef.current) return;
      // Avoid double-loading: the visual update callback runs every frame and
      // the loading flag prevents a second async load from racing past the
      // first.
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
      void import("@agent-hq/pets")
        .then(({ createAmbientAnimals }) =>
          createAmbientAnimals(parent, [
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
          ]),
        )
        .then((animals) => {
          if (!ambientAnimalsMountedRef.current) {
            animals.dispose();
            return;
          }
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
  const setupVisual = useCallback(
    (visual: THREE.Group) => {
      setupEnvironment(visual);
    },
    [setupEnvironment],
  );
  const updateAmbientAnimals = useCallback<SceneVisualUpdate>((scene, delta) => {
    if (
      ambientAnimalsForHome &&
      !ambientAnimalsRef.current &&
      !ambientAnimalsLoadingRef.current &&
      ambientAnimalsStartTimerRef.current === null
    ) {
      // Let SceneHost paint the first frame before starting optional module and
      // model work. Subsequent frames continue advancing the handle normally.
      ambientAnimalsStartTimerRef.current = window.setTimeout(() => {
        ambientAnimalsStartTimerRef.current = null;
        setupAmbientAnimals(scene);
      }, 0);
    }
    ambientAnimalsRef.current?.update(delta);
  }, [ambientAnimalsForHome, setupAmbientAnimals]);

  // Keep these scene-runtime inputs stable while the shell updates transient
  // UI state such as the active camera. Changing their identities would make
  // SceneHost tear down and reload the entire Three.js scene on every toggle.
  const waterVolumes = useMemo(
    () => (manifest.zones?.length ? hqPoolWaterVolumes(manifest.id) : undefined),
    [manifest.id, manifest.zones?.length],
  );
  const materialOverrides = useMemo(
    () =>
      manifest.zones?.length
        ? [
            {
              name: "PoolWaterSurface",
              color: 0x0b8fc4,
              opacity: 0.78,
              transparent: true,
              depthWrite: false,
              side: "double" as const,
            },
          ]
        : undefined,
    [manifest.zones?.length],
  );
  const portals = useMemo(
    () => hqWorldPortals(visualTheme === "home" ? "hq-home" : "hq-work"),
    [visualTheme],
  );

  useEffect(() => {
    ambientAnimalsMountedRef.current = true;
    return () => {
      ambientAnimalsMountedRef.current = false;
      if (ambientAnimalsStartTimerRef.current !== null) {
        window.clearTimeout(ambientAnimalsStartTimerRef.current);
        ambientAnimalsStartTimerRef.current = null;
      }
      ambientAnimalsRef.current?.dispose();
      ambientAnimalsRef.current = null;
      animalCollisionCheckRef.current = null;
    };
  }, []);

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
    if (!isCharacterId(nextCharacter) && !isCustomCharacterId(nextCharacter)) return;
    setCharacter(nextCharacter);
    setCharacterConfiguration(getCharacterConfiguration(nextCharacter));
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("character", nextCharacter);
    window.history.replaceState(null, "", nextUrl);
  };

  const handleCharacterConfigurationChange = (nextConfiguration: CharacterConfiguration) => {
    setCharacter(configurableCharacterId);
    setCharacterConfiguration(nextConfiguration);
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("character", serializeCharacterConfiguration(nextConfiguration));
    window.history.replaceState(null, "", nextUrl);
  };

  const handleCharacterSave = ({
    character: savedCharacter,
    configuration,
  }: {
    character: string;
    configuration?: CharacterConfiguration;
  }) => {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set(
      "character",
      savedCharacter === configurableCharacterId && configuration
        ? serializeCharacterConfiguration(configuration)
        : savedCharacter,
    );
    window.history.replaceState(null, "", nextUrl);
  };

  return (
    <SceneWrapper
      manifest={manifest}
      viewportMode="container"
      startPosition={startPosition}
      character={character}
      onCharacterChange={handleCharacterChange}
      characterOptions={characterOptions}
      characterConfiguration={characterConfiguration}
      onCharacterConfigurationChange={handleCharacterConfigurationChange}
      onCharacterConfigurationReset={() => setCharacterConfiguration(undefined)}
      accountTargetId={accountTargetId}
      accountLabel={accountLabel}
      accountAuthenticated={accountAuthenticated}
      accountBusy={accountBusy}
      accountMusicControl={accountMusicControl}
      onAccountSignIn={onAccountSignIn}
      onAccountSignOut={onAccountSignOut}
      showAccountDrawer={showAccountDrawer}
      cameraTargetId={cameraTargetId}
      roomDesignerTargetId={roomDesignerTargetId}
      onOpenRoomDesigner={onOpenRoomDesigner}
      characterDesignerTargetId={characterDesignerTargetId}
      sceneEditorTargetId={sceneEditorTargetId}
      onCharacterSave={handleCharacterSave}
      cameraViewMode={cameraViewMode}
      onCameraViewModeChange={onCameraViewModeChange}
      characterScale={hqCharacterScale}
      sceneScale={hqRuntimeScale}
      orthographicClickOnly
      orthographicMovementSpeedFactor={hqTopDownMovementSpeedFactor}
      enableClickNavigation={enableClickNavigation}
      cameraWheelZoomEnabled={cameraWheelZoomEnabled}
      ktx2Enabled={ktx2Enabled}
      clickNavigationBounds={hqClickNavigationBounds}
      clickNavigationIndicatorScale={80}
      cameraBounds={hqCameraBounds}
      // Keep the full HQ envelope quick to traverse while giving the shared
      // World-sized avatar enough screen presence in the fixed top-down view.
      orthographicHalfHeight={hqOrthographicHalfHeight}
      orthographicPitch={-0.9}
      orthographicPan={{ x: 0, z: 0 }}
      waterVolumes={waterVolumes}
      deferCharacterDetails={deferCharacterDetails}
      loadDeferredCharacterDetails={loadDeferredCharacterDetails}
      environment={galleryEnvironments[visualTheme]}
      enableSceneEditor={enableSceneEditor}
      sceneEditorAvailable={enableSceneEditor && process.env.NODE_ENV === "development"}
      sceneEditorLockedObjectPrefixes={hqSceneEditorLockedObjectPrefixes}
      characterDesignerAvailable
      enableCharacterDesigner={enableCharacterDesigner}
      assignedPropsEnabled={assignedPropsEnabled}
      assignedPropsScale={hqRuntimeScale}
      assignedPropsGroundY={ROOM_GALLERY_FOUNDATION_TOP_Y}
      enablePropColliders={enablePropColliders}
      allowCameraViewModeChange={allowCameraViewModeChange}
      showOnScreenControls={showOnScreenControls}
      sceneOverlay={sceneOverlay}
      debugApiRef={debugApiRef}
      keepZoneCollisionsActive
      staticColliders={hqBoundaryColliders}
      collideAdditionalVisualLayers={false}
      visualSetup={setupVisual}
      visualUpdate={updateAmbientAnimals}
      portals={portals}
      materialOverrides={materialOverrides}
      onDebugApiReady={handleDebugApiReady}
    />
  );
}
