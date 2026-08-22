"use client";

import { useEffect, useRef, useState } from "react";
import { Timer } from "three";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { disposeObjectResources } from "./resources";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import {
  createCharacterAnimationController,
  loadCharacter,
  loadCharacterAnimations,
  type CharacterAnimationController,
} from "@agent-hq/characters";
import { loadLandscapeField } from "@agent-hq/landscape/runtime";
import { loadPropsField } from "@agent-hq/interior/runtime";
import { createScenePerformanceTelemetry } from "./performance";
import { createSceneLoadScope } from "./loading";
import RAPIER, {
  type Collider,
  type KinematicCharacterController,
  type World,
} from "@dimforge/rapier3d-compat";
import type { SceneZone, StaticFieldAssetUrls } from "@agent-hq/asset-manifests";
import {
  DEBUG_COMPONENT_PROXY,
  isSceneEditorObject,
  resolveDebugSourceObject,
  type DebugComponentProxyMetadata,
} from "./sceneDebug";
import { applySceneEditorOverrides, type SceneEditorOverrides } from "./sceneEditorOverrides";
import { CameraController, type CameraBounds, type CameraViewMode } from "./camera-controller";

function isCameraOccluder(object: THREE.Object3D, characterRoot: THREE.Object3D | null): boolean {
  if (!object.visible) return false;
  let current: THREE.Object3D | null = object;
  while (current) {
    if (!current.visible || current === characterRoot || current.name.startsWith("scene-editor-"))
      return false;
    current = current.parent;
  }
  return object instanceof THREE.Mesh;
}

function toCssColor(color: THREE.ColorRepresentation | undefined): string {
  return new THREE.Color(color ?? 0x9fd9f7).getStyle();
}

// Keep the loading affordance visible long enough to communicate a scene
// transition when the browser has already cached the scene assets. This only
// delays hiding the overlay; the first rendered scene frame is not delayed.
const MIN_LOADING_INDICATOR_MS = 180;

export type SceneHostStart = {
  x: number;
  y: number;
  z: number;
  yaw?: number;
  pitch?: number;
  /** Keep the authored y instead of snapping to the first loaded surface. */
  snapToGround?: boolean;
};

export type StaticColliderConfig = {
  /** Cuboid center in world space. */
  x: number;
  y: number;
  z: number;
  /** Half extents along each axis (hx, hy, hz). */
  halfExtents: readonly [number, number, number];
  /** Optional world-space quaternion for ramps and other rotated cuboids. */
  rotation?: readonly [number, number, number, number];
};

export type CollisionExclusionArea = {
  /** Only meshes whose name/ancestor/material string matches are filtered. */
  meshPattern: RegExp;
  /** World-space volume whose triangle centroids are omitted from collision. */
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  zMin: number;
  zMax: number;
  /** Omit any triangle intersecting the volume instead of only its centroid. */
  triangleIntersection?: boolean;
  /** Keep horizontal floors and stair treads when carving a vertical doorway. */
  surface?: "all" | "vertical";
};

export type SceneMaterialOverride = {
  /** Exact runtime mesh name or stable generated-field prefix. */
  name?: string;
  namePrefix?: string;
  opacity?: number;
  /** Optional material tint for imported effect layers. */
  color?: THREE.ColorRepresentation;
  emissiveIntensity?: number;
  depthWrite?: boolean;
  visible?: boolean;
  /** Render the imported material without scene-lighting attenuation. */
  unlit?: boolean;
  side?: "front" | "back" | "double";
  /** Render the base-color texture without scene-lighting attenuation. */
  unlitFromMap?: boolean;
  /** Replace the imported texture with a solid unlit color. */
  ignoreMap?: boolean;
  alphaTest?: number;
  transparent?: boolean;
  blending?: "normal" | "additive";
  /** Stable draw order for transparent scene layers such as glass panels. */
  renderOrder?: number;
  /** One-based disconnected geometry components to override together. */
  components?: readonly number[];
};

export type SceneSpotlightConfig = {
  color: THREE.ColorRepresentation;
  intensity: number;
  position: readonly [number, number, number];
  target: readonly [number, number, number];
  distance?: number;
  angle?: number;
  penumbra?: number;
  decay?: number;
  light?: boolean;
  beam?: {
    radius: number;
    opacity: number;
  };
};

export type PlayerVisibilityGroup = {
  names?: readonly string[];
  namePrefixes?: readonly string[];
  visibleArea: { xMin: number; xMax: number; zMin: number; zMax: number };
};

export type SceneEnvironmentConfig = {
  /** Solid fallback used while an optional background texture is loading. */
  background?: THREE.ColorRepresentation;
  /** Optional world-space backdrop texture, independent of the scene GLB. */
  backgroundTextureUrl?: string;
  backgroundTextureMapping?: "2d" | "equirectangular";
  backgroundTextureRepeat?: readonly [number, number];
  backgroundTextureOffset?: readonly [number, number];
  backgroundTextureRotation?: number;
  fog?: {
    color: THREE.ColorRepresentation;
    mode?: "linear" | "exp2";
    density?: number;
    near?: number;
    far?: number;
  } | null;
  hemisphereLight?: {
    skyColor: THREE.ColorRepresentation;
    groundColor: THREE.ColorRepresentation;
    intensity: number;
  } | null;
  directionalLights?: readonly {
    color: THREE.ColorRepresentation;
    intensity: number;
    position: readonly [number, number, number];
    target?: readonly [number, number, number];
    castShadow?: boolean;
  }[];
  /** Scene-specific spotlights, with optional visible beam geometry. */
  spotlights?: readonly SceneSpotlightConfig[];
};

export type SceneHostProps = {
  label?: string;
  assetUrl: string;
  entryZoneId?: string;
  /** Keep the entry zone collision active while another zone is loaded. */
  preserveEntryCollision?: boolean;
  /** Keep every loaded zone collision active (for maps made from solid rooms). */
  keepZoneCollisionsActive?: boolean;
  collisionAssetUrl?: string;
  /** Additional collision layers kept active for multi-level scenes. */
  additionalCollisionAssetUrls?: readonly string[];
  additionalAssetUrls?: readonly string[];
  zones?: readonly SceneZone[];
  startPosition?: SceneHostStart;
  /**
   * Extra static colliders added after the scene colliders (used for door
   * fills on meshopt-compressed collision layers where the GLB mesh would be
   * unreliable).
   */
  staticColliders?: readonly StaticColliderConfig[];
  /** Water/material names that are explicitly allowed to create colliders. */
  collisionIncludePatterns?: readonly RegExp[];
  /** Mesh names in generated static fields that should participate in physics. */
  staticFieldCollisionPatterns?: readonly RegExp[];
  /** Whether additional visual fields should also participate in physics. */
  collideAdditionalVisualLayers?: boolean;
  /** Scene-authored holes in decorative triangle meshes, replaced by simple
   * static colliders where the original mesh blocks a walkable approach. */
  collisionExclusionAreas?: readonly CollisionExclusionArea[];
  /** Exact mesh names whose overlapping material groups need deterministic
   * depth bias. Used for authored coplanar layers that cannot be merged. */
  coplanarMaterialMeshNames?: readonly string[];
  /** Scene-authored material corrections scoped to exact stable mesh names. */
  materialOverrides?: readonly SceneMaterialOverride[];
  /** Visual-only groups that are shown only while the player is in an area. */
  playerVisibilityGroups?: readonly PlayerVisibilityGroup[];
  characterId?: string;
  /** Defer optional animation assets until after the scene is playable. */
  deferCharacterDetails?: boolean;
  /** Whether deferred character details should be fetched automatically. */
  loadDeferredCharacterDetails?: boolean;
  /**
   * Mutable reference to the live scene debug API used by shared scene tools.
   */
  debugApiRef?: React.MutableRefObject<SceneDebugApi | null>;
  /** Notify shared scene tools when a new scene debug API is ready. */
  onDebugApiReady?: (api: SceneDebugApi) => void;
  /** Optional scene-specific sky, fog, and light configuration. */
  environment?: SceneEnvironmentConfig;
  /** Optional persisted transforms/deletions for authored scene objects. */
  editorOverridesUrl?: string;
  /** Initial camera projection used by this app/scene. */
  initialCameraViewMode?: CameraViewMode;
  /** Mutable camera mode shared with controls without remounting the scene. */
  cameraViewModeRef?: { current: CameraViewMode };
  visualSetup?: SceneVisualSetup;
  /** Updates scene-specific visual effects once per rendered frame. */
  visualUpdate?: SceneVisualUpdate;
  /** Per-scene character size (physics capsule + visual model). */
  characterScale?: CharacterScale;
  /** Uniform authored-world scale applied to visuals, physics, navigation, and camera framing. */
  sceneScale?: number;
  /** Multiplier applied to on-foot movement in every camera view. */
  movementSpeedFactor?: number;
  /** Allow primary-click movement to a point on the loaded scene in orthographic view. */
  enableClickNavigation?: boolean;
  /** Optional walkable map bounds for click navigation, expressed in world units. */
  clickNavigationBounds?: { xMin: number; xMax: number; zMin: number; zMax: number };
  /** World-space scale for the click destination ring. Defaults to 1. */
  clickNavigationIndicatorScale?: number;
  /** Disable keyboard and jumping while orthographic click-only mode is active. */
  orthographicClickOnly?: boolean;
  /** Capture canvas wheel/pinch gestures for camera zoom instead of browser zoom. */
  cameraWheelZoomEnabled?: boolean;
  /** Optional movement multiplier used only by orthographic click navigation. */
  orthographicMovementSpeedFactor?: number;
  /** Optional camera envelope. The view is clamped to keep the map edges in frame. */
  cameraBounds?: CameraBounds;
  /** Scene-specific orthographic framing; defaults preserve existing views. */
  orthographicHalfHeight?: number;
  /** Scene-specific orthographic pitch in radians; defaults preserve existing views. */
  orthographicPitch?: number;
  /** Initial authored-world pan applied only to the orthographic camera target. */
  orthographicPan?: { x: number; z: number };
  /** Override the perspective camera follow distance for scenes with a
   *  miniature environment scale so the character and room are both visible. */
  perspectiveCameraDistance?: number;
  /** Explicit water volumes for authored pools whose meshes are not flat sheets. */
  waterVolumes?: readonly SceneWaterVolume[];
  /** Scene-specific visual-only vertical correction for the character model. */
  characterGroundOffset?: number;
  /**
   * Show the in-scene info/controls panel (label, position, key hints).
   * Hidden by default; the settings drawer toggles it on demand.
   */
  showHud?: boolean;
  /** Notify the owning scene shell when a new scene load begins. */
  onLoadingStart?: () => void;
  /** Notify the owning scene shell after the first playable frame is rendered. */
  onReady?: () => void;
  /** Build-generated instanced field GLBs for static scenes. */
  staticFieldAssetUrls?: StaticFieldAssetUrls;
  /** Render-free exact-triangle companions for build-generated fields. */
  staticFieldCollisionAssetUrls?: StaticFieldAssetUrls;
  /**
   * Optional foliage placement manifest. When set, the scene's foliage is
   * instanced at runtime from the shared @agent-hq/landscape catalog instead of being
   * embedded in the scene GLB.
   */
  foliageManifestUrl?: string;
  /**
   * Optional props placement manifest. When set, the scene's props are
   * instanced at runtime from the shared @agent-hq/interior catalog instead of being
   * embedded in the scene GLB.
   */
  propsManifestUrl?: string;
};

export type SceneVisualSetup = (visual: THREE.Group) => void;
export type SceneVisualUpdate = (visual: THREE.Scene, delta: number, elapsed: number) => void;

export type SceneDebugApi = {
  scene: THREE.Scene;
  camera: THREE.Camera;
  cameraViewMode: CameraViewMode;
  setCameraViewMode: (viewMode: CameraViewMode) => void;
  setOrthographicHalfHeight: (halfHeight: number) => void;
  setOrthographicPan: (x: number, z: number) => void;
  setOrthographicZoom: (zoom: number) => void;
  setOrthographicZoomImmediate: (zoom: number) => void;
  adjustOrthographicZoom: (delta: number) => void;
  adjustPerspectiveZoom: (delta: number) => void;
  setOrthographicBoundsPadding: (padding: number) => void;
  resetOrthographicView: () => void;
  setClickNavigationEnabled: (enabled: boolean) => void;
  renderer: THREE.WebGLRenderer;
  world: unknown;
  playerCollider: unknown;
  characterController: unknown;
  characterRoot: THREE.Object3D | null;
  getState: () => Record<string, unknown>;
  /** Move the player to the given world x/z, snapping to the ground below
   * (used to place players beside a portal). An optional y seeds the
   * ground probe so cross-level teleports land on the intended floor, an
   * optional yaw turns the camera, and an optional bodyYaw turns the
   * character model (independent of the camera). */
  teleportTo: (
    x: number,
    z: number,
    y?: number,
    yaw?: number,
    bodyYaw?: number,
    snapToGround?: boolean,
  ) => void;
  /** Return whether a player capsule can occupy the given center position. */
  isSpawnSafe: (x: number, y: number, z: number) => boolean;
  /** Return whether a ball of the given radius at the given world position
   *  is free of collisions (excluding the player collider). Used by ambient
   *  animals and other non-player entities to respect scene colliders. */
  isBallCollisionFree: (x: number, y: number, z: number, radius: number) => boolean;
  /** Return the lowest walkable surface at or above a local height seed. */
  groundYAt: (x: number, z: number, seedY: number) => number | null;
  /** Load or unload a visual zone without adding it to the scene's cold load. */
  loadZone?: (id: string) => Promise<void>;
  unloadZone?: (id: string) => Promise<void>;
  findMesh: (pattern: string) => Array<Record<string, unknown>>;
  /** Raycast straight down from y=150 at the given world x/z and return the
   * first ground height (excluding the player capsule), or null. */
  groundY: (x: number, z: number) => number | null;
  /** Raycast from the canvas and return the actual leaf mesh under the pointer. */
  pick: (clientX: number, clientY: number) => SceneDebugHit | null;
  /** "/"-joined parent chain from the scene root down to the object. */
  getPath: (object: object) => string;
  getObjectInfo: (object: object, hit?: SceneDebugHit | null) => Record<string, unknown>;
  /** Tint the object's materials with an emissive highlight (on/off). */
  highlight: (object: object, on: boolean) => void;
  /** Hide/show an object, including a disconnected mesh component proxy. */
  setVisible: (object: object, visible: boolean) => void;
  /** Create a static cuboid collider (half-extents + translation in world
   *  space, already scaled by the caller). Returns an opaque handle that
   *  can be passed to removePropCollider. */
  addBoxCollider: (
    halfExtents: readonly [number, number, number],
    translation: readonly [number, number, number],
  ) => unknown | null;
  /** Create a static trimesh collider from a BufferGeometry (vertices and
   *  indices in world space, already scaled by the caller). */
  addTrimeshCollider: (geometry: THREE.BufferGeometry) => unknown | null;
  /** Remove a collider previously created by addBoxCollider or
   *  addTrimeshCollider. */
  removePropCollider: (handle: unknown) => void;
};

export type SceneDebugHit = {
  object: object;
  /** Stable authored object when `object` is a temporary debug component proxy. */
  sourceObject?: THREE.Object3D;
  distance: number;
  point: { toArray: () => number[] };
  faceIndex?: number;
  instanceId?: number;
};

const DEFAULT_START: SceneHostStart = { x: 0, y: 6, z: 0, yaw: 0 };
const EMPTY_ASSET_URLS: readonly string[] = [];
const EMPTY_COLLISION_INCLUDE_PATTERNS: readonly RegExp[] = [];
const EMPTY_ZONES: readonly SceneZone[] = [];
const EMPTY_MATERIAL_OVERRIDES: readonly SceneMaterialOverride[] = [];
const EMPTY_VISIBILITY_GROUPS: readonly PlayerVisibilityGroup[] = [];
/** Per-scene character size. */
export interface CharacterScale {
  /** The character's physics capsule height. */
  height: number;
  /** The character's physics capsule radius. */
  radius: number;
  /** The visual character model scale. */
  modelScale: number;
}

export type SceneWaterVolume = {
  /** Optional streamed zone whose transform is applied to these local bounds. */
  zoneId?: string;
  xMin: number;
  xMax: number;
  zMin: number;
  zMax: number;
  /** Waterline in the same coordinate space as the bounds. */
  surfaceY: number;
  /** Allow swimming even when a shallow pool still reports grounded contact. */
  forceSwimming?: boolean;
};

/** The current default: the character at 75% of the original authored size. */
export const DEFAULT_characterModelScale: CharacterScale = {
  height: 1.35,
  radius: 0.18,
  modelScale: 0.3,
};

const EMPTY_STATIC_COLLIDERS: readonly StaticColliderConfig[] = [];
const EMPTY_COLLISION_EXCLUSION_AREAS: readonly CollisionExclusionArea[] = [];
const EMPTY_WATER_VOLUMES: readonly SceneWaterVolume[] = [];
const EMPTY_OBJECTS: readonly THREE.Object3D[] = [];
const PLAYER_SPEED = 5;
const JUMP_SPEED = 4.5;
const GRAVITY = -22;
// Sideways (A/D) movement is faster than forward so strafing stays responsive
// next to the slower run speed.
const STRAFE_SPEED_FACTOR = 1.3;
const CLICK_NAVIGATION_ARRIVAL_DISTANCE = 0.35;
const CLICK_NAVIGATION_MOVEMENT_EPSILON = 0.02;
const HIGH_END_PIXEL_RATIO = 1.5;
// Adaptive-quality tiers so scenes stay interactive on phones and low-end
// laptops without sacrificing visual fidelity on capable desktops. The render
// scale starts at the tier cap and is lowered further (and later restored)
// by a running frame-time monitor.
const STANDARD_PIXEL_RATIO = 1.25;
const LOW_END_PIXEL_RATIO = 1.0;
const QUALITY_MONITOR_WINDOW_FRAMES = 30;
const QUALITY_MONITOR_MS = 18; // 55+ fps keeps quality
const QUALITY_REDUCE_MS = 28; // 35- fps lowers quality
const QUALITY_MIN_RENDER_SCALE = 0.7;
const QUALITY_SCALE_STEP = 0.1;
const QUALITY_GRACE_FRAMES = 120; // don't raise quality again for ~2s after lowering

function detectQualityTier(): "high" | "standard" | "low" {
  const isMobile = /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);
  const cores = navigator.hardwareConcurrency ?? 4;
  const memory = (navigator as { deviceMemory?: number }).deviceMemory ?? 8;
  if (isMobile || cores <= 4 || memory <= 4) return "low";
  if (cores <= 8 || memory <= 6) return "standard";
  return "high";
}

// Verbose per-load diagnostics (mesh counts, water surfaces, character clip
// catalogs, swim transitions) are only useful while debugging a scene. They
// fire on every route visit in production, so gate them behind ?debug to keep
// production console output clean and skip the string-formatting work.
const debugLoggingEnabled = () =>
  typeof window !== "undefined" && new URLSearchParams(window.location.search).has("debug");
function debugLog(message: string, ...args: unknown[]): void {
  if (debugLoggingEnabled()) console.info(message, ...args);
}
const RAPIER_INIT_WARNING =
  "using deprecated parameters for the initialization function; pass a single object instead";
const WATER_NAME_PATTERN = /water|ocean|sea|river|lake|pool/i;
// Names that contain "water" but are not water (e.g. a watering can prop).
const NOT_WATER_NAME_PATTERN = /watering/i;
const COLLISION_WATER_PATTERN = /water|ocean|sea|river|lake|pool/i;
const COLLISION_VFX_PATTERN =
  /vfx|effect|(?:^|[-_ ])trail(?:$|[-_ ])|smoke|fog|cloud|spark|flare|billboard|decal/i;
const COLLISION_LAYER_PATTERN = /collider|collision|navmesh|trigger/i;
const EDITOR_MESH_PATTERN =
  /editor|gizmo|helper|debug|wireframe|camera|light|reflection|probe|volume/i;
// A failed collider creation usually means the Rapier wasm world panicked and
// is poisoned: every subsequent creation attempt throws the same borrow error.
// Stop after a few consecutive failures instead of warning once per mesh.
const COLLIDER_FAILURE_BAILOUT = 5;
const WATER_ENTRY_MARGIN = 0.1;
// Horizontal water sheets thinner than this count as swim surfaces; vertical
// waterfall planes and river bed blocks do not (their bounds.max.y is not the
// waterline).
const WATER_SHEET_MAX_THICKNESS = 0.15;
// A jump from the water must clear river trench lips, which sit up to ~2.1
// units above the waterline (JUMP_SPEED^2 / (2 * -GRAVITY) ≈ 0.36 would leave
// the character trapped against the bank). While rising out of the water the
// capsule may overlap bank terrain (the swim float line sits inside the shore
// slope), which would block the rise; SWIM_JUMP_FRAMES bypass collision for
// the upward motion only.
const SWIM_JUMP_SPEED = 10;
const SWIM_JUMP_FRAMES = 10;
// Auto-climb out of the water: while swimming into a bank or ledge whose top
// sits above the waterline and within reach, the character climbs onto it
// automatically instead of needing a perfectly timed jump.
const CLIMB_RAY_DISTANCE = 1.8;
const CLIMB_MAX_RISE = 2.2;
const CLIMB_FRAMES = 10;
const CLIMB_EDGE_PAST = 0.5;
// The swimmer floats with its body parallel to the water surface (see
// SWIM_BODY_TILT). The capsule center sits far enough below the surface that
// the character's feet are actually under the waterline, but still inside the
// swim-detection band: findWaterZone requires the feet to be at or below
// surfaceY + WATER_ENTRY_MARGIN (capsule center at or below surface + 0.775
// for the default capsule). A float above that band would lift the character
// past the detection threshold every frame, kicking it out of the swim state
// so it falls back and re-triggers - a visible jitter at the waterline with
// the feet hovering above the water.
// Tuned for the reference 1.35-tall capsule; scale the float offset for
// scenes that use a taller character capsule.
const SWIM_SURFACE_OFFSET = 0.65;
const SWIM_SURFACE_REFERENCE_HEIGHT = 1.35;
const SWIM_SPEED_FACTOR = 0.6;
// The character stops swimming (stands up) as soon as the floor reaches the
// water line, not when it reaches the float line (chest height). Waiting for
// the float line would let the shore sand rise past the swimmer's feet and
// up to its chest, leaving the body embedded under the sand before the wade
// triggers. The margin is generous so a swimmer closes on a gently rising
// shore and stands up in knee-deep water instead of hovering at the slope.
const SWIM_WADE_MARGIN = 0.35;
// How far ahead of the swimmer the floor probe reaches. The shore sand is a
// flat sheet whose lip sits inside the capsule radius, so probing only the
// leading edge (playerRadius) never sees the bank top - the probe lands in the
// water column and the swimmer hovers against the invisible step forever.
// Reaching a capsule and a half ahead clears the lip and finds the shore.
const SWIM_WADE_AHEAD_DISTANCE = 1.2;
// The floor probe under the swimmer starts far above the surface and casts
// downward so it catches beaches whose top sits above the water line too;
// otherwise a swimmer closing on a steep shore stays embedded below the sand
// and sinks under it when leaving the water. The vertical cast at the player's
// x/z only hits the terrain directly beneath, so it cannot teleport the
// swimmer onto distant cliff tops.
const SWIM_FLOOR_PROBE_ORIGIN = 5.0;
const SWIM_FLOOR_PROBE_DISTANCE = 10.0;
// The browser GLBs keep the rig upright, so the character root needs an
// additional quarter-turn to lay the body parallel to the water surface.
const SWIM_BODY_TILT = Math.PI / 2;
const SWIM_BODY_TILT_DAMPING = 14;
// The swim clip only takes over once the body has actually laid down on the
// water; while the character is still running/wading through shallow water it
// keeps the locomotion animation and speed.
const SWIM_POSE_TILT = Math.PI / 3;

let rapierInitPromise: Promise<void> | null = null;

async function initializeRapier(): Promise<void> {
  // React StrictMode mounts the scene twice in development, and both mounts
  // race through RAPIER.init(). wasm-bindgen's generated glue is not
  // re-entrant: two concurrent instantiations each finalize the module-global
  // wasm/memory state, so worlds created in between can hold pointers into a
  // replaced wasm instance and collider creation fails with
  // "recursive use of an object detected ... in rust". Share a single init
  // promise so the second mount waits for the first instead of re-initializing.
  if (rapierInitPromise) return rapierInitPromise;
  rapierInitPromise = (async () => {
    // Rapier 0.19.3's compatibility wrapper emits this warning internally while
    // loading its embedded WASM, even when its public init() API is called correctly.
    const originalWarn = console.warn;
    console.warn = (...args) => {
      if (args[0] === RAPIER_INIT_WARNING) return;
      originalWarn(...args);
    };
    try {
      await RAPIER.init();
    } finally {
      console.warn = originalWarn;
    }
  })();
  try {
    await rapierInitPromise;
  } catch (cause) {
    rapierInitPromise = null;
    throw cause;
  }
}

function collisionMeshName(mesh: THREE.Mesh): string {
  const names: string[] = [];
  let current: THREE.Object3D | null = mesh;
  while (current) {
    names.push(current.name);
    current = current.parent;
  }
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  names.push(...materials.map((material) => material.name));
  return names.join(" ");
}

function createStaticCollider(
  world: World,
  mesh: THREE.Mesh,
  exclusionAreas: readonly CollisionExclusionArea[] = EMPTY_COLLISION_EXCLUSION_AREAS,
  instanceMatrix?: THREE.Matrix4,
): Collider | null {
  const position = mesh.geometry.getAttribute("position");
  if (!position || position.count < 3) return null;

  mesh.updateWorldMatrix(true, false);
  const worldMatrix = mesh.matrixWorld.clone();
  if (instanceMatrix) worldMatrix.multiply(instanceMatrix);
  const vertices = new Float32Array(position.count * 3);
  const vertex = new THREE.Vector3();
  for (let index = 0; index < position.count; index += 1) {
    vertex.fromBufferAttribute(position, index).applyMatrix4(worldMatrix);
    vertices[index * 3] = vertex.x;
    vertices[index * 3 + 1] = vertex.y;
    vertices[index * 3 + 2] = vertex.z;
  }

  const sourceIndex = mesh.geometry.getIndex();
  let indices = sourceIndex
    ? new Uint32Array(sourceIndex.array)
    : new Uint32Array(Array.from({ length: position.count }, (_, index) => index));
  const meshName = collisionMeshName(mesh);
  const matchingExclusions = exclusionAreas.filter(({ meshPattern }) => meshPattern.test(meshName));
  if (matchingExclusions.length > 0) {
    const filtered: number[] = [];
    for (let index = 0; index < indices.length; index += 3) {
      const a = indices[index] * 3;
      const b = indices[index + 1] * 3;
      const c = indices[index + 2] * 3;
      const centerX = (vertices[a] + vertices[b] + vertices[c]) / 3;
      const centerY = (vertices[a + 1] + vertices[b + 1] + vertices[c + 1]) / 3;
      const centerZ = (vertices[a + 2] + vertices[b + 2] + vertices[c + 2]) / 3;
      const abX = vertices[b] - vertices[a];
      const abY = vertices[b + 1] - vertices[a + 1];
      const abZ = vertices[b + 2] - vertices[a + 2];
      const acX = vertices[c] - vertices[a];
      const acY = vertices[c + 1] - vertices[a + 1];
      const acZ = vertices[c + 2] - vertices[a + 2];
      const normalX = abY * acZ - abZ * acY;
      const normalY = abZ * acX - abX * acZ;
      const normalZ = abX * acY - abY * acX;
      const normalLength = Math.hypot(normalX, normalY, normalZ);
      const isVerticalSurface = normalLength > 0 && Math.abs(normalY / normalLength) < 0.55;
      const excluded = matchingExclusions.some((area) => {
        const intersectsArea = area.triangleIntersection
          ? Math.min(vertices[a], vertices[b], vertices[c]) <= area.xMax &&
            Math.max(vertices[a], vertices[b], vertices[c]) >= area.xMin &&
            Math.min(vertices[a + 1], vertices[b + 1], vertices[c + 1]) <= area.yMax &&
            Math.max(vertices[a + 1], vertices[b + 1], vertices[c + 1]) >= area.yMin &&
            Math.min(vertices[a + 2], vertices[b + 2], vertices[c + 2]) <= area.zMax &&
            Math.max(vertices[a + 2], vertices[b + 2], vertices[c + 2]) >= area.zMin
          : centerX >= area.xMin &&
            centerX <= area.xMax &&
            centerY >= area.yMin &&
            centerY <= area.yMax &&
            centerZ >= area.zMin &&
            centerZ <= area.zMax;
        return intersectsArea && (area.surface !== "vertical" || isVerticalSurface);
      });
      if (!excluded) filtered.push(indices[index], indices[index + 1], indices[index + 2]);
    }
    indices = new Uint32Array(filtered);
  }
  if (indices.length < 3) return null;

  const descriptor = RAPIER.ColliderDesc.trimesh(vertices, indices);
  if (!descriptor) return null;
  descriptor.setFriction(0.9);
  try {
    return world.createCollider(descriptor);
  } catch (cause) {
    console.warn(`[Agent HQ] collision mesh ${mesh.name || "unnamed"} unavailable`, cause);
    return null;
  }
}

function shouldSkipCollisionMesh(
  mesh: THREE.Mesh,
  allowCollisionLayer: boolean,
  collisionIncludePatterns: readonly RegExp[] = EMPTY_COLLISION_INCLUDE_PATTERNS,
  trustedGeneratedLayer = false,
): boolean {
  if (!mesh.visible) return true;

  const names: string[] = [];
  let current: THREE.Object3D | null = mesh;
  while (current) {
    names.push(current.name);
    if (current instanceof THREE.Camera || current instanceof THREE.Light) return true;
    const userData = current.userData as Record<string, unknown>;
    if (
      userData.editorOnly === true ||
      userData.isEditorOnly === true ||
      userData.isTrigger === true
    )
      return true;
    current = current.parent;
  }
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  names.push(...materials.map((material) => material.name));
  const name = names.join(" ");
  if (collisionIncludePatterns.some((pattern) => pattern.test(name))) return false;
  // Catalog prop fields are visual-only. In particular, decorative portal
  // meshes (Glow, Arrow, and the opening cover) must never become physics.
  if (!trustedGeneratedLayer && names.some((value) => /^props/i.test(value))) return true;
  // Generated collision companions contain no render data and have already
  // passed the exact package policy. Model ids such as "effect" or
  // "billboard" must not be reclassified by the visual-layer name filter.
  if (trustedGeneratedLayer) return false;
  // The exchange bank escalator mesh contains a vertical end-cap that blocks
  // the player before the top landing. The exchange scene supplies simple
  // authored ramp colliders, so omit only this decorative overlay from
  // physics.
  if (/(?:exchange[-_ ]*)?bank[-_ ]*escalator/i.test(name)) return true;
  if (COLLISION_WATER_PATTERN.test(name) || COLLISION_VFX_PATTERN.test(name)) return true;
  if (EDITOR_MESH_PATTERN.test(name)) return true;
  return !allowCollisionLayer && COLLISION_LAYER_PATTERN.test(name);
}

function addSceneColliders(
  world: World,
  root: THREE.Object3D,
  allowCollisionLayer = false,
  exclusionAreas: readonly CollisionExclusionArea[] = EMPTY_COLLISION_EXCLUSION_AREAS,
  meshFilter: (mesh: THREE.Mesh) => boolean = () => true,
  collisionIncludePatterns: readonly RegExp[] = EMPTY_COLLISION_INCLUDE_PATTERNS,
  createdColliders?: Collider[],
  trustedGeneratedLayer = false,
): number {
  let created = 0;
  let consecutiveFailures = 0;
  let halted = false;
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (
      !meshFilter(object) ||
      shouldSkipCollisionMesh(
        object,
        allowCollisionLayer,
        collisionIncludePatterns,
        trustedGeneratedLayer,
      )
    )
      return;
    if (halted) return;
    if (consecutiveFailures >= COLLIDER_FAILURE_BAILOUT) {
      // A failed collider creation usually means the Rapier wasm world is
      // poisoned. Stop adding colliders for this layer instead of killing the
      // whole scene load: the remaining meshes simply have no physics.
      halted = true;
      console.warn(
        `[Agent HQ] collider creation failed ${consecutiveFailures} times in a row; skipping remaining collision meshes in ${root.name || "layer"}`,
      );
      return;
    }
    if (object instanceof THREE.InstancedMesh) {
      const instanceMatrix = new THREE.Matrix4();
      for (let index = 0; index < object.count; index += 1) {
        if (halted) break;
        object.getMatrixAt(index, instanceMatrix);
        const collider = createStaticCollider(world, object, exclusionAreas, instanceMatrix);
        if (collider) {
          createdColliders?.push(collider);
          created += 1;
          consecutiveFailures = 0;
        } else {
          consecutiveFailures += 1;
        }
      }
    } else {
      const collider = createStaticCollider(world, object, exclusionAreas);
      if (collider) {
        createdColliders?.push(collider);
        created += 1;
        consecutiveFailures = 0;
      } else {
        consecutiveFailures += 1;
      }
    }
  });
  return created;
}

function createFallbackFloorCollider(
  world: World,
  bounds: THREE.Box3,
  playerPosition: THREE.Vector3,
  playerHeight: number,
): Collider | null {
  const floorY = playerPosition.y - playerHeight / 2;
  const centerX = (bounds.min.x + bounds.max.x) / 2;
  const centerZ = (bounds.min.z + bounds.max.z) / 2;
  const halfWidth = Math.max((bounds.max.x - bounds.min.x) / 2, 50);
  const halfDepth = Math.max((bounds.max.z - bounds.min.z) / 2, 50);
  const descriptor = RAPIER.ColliderDesc.cuboid(halfWidth, 0.1, halfDepth)
    .setTranslation(centerX, floorY - 0.1, centerZ)
    .setFriction(0.9);
  try {
    return world.createCollider(descriptor);
  } catch (cause) {
    console.warn("[Agent HQ] fallback collision floor unavailable", cause);
    return null;
  }
}

type WaterZone = {
  bounds: THREE.Box3;
  surfaceY: number;
  forceSwimming?: boolean;
};

type NavigationCell = { x: number; z: number };

function collectWaterZones(root: THREE.Object3D): WaterZone[] {
  root.updateMatrixWorld(true);
  const zones: WaterZone[] = [];
  root.traverse((object) => {
    if (
      !(object instanceof THREE.Mesh) ||
      !WATER_NAME_PATTERN.test(object.name) ||
      NOT_WATER_NAME_PATTERN.test(object.name)
    )
      return;
    const bounds = new THREE.Box3().setFromObject(object);
    if (bounds.isEmpty()) return;
    // Only thin horizontal sheets are swim surfaces. Vertical waterfall planes
    // and thick bed blocks (e.g. a river basin cube named "river_lower") would
    // otherwise become bogus zones whose surfaceY sits at their tallest point.
    // Authored pool surfaces are sometimes exported as a thick/irregular mesh;
    // an explicit *surface* name is trusted even when its geometry exceeds the
    // generic thin-sheet limit.
    const explicitSurface = /water.?surface|water.?sheet/i.test(object.name);
    if (bounds.max.y - bounds.min.y > WATER_SHEET_MAX_THICKNESS && !explicitSurface) return;
    zones.push({ bounds, surfaceY: bounds.max.y });
  });
  return zones;
}

function findWaterZone(
  zones: readonly WaterZone[],
  position: THREE.Vector3,
  playerHeight: number,
): WaterZone | null {
  const feetY = position.y - playerHeight / 2;
  // A scene can carry overlapping thin water sheets (an ocean floor plane
  // named "Ocean Base" under the actual surface sheet, bed planes, etc.).
  // A swimmer floats on the TOP of the water, so among every zone the
  // position is inside, use the one with the highest surface.
  let best: WaterZone | null = null;
  for (const zone of zones) {
    const { bounds, surfaceY } = zone;
    if (position.x < bounds.min.x || position.x > bounds.max.x) continue;
    if (position.z < bounds.min.z || position.z > bounds.max.z) continue;
    if (feetY > surfaceY + WATER_ENTRY_MARGIN) continue;
    if (position.y > surfaceY + playerHeight + WATER_ENTRY_MARGIN) continue;
    if (best === null || surfaceY > best.surfaceY) best = zone;
  }
  return best;
}

const disposeObjectTree = disposeObjectResources;

const LAVA_TEXTURE_REPEAT = 1;
const BRICK_TEXTURE_REPEAT = 1 / 0.35;

function prepareBrickTextures(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => {
      if (material.name !== "Rugman Brick") return;
      const typedMaterial = material as THREE.Material & { map?: THREE.Texture };
      const sourceTexture = typedMaterial.map;
      if (!sourceTexture) return;
      // Blender's Mapping scale is authored in object space. Restore the
      // authored 0.35 cadence after export drops that node transform.
      sourceTexture.wrapS = THREE.RepeatWrapping;
      sourceTexture.wrapT = THREE.RepeatWrapping;
      const repeat = object.name === "Cube001_1" ? 1 : BRICK_TEXTURE_REPEAT;
      sourceTexture.repeat.set(repeat, repeat);
      sourceTexture.offset.set(0, 0);
      sourceTexture.center.set(0.5, 0.5);
      sourceTexture.rotation = 0;
      sourceTexture.matrixAutoUpdate = true;
      sourceTexture.updateMatrix();
      sourceTexture.magFilter = THREE.NearestFilter;
      sourceTexture.minFilter = THREE.NearestFilter;
      sourceTexture.generateMipmaps = false;
      sourceTexture.anisotropy = 1;
      sourceTexture.needsUpdate = true;
    });
  });
}

function prepareLavaTextures(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const path: string[] = [];
    let ancestor: THREE.Object3D | null = object;
    while (ancestor) {
      path.push(ancestor.name);
      ancestor = ancestor.parent;
    }
    const pathName = path.join(" ");
    if (!/lava|volcano|volcanic/i.test(pathName) || /banner|spike/i.test(pathName)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => {
      // The emissive mountain clone shares its RugmanMountain texture object
      // with every bridge/door/tower mesh. Only retile the actual Lava.png
      // material; mutating the shared atlas would turn the whole scene into
      // lava.
      if (!/^lava(?:\s|$)/i.test(material.name)) return;
      const textured = material as THREE.Material & {
        map?: THREE.Texture;
        emissiveMap?: THREE.Texture;
      };
      for (const texture of [textured.map, textured.emissiveMap]) {
        if (!texture) continue;
        // The exporter bakes the authored Object-space Mapping (coords * 0.35)
        // into the pool UVs, so the texture is sampled 1:1 at the original
        // density on every pool instead of stretching one repeat per mesh.
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.repeat.set(LAVA_TEXTURE_REPEAT, LAVA_TEXTURE_REPEAT);
        texture.offset.set(0, 0);
        texture.center.set(0.5, 0.5);
        texture.rotation = 0;
        texture.matrixAutoUpdate = true;
        texture.updateMatrix();
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.NearestFilter;
        texture.generateMipmaps = false;
        texture.anisotropy = 1;
        texture.needsUpdate = true;
      }
    });
  });
}

function freeRapierWorld(world: World): void {
  // World.free() releases the world and all of its dependent WASM objects in
  // the order expected by Rapier. Freeing the public fields individually can
  // race with a borrowed controller during route changes and HMR teardown.
  world.free();
}

function prepareImportedMaterial(material: THREE.Material): void {
  const texturedMaterial = material as THREE.Material & { map?: THREE.Texture };
  if (texturedMaterial.map) {
    // Unity exports several atlas maps as RGBA PNGs while leaving their glTF
    // material mode opaque. Respect the embedded alpha so unused atlas regions
    // do not become black rectangles in the browser.
    texturedMaterial.map.colorSpace = THREE.SRGBColorSpace;
    // High anisotropy keeps the alpha-cut boundaries (foliage, pool mats, ...)
    // from shimmering between mip levels while the camera moves.
    texturedMaterial.map.anisotropy = 16;
    texturedMaterial.map.needsUpdate = true;
    if (/cutout/i.test(material.name)) {
      // Unity CUTOUT materials use clip transparency; the Blender export
      // converts them to BLEND, which turns half a scene into alpha-sorted
      // geometry and lets large transparent sheets (water) draw over solid
      // ground. Restore alpha-testing so they render opaque with hard edges.
      material.transparent = false;
      material.alphaTest = Math.max(material.alphaTest, 0.5);
      material.depthWrite = true;
    } else if (!material.transparent) {
      material.alphaTest = Math.max(material.alphaTest, 0.1);
      material.depthWrite = true;
    }
  }
  if (/yacht club opaque|cardboard box opaque/i.test(material.name)) {
    material.transparent = false;
    material.alphaTest = 0;
    material.opacity = 1;
    material.depthWrite = true;
  }
  // GLTFLoader already sets material.side from the GLB's doubleSided flag
  // (the export pipeline marks every material that needs backface rendering,
  // e.g. via the double-sided-faces pass). Do not force DoubleSide on every
  // material: single-sided materials rasterize half the pixels, which matters
  // on mobile GPUs. Inverted winding on a single-sided mesh would punch holes,
  // so the pipeline's explicit per-material flag is authoritative.
  material.needsUpdate = true;
}

function matchesMaterialOverride(objectName: string, override: SceneMaterialOverride): boolean {
  const exactName = override.name ? THREE.PropertyBinding.sanitizeNodeName(override.name) : null;
  const namePrefix = override.namePrefix
    ? THREE.PropertyBinding.sanitizeNodeName(override.namePrefix)
    : null;
  return exactName === objectName || (namePrefix != null && objectName.startsWith(namePrefix));
}

type IndexedComponentData = {
  triangleComponents: readonly number[];
  trianglesByComponent: readonly (readonly number[])[];
};

function getIndexedComponentData(geometry: THREE.BufferGeometry): IndexedComponentData | null {
  const index = geometry.getIndex();
  const position = geometry.getAttribute("position");
  if (!index || !position || index.count % 3 !== 0) return null;
  const parents = new Int32Array(position.count);
  parents.forEach((_value, vertex) => {
    parents[vertex] = vertex;
  });
  const root = (vertex: number): number => {
    let current = vertex;
    while (parents[current] !== current) {
      parents[current] = parents[parents[current]];
      current = parents[current];
    }
    return current;
  };
  const join = (left: number, right: number) => {
    const leftRoot = root(left);
    const rightRoot = root(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  const indices = index.array;
  for (let triangle = 0; triangle < index.count; triangle += 3) {
    join(indices[triangle], indices[triangle + 1]);
    join(indices[triangle + 1], indices[triangle + 2]);
  }
  const componentIds = new Map<number, number>();
  const trianglesByComponent: number[][] = [];
  const triangleComponents = new Array<number>(index.count / 3);
  for (let triangle = 0; triangle < index.count / 3; triangle += 1) {
    const componentRoot = root(indices[triangle * 3]);
    let component = componentIds.get(componentRoot);
    if (component == null) {
      component = trianglesByComponent.length;
      componentIds.set(componentRoot, component);
      trianglesByComponent.push([]);
    }
    triangleComponents[triangle] = component;
    trianglesByComponent[component].push(
      indices[triangle * 3],
      indices[triangle * 3 + 1],
      indices[triangle * 3 + 2],
    );
  }
  return { triangleComponents, trianglesByComponent };
}

function cloneGeometryWithIndices(
  source: THREE.BufferGeometry,
  indices: readonly number[],
): THREE.BufferGeometry {
  const geometry = source.clone();
  geometry.clearGroups();
  const sourceIndexArray = source.getIndex()?.array;
  const IndexArray = sourceIndexArray?.constructor as typeof Uint16Array | undefined;
  if (!IndexArray) return geometry;
  geometry.setIndex(new THREE.BufferAttribute(new IndexArray(indices), 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function applySceneMaterialOverrides(
  root: THREE.Object3D,
  overrides: readonly SceneMaterialOverride[],
): void {
  if (overrides.length === 0) return;
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const matching = overrides.filter((override) => matchesMaterialOverride(object.name, override));
    if (matching.length === 0) return;
    const componentOverride = matching.find((override) => override.components?.length);
    if (componentOverride?.components?.length && object.geometry.index) {
      const componentData = getIndexedComponentData(object.geometry);
      const componentIndices = componentData
        ? componentOverride.components.flatMap(
            (component) => componentData.trianglesByComponent[component - 1] ?? [],
          )
        : [];
      const selectedComponents = new Set(
        componentOverride.components.map((component) => component - 1),
      );
      if (componentData && componentIndices.length > 0) {
        const originalIndex = object.geometry.index.array;
        const remainingIndices: number[] = [];
        for (let triangle = 0; triangle < originalIndex.length / 3; triangle += 1) {
          if (selectedComponents.has(componentData.triangleComponents[triangle])) continue;
          remainingIndices.push(
            originalIndex[triangle * 3],
            originalIndex[triangle * 3 + 1],
            originalIndex[triangle * 3 + 2],
          );
        }
        const componentMesh = object.clone();
        componentMesh.name = `${object.name} components ${componentOverride.components.join(",")}`;
        componentMesh.geometry = cloneGeometryWithIndices(object.geometry, componentIndices);
        componentMesh.material = Array.isArray(object.material)
          ? object.material[0].clone()
          : object.material.clone();
        object.geometry = cloneGeometryWithIndices(object.geometry, remainingIndices);
        object.parent?.add(componentMesh);
        const componentName = componentMesh.name;
        componentMesh.name = object.name;
        applySceneMaterialOverrides(componentMesh, [
          {
            ...componentOverride,
            name: object.name,
            components: undefined,
          },
        ]);
        componentMesh.name = componentName;
      }
    }
    const meshMatching = matching.filter((override) => !override.components?.length);
    if (meshMatching.length === 0) return;
    matching.forEach((override) => {
      if (override.components?.length) return;
      if (override.visible != null) object.visible = override.visible;
    });
    const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
    const corrected = sourceMaterials.map((source) => {
      let material = source.clone();
      for (const override of meshMatching) {
        const textured = material as THREE.Material & {
          alphaMap?: THREE.Texture | null;
          map?: THREE.Texture | null;
        };
        if (override.unlitFromMap && textured.map) {
          const unlit = new THREE.MeshBasicMaterial({
            alphaMap: textured.alphaMap ?? null,
            alphaTest: material.alphaTest,
            color: 0xffffff,
            depthTest: material.depthTest,
            depthWrite: material.depthWrite,
            map: textured.map,
            opacity: material.opacity,
            side: material.side,
            transparent: material.transparent,
            vertexColors: material.vertexColors,
          });
          unlit.name = material.name;
          material.dispose();
          material = unlit;
        }
        if (override.unlit) {
          const unlit = new THREE.MeshBasicMaterial({
            alphaMap: override.ignoreMap ? null : (textured.alphaMap ?? null),
            alphaTest: override.ignoreMap ? 0 : material.alphaTest,
            color:
              "color" in material
                ? (material as THREE.Material & { color: THREE.Color }).color
                : 0xffffff,
            depthTest: material.depthTest,
            depthWrite: material.depthWrite,
            map: override.ignoreMap ? null : (textured.map ?? null),
            opacity: material.opacity,
            side: material.side,
            transparent: material.transparent,
          });
          unlit.name = material.name;
          material.dispose();
          material = unlit;
        }
        if (override.opacity != null) {
          material.opacity = override.opacity;
          material.transparent = override.opacity < 1;
        }
        if (override.alphaTest != null) material.alphaTest = override.alphaTest;
        if (override.transparent != null) material.transparent = override.transparent;
        if (override.color != null && "color" in material) {
          (material as THREE.Material & { color: THREE.Color }).color.set(override.color);
        }
        if (override.emissiveIntensity != null && "emissiveIntensity" in material) {
          (material as THREE.Material & { emissiveIntensity: number }).emissiveIntensity =
            override.emissiveIntensity;
        }
        if (override.depthWrite != null) material.depthWrite = override.depthWrite;
        if (override.side === "front") material.side = THREE.FrontSide;
        else if (override.side === "back") material.side = THREE.BackSide;
        else if (override.side === "double") material.side = THREE.DoubleSide;
        if (override.blending === "normal") material.blending = THREE.NormalBlending;
        else if (override.blending === "additive") material.blending = THREE.AdditiveBlending;
        if (override.renderOrder != null) object.renderOrder = override.renderOrder;
      }
      material.needsUpdate = true;
      return material;
    });
    object.material = Array.isArray(object.material) ? corrected : corrected[0];
  });
}

export function SceneHost({
  label = "Scene",
  assetUrl,
  entryZoneId,
  preserveEntryCollision = false,
  keepZoneCollisionsActive = false,
  collisionAssetUrl,
  additionalCollisionAssetUrls = EMPTY_ASSET_URLS,
  additionalAssetUrls = EMPTY_ASSET_URLS,
  zones = EMPTY_ZONES,
  startPosition = DEFAULT_START,
  staticColliders = EMPTY_STATIC_COLLIDERS,
  collideAdditionalVisualLayers = true,
  collisionExclusionAreas = EMPTY_COLLISION_EXCLUSION_AREAS,
  coplanarMaterialMeshNames = EMPTY_ASSET_URLS,
  materialOverrides = EMPTY_MATERIAL_OVERRIDES,
  playerVisibilityGroups = EMPTY_VISIBILITY_GROUPS,
  characterId = "security",
  characterScale = DEFAULT_characterModelScale,
  sceneScale = 1,
  movementSpeedFactor = 1,
  enableClickNavigation = false,
  clickNavigationBounds,
  clickNavigationIndicatorScale = 1,
  orthographicClickOnly = false,
  cameraWheelZoomEnabled = true,
  orthographicMovementSpeedFactor = movementSpeedFactor,
  cameraBounds,
  orthographicHalfHeight,
  orthographicPitch,
  orthographicPan,
  perspectiveCameraDistance: _perspectiveCameraDistance,
  waterVolumes = EMPTY_WATER_VOLUMES,
  initialCameraViewMode = "perspective",
  cameraViewModeRef,
  deferCharacterDetails = false,
  loadDeferredCharacterDetails = true,
  characterGroundOffset = 0,
  debugApiRef,
  onDebugApiReady,
  environment,
  editorOverridesUrl,
  visualSetup,
  visualUpdate,
  showHud = false,
  onLoadingStart,
  onReady,
  staticFieldAssetUrls,
  staticFieldCollisionAssetUrls,
  staticFieldCollisionPatterns = EMPTY_COLLISION_INCLUDE_PATTERNS,
  collisionIncludePatterns = EMPTY_COLLISION_INCLUDE_PATTERNS,
  foliageManifestUrl,
  propsManifestUrl,
}: SceneHostProps) {
  const playerHeight = characterScale.height;
  const playerRadius = characterScale.radius;
  const playerSpeed = PLAYER_SPEED;
  const jumpSpeed = JUMP_SPEED;
  const gravity = GRAVITY;
  const swimJumpSpeed = SWIM_JUMP_SPEED;
  const groundedVelocity = -1;
  const characterModelScale = characterScale.modelScale;
  const segmentHalfHeight = Math.max(playerHeight / 2 - playerRadius, 0.05);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const initialCameraViewModeRef = useRef(initialCameraViewMode);
  const cameraWheelZoomEnabledRef = useRef(cameraWheelZoomEnabled);
  const [status, setStatus] = useState(`Loading ${label}…`);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<string>("—");

  useEffect(() => {
    cameraWheelZoomEnabledRef.current = cameraWheelZoomEnabled;
  }, [cameraWheelZoomEnabled]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    onLoadingStart?.();
    setError(null);
    const loadingStartedAt = performance.now();

    const scaleBounds = <T extends { xMin: number; xMax: number; zMin: number; zMax: number }>(
      bounds: T,
    ): T => ({
      ...bounds,
      xMin: bounds.xMin * sceneScale,
      xMax: bounds.xMax * sceneScale,
      zMin: bounds.zMin * sceneScale,
      zMax: bounds.zMax * sceneScale,
    });
    const runtimeClickNavigationBounds = clickNavigationBounds
      ? scaleBounds(clickNavigationBounds)
      : undefined;
    const runtimeCameraBounds = cameraBounds ? scaleBounds(cameraBounds) : undefined;
    const runtimeOrthographicHalfHeight =
      orthographicHalfHeight == null ? undefined : orthographicHalfHeight * sceneScale;
    const runtimeOrthographicPan = orthographicPan
      ? { x: orthographicPan.x * sceneScale, z: orthographicPan.z * sceneScale }
      : undefined;
    const runtimeClickNavigationIndicatorScale = clickNavigationIndicatorScale * sceneScale;
    const runtimeCollisionExclusionAreas = collisionExclusionAreas.map((area) => ({
      ...area,
      xMin: area.xMin * sceneScale,
      xMax: area.xMax * sceneScale,
      yMin: area.yMin * sceneScale,
      yMax: area.yMax * sceneScale,
      zMin: area.zMin * sceneScale,
      zMax: area.zMax * sceneScale,
    }));
    // Zone-local water bounds are transformed by their scaled zone root below;
    // global volumes need their coordinates scaled here.
    const runtimeWaterVolumes = waterVolumes.map((volume) =>
      volume.zoneId
        ? volume
        : {
            ...volume,
            xMin: volume.xMin * sceneScale,
            xMax: volume.xMax * sceneScale,
            zMin: volume.zMin * sceneScale,
            zMax: volume.zMax * sceneScale,
            surfaceY: volume.surfaceY * sceneScale,
          },
    );

    let disposed = false;
    const loadScope = createSceneLoadScope();
    let loadingManager: THREE.LoadingManager | null = null;
    const editorOverridesRequest: Promise<SceneEditorOverrides> = editorOverridesUrl
      ? fetch(editorOverridesUrl, { cache: "no-store", signal: loadScope.signal })
          .then((response) =>
            response.ok ? (response.json() as Promise<SceneEditorOverrides>) : { objects: {} },
          )
          .catch(() => ({ objects: {} }))
      : Promise.resolve({ objects: {} });
    let animationFrame = 0;
    let positionFrame = 0;
    let world: World | null = null;
    let characterController: KinematicCharacterController | null = null;
    let playerCollider: Collider | null = null;
    let characterRoot: THREE.Object3D | null = null;
    let animationController: CharacterAnimationController | null = null;
    let locomotionAction: THREE.AnimationAction | undefined;
    let idleAction: THREE.AnimationAction | undefined;
    let jumpAction: THREE.AnimationAction | undefined;
    let swimmingAction: THREE.AnimationAction | undefined;
    let backgroundTexture: THREE.Texture | null = null;
    const detachedCollisionRoots = new Set<THREE.Object3D>();

    const qualityTier = detectQualityTier();
    const activeRenderer = (() => {
      let candidate: THREE.WebGLRenderer | undefined;
      try {
        const pixelRatio = Math.min(
          window.devicePixelRatio,
          qualityTier === "high"
            ? HIGH_END_PIXEL_RATIO
            : qualityTier === "standard"
              ? STANDARD_PIXEL_RATIO
              : LOW_END_PIXEL_RATIO,
        );
        candidate = new THREE.WebGLRenderer({
          canvas,
          antialias: qualityTier !== "low",
          powerPreference: qualityTier === "high" ? "high-performance" : "default",
        });
        candidate.setPixelRatio(pixelRatio);
        candidate.setSize(window.innerWidth, window.innerHeight, false);
        candidate.outputColorSpace = THREE.SRGBColorSpace;
        candidate.shadowMap.enabled = true;
        candidate.shadowMap.type = THREE.PCFShadowMap;
        return candidate;
      } catch (cause) {
        candidate?.dispose();
        const message =
          cause instanceof Error ? cause.message : "WebGL is unavailable in this browser";
        setError(message);
        setStatus(`Unable to initialize ${label}`);
        return null;
      }
    })();
    if (!activeRenderer) {
      return;
    }
    const telemetry = createScenePerformanceTelemetry(label, activeRenderer, qualityTier);
    const onWebglContextLost = (event: Event) => {
      event.preventDefault();
      const message = "webgl_context_lost";
      telemetry.fail(new Error(message));
      setError("The graphics context was lost. Reload the scene to restore it.");
      setStatus(`${label} graphics unavailable`);
    };
    canvas.addEventListener("webglcontextlost", onWebglContextLost, false);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(environment?.background ?? 0x9fd9f7);
    if (environment?.fog) {
      scene.fog =
        environment.fog.mode === "linear"
          ? new THREE.Fog(
              environment.fog.color,
              environment.fog.near ?? 1,
              environment.fog.far ?? 500,
            )
          : new THREE.FogExp2(environment.fog.color, environment.fog.density ?? 0.002);
    } else {
      scene.fog = null;
    }

    let textureTranscoder: KTX2Loader | null = null;
    const zoneRoots = new Map<string, THREE.Object3D>();
    const zonePromises = new Map<string, Promise<void>>();
    const zoneCollisionColliders = new Map<string, Collider[]>();
    let activeZoneCollisionId: string | null = null;
    let zoneProximityFrame = 0;
    let proximityZonesReady = false;
    let registerZoneVisibility: (root: THREE.Object3D) => void = () => undefined;
    let unregisterZoneVisibility: (root: THREE.Object3D) => void = () => undefined;
    const cameraController = new CameraController({
      canvas,
      initialViewMode: initialCameraViewModeRef.current,
      initialYaw: startPosition.yaw ?? 0,
      initialPerspectivePitch: startPosition.pitch ?? -0.2,
      characterScale: playerHeight / 1.8,
      cameraBounds: runtimeCameraBounds,
      orthographicHalfHeight: runtimeOrthographicHalfHeight,
      orthographicPitch,
      orthographicPan: runtimeOrthographicPan,
    });
    let camera: THREE.Camera = cameraController.camera;
    const isOrthographicClickOnly = () =>
      orthographicClickOnly && cameraController.viewMode === "orthographic";
    const playerPosition = new THREE.Vector3(
      startPosition.x * sceneScale,
      startPosition.y * sceneScale,
      startPosition.z * sceneScale,
    );
    const clickNavigationTarget = new THREE.Vector3();
    const clickNavigationDirection = new THREE.Vector3();
    const clickNavigationPath: THREE.Vector3[] = [];
    let clickNavigationPathIndex = 0;
    const navigationRaycaster = new THREE.Raycaster();
    const navigationPointer = new THREE.Vector2();
    const navigationPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const navigationWorldPoint = new THREE.Vector3();
    const navigationIndicator = new THREE.Mesh(
      new THREE.RingGeometry(0.28, 0.42, 32),
      new THREE.MeshBasicMaterial({
        color: 0xffd166,
        depthWrite: false,
        opacity: 0.9,
        side: THREE.DoubleSide,
        transparent: true,
      }),
    );
    navigationIndicator.scale.setScalar(runtimeClickNavigationIndicatorScale);
    navigationIndicator.name = "scene-editor-click-navigation-indicator";
    navigationIndicator.rotation.x = -Math.PI / 2;
    navigationIndicator.renderOrder = 100;
    navigationIndicator.visible = false;
    scene.add(navigationIndicator);
    let clickNavigationActive = false;
    let clickNavigationEnabled = enableClickNavigation;
    let clickNavigationBlockedFrames = 0;
    let verticalVelocity = 0;
    let intentionalJumpActive = false;
    let jumpQueued = false;
    let swimJumpFrames = 0;
    let climbFrames = 0;
    const keys = new Set<string>();
    const timer = new Timer();
    let resourcesDisposed = false;
    const disposeResources = () => {
      if (resourcesDisposed) return;
      resourcesDisposed = true;
      loadScope.abort();
      loadingManager?.abort();
      loadingManager = null;
      const controller = characterController;
      const physicsWorld = world;
      characterController = null;
      playerCollider = null;
      world = null;
      try {
        // Rapier's WASM wrapper can reject a controller that is being torn down
        // while an async scene load is being cancelled. Cleanup must never turn
        // a route change or HMR refresh into an unhandled runtime error.
        if (controller && physicsWorld) physicsWorld.removeCharacterController(controller);
      } catch (cause) {
        console.warn("[Agent HQ] Rapier character controller cleanup skipped", cause);
      }
      try {
        if (physicsWorld) freeRapierWorld(physicsWorld);
      } catch (cause) {
        console.warn("[Agent HQ] Rapier world cleanup skipped", cause);
      }
      animationController?.dispose();
      animationController = null;
      locomotionAction = undefined;
      idleAction = undefined;
      jumpAction = undefined;
      swimmingAction = undefined;
      textureTranscoder?.dispose();
      textureTranscoder = null;
      backgroundTexture?.dispose();
      backgroundTexture = null;
      scene.background = null;
      detachedCollisionRoots.forEach(disposeObjectTree);
      detachedCollisionRoots.clear();
      disposeObjectTree(scene);
      activeRenderer.dispose();
    };

    const hemisphereConfig = environment?.hemisphereLight;
    if (hemisphereConfig !== null) {
      const hemisphere = hemisphereConfig ?? {
        skyColor: 0xc9ecff,
        groundColor: 0x745238,
        intensity: 2.2,
      };
      scene.add(
        new THREE.HemisphereLight(
          hemisphere.skyColor,
          hemisphere.groundColor,
          hemisphere.intensity,
        ),
      );
    }
    const directionalLights = environment?.directionalLights ?? [
      { color: 0xfff0c5, intensity: 3.2, position: [-80, 140, 70] as const, castShadow: true },
    ];
    directionalLights.forEach((config) => {
      const directional = new THREE.DirectionalLight(config.color, config.intensity);
      directional.position.set(...config.position);
      directional.target.position.set(...(config.target ?? [0, 0, 0]));
      directional.castShadow = config.castShadow ?? false;
      if (directional.castShadow) {
        directional.shadow.mapSize.set(2048, 2048);
        directional.shadow.camera.near = 1;
        directional.shadow.camera.far = 500;
        directional.shadow.camera.left = -180;
        directional.shadow.camera.right = 180;
        directional.shadow.camera.top = 180;
        directional.shadow.camera.bottom = -180;
      }
      scene.add(directional.target);
      scene.add(directional);
    });
    for (const config of environment?.spotlights ?? []) {
      const position = new THREE.Vector3(...config.position);
      const target = new THREE.Vector3(...config.target);
      if (config.light !== false) {
        const spotlight = new THREE.SpotLight(
          config.color,
          config.intensity,
          config.distance ?? 50,
          config.angle ?? Math.PI / 6,
          config.penumbra ?? 0.7,
          config.decay ?? 1.5,
        );
        spotlight.position.copy(position);
        spotlight.target.position.copy(target);
        scene.add(spotlight.target);
        scene.add(spotlight);
      }

      if (config.beam) {
        const direction = target.sub(position);
        const length = direction.length();
        if (length > 0.01) {
          const beam = new THREE.Mesh(
            new THREE.ConeGeometry(config.beam.radius, length, 32, 1, true),
            new THREE.MeshBasicMaterial({
              color: config.color,
              depthWrite: false,
              opacity: config.beam.opacity,
              side: THREE.DoubleSide,
              blending: THREE.AdditiveBlending,
              transparent: true,
              toneMapped: false,
            }),
          );
          beam.name = "Scene spotlight beam";
          beam.position.copy(position).addScaledVector(direction, 0.5);
          beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), direction.normalize());
          beam.renderOrder = 2;
          scene.add(beam);
        }
      }
    }

    const resize = () => {
      cameraController.resize(window.innerWidth, window.innerHeight);
      activeRenderer.setSize(window.innerWidth, window.innerHeight, false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (isOrthographicClickOnly()) {
        event.preventDefault();
        keys.clear();
        jumpQueued = false;
        clickNavigationActive = false;
        clickNavigationPath.length = 0;
        clickNavigationPathIndex = 0;
        return;
      }
      if (clickNavigationEnabled && ["KeyW", "KeyA", "KeyS", "KeyD"].includes(event.code)) {
        clickNavigationActive = false;
        clickNavigationPath.length = 0;
        clickNavigationPathIndex = 0;
      }
      keys.add(event.code);
      if (event.code === "Space" && !event.repeat) {
        event.preventDefault();
        jumpQueued = true;
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      keys.delete(event.code);
    };
    const onBlur = () => {
      keys.clear();
      clickNavigationActive = false;
      clickNavigationPath.length = 0;
      clickNavigationPathIndex = 0;
    };
    const navigationHitAt = (event: PointerEvent): THREE.Vector3 | null => {
      if (!clickNavigationEnabled || cameraController.viewMode !== "orthographic") return null;
      const rect = activeRenderer.domElement.getBoundingClientRect();
      navigationPointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      navigationRaycaster.setFromCamera(navigationPointer, camera);
      // The visual floor is allowed to have gaps, room overrides, or meshes
      // whose raycast bounds are not reliable. Use a dedicated horizontal map
      // plane for input instead of requiring a particular visible mesh to win
      // the raycast. This keeps clicking reliable across grass, slab, and open
      // doorways while the physics route still decides whether the destination
      // is reachable.
      const navigationSurfaceY = playerPosition.y - playerHeight / 2;
      navigationPlane.constant = -navigationSurfaceY;
      const point = navigationRaycaster.ray.intersectPlane(navigationPlane, navigationWorldPoint);
      if (!point) return null;
      if (runtimeClickNavigationBounds) {
        point.x = Math.max(
          runtimeClickNavigationBounds.xMin,
          Math.min(runtimeClickNavigationBounds.xMax, point.x),
        );
        point.z = Math.max(
          runtimeClickNavigationBounds.zMin,
          Math.min(runtimeClickNavigationBounds.zMax, point.z),
        );
      }
      return point;
    };
    // HQ's foundation colliders are static during play. Keep the expensive
    // capsule occupancy probes across clicks so long routes do not rebuild
    // the same grid one cell at a time.
    const clickNavigationSafeCache = new Map<string, boolean>();
    const buildClickNavigationPath = (targetX: number, targetZ: number): THREE.Vector3[] => {
      if (!world || !playerCollider) return [];
      const physicsWorld = world;
      const navigationCollider = playerCollider;
      // The foundation is authored in centimetre-scale world units. HQ's
      // 120-unit doorways render to 0.6 m while the avatar's 0.48 m diameter
      // leaves only 0.12 m of center clearance. A coarse cell can therefore
      // straddle a doorway and make an otherwise valid route look blocked.
      // Keep the finer grid aligned to 12 authored units (0.06 m at HQ's
      // locked scale), but preserve World's existing navigation resolution
      // for normal-scale scenes.
      const defaultGridStep = Math.min(
        64 * sceneScale,
        Math.max(24 * sceneScale, playerRadius * 0.75),
      );
      const hqGridStep = Math.min(64 * sceneScale, Math.max(6 * sceneScale, playerRadius * 0.25));
      const gridStep = sceneScale < 0.1 ? hqGridStep : defaultGridStep;
      const clampCell = (value: number, minimum: number, maximum: number) =>
        Math.max(minimum, Math.min(maximum, value));
      const mapMinX = runtimeClickNavigationBounds
        ? Math.ceil(runtimeClickNavigationBounds.xMin / gridStep)
        : -Infinity;
      const mapMaxX = runtimeClickNavigationBounds
        ? Math.floor(runtimeClickNavigationBounds.xMax / gridStep)
        : Infinity;
      const mapMinZ = runtimeClickNavigationBounds
        ? Math.ceil(runtimeClickNavigationBounds.zMin / gridStep)
        : -Infinity;
      const mapMaxZ = runtimeClickNavigationBounds
        ? Math.floor(runtimeClickNavigationBounds.zMax / gridStep)
        : Infinity;
      const start: NavigationCell = {
        x: clampCell(Math.round(playerPosition.x / gridStep), mapMinX, mapMaxX),
        z: clampCell(Math.round(playerPosition.z / gridStep), mapMinZ, mapMaxZ),
      };
      const requestedGoal: NavigationCell = {
        x: clampCell(Math.round(targetX / gridStep), mapMinX, mapMaxX),
        z: clampCell(Math.round(targetZ / gridStep), mapMinZ, mapMaxZ),
      };
      // A destination can be on the far side of several foundation walls.
      // Search the complete bounded HQ envelope so the route can use any
      // doorway, including one well outside the direct start-to-goal window.
      // The bounded map is only about 30k cells at this grid size, and the
      // Euclidean heuristic still makes ordinary clicks resolve in a narrow
      // corridor around the shortest route.
      const margin = Math.max(10, Math.ceil((playerRadius + 24 * sceneScale) / gridStep));
      const hasFiniteMapBounds = [mapMinX, mapMaxX, mapMinZ, mapMaxZ].every(Number.isFinite);
      const minX = hasFiniteMapBounds ? mapMinX : Math.min(start.x, requestedGoal.x) - margin;
      const maxX = hasFiniteMapBounds ? mapMaxX : Math.max(start.x, requestedGoal.x) + margin;
      const minZ = hasFiniteMapBounds ? mapMinZ : Math.min(start.z, requestedGoal.z) - margin;
      const maxZ = hasFiniteMapBounds ? mapMaxZ : Math.max(start.z, requestedGoal.z) + margin;
      const cellKey = ({ x, z }: NavigationCell) => `${x},${z}`;
      const startKey = cellKey(start);
      // The walkable floor is intentionally a solid collider. Probe at the
      // player's actual capsule height, with only a small lift to avoid the
      // resting contact with the floor. The previous +1-unit lift placed the
      // probe above HQ's short foundation walls, marking walls as walkable;
      // the live character then ran into those walls and could not re-route.
      const navigationQueryY = playerPosition.y + Math.max(0.02, playerRadius * 0.15);
      const isSafe = (cell: NavigationCell): boolean => {
        const key = cellKey(cell);
        const cached = clickNavigationSafeCache.get(key);
        if (cached != null) return cached;
        if (key === startKey) {
          clickNavigationSafeCache.set(key, true);
          return true;
        }
        const safe =
          physicsWorld.intersectionWithShape(
            { x: cell.x * gridStep, y: navigationQueryY, z: cell.z * gridStep },
            { x: 0, y: 0, z: 0, w: 1 },
            navigationCollider.shape,
            undefined,
            undefined,
            navigationCollider,
          ) == null;
        clickNavigationSafeCache.set(key, safe);
        return safe;
      };

      const isSafePoint = (x: number, z: number): boolean =>
        physicsWorld.intersectionWithShape(
          { x, y: navigationQueryY, z },
          { x: 0, y: 0, z: 0, w: 1 },
          navigationCollider.shape,
          undefined,
          undefined,
          navigationCollider,
        ) == null;

      let goal = requestedGoal;
      if (!isSafe(goal)) {
        for (let radius = 1; radius <= 8 && goal === requestedGoal; radius += 1) {
          for (
            let x = requestedGoal.x - radius;
            x <= requestedGoal.x + radius && goal === requestedGoal;
            x += 1
          ) {
            for (let z = requestedGoal.z - radius; z <= requestedGoal.z + radius; z += 1) {
              if (Math.max(Math.abs(x - requestedGoal.x), Math.abs(z - requestedGoal.z)) !== radius)
                continue;
              if (x < mapMinX || x > mapMaxX || z < mapMinZ || z > mapMaxZ) continue;
              const candidate = { x, z };
              if (isSafe(candidate)) goal = candidate;
            }
          }
        }
        if (!isSafe(goal)) return [];
      }

      const goalKey = cellKey(goal);
      type NavigationQueueEntry = { cell: NavigationCell; priority: number };
      const open: NavigationQueueEntry[] = [{ cell: start, priority: 0 }];
      const pushOpen = (entry: NavigationQueueEntry): void => {
        open.push(entry);
        let index = open.length - 1;
        while (index > 0) {
          const parent = Math.floor((index - 1) / 2);
          if (open[parent].priority <= open[index].priority) break;
          [open[parent], open[index]] = [open[index], open[parent]];
          index = parent;
        }
      };
      const popOpen = (): NavigationQueueEntry | undefined => {
        const first = open[0];
        const last = open.pop();
        if (!last || open.length === 0) return first;
        open[0] = last;
        let index = 0;
        while (true) {
          const left = index * 2 + 1;
          const right = left + 1;
          let smallest = index;
          if (left < open.length && open[left].priority < open[smallest].priority) smallest = left;
          if (right < open.length && open[right].priority < open[smallest].priority)
            smallest = right;
          if (smallest === index) break;
          [open[index], open[smallest]] = [open[smallest], open[index]];
          index = smallest;
        }
        return first;
      };
      const cameFrom = new Map<string, string>();
      const cost = new Map<string, number>([[startKey, 0]]);
      const estimate = (cell: NavigationCell) => Math.hypot(cell.x - goal.x, cell.z - goal.z);
      const directions: Array<[number, number, number]> = [
        [1, 0, 1],
        [-1, 0, 1],
        [0, 1, 1],
        [0, -1, 1],
        [1, 1, Math.SQRT2],
        [1, -1, Math.SQRT2],
        [-1, 1, Math.SQRT2],
        [-1, -1, Math.SQRT2],
      ];
      const pointForCell = (cell: NavigationCell): THREE.Vector3 =>
        new THREE.Vector3(cell.x * gridStep, playerPosition.y, cell.z * gridStep);
      const hasClearSegment = (from: THREE.Vector3, to: THREE.Vector3): boolean => {
        const distance = Math.hypot(to.x - from.x, to.z - from.z);
        const sampleStep = Math.max(sceneScale * 12, playerRadius * 0.35);
        const samples = Math.max(1, Math.ceil(distance / sampleStep));
        for (let sample = 1; sample <= samples; sample += 1) {
          const progress = sample / samples;
          const x = THREE.MathUtils.lerp(from.x, to.x, progress);
          const z = THREE.MathUtils.lerp(from.z, to.z, progress);
          if (!isSafePoint(x, z)) return false;
        }
        return true;
      };
      const hasClearGridSegment = (from: NavigationCell, to: NavigationCell): boolean => {
        const startPoint =
          cellKey(from) === startKey
            ? new THREE.Vector3(playerPosition.x, playerPosition.y, playerPosition.z)
            : pointForCell(from);
        return hasClearSegment(startPoint, pointForCell(to));
      };
      let found = false;
      let visited = 0;
      const maxVisits = (maxX - minX + 1) * (maxZ - minZ + 1);
      while (open.length > 0 && visited < maxVisits) {
        const entry = popOpen();
        if (!entry) break;
        const current = entry.cell;
        const currentKey = cellKey(current);
        const currentPriority = (cost.get(currentKey) ?? Infinity) + estimate(current);
        if (entry.priority > currentPriority + 0.0001) continue;
        visited += 1;
        if (currentKey === goalKey) {
          found = true;
          break;
        }
        for (const [offsetX, offsetZ, stepCost] of directions) {
          const next = { x: current.x + offsetX, z: current.z + offsetZ };
          if (next.x < minX || next.x > maxX || next.z < minZ || next.z > maxZ || !isSafe(next))
            continue;
          if (
            offsetX !== 0 &&
            offsetZ !== 0 &&
            (!isSafe({ x: current.x + offsetX, z: current.z }) ||
              !isSafe({ x: current.x, z: current.z + offsetZ }))
          )
            continue;
          if (!hasClearGridSegment(current, next)) continue;
          const nextKey = cellKey(next);
          const nextCost = (cost.get(currentKey) ?? Infinity) + stepCost;
          if (nextCost >= (cost.get(nextKey) ?? Infinity)) continue;
          cost.set(nextKey, nextCost);
          cameFrom.set(nextKey, currentKey);
          pushOpen({ cell: next, priority: nextCost + estimate(next) });
        }
      }
      if (!found) {
        const nearby = directions
          .slice(0, 4)
          .map(
            ([offsetX, offsetZ]) =>
              `${offsetX},${offsetZ}:${isSafe({ x: start.x + offsetX, z: start.z + offsetZ })}`,
          )
          .join(" ");
        debugLog(
          `[Agent HQ] ${label} click navigation failed visited=${visited} start=${start.x},${start.z} goal=${goal.x},${goal.z} goalSafe=${isSafe(goal)} nearby=${nearby}`,
        );
        return [];
      }

      const cells: NavigationCell[] = [goal];
      let currentKey = goalKey;
      while (currentKey !== startKey) {
        const previousKey = cameFrom.get(currentKey);
        if (!previousKey) return [];
        const [x, z] = previousKey.split(",").map(Number);
        cells.push({ x, z });
        currentKey = previousKey;
      }
      cells.reverse();
      // Shortcut the grid route through collision-checked line segments. A
      // shortest 8-neighbour grid path can alternate E/NE/E/NE for a shallow
      // diagonal, which makes the avatar visibly jig-jag. Keep only the
      // farthest waypoint that can be reached in a straight run while still
      // checking every traversed grid cell and diagonal corner.
      const hasClearGridLine = (from: NavigationCell, to: NavigationCell): boolean => {
        const startPoint =
          cellKey(from) === startKey
            ? new THREE.Vector3(playerPosition.x, playerPosition.y, playerPosition.z)
            : pointForCell(from);
        return hasClearSegment(startPoint, pointForCell(to));
      };
      const smoothedCells = [cells[0]];
      let anchorIndex = 0;
      while (anchorIndex < cells.length - 1) {
        let nextIndex = cells.length - 1;
        while (
          nextIndex > anchorIndex + 1 &&
          !hasClearGridLine(cells[anchorIndex], cells[nextIndex])
        )
          nextIndex -= 1;
        smoothedCells.push(cells[nextIndex]);
        anchorIndex = nextIndex;
      }
      return smoothedCells
        .slice(1)
        .map((cell) => new THREE.Vector3(cell.x * gridStep, playerPosition.y, cell.z * gridStep));
    };
    const onCanvasPointerMove = (event: PointerEvent) => {
      if (!clickNavigationEnabled || cameraController.viewMode !== "orthographic") return;
      activeRenderer.domElement.style.cursor = "crosshair";
      const hit = navigationHitAt(event);
      if (!hit) {
        navigationIndicator.visible = false;
        return;
      }
      navigationIndicator.position.set(hit.x, hit.y + 0.04, hit.z);
      navigationIndicator.visible = true;
    };
    const onCanvasPointerLeave = () => {
      navigationIndicator.visible = false;
      activeRenderer.domElement.style.cursor = "";
    };
    const onCanvasPointerDown = (event: PointerEvent) => {
      if (
        !clickNavigationEnabled ||
        event.button !== 0 ||
        cameraController.viewMode !== "orthographic" ||
        !world ||
        !characterController ||
        !playerCollider
      )
        return;
      const hit = navigationHitAt(event);
      if (!hit) return;
      clickNavigationTarget.set(hit.x, playerPosition.y, hit.z);
      clickNavigationPath.length = 0;
      clickNavigationPath.push(...buildClickNavigationPath(hit.x, hit.z));
      clickNavigationPathIndex = 0;
      debugLog(
        `[Agent HQ] ${label} click navigation target=${hit.x.toFixed(1)},${hit.z.toFixed(1)} path=${clickNavigationPath.length}`,
      );
      // A missing path means the target is blocked or outside the walkable
      // map. Do not fall back to steering directly into a wall.
      clickNavigationActive = clickNavigationPath.length > 0;
      navigationIndicator.position.set(hit.x, hit.y + 0.04, hit.z);
      navigationIndicator.visible = true;
      event.preventDefault();
    };
    const onCanvasWheel = (event: WheelEvent) => {
      if (!cameraWheelZoomEnabledRef.current || event.defaultPrevented) return;
      const rawDelta = Math.abs(event.deltaY);
      if (rawDelta === 0) return;
      const zoomDelta = Math.sign(event.deltaY) * -Math.min(0.15, Math.max(0.02, rawDelta * 0.003));
      if (cameraController.isPerspective) {
        cameraController.adjustPerspectiveZoom(zoomDelta);
      } else {
        cameraController.adjustOrthographicZoom(zoomDelta);
      }
      event.preventDefault();
    };
    canvas.addEventListener("pointerdown", onCanvasPointerDown);
    canvas.addEventListener("pointermove", onCanvasPointerMove);
    canvas.addEventListener("pointerleave", onCanvasPointerLeave);
    canvas.addEventListener("wheel", onCanvasWheel, { passive: false });

    const load = async () => {
      try {
        await telemetry.track("physics.initialize", initializeRapier());
        if (disposed) return;
        world = new RAPIER.World({ x: 0, y: gravity, z: 0 });

        const manager = new THREE.LoadingManager();
        loadingManager = manager;
        manager.onProgress = (_url, loaded, total) =>
          setStatus(`Loading ${label}… ${Math.round((loaded / Math.max(total, 1)) * 100)}%`);
        const loader = new GLTFLoader(manager);
        // meshopt-compressed GLBs (produced by the asset pipeline for large
        // scene geometry) decode in the browser instead of shipping raw floats.
        loader.setMeshoptDecoder(MeshoptDecoder);
        textureTranscoder = new KTX2Loader(manager)
          .setTranscoderPath("/assets/basis/")
          .detectSupport(activeRenderer);
        loader.setKTX2Loader(textureTranscoder);
        const pendingBackground = environment?.backgroundTextureUrl
          ? new THREE.TextureLoader(manager)
              .loadAsync(environment.backgroundTextureUrl)
              .catch((cause) => {
                const message =
                  cause instanceof Error ? cause.message : "unknown background texture error";
                console.warn(`[Agent HQ] ${label} background unavailable: ${message}`);
                return null;
              })
          : Promise.resolve<THREE.Texture | null>(null);
        const prepareSceneLayer = (root: THREE.Object3D) => {
          root.traverse((object) => {
            if (!(object instanceof THREE.Mesh)) return;
            object.castShadow = false;
            object.receiveShadow = true;
            object.frustumCulled = true;
            if (/stats\s*on|spritemesh/i.test(object.name)) {
              object.visible = false;
              return;
            }
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            materials.forEach(prepareImportedMaterial);
          });
        };
        const zonesById = new Map(zones.map((zone) => [zone.id, zone]));
        const deactivateZoneCollision = (id: string) => {
          const colliders = zoneCollisionColliders.get(id);
          if (!colliders) return;
          colliders.forEach((collider) => world?.removeCollider(collider, true));
          zoneCollisionColliders.delete(id);
          if (activeZoneCollisionId === id) activeZoneCollisionId = null;
        };
        const activateZoneCollision = (
          id: string,
          collisionScene: THREE.Object3D | null,
          generatedCollisionScenes: readonly THREE.Object3D[] = EMPTY_OBJECTS,
        ) => {
          if (!world) return 0;
          if (
            !keepZoneCollisionsActive &&
            activeZoneCollisionId &&
            activeZoneCollisionId !== id &&
            !(preserveEntryCollision && activeZoneCollisionId === entryZoneId)
          ) {
            deactivateZoneCollision(activeZoneCollisionId);
          }
          const colliders: Collider[] = [];
          let count = collisionScene
            ? addSceneColliders(
                world,
                collisionScene,
                true,
                runtimeCollisionExclusionAreas,
                undefined,
                collisionIncludePatterns,
                colliders,
              )
            : 0;
          for (const generatedScene of generatedCollisionScenes) {
            count += addSceneColliders(
              world,
              generatedScene,
              true,
              runtimeCollisionExclusionAreas,
              undefined,
              collisionIncludePatterns,
              colliders,
              true,
            );
          }
          zoneCollisionColliders.set(id, colliders);
          activeZoneCollisionId = id;
          if (collisionScene) disposeObjectTree(collisionScene);
          generatedCollisionScenes.forEach(disposeObjectTree);
          return count;
        };
        const applyZoneTransform = (root: THREE.Object3D, transform: SceneZone["transform"]) => {
          if (!transform) return;
          if (transform.position) root.position.fromArray(transform.position);
          if (transform.quaternion) root.quaternion.fromArray(transform.quaternion);
          if (transform.scale) root.scale.fromArray(transform.scale);
          root.updateMatrixWorld(true);
        };
        const loadZone = (id: string): Promise<void> => {
          if (zoneRoots.has(id)) return Promise.resolve();
          const pending = zonePromises.get(id);
          if (pending) return pending;
          const zone = zonesById.get(id);
          if (!zone) return Promise.reject(new Error(`Unknown scene zone: ${id}`));
          const zoneAssetUrls = zone.assetUrls?.length ? zone.assetUrls : [zone.assetUrl];
          const request = telemetry
            .track(
              `zone.${id}`,
              Promise.all([
                ...zoneAssetUrls.map((url) => loader.loadAsync(url)),
                ...(zone.collisionAssetUrl ? [loader.loadAsync(zone.collisionAssetUrl)] : []),
                ...(zone.collisionAssetUrls ?? []).map((url) => loader.loadAsync(url)),
              ]),
            )
            .then(async (loadedAssets) => {
              const zoneAssets = loadedAssets.slice(0, zoneAssetUrls.length);
              const collisionAsset = zone.collisionAssetUrl
                ? loadedAssets[zoneAssetUrls.length]
                : null;
              const collisionAssets = loadedAssets.slice(
                zoneAssetUrls.length + (zone.collisionAssetUrl ? 1 : 0),
              );
              if (disposed) {
                loadedAssets.forEach(({ scene: zoneScene }) => disposeObjectTree(zoneScene));
                return;
              }
              const zoneRoot = new THREE.Group();
              zoneRoot.name = `zone:${zone.id}`;
              applyZoneTransform(zoneRoot, zone.transform);
              zoneRoot.position.multiplyScalar(sceneScale);
              zoneRoot.scale.multiplyScalar(sceneScale);
              zoneRoot.updateMatrixWorld(true);
              for (const { scene: zoneScene } of zoneAssets) {
                prepareSceneLayer(zoneScene);
                visualSetup?.(zoneScene);
                applySceneMaterialOverrides(zoneScene, materialOverrides);
                zoneRoot.add(zoneScene);
              }
              scene.add(zoneRoot);
              zoneRoots.set(id, zoneRoot);
              registerZoneVisibility(zoneRoot);
              applySceneEditorOverrides(scene, await editorOverridesRequest);
              refreshWaterZones();
              debugLog(`[Agent HQ] ${label} loaded zone=${id} water zones=${waterZones.length}`);
              if (collisionAsset || collisionAssets.length > 0) {
                const transformedCollisionScene = collisionAsset?.scene ?? null;
                const appliedZoneTransform = {
                  position: zoneRoot.position.toArray() as [number, number, number],
                  quaternion: zoneRoot.quaternion.toArray() as [number, number, number, number],
                  scale: zoneRoot.scale.toArray() as [number, number, number],
                };
                if (transformedCollisionScene)
                  applyZoneTransform(transformedCollisionScene, appliedZoneTransform);
                const transformedCollisionAssets = collisionAssets.map(
                  ({ scene: collisionScene }) => {
                    applyZoneTransform(collisionScene, appliedZoneTransform);
                    return collisionScene;
                  },
                );
                activateZoneCollision(id, transformedCollisionScene, transformedCollisionAssets);
              }
            })
            .finally(() => {
              zonePromises.delete(id);
            });
          zonePromises.set(id, request);
          return request;
        };
        const updateProximityZones = () => {
          if (!proximityZonesReady) return;
          zoneProximityFrame += 1;
          if (zoneProximityFrame % 15 !== 0) return;
          for (const zone of zones) {
            const preloadDistance = zone.preloadDistance;
            const position = zone.transform?.position;
            if (!preloadDistance || !position) continue;
            const distance = Math.hypot(
              playerPosition.x - position[0] * sceneScale,
              playerPosition.z - position[2] * sceneScale,
            );
            if (distance <= preloadDistance) {
              if (!zoneRoots.has(zone.id) && !zonePromises.has(zone.id)) void loadZone(zone.id);
            } else if (!zone.preload && distance > preloadDistance * 2 && zoneRoots.has(zone.id)) {
              void unloadZone(zone.id);
            }
          }
        };
        const unloadZone = async (id: string): Promise<void> => {
          const pending = zonePromises.get(id);
          if (pending) await pending.catch(() => undefined);
          const zoneRoot = zoneRoots.get(id);
          if (!zoneRoot) return;
          // The development scene editor may have TransformControls attached
          // to an object inside this zone. Tell it to detach before the zone
          // leaves the scene graph; otherwise three.js logs every frame while
          // the control still points at the unloaded object.
          window.dispatchEvent(
            new CustomEvent("agent-hq:scene-zone-unloading", {
              detail: { id, root: zoneRoot },
            }),
          );
          zoneRoots.delete(id);
          unregisterZoneVisibility(zoneRoot);
          zoneRoot.removeFromParent();
          disposeObjectTree(zoneRoot);
          if (!(preserveEntryCollision && id === entryZoneId)) deactivateZoneCollision(id);
        };
        // Kick off only the entry scene, its collision, and the character on the
        // critical path. Optional gallery zones are distance-loaded after the
        // player is ready, so large room meshes never delay the first frame.
        const pendingVisual = telemetry.track("visual", loader.loadAsync(assetUrl));
        const pendingCollision = [
          ...(collisionAssetUrl
            ? [telemetry.track("physics.asset", loader.loadAsync(collisionAssetUrl))]
            : []),
          ...additionalCollisionAssetUrls.map((url, index) =>
            telemetry.track(`physics.asset.${index + 2}`, loader.loadAsync(url)),
          ),
        ];
        const pendingAdditional = additionalAssetUrls.map((url) => loader.loadAsync(url));
        const pendingCharacter: Promise<Awaited<ReturnType<typeof loadCharacter>>> = loadCharacter(
          loader,
          characterId,
        );
        // Runtime-generated catalog fields are independent of the base scene
        // and of one another. Begin their manifest/model requests during the
        // core GLB transfer instead of serially after it has finished.
        const fieldSources = [
          staticFieldAssetUrls?.foliage ?? foliageManifestUrl,
          staticFieldAssetUrls?.props ?? propsManifestUrl,
        ] as const;
        const fieldNames = ["foliage", "props"] as const;
        const pendingFields = [
          staticFieldAssetUrls?.foliage
            ? loader.loadAsync(staticFieldAssetUrls.foliage).then(({ scene }) => scene)
            : foliageManifestUrl
              ? loadLandscapeField(loader, foliageManifestUrl, loadScope.signal)
              : null,
          staticFieldAssetUrls?.props
            ? loader.loadAsync(staticFieldAssetUrls.props).then(({ scene }) => scene)
            : propsManifestUrl
              ? loadPropsField(loader, propsManifestUrl, loadScope.signal)
              : null,
        ].map((pending, index) =>
          pending ? telemetry.track(`field.${fieldNames[index]}`, pending) : null,
        );
        const collisionFieldSources = [
          staticFieldCollisionAssetUrls?.foliage,
          staticFieldCollisionAssetUrls?.props,
        ] as const;
        const pendingCollisionFields = collisionFieldSources.map((source, index) =>
          source
            ? telemetry.track(
                `physics.field.${fieldNames[index]}`,
                loader.loadAsync(source).then(({ scene: collisionScene }) => {
                  // Field downloads can finish after an unmount or an earlier
                  // layer failure. Dispose at the promise boundary so detached
                  // exact-collider roots are never orphaned by an early return.
                  if (disposed) {
                    disposeObjectTree(collisionScene);
                    return null;
                  }
                  return collisionScene;
                }),
              )
            : null,
        );
        const visual = await pendingVisual;
        const loadedBackground = await pendingBackground;
        if (disposed) {
          disposeObjectTree(visual.scene);
          loadedBackground?.dispose();
          return;
        }
        if (loadedBackground) {
          backgroundTexture = loadedBackground;
          const mapping = environment?.backgroundTextureMapping ?? "2d";
          const repeat = environment?.backgroundTextureRepeat ?? [1, 1];
          const offset = environment?.backgroundTextureOffset ?? [0, 0];
          loadedBackground.colorSpace = THREE.SRGBColorSpace;
          loadedBackground.flipY = mapping !== "equirectangular";
          loadedBackground.mapping =
            mapping === "equirectangular"
              ? THREE.EquirectangularReflectionMapping
              : THREE.UVMapping;
          loadedBackground.wrapS = THREE.RepeatWrapping;
          loadedBackground.wrapT = THREE.ClampToEdgeWrapping;
          loadedBackground.repeat.set(repeat[0], repeat[1]);
          loadedBackground.offset.set(offset[0], offset[1]);
          loadedBackground.center.set(0.5, 0.5);
          loadedBackground.rotation = environment?.backgroundTextureRotation ?? 0;
          loadedBackground.needsUpdate = true;
          scene.background = loadedBackground;
        }
        prepareSceneLayer(visual.scene);
        visual.scene.scale.multiplyScalar(sceneScale);
        visualSetup?.(visual.scene);
        applySceneMaterialOverrides(visual.scene, materialOverrides);
        if (/rugman/i.test(label)) {
          prepareBrickTextures(visual.scene);
          prepareLavaTextures(visual.scene);
        }
        const coplanarMaterialMeshes = new Set(
          coplanarMaterialMeshNames.map((name) => THREE.PropertyBinding.sanitizeNodeName(name)),
        );
        if (coplanarMaterialMeshes.size > 0) {
          visual.scene.traverse((object) => {
            if (!(object instanceof THREE.Mesh) || !coplanarMaterialMeshes.has(object.name)) return;
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            if (materials.length < 2) return;
            object.material = materials.map((material, index) => {
              const stableMaterial = material.clone();
              stableMaterial.polygonOffset = index > 0;
              stableMaterial.polygonOffsetFactor = -index;
              stableMaterial.polygonOffsetUnits = -index;
              stableMaterial.needsUpdate = true;
              return stableMaterial;
            });
          });
        }
        const entryRoot = entryZoneId ? new THREE.Group() : visual.scene;
        if (entryZoneId) {
          entryRoot.name = `zone:${entryZoneId}`;
          entryRoot.add(visual.scene);
        }
        scene.add(entryRoot);
        const visualLayers: THREE.Object3D[] = [visual.scene];
        for (const additionalVisual of await Promise.all(pendingAdditional)) {
          if (disposed) {
            disposeObjectTree(additionalVisual.scene);
            return;
          }
          prepareSceneLayer(additionalVisual.scene);
          additionalVisual.scene.scale.multiplyScalar(sceneScale);
          applySceneMaterialOverrides(additionalVisual.scene, materialOverrides);
          (entryZoneId ? entryRoot : scene).add(additionalVisual.scene);
          visualLayers.push(additionalVisual.scene);
        }
        const [fieldResults, collisionFieldResults] = await Promise.all([
          Promise.allSettled(pendingFields),
          Promise.allSettled(pendingCollisionFields),
        ]);
        const rejectedField = [...fieldResults, ...collisionFieldResults].find(
          (result) => result.status === "rejected",
        );
        if (rejectedField?.status === "rejected") {
          [...fieldResults, ...collisionFieldResults].forEach((result) => {
            if (result.status === "fulfilled" && result.value) disposeObjectTree(result.value);
          });
          throw rejectedField.reason;
        }
        const [foliage, props] = fieldResults.map((result) =>
          result.status === "fulfilled" ? result.value : null,
        );
        const collisionFields = collisionFieldResults.map((result) =>
          result.status === "fulfilled" ? result.value : null,
        );
        collisionFields.forEach((root) => {
          if (root) detachedCollisionRoots.add(root);
        });
        if (disposed) {
          for (const field of [foliage, props, ...collisionFields]) {
            if (field) {
              disposeObjectTree(field);
              detachedCollisionRoots.delete(field);
            }
          }
          return;
        }
        if (foliage && fieldSources[0]) {
          foliage.name = "foliage";
          foliage.scale.multiplyScalar(sceneScale);
          foliage.traverse((object) => {
            if (!(object instanceof THREE.Mesh)) return;
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            materials.forEach(prepareImportedMaterial);
          });
          applySceneMaterialOverrides(foliage, materialOverrides);
          (entryZoneId ? entryRoot : scene).add(foliage);
          debugLog(`[Agent HQ] ${label} foliage field loaded from ${fieldSources[0]}`);
        }
        if (props && fieldSources[1]) {
          props.name = "props";
          props.scale.multiplyScalar(sceneScale);
          props.traverse((object) => {
            if (!(object instanceof THREE.Mesh)) return;
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            materials.forEach(prepareImportedMaterial);
          });
          applySceneMaterialOverrides(props, materialOverrides);
          (entryZoneId ? entryRoot : scene).add(props);
          debugLog(`[Agent HQ] ${label} props field loaded from ${fieldSources[1]}`);
        }
        const visibilityStates: Array<{
          group: PlayerVisibilityGroup;
          objects: THREE.Object3D[];
          visible: boolean | null;
        }> = playerVisibilityGroups.map((group) => {
          const names = new Set(
            (group.names ?? []).map((name) => THREE.PropertyBinding.sanitizeNodeName(name)),
          );
          const prefixes = (group.namePrefixes ?? []).map((prefix) =>
            THREE.PropertyBinding.sanitizeNodeName(prefix),
          );
          const objects: THREE.Object3D[] = [];
          const addRoot = (root: THREE.Object3D | null) => {
            root?.traverse((object) => {
              if (
                names.has(object.name) ||
                prefixes.some((prefix) => object.name.startsWith(prefix))
              )
                objects.push(object);
            });
          };
          for (const root of [visual.scene, foliage, props]) addRoot(root);
          return { group, objects, visible: null as boolean | null };
        });
        const addVisibilityRoot = (root: THREE.Object3D) => {
          for (const state of visibilityStates) {
            const names = new Set(
              (state.group.names ?? []).map((name) => THREE.PropertyBinding.sanitizeNodeName(name)),
            );
            const prefixes = (state.group.namePrefixes ?? []).map((prefix) =>
              THREE.PropertyBinding.sanitizeNodeName(prefix),
            );
            root.traverse((object) => {
              if (
                names.has(object.name) ||
                prefixes.some((prefix) => object.name.startsWith(prefix))
              ) {
                state.objects.push(object);
                object.visible = state.visible ?? true;
              }
            });
          }
        };
        const removeVisibilityRoot = (root: THREE.Object3D) => {
          for (const state of visibilityStates) {
            const descendants = new Set<THREE.Object3D>();
            root.traverse((object) => descendants.add(object));
            state.objects = state.objects.filter((object) => !descendants.has(object));
          }
        };
        registerZoneVisibility = addVisibilityRoot;
        unregisterZoneVisibility = removeVisibilityRoot;
        if (entryZoneId) {
          zoneRoots.set(entryZoneId, entryRoot);
          registerZoneVisibility(entryRoot);
        }
        debugLog(
          `[Agent HQ] ${label} player visibility groups=${visibilityStates.map(({ objects }) => objects.length).join(",") || "none"}`,
        );
        const updatePlayerVisibility = () => {
          for (const state of visibilityStates) {
            const { visibleArea } = state.group;
            const visible =
              playerPosition.x >= visibleArea.xMin &&
              playerPosition.x <= visibleArea.xMax &&
              playerPosition.z >= visibleArea.zMin &&
              playerPosition.z <= visibleArea.zMax;
            if (visible === state.visible) continue;
            state.visible = visible;
            state.objects.forEach((object) => {
              object.visible = visible;
            });
            debugLog(
              `[Agent HQ] ${label} player visibility visible=${visible} objects=${state.objects.length}`,
            );
          }
        };
        updatePlayerVisibility();
        applySceneEditorOverrides(scene, await editorOverridesRequest);
        let waterZones: WaterZone[] = [];
        const refreshWaterZones = () => {
          // Room galleries can stream zones without having one entryZoneId.
          // Include those loaded roots so named pool/river surfaces participate
          // in swim detection as soon as their room arrives.
          const waterRoots =
            zones.length > 0
              ? [...zoneRoots.values(), ...(foliage ? [foliage] : [])]
              : [visual.scene, ...(foliage ? [foliage] : [])];
          const explicitWaterZones = runtimeWaterVolumes.flatMap((volume) => {
            const zoneRoot = volume.zoneId ? zoneRoots.get(volume.zoneId) : null;
            if (volume.zoneId && !zoneRoot) return [];
            const bounds = new THREE.Box3(
              new THREE.Vector3(volume.xMin, volume.surfaceY - 0.05, volume.zMin),
              new THREE.Vector3(volume.xMax, volume.surfaceY, volume.zMax),
            );
            const surfacePoint = new THREE.Vector3(
              (volume.xMin + volume.xMax) / 2,
              volume.surfaceY,
              (volume.zMin + volume.zMax) / 2,
            );
            if (zoneRoot) {
              zoneRoot.updateMatrixWorld(true);
              bounds.applyMatrix4(zoneRoot.matrixWorld);
              surfacePoint.applyMatrix4(zoneRoot.matrixWorld);
            }
            return [{ bounds, surfaceY: surfacePoint.y, forceSwimming: volume.forceSwimming }];
          });
          waterZones = [
            ...waterRoots.flatMap((root) => collectWaterZones(root)),
            ...explicitWaterZones,
          ];
        };
        refreshWaterZones();
        debugLog(
          `[Agent HQ] ${label} water zones=${waterZones.length} surfaces=${waterZones.map(({ surfaceY }) => surfaceY.toFixed(3)).join(",") || "none"}`,
        );
        let meshCount = 0;
        let invisibleMeshes = 0;
        let transparentMaterials = 0;
        let zeroOpacityMaterials = 0;
        visual.scene.traverse((object) => {
          if (!(object instanceof THREE.Mesh)) return;
          meshCount += 1;
          if (!object.visible) invisibleMeshes += 1;
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => {
            if (material.transparent) transparentMaterials += 1;
            if (material.opacity === 0) zeroOpacityMaterials += 1;
          });
        });
        const bounds = new THREE.Box3().setFromObject(visual.scene);
        debugLog(
          `[Agent HQ] ${label} loaded meshes=${meshCount} invisibleMeshes=${invisibleMeshes} rootChildren=${visual.scene.children.length} transparentMaterials=${transparentMaterials} zeroOpacityMaterials=${zeroOpacityMaterials}`,
        );
        debugLog(
          `[Agent HQ] ${label} bounds min=${bounds.min.toArray().join(",")} max=${bounds.max.toArray().join(",")} start=${playerPosition.toArray().join(",")}`,
        );

        let collisionRoot: THREE.Object3D | null = null;
        let separateCollisionRoot: THREE.Object3D | null = null;
        if (pendingCollision.length > 0) {
          const collisions = await Promise.all(pendingCollision);
          if (disposed) {
            collisions.forEach(({ scene: collisionScene }) => disposeObjectTree(collisionScene));
            return;
          }
          collisionRoot = collisions[0]?.scene ?? null;
          separateCollisionRoot = collisions.length > 0 ? new THREE.Group() : null;
          if (separateCollisionRoot) {
            separateCollisionRoot.name = "Collision layers";
            collisions.forEach(({ scene: collisionScene }) => {
              collisionScene.scale.multiplyScalar(sceneScale);
              separateCollisionRoot?.add(collisionScene);
            });
            detachedCollisionRoots.add(separateCollisionRoot);
          }
        }
        // A dedicated collision asset replaces the base visual layer. Keep
        // colliders for every extra visual layer without adding the terrain twice.
        const visualCollisionLayers =
          collisionRoot && collideAdditionalVisualLayers
            ? visualLayers.slice(1)
            : collisionRoot
              ? []
              : visualLayers;
        const colliderBounds = new THREE.Box3();
        if (collisionRoot) colliderBounds.expandByObject(collisionRoot);
        visualCollisionLayers.forEach((root) => colliderBounds.expandByObject(root));
        const physicsWorld = world;
        if (!physicsWorld)
          throw new Error("Rapier world was disposed before scene colliders were created");
        const initialCollisionColliders: Collider[] = [];
        let colliderCount = collisionRoot
          ? addSceneColliders(
              physicsWorld,
              collisionRoot,
              true,
              runtimeCollisionExclusionAreas,
              undefined,
              collisionIncludePatterns,
              initialCollisionColliders,
            )
          : 0;
        if (separateCollisionRoot) {
          for (const collisionLayer of separateCollisionRoot.children) {
            if (collisionLayer === collisionRoot) continue;
            colliderCount += addSceneColliders(
              physicsWorld,
              collisionLayer,
              true,
              runtimeCollisionExclusionAreas,
              undefined,
              collisionIncludePatterns,
              initialCollisionColliders,
            );
          }
        }
        visualCollisionLayers.forEach((root) => {
          colliderCount += addSceneColliders(
            physicsWorld,
            root,
            false,
            runtimeCollisionExclusionAreas,
            undefined,
            collisionIncludePatterns,
            initialCollisionColliders,
          );
        });
        for (const field of collisionFields) {
          if (field) {
            colliderCount += addSceneColliders(
              physicsWorld,
              field,
              true,
              runtimeCollisionExclusionAreas,
              undefined,
              collisionIncludePatterns,
              initialCollisionColliders,
              true,
            );
          }
        }
        if (staticFieldCollisionPatterns.length > 0) {
          const fieldMeshFilter = (mesh: THREE.Mesh) => {
            let current: THREE.Object3D | null = mesh;
            while (current) {
              const objectName = current.name;
              if (staticFieldCollisionPatterns.some((pattern) => pattern.test(objectName)))
                return true;
              current = current.parent;
            }
            return false;
          };
          for (const [field, exactCompanion] of [[props, collisionFields[1]]] as const) {
            if (field && !exactCompanion) {
              // This filter is the explicit opt-in for otherwise visual-only
              // generated fields. Treat the selected meshes as trusted so the
              // generic props-layer exclusion cannot discard them before the
              // field filter gets a chance to include them.
              colliderCount += addSceneColliders(
                physicsWorld,
                field,
                false,
                runtimeCollisionExclusionAreas,
                fieldMeshFilter,
                collisionIncludePatterns,
                initialCollisionColliders,
                true,
              );
            }
          }
        }
        for (const collider of staticColliders) {
          const descriptor = RAPIER.ColliderDesc.cuboid(
            collider.halfExtents[0] * sceneScale,
            collider.halfExtents[1] * sceneScale,
            collider.halfExtents[2] * sceneScale,
          )
            .setTranslation(
              collider.x * sceneScale,
              collider.y * sceneScale,
              collider.z * sceneScale,
            )
            .setFriction(0.9);
          if (collider.rotation) {
            descriptor.setRotation({
              x: collider.rotation[0],
              y: collider.rotation[1],
              z: collider.rotation[2],
              w: collider.rotation[3],
            });
          }
          try {
            const created = physicsWorld.createCollider(descriptor);
            initialCollisionColliders.push(created);
            colliderCount += 1;
          } catch (cause) {
            console.warn(
              `[Agent HQ] static collider at ${collider.x},${collider.z} unavailable`,
              cause,
            );
          }
        }
        if (colliderCount === 0) {
          colliderCount = createFallbackFloorCollider(
            physicsWorld,
            colliderBounds,
            playerPosition,
            playerHeight,
          )
            ? 1
            : 0;
          if (colliderCount > 0) console.info(`[Agent HQ] ${label} using fallback spawn floor`);
        }
        if (separateCollisionRoot) {
          disposeObjectTree(separateCollisionRoot);
          detachedCollisionRoots.delete(separateCollisionRoot);
        }
        for (const field of collisionFields) {
          if (!field) continue;
          disposeObjectTree(field);
          detachedCollisionRoots.delete(field);
        }
        if (entryZoneId && initialCollisionColliders.length > 0) {
          zoneCollisionColliders.set(entryZoneId, initialCollisionColliders);
          activeZoneCollisionId = entryZoneId;
        }
        if (pendingCollision.length > 0 && startPosition.snapToGround !== false) {
          // A poisoned Rapier world throws here after collider failures. Keep
          // the scene alive on the authored spawn position instead of failing
          // the whole load.
          try {
            const spawnRay = new RAPIER.Ray(
              { x: playerPosition.x, y: playerPosition.y + 4, z: playerPosition.z },
              { x: 0, y: -1, z: 0 },
            );
            const surface = world.castRay(spawnRay, 20, true);
            if (surface) {
              playerPosition.y = playerPosition.y + 4 - surface.timeOfImpact + playerHeight / 2;
              console.info(`[Agent HQ] ${label} snapped spawn to y=${playerPosition.y}`);
            } else {
              // The physics colliders may not cover the spawn point (e.g. a
              // plaza gap between road tiles): fall back to the visible ground
              // so the player does not spawn buried underground.
              const fallbackRaycaster = new THREE.Raycaster();
              fallbackRaycaster.set(
                new THREE.Vector3(playerPosition.x, playerPosition.y + 4, playerPosition.z),
                new THREE.Vector3(0, -1, 0),
              );
              const visualHits = fallbackRaycaster.intersectObjects(scene.children, true);
              if (visualHits.length > 0) {
                playerPosition.y = visualHits[0].point.y + playerHeight / 2;
                console.info(
                  `[Agent HQ] ${label} snapped spawn to visible ground y=${playerPosition.y}`,
                );
              }
            }
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : "unknown spawn ray error";
            console.warn(`[Agent HQ] ${label} spawn ray unavailable: ${message}`);
          }
        }
        const playerShape = RAPIER.ColliderDesc.capsule(segmentHalfHeight, playerRadius)
          .setTranslation(playerPosition.x, playerPosition.y, playerPosition.z)
          .setFriction(0);
        playerCollider = world.createCollider(playerShape);
        telemetry.mark("physics.ready");
        debugLog(
          `[Agent HQ] ${label} physics ready colliders=${colliderCount} player=${playerPosition.toArray().join(",")}`,
        );

        // Fire the optional locomotion catalog alongside the character GLB.
        const coreAnimationKeys = ["idle", "walk", "run", "jump", "doubleJump", "swim"];
        const pendingCoreAnimations = deferCharacterDetails
          ? Promise.resolve({ clips: [], names: {} })
          : loadCharacterAnimations(loader, characterId, coreAnimationKeys);
        const loadedCharacter = await pendingCharacter;
        if (disposed) {
          disposeObjectTree(loadedCharacter.scene);
          return;
        }
        let coreAnimations: Awaited<ReturnType<typeof loadCharacterAnimations>> = {
          clips: [],
          names: {},
        };
        try {
          coreAnimations = await pendingCoreAnimations;
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : "unknown core animation error";
          console.warn(
            `[Agent HQ] ${characterId} core animation catalog partially unavailable: ${message}`,
          );
        }
        const character = loadedCharacter.scene;
        characterRoot = character;
        character.scale.setScalar(characterModelScale);
        character.traverse((object) => {
          if (!(object instanceof THREE.Mesh)) return;
          if (/icosphere|helper|collision/i.test(object.name)) {
            object.visible = false;
            return;
          }
          object.castShadow = true;
          object.receiveShadow = true;
          object.frustumCulled = true;
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => {
            prepareImportedMaterial(material);
          });
        });
        scene.add(character);
        character.updateMatrixWorld(true);
        const characterBounds = new THREE.Box3();
        character.traverse((object) => {
          if (object instanceof THREE.Mesh && object.visible)
            characterBounds.expandByObject(object);
        });
        const characterBottom = characterBounds.min.y;
        // Aim near the upper torso/head of the visual model instead of relying
        // on the physics capsule height.
        const cameraTargetOffset = characterGroundOffset + characterBounds.max.y * 0.9;
        const characterClips = [...loadedCharacter.clips, ...coreAnimations.clips];
        const controller = createCharacterAnimationController(character, characterClips);
        animationController = controller;
        let runName = coreAnimations.names.run ?? loadedCharacter.clips[0]?.name;
        let locomotionName = runName ?? coreAnimations.names.walk;
        let idleName = coreAnimations.names.idle;
        let jumpName = coreAnimations.names.jump;
        let swimmingName = coreAnimations.names.swim;
        locomotionAction = locomotionName ? controller.actions.get(locomotionName) : undefined;
        idleAction = idleName ? controller.actions.get(idleName) : undefined;
        jumpAction = jumpName ? controller.actions.get(jumpName) : undefined;
        swimmingAction = swimmingName ? controller.actions.get(swimmingName) : undefined;
        [locomotionAction, idleAction, swimmingAction].forEach((action) =>
          action?.setLoop(THREE.LoopRepeat, Infinity),
        );
        jumpAction?.setLoop(THREE.LoopOnce, 1);
        if (idleName) controller.play(idleName);
        if (swimmingAction) swimmingAction.setLoop(THREE.LoopRepeat, Infinity);
        let activeAnimationName: string | null = idleName ?? null;
        let isSwimming = false;
        debugLog(
          `[Agent HQ] ${characterId} character ready clips=${characterClips.length} idle=${idleName ?? "fallback"} run=${runName ?? "fallback"} jump=${jumpName ?? "fallback"} swim=${swimmingName ?? "fallback"} bounds=${characterBounds.min.toArray().join(",")}..${characterBounds.max.toArray().join(",")}`,
        );

        characterController = world.createCharacterController(0.05);
        characterController.setUp({ x: 0, y: 1, z: 0 });
        characterController.setMaxSlopeClimbAngle(THREE.MathUtils.degToRad(48));
        // The cafe/beach-house decks sit ~0.6 above the sand. HQ switches to
        // its larger slab step only while click-only orthographic mode is
        // active; perspective keeps the shared World value.
        characterController.enableAutostep(0.6, 0.2, false);
        characterController.enableSnapToGround(0.3);
        let activeAutostepHeight = 0.6;

        const loadDeferredCharacterDetails = async () => {
          try {
            const animations = await loadCharacterAnimations(
              loader,
              characterId,
              coreAnimationKeys,
            );
            if (disposed || !animationController) return;
            animationController.addClips(animations.clips);
            coreAnimations = animations;
            runName = coreAnimations.names.run ?? runName;
            locomotionName = runName ?? coreAnimations.names.walk;
            idleName = coreAnimations.names.idle;
            jumpName = coreAnimations.names.jump;
            swimmingName = coreAnimations.names.swim;
            locomotionAction = locomotionName
              ? animationController.actions.get(locomotionName)
              : undefined;
            idleAction = idleName ? animationController.actions.get(idleName) : undefined;
            jumpAction = jumpName ? animationController.actions.get(jumpName) : undefined;
            swimmingAction = swimmingName
              ? animationController.actions.get(swimmingName)
              : undefined;
            [locomotionName, idleName, swimmingName].forEach((name) => {
              if (name) animationController?.actions.get(name)?.setLoop(THREE.LoopRepeat, Infinity);
            });
            if (jumpName) animationController.actions.get(jumpName)?.setLoop(THREE.LoopOnce, 1);
            if (idleName && activeAnimationName !== idleName) {
              animationController.play(idleName);
              activeAnimationName = idleName;
            }
          } catch (cause) {
            const message =
              cause instanceof Error ? cause.message : "unknown deferred character detail error";
            console.warn(
              `[Agent HQ] ${characterId} deferred character details unavailable: ${message}`,
            );
          }
        };

        const colliderLabel = collisionAssetUrl ? "collision mesh" : "colliders";
        const readyStatus = `${label} ready · ${colliderCount.toLocaleString()} ${colliderLabel} · ${characterId}`;
        setStatus(readyStatus);
        telemetry.markPlayable();
        const viewDirection = new THREE.Vector3();
        const cameraRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
        const floorRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
        const climbRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
        const cameraOcclusionRaycaster = new THREE.Raycaster();
        const cameraOcclusionDirection = new THREE.Vector3();
        const forward = new THREE.Vector3();
        const right = new THREE.Vector3();
        const desired = new THREE.Vector3();
        const movement = new THREE.Vector3();
        const climbDir = new THREE.Vector3();
        const climbStart = new THREE.Vector3();
        const climbTarget = new THREE.Vector3();
        const characterTarget = new THREE.Vector3();
        let cameraOcclusionFrame = 0;
        let cameraDistance = cameraController.perspectiveDistance;
        // Face the character along the spawn view direction: the camera yaw
        // already honors startPosition.yaw, so the avatar must start turned
        // the same way instead of staring at the default +z heading.
        let characterYaw = startPosition.yaw ?? 0;
        let swimTilt = 0;
        const characterYawEuler = new THREE.Euler();
        const swimTiltEuler = new THREE.Euler();
        const swimTiltQuaternion = new THREE.Quaternion();
        // Dynamic-resolution monitor: the render scale starts at the tier cap
        // and drops when sustained frame times fall behind, then climbs back
        // once the GPU has headroom again.
        const basePixelRatio = activeRenderer ? activeRenderer.getPixelRatio() : 1;
        let renderScale = 1;
        let qualityFrames = 0;
        let qualityFrameMs = 0;
        let qualityGraceFrames = QUALITY_GRACE_FRAMES;

        const debugRaycaster = new THREE.Raycaster();
        const debugHighlightOriginals = new WeakMap<THREE.Material, number>();
        const debugComponentData = new WeakMap<THREE.BufferGeometry, IndexedComponentData | null>();
        const debugComponentProxies = new WeakMap<THREE.Mesh, Map<number, THREE.Mesh>>();
        const debugComponentForHit = (
          source: THREE.Mesh,
          faceIndex?: number,
          point?: THREE.Vector3,
        ): THREE.Mesh => {
          if (source instanceof THREE.SkinnedMesh) return source;
          let data = debugComponentData.get(source.geometry);
          if (data === undefined) {
            data = getIndexedComponentData(source.geometry);
            debugComponentData.set(source.geometry, data);
          }
          if (!data || data.trianglesByComponent.length < 2) return source;
          let component = faceIndex == null ? undefined : data.triangleComponents[faceIndex];
          if (component == null && point) {
            const local = source.worldToLocal(point.clone());
            const position = source.geometry.getAttribute("position");
            const index = source.geometry.getIndex()?.array;
            if (index) {
              let distance = Infinity;
              for (let triangle = 0; triangle < index.length / 3; triangle += 1) {
                const centroid = new THREE.Vector3();
                for (let corner = 0; corner < 3; corner += 1)
                  centroid.add(
                    new THREE.Vector3().fromBufferAttribute(position, index[triangle * 3 + corner]),
                  );
                const nextDistance = centroid.multiplyScalar(1 / 3).distanceToSquared(local);
                if (nextDistance < distance) {
                  distance = nextDistance;
                  component = data.triangleComponents[triangle];
                }
              }
            }
          }
          if (component == null) return source;
          let proxies = debugComponentProxies.get(source);
          if (!proxies) {
            proxies = new Map();
            debugComponentProxies.set(source, proxies);
          }
          const existing = proxies.get(component);
          if (existing) return existing;
          const proxy = source.clone();
          proxy.name = `${source.name} component ${component + 1}`;
          proxy.geometry = cloneGeometryWithIndices(
            source.geometry,
            data.trianglesByComponent[component],
          );
          proxy.material = Array.isArray(source.material)
            ? source.material[0].clone()
            : source.material.clone();
          proxy.userData[DEBUG_COMPONENT_PROXY] = { source, component };
          proxy.visible = false;
          proxy.renderOrder = source.renderOrder + 10;
          source.parent?.add(proxy);
          proxies.set(component, proxy);
          return proxy;
        };
        const setDebugComponentVisible = (proxy: THREE.Mesh, visible: boolean) => {
          const metadata = proxy.userData[DEBUG_COMPONENT_PROXY] as
            DebugComponentProxyMetadata | undefined;
          if (!metadata?.source || metadata.component == null) return;
          const source = metadata.source;
          const data =
            debugComponentData.get(source.geometry) ?? getIndexedComponentData(source.geometry);
          if (!data) return;
          debugComponentData.set(source.geometry, data);
          const index = source.geometry.getIndex();
          if (!index) return;
          const hidden =
            (source.userData.__agentHqHiddenComponents as Set<number> | undefined) ??
            new Set<number>();
          source.userData.__agentHqHiddenComponents = hidden;
          if (visible) hidden.delete(metadata.component);
          else hidden.add(metadata.component);
          const kept = [] as number[];
          for (let triangle = 0; triangle < index.array.length / 3; triangle += 1) {
            if (hidden.has(data.triangleComponents[triangle])) continue;
            kept.push(
              index.array[triangle * 3],
              index.array[triangle * 3 + 1],
              index.array[triangle * 3 + 2],
            );
          }
          source.geometry = cloneGeometryWithIndices(source.geometry, kept);
          proxy.visible = visible;
        };
        const debugApi: SceneDebugApi = {
          scene,
          get camera() {
            return camera;
          },
          get cameraViewMode() {
            return cameraController.viewMode;
          },
          setCameraViewMode: (viewMode) => {
            cameraController.setViewMode(viewMode);
            camera = cameraController.camera;
          },
          setOrthographicHalfHeight: (halfHeight) => {
            cameraController.setOrthographicHalfHeight(halfHeight);
          },
          setOrthographicPan: (x, z) => {
            cameraController.setOrthographicPan(x, z);
          },
          setOrthographicZoom: (zoom) => {
            cameraController.setOrthographicZoom(zoom);
          },
          setOrthographicZoomImmediate: (zoom) => {
            cameraController.setOrthographicZoomImmediate(zoom);
          },
          adjustOrthographicZoom: (delta) => {
            cameraController.adjustOrthographicZoom(delta);
          },
          adjustPerspectiveZoom: (delta) => {
            cameraController.adjustPerspectiveZoom(delta);
          },
          setOrthographicBoundsPadding: (padding) => {
            cameraController.setOrthographicBoundsPadding(padding);
          },
          resetOrthographicView: () => {
            cameraController.resetOrthographicPan();
            cameraController.resetOrthographicZoom();
            cameraController.setOrthographicBoundsPadding(0);
          },
          setClickNavigationEnabled: (enabled) => {
            clickNavigationEnabled = enabled;
            if (enabled) return;
            clickNavigationActive = false;
            clickNavigationPath.length = 0;
            clickNavigationPathIndex = 0;
            navigationIndicator.visible = false;
            activeRenderer.domElement.style.cursor = "";
          },
          renderer: activeRenderer,
          world,
          playerCollider,
          characterController,
          characterRoot,
          getState: () => ({
            playerPosition: playerPosition.toArray(),
            playerHeight,
            ...cameraController.state,
            isSwimming,
            characterRootPosition: characterRoot ? characterRoot.position.toArray() : null,
            characterScale: characterRoot ? characterRoot.scale.toArray() : null,
            waterZones: waterZones.map(({ bounds, surfaceY }) => ({
              surfaceY,
              min: bounds.min.toArray(),
              max: bounds.max.toArray(),
            })),
          }),
          teleportTo: (x, z, y?, yaw?, bodyYaw?, snapToGround = true) => {
            clickNavigationActive = false;
            playerPosition.x = x;
            playerPosition.z = z;
            if (y != null) playerPosition.y = y;
            if (yaw != null) cameraController.setYaw(yaw);
            if (bodyYaw != null) characterYaw = bodyYaw;
            if (isSwimming) isSwimming = false;
            if (snapToGround) {
              try {
                const seededPlayerY = y != null ? y : null;
                const seededFloorY =
                  seededPlayerY != null ? seededPlayerY - playerHeight / 2 : null;
                const probeOriginY =
                  seededPlayerY != null ? seededPlayerY + playerHeight : playerPosition.y + 4;
                const probeDistance = seededPlayerY != null ? 8 : 20;
                const ray = new RAPIER.Ray({ x, y: probeOriginY, z }, { x: 0, y: -1, z: 0 });
                let floorY: number | null = null;
                if (seededFloorY != null && world) {
                  const floorCandidates: number[] = [];
                  world.intersectionsWithRay(
                    ray,
                    probeDistance,
                    true,
                    (intersection) => {
                      if (intersection.normal.y < 0.5) return true;
                      const candidateY = probeOriginY - intersection.timeOfImpact;
                      if (candidateY > seededFloorY + 0.5 || candidateY < seededFloorY - 4)
                        return true;
                      floorCandidates.push(candidateY);
                      return true;
                    },
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    (collider) => collider !== playerCollider,
                  );
                  if (floorCandidates.length > 0) {
                    floorY = floorCandidates.reduce((closest, candidate) =>
                      Math.abs(candidate - seededFloorY) < Math.abs(closest - seededFloorY)
                        ? candidate
                        : closest,
                    );
                  }
                }
                if (floorY == null && seededPlayerY == null) {
                  const surface = world?.castRay(
                    ray,
                    probeDistance,
                    true,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    (collider) => collider !== playerCollider,
                  );
                  if (surface) floorY = probeOriginY - surface.timeOfImpact;
                }
                if (floorY != null) playerPosition.y = floorY + playerHeight / 2;
              } catch {
                // keep the current height if the ground probe fails
              }
            }
            verticalVelocity = 0;
            playerCollider?.setTranslation({
              x: playerPosition.x,
              y: playerPosition.y,
              z: playerPosition.z,
            });
          },
          isSpawnSafe: (x, y, z) => {
            if (!world || !playerCollider) return false;
            try {
              return (
                world.intersectionWithShape(
                  { x, y, z },
                  { x: 0, y: 0, z: 0, w: 1 },
                  playerCollider.shape,
                  undefined,
                  undefined,
                  playerCollider,
                ) == null
              );
            } catch {
              return false;
            }
          },
          isBallCollisionFree: (x, y, z, radius) => {
            if (!world) return true;
            try {
              const desc = RAPIER.ColliderDesc.ball(radius).setTranslation(9999, 9999, 9999);
              const collider = world.createCollider(desc);
              const shape = collider.shape;
              const free =
                world.intersectionWithShape(
                  { x, y, z },
                  { x: 0, y: 0, z: 0, w: 1 },
                  shape,
                  undefined,
                  undefined,
                  playerCollider ?? undefined,
                ) == null;
              world.removeCollider(collider, true);
              return free;
            } catch {
              return true;
            }
          },
          loadZone,
          unloadZone,
          findMesh: (pattern) => {
            const found: Array<Record<string, unknown>> = [];
            const matcher = new RegExp(pattern, "i");
            const matchedObjects = new Set<THREE.Object3D>();
            scene.traverse((object) => {
              if (!(object instanceof THREE.Mesh)) return;
              const ancestors: THREE.Object3D[] = [];
              let current: THREE.Object3D | null = object;
              while (current) {
                ancestors.push(current);
                current = current.parent;
              }
              const matchedAncestor = ancestors.find((candidate) => matcher.test(candidate.name));
              if (!matchedAncestor || matchedObjects.has(matchedAncestor)) return;
              matchedObjects.add(matchedAncestor);
              const materials = Array.isArray(object.material)
                ? object.material
                : [object.material];
              const materialInfo = materials.map((material) => ({
                name: material.name,
                type: material.type,
                transparent: material.transparent,
                opacity: material.opacity,
                alphaTest: material.alphaTest,
                color: (material as THREE.Material & { color?: THREE.Color }).color?.getHexString(),
                hasMap: Boolean((material as THREE.Material & { map?: THREE.Texture }).map),
                mapComplete: Boolean(
                  (material as THREE.Material & { map?: THREE.Texture }).map?.image,
                ),
              }));
              const instancedMeshes: THREE.InstancedMesh[] = [];
              if (matchedAncestor instanceof THREE.InstancedMesh)
                instancedMeshes.push(matchedAncestor);
              matchedAncestor.traverse((candidate) => {
                if (candidate instanceof THREE.InstancedMesh && candidate !== matchedAncestor)
                  instancedMeshes.push(candidate);
              });
              if (instancedMeshes.length > 0) {
                const instanceMatrix = new THREE.Matrix4();
                const worldMatrix = new THREE.Matrix4();
                for (const instancedMesh of instancedMeshes) {
                  instancedMesh.geometry.computeBoundingBox();
                  const localBounds = instancedMesh.geometry.boundingBox;
                  if (!localBounds) continue;
                  for (let instanceId = 0; instanceId < instancedMesh.count; instanceId += 1) {
                    instancedMesh.getMatrixAt(instanceId, instanceMatrix);
                    worldMatrix.multiplyMatrices(instancedMesh.matrixWorld, instanceMatrix);
                    const bounds = localBounds.clone().applyMatrix4(worldMatrix);
                    found.push({
                      name: instancedMesh.name,
                      instanceId,
                      zoneId: (() => {
                        let zone: THREE.Object3D | null = instancedMesh;
                        while (zone) {
                          if (zone.name.startsWith("zone:")) return zone.name.slice(5);
                          zone = zone.parent;
                        }
                        return undefined;
                      })(),
                      visible: instancedMesh.visible,
                      worldBounds: [bounds.min.toArray(), bounds.max.toArray()],
                      worldPosition: bounds.getCenter(new THREE.Vector3()).toArray(),
                      materials: materialInfo,
                    });
                  }
                }
                return;
              }
              const bounds = new THREE.Box3().setFromObject(matchedAncestor);
              found.push({
                name: object.name,
                zoneId: (() => {
                  let zone: THREE.Object3D | null = matchedAncestor;
                  while (zone) {
                    if (zone.name.startsWith("zone:")) return zone.name.slice(5);
                    zone = zone.parent;
                  }
                  return undefined;
                })(),
                visible: object.visible,
                worldBounds: [bounds.min.toArray(), bounds.max.toArray()],
                worldPosition: object.getWorldPosition(new THREE.Vector3()).toArray(),
                materials: materialInfo,
              });
            });
            return found;
          },
          groundY: (x, z) => {
            const ray = new RAPIER.Ray({ x, y: 150, z }, { x: 0, y: -1, z: 0 });
            const hit = world?.castRay(
              ray,
              300,
              true,
              undefined,
              undefined,
              undefined,
              undefined,
              (collider) => collider !== playerCollider,
            );
            return hit ? 150 - hit.timeOfImpact : null;
          },
          groundYAt: (x, z, seedY) => {
            const ray = new RAPIER.Ray({ x, y: seedY + 4, z }, { x: 0, y: -1, z: 0 });
            const surfaces: number[] = [];
            world?.intersectionsWithRay(
              ray,
              20,
              true,
              (hit) => {
                const surfaceY = seedY + 4 - hit.timeOfImpact;
                if (surfaceY >= seedY - 0.5) surfaces.push(surfaceY);
                return true;
              },
              undefined,
              undefined,
              playerCollider ?? undefined,
              undefined,
              (collider) => collider !== playerCollider,
            );
            return surfaces.length > 0 ? Math.min(...surfaces) : null;
          },
          pick: (clientX, clientY) => {
            const rect = activeRenderer.domElement.getBoundingClientRect();
            const pointer = new THREE.Vector2(
              ((clientX - rect.left) / rect.width) * 2 - 1,
              -((clientY - rect.top) / rect.height) * 2 + 1,
            );
            debugRaycaster.setFromCamera(pointer, camera);
            const hits = debugRaycaster
              .intersectObjects(scene.children, true)
              .filter(({ object }) => !isSceneEditorObject(object));
            if (hits.length === 0) return null;
            const hit =
              hits.find(({ object }) => object.userData[DEBUG_COMPONENT_PROXY] == null) ?? hits[0];
            const picked =
              hit.object instanceof THREE.Mesh
                ? debugComponentForHit(hit.object, hit.faceIndex ?? undefined, hit.point)
                : hit.object;
            return {
              ...hit,
              object: picked,
              sourceObject: picked === hit.object ? undefined : resolveDebugSourceObject(picked),
              faceIndex: hit.faceIndex ?? undefined,
              instanceId: hit.instanceId ?? undefined,
            };
          },
          getPath: (object) => {
            const parts: string[] = [];
            let current: THREE.Object3D | null =
              object instanceof THREE.Object3D
                ? object
                : (object as THREE.Intersection<THREE.Object3D>).object;
            current = resolveDebugSourceObject(current);
            while (current && current !== scene) {
              parts.unshift(current.name || current.type);
              current = current.parent;
            }
            return parts.join(" / ");
          },
          getObjectInfo: (object, hit = null) => {
            const target =
              object instanceof THREE.Object3D
                ? object
                : (object as THREE.Intersection<THREE.Object3D>).object;
            const bounds = new THREE.Box3().setFromObject(target);
            const worldPosition = target.getWorldPosition(new THREE.Vector3());
            const worldQuaternion = target.getWorldQuaternion(new THREE.Quaternion());
            if (target instanceof THREE.InstancedMesh && hit?.instanceId != null) {
              target.geometry.computeBoundingBox();
              if (target.geometry.boundingBox) {
                const instanceMatrix = new THREE.Matrix4();
                target.getMatrixAt(hit.instanceId, instanceMatrix);
                const worldMatrix = target.matrixWorld.clone().multiply(instanceMatrix);
                bounds.copy(target.geometry.boundingBox).applyMatrix4(worldMatrix);
                worldMatrix.decompose(worldPosition, worldQuaternion, new THREE.Vector3());
              }
            }
            const objectMaterials: Array<Record<string, unknown>> = [];
            const targetMesh = target instanceof THREE.Mesh ? target : null;
            const hitIndexOffset = hit?.faceIndex != null ? hit.faceIndex * 3 : null;
            const hitGroupIndex =
              targetMesh && hitIndexOffset != null
                ? targetMesh.geometry.groups.findIndex(
                    (group: { start: number; count: number; materialIndex: number }) =>
                      hitIndexOffset >= group.start && hitIndexOffset < group.start + group.count,
                  )
                : -1;
            const hitGroup =
              hitGroupIndex >= 0 && targetMesh ? targetMesh.geometry.groups[hitGroupIndex] : null;
            const hitMaterialIndex =
              hitGroup?.materialIndex ??
              (targetMesh && !Array.isArray(targetMesh.material) ? 0 : null);
            const hitMaterial =
              targetMesh && hitMaterialIndex != null
                ? Array.isArray(targetMesh.material)
                  ? targetMesh.material[hitMaterialIndex]
                  : targetMesh.material
                : null;
            target.traverse((child) => {
              if (!(child instanceof THREE.Mesh)) return;
              for (const material of Array.isArray(child.material)
                ? child.material
                : [child.material]) {
                objectMaterials.push({
                  name: material.name,
                  type: material.type,
                  transparent: material.transparent,
                  opacity: material.opacity,
                  hasMap: Boolean((material as THREE.Material & { map?: THREE.Texture }).map),
                });
              }
            });
            return {
              name: target.name || target.type,
              displayName: [
                target.name || target.type,
                hitMaterial?.name ? `material=${hitMaterial.name}` : null,
                hitGroupIndex >= 0 ? `group=${hitGroupIndex}` : null,
                hit?.faceIndex != null ? `face=${hit.faceIndex}` : null,
              ]
                .filter(Boolean)
                .join(" · "),
              type: target.type,
              visible: target.visible,
              instanceId: hit?.instanceId ?? null,
              worldPosition: worldPosition.toArray(),
              worldBounds: [bounds.min.toArray(), bounds.max.toArray()],
              materials: objectMaterials,
              hit: hit
                ? {
                    distance: hit.distance,
                    point: hit.point.toArray(),
                    faceIndex: hit.faceIndex ?? null,
                    instanceId: hit.instanceId ?? null,
                    groupIndex: hitGroupIndex >= 0 ? hitGroupIndex : null,
                    materialIndex: hitMaterialIndex,
                    material: hitMaterial?.name ?? null,
                  }
                : null,
              geometry:
                target instanceof THREE.Mesh
                  ? {
                      vertexCount: target.geometry.attributes.position?.count ?? 0,
                      indexCount: target.geometry.index?.count ?? 0,
                      groupCount: target.geometry.groups.length,
                      groups: target.geometry.groups.map(
                        (group: { start: number; count: number; materialIndex: number }) => ({
                          start: group.start,
                          count: group.count,
                          materialIndex: group.materialIndex,
                          material: Array.isArray(target.material)
                            ? (target.material[group.materialIndex]?.name ?? null)
                            : target.material.name,
                        }),
                      ),
                    }
                  : null,
            };
          },
          highlight: (object, on) => {
            (object as THREE.Object3D).traverse((child) => {
              if (!(child instanceof THREE.Mesh)) return;
              const materials = Array.isArray(child.material) ? child.material : [child.material];
              for (const material of materials) {
                const standard = material as THREE.MeshStandardMaterial;
                if (!standard.emissive) continue;
                if (!debugHighlightOriginals.has(standard)) {
                  debugHighlightOriginals.set(standard, standard.emissive.getHex());
                }
                standard.emissive.setHex(
                  on ? 0x442200 : (debugHighlightOriginals.get(standard) ?? 0),
                );
                standard.needsUpdate = true;
              }
            });
          },
          setVisible: (object, visible) => {
            const target = object as THREE.Object3D;
            if (target.userData[DEBUG_COMPONENT_PROXY] != null && target instanceof THREE.Mesh) {
              setDebugComponentVisible(target, visible);
              return;
            }
            target.visible = visible;
          },
          addBoxCollider: (halfExtents, translation) => {
            if (!world) return null;
            try {
              const descriptor = RAPIER.ColliderDesc.cuboid(
                halfExtents[0],
                halfExtents[1],
                halfExtents[2],
              )
                .setTranslation(translation[0], translation[1], translation[2])
                .setFriction(0.9);
              return world.createCollider(descriptor);
            } catch (cause) {
              console.warn("[Agent HQ] addBoxCollider failed", cause);
              return null;
            }
          },
          addTrimeshCollider: (geometry) => {
            if (!world) return null;
            const posAttr = geometry.getAttribute("position");
            const idxAttr = geometry.getIndex();
            if (!posAttr || !idxAttr) return null;
            const vertices = posAttr.array as Float32Array;
            const rawIndices = idxAttr.array as Uint16Array | Uint32Array;
            const indices =
              rawIndices instanceof Uint32Array ? rawIndices : new Uint32Array(rawIndices);
            if (indices.length < 3) return null;
            try {
              const descriptor = RAPIER.ColliderDesc.trimesh(vertices, indices);
              if (!descriptor) return null;
              descriptor.setFriction(0.9);
              return world.createCollider(descriptor);
            } catch (cause) {
              console.warn("[Agent HQ] addTrimeshCollider failed", cause);
              return null;
            }
          },
          removePropCollider: (handle) => {
            if (!world || !handle) return;
            try {
              world.removeCollider(handle as Collider, true);
            } catch (cause) {
              console.warn("[Agent HQ] removePropCollider failed", cause);
            }
          },
        };
        if (debugApiRef) debugApiRef.current = debugApi;
        onDebugApiReady?.(debugApi);
        if (new URLSearchParams(window.location.search).has("debug")) {
          (window as unknown as { __agentHq: SceneDebugApi }).__agentHq = debugApi;
        }
        for (const zone of zones) if (zone.preload) void loadZone(zone.id);
        const render = () => {
          if (disposed || !world || !characterController || !playerCollider) return;
          const frameStartedAt = performance.now();
          animationFrame = requestAnimationFrame(render);
          timer.update();
          updateProximityZones();
          const delta = Math.min(timer.getDelta(), 0.05);
          if (cameraViewModeRef && cameraViewModeRef.current !== cameraController.viewMode) {
            cameraController.setViewMode(cameraViewModeRef.current);
            camera = cameraController.camera;
            if (isOrthographicClickOnly()) {
              keys.clear();
              jumpQueued = false;
              verticalVelocity = 0;
              clickNavigationActive = false;
              clickNavigationPath.length = 0;
              clickNavigationPathIndex = 0;
            }
            if (cameraController.viewMode !== "orthographic") {
              clickNavigationActive = false;
              clickNavigationPath.length = 0;
              clickNavigationPathIndex = 0;
              navigationIndicator.visible = false;
              activeRenderer.domElement.style.cursor = "";
            }
          }
          cameraController.setCameraRelativeBasis(forward, right);
          visualUpdate?.(scene, delta, timer.getElapsed());
          world.step();
          const inputFrozen = false;
          const topDownClickOnlyActive = isOrthographicClickOnly();
          const desiredAutostepHeight = 0.6;
          if (desiredAutostepHeight !== activeAutostepHeight) {
            characterController.enableAutostep(desiredAutostepHeight, 0.2, false);
            activeAutostepHeight = desiredAutostepHeight;
          }
          // Top-down keeps its deliberate click-navigation override. Perspective
          // continues to use the shared movement settings without scene-specific
          // compensation.
          const activeMovementSpeedFactor = topDownClickOnlyActive
            ? orthographicMovementSpeedFactor
            : movementSpeedFactor;
          let inputX =
            inputFrozen || topDownClickOnlyActive
              ? 0
              : Number(keys.has("KeyD")) - Number(keys.has("KeyA"));
          let inputZ =
            inputFrozen || topDownClickOnlyActive
              ? 0
              : Number(keys.has("KeyW")) - Number(keys.has("KeyS"));
          let clickNavigationSteering = false;
          let clickNavigationTargetDistance = 0;
          if (
            !inputFrozen &&
            clickNavigationEnabled &&
            cameraController.viewMode === "orthographic" &&
            clickNavigationActive
          ) {
            // Consume any waypoint reached in this frame before calculating
            // steering. This avoids a one-frame idle blip at every corner of
            // a diagonal route, which made the run animation visibly jitter.
            while (clickNavigationActive) {
              const routeTarget =
                clickNavigationPath[clickNavigationPathIndex] ?? clickNavigationTarget;
              const targetX = routeTarget.x - playerPosition.x;
              const targetZ = routeTarget.z - playerPosition.z;
              clickNavigationTargetDistance = Math.hypot(targetX, targetZ);
              if (clickNavigationTargetDistance > CLICK_NAVIGATION_ARRIVAL_DISTANCE) {
                if (inputX === 0 && inputZ === 0) {
                  clickNavigationDirection.set(targetX, 0, targetZ).normalize();
                  inputX = clickNavigationDirection.dot(right);
                  inputZ = clickNavigationDirection.dot(forward);
                  clickNavigationSteering = true;
                }
                break;
              }
              if (clickNavigationPathIndex + 1 < clickNavigationPath.length) {
                clickNavigationPathIndex += 1;
                continue;
              }
              clickNavigationActive = false;
              clickNavigationPath.length = 0;
              clickNavigationPathIndex = 0;
            }
          }
          const inputMagnitude = Math.hypot(inputX, inputZ);
          const inputLength = inputMagnitude || 1;
          const wasSwimming = isSwimming;
          const waterAtStart = findWaterZone(waterZones, playerPosition, playerHeight);
          if (
            waterAtStart &&
            (waterAtStart.forceSwimming || !characterController.computedGrounded())
          )
            isSwimming = true;

          // The character only swims (slower, swim animation) once its body has
          // actually laid down on the water; while it is still running through
          // the shallows it keeps the locomotion speed. swimTilt trails one
          // frame behind, which is imperceptible.
          const onFootSpeed =
            (isSwimming && swimTilt > SWIM_POSE_TILT ? playerSpeed * SWIM_SPEED_FACTOR : 0) ||
            playerSpeed;
          const movementSpeed = onFootSpeed * activeMovementSpeedFactor;
          if (clickNavigationSteering) {
            desired
              .copy(clickNavigationDirection)
              .multiplyScalar(Math.min(movementSpeed * delta, clickNavigationTargetDistance));
          } else {
            desired
              .copy(forward)
              .multiplyScalar((inputZ / inputLength) * movementSpeed * delta)
              .addScaledVector(
                right,
                (inputX / inputLength) * movementSpeed * STRAFE_SPEED_FACTOR * delta,
              );
          }

          const groundedBeforeMovement = characterController.computedGrounded();
          let jumpStartedThisFrame = false;
          if (topDownClickOnlyActive) {
            // Top-down HQ navigation has no jump/fall state. Keep the capsule
            // on the already-resolved floor while the horizontal route runs.
            verticalVelocity = 0;
            jumpQueued = false;
            desired.y = 0;
          } else if (isSwimming) {
            if (jumpQueued) {
              // A jump while swimming pops the character out of the water so
              // it can climb onto banks and trench ledges instead of being
              // trapped in the river. Leaving the swim state hands the arc
              // back to gravity; landing in the water re-triggers swimming.
              isSwimming = false;
              verticalVelocity = swimJumpSpeed;
              swimJumpFrames = SWIM_JUMP_FRAMES;
            } else {
              verticalVelocity = 0;
            }
            desired.y = verticalVelocity * delta;
            jumpQueued = false;
          } else if (groundedBeforeMovement) {
            const startedJump = jumpQueued;
            jumpStartedThisFrame = startedJump;
            if (startedJump) intentionalJumpActive = true;
            verticalVelocity = startedJump
              ? jumpSpeed
              : Math.max(verticalVelocity, groundedVelocity);
          } else {
            verticalVelocity += gravity * delta;
          }
          if (!isSwimming) jumpQueued = false;
          characterController.enableSnapToGround(0.3);
          if (!isSwimming) desired.y = verticalVelocity * delta;
          characterController.computeColliderMovement(playerCollider, {
            x: desired.x,
            y: desired.y,
            z: desired.z,
          });
          const computed = characterController.computedMovement();
          movement.set(computed.x, computed.y, computed.z);
          if (swimJumpFrames > 0) {
            // The swim float line can sit inside the bank slope, so the first
            // frames of a water-exit jump are resolved without collision.
            swimJumpFrames -= 1;
            movement.y = verticalVelocity * delta;
          }
          playerPosition.add(movement);
          if (climbFrames > 0) {
            // The climb owns the position: lift the character onto the bank
            // over a few frames, ignoring wall collision for the transition.
            climbFrames -= 1;
            playerPosition.lerpVectors(climbStart, climbTarget, 1 - climbFrames / CLIMB_FRAMES);
          }
          const waterAfterMovement = findWaterZone(waterZones, playerPosition, playerHeight);
          if (isSwimming && !waterAfterMovement) {
            isSwimming = false;
            verticalVelocity = groundedVelocity;
          } else if (
            !isSwimming &&
            waterAfterMovement &&
            (waterAfterMovement.forceSwimming || !characterController.computedGrounded())
          ) {
            isSwimming = true;
            verticalVelocity = 0;
          }
          if (wasSwimming !== isSwimming) {
            debugLog(
              `[Agent HQ] ${label} swimming=${isSwimming} surface=${waterAfterMovement?.surfaceY.toFixed(3) ?? "none"} position=${playerPosition
                .toArray()
                .map((value) => value.toFixed(2))
                .join(",")}`,
            );
            setStatus(isSwimming ? `${readyStatus} · swimming` : readyStatus);
          }
          // Probe the floor under the water on the entry, floating, and exit
          // frames alike (referenceWater falls back to the zone the character
          // was in at the start of the frame). When the floor rises above the
          // float line the character stands on it (wading) and steps out of the
          // water; otherwise the body keeps floating at the surface. Running
          // this probe on the frame the character leaves the water zone is
          // what lifts the capsule above the shore sand instead of leaving it
          // embedded below the beach.
          const referenceWater = waterAfterMovement ?? waterAtStart;
          let floating = false;
          if ((isSwimming || waterAtStart) && referenceWater) {
            const swimTargetY =
              referenceWater.surfaceY +
              SWIM_SURFACE_OFFSET +
              (playerHeight - SWIM_SURFACE_REFERENCE_HEIGHT) / 2;
            // Cast from well above the surface instead of just above it: the
            // floor probe must also catch beaches whose top sits more than a
            // unit above the water line. A ray that only looks downward from
            // surfaceY+1 misses those, so a swimmer closing in on a steep shore
            // never wades, stays embedded below the beach, and then "exits the
            // water under the sand". The vertical cast at the player's x/z
            // still only hits the terrain directly beneath, so it cannot
            // teleport the swimmer onto distant cliff tops.
            const probeWorld = world;
            const probeCollider = playerCollider;
            const probeFloor = (x: number, z: number) => {
              floorRay.origin.x = x;
              floorRay.origin.y = referenceWater.surfaceY + SWIM_FLOOR_PROBE_ORIGIN;
              floorRay.origin.z = z;
              floorRay.dir.x = 0;
              floorRay.dir.y = -1;
              floorRay.dir.z = 0;
              const hit = probeWorld.castRay(
                floorRay,
                SWIM_FLOOR_PROBE_ORIGIN + SWIM_FLOOR_PROBE_DISTANCE,
                true,
                undefined,
                undefined,
                probeCollider,
              );
              return hit
                ? referenceWater.surfaceY + SWIM_FLOOR_PROBE_ORIGIN - hit.timeOfImpact
                : -Infinity;
            };
            // Probe directly beneath the capsule and just ahead of its leading
            // edge (the facing direction). A swimmer approaching a rising shore
            // gets blocked by the slope before the ground under its center
            // clears the float line; without the ahead probe it hovers against
            // the beach forever instead of wading out.
            let floorY = probeFloor(playerPosition.x, playerPosition.z);
            const aheadX = playerPosition.x + forward.x * SWIM_WADE_AHEAD_DISTANCE;
            const aheadZ = playerPosition.z + forward.z * SWIM_WADE_AHEAD_DISTANCE;
            floorY = Math.max(floorY, probeFloor(aheadX, aheadZ));
            if (
              floorY > referenceWater.surfaceY - SWIM_WADE_MARGIN &&
              floorY <= playerPosition.y + playerHeight * 2
            ) {
              playerPosition.y = Math.max(playerPosition.y, floorY + playerHeight / 2);
              if (isSwimming) {
                isSwimming = false;
                verticalVelocity = groundedVelocity;
              }
            } else if (climbFrames === 0 && isSwimming && inputMagnitude > 0.01) {
              // Look for a bank in the movement direction: a forward ray finds
              // the wall/slope at the waterline, then a downward probe finds
              // the bank top. Climbing lifts the character onto it.
              climbDir
                .copy(forward)
                .multiplyScalar(inputZ / inputLength)
                .addScaledVector(right, inputX / inputLength);
              climbDir.y = 0;
              if (climbDir.lengthSq() > 0.001) {
                climbDir.normalize();
                // Fire the bank probe from the top of the capsule: a swimmer
                // floats with its center below the shore lip, so a ray from the
                // body center runs underneath the sand edge and never finds the
                // bank. From the capsule top it clears the lip and the downhill
                // probe can locate the bank top.
                climbRay.origin.x = playerPosition.x;
                climbRay.origin.y = playerPosition.y + playerHeight / 2;
                climbRay.origin.z = playerPosition.z;
                climbRay.dir.x = climbDir.x;
                climbRay.dir.y = 0;
                climbRay.dir.z = climbDir.z;
                const climbHit = world.castRay(
                  climbRay,
                  CLIMB_RAY_DISTANCE,
                  true,
                  undefined,
                  undefined,
                  playerCollider,
                );
                if (climbHit) {
                  const bankX = playerPosition.x + climbDir.x * climbHit.timeOfImpact;
                  const bankZ = playerPosition.z + climbDir.z * climbHit.timeOfImpact;
                  floorRay.origin.x = bankX;
                  floorRay.origin.y = playerPosition.y + CLIMB_MAX_RISE + 1.5;
                  floorRay.origin.z = bankZ;
                  floorRay.dir.y = -1;
                  const bankHit = world.castRay(
                    floorRay,
                    CLIMB_MAX_RISE + 4,
                    true,
                    undefined,
                    undefined,
                    playerCollider,
                  );
                  const bankY = bankHit ? floorRay.origin.y - bankHit.timeOfImpact : -Infinity;
                  if (
                    bankY > referenceWater.surfaceY + 0.15 &&
                    bankY - playerPosition.y <= CLIMB_MAX_RISE
                  ) {
                    climbStart.copy(playerPosition);
                    climbTarget.set(
                      bankX + climbDir.x * CLIMB_EDGE_PAST,
                      bankY + playerHeight / 2,
                      bankZ + climbDir.z * CLIMB_EDGE_PAST,
                    );
                    climbFrames = CLIMB_FRAMES;
                    isSwimming = false;
                    verticalVelocity = 0;
                  } else {
                    floating = true;
                    if (isSwimming) playerPosition.y = swimTargetY;
                  }
                } else {
                  floating = true;
                  if (isSwimming) playerPosition.y = swimTargetY;
                }
              } else {
                floating = true;
                if (isSwimming) playerPosition.y = swimTargetY;
              }
            } else {
              floating = true;
              if (isSwimming) playerPosition.y = swimTargetY;
            }
            verticalVelocity = 0;
          }
          if (verticalVelocity > 0 && movement.y < desired.y - 0.001) verticalVelocity = 0;
          if (characterController.computedGrounded() && verticalVelocity < 0)
            verticalVelocity = groundedVelocity;
          playerCollider.setTranslation({
            x: playerPosition.x,
            y: playerPosition.y,
            z: playerPosition.z,
          });
          const groundedAfterMovement = characterController.computedGrounded();
          if (groundedAfterMovement && !jumpStartedThisFrame && verticalVelocity <= 0)
            intentionalJumpActive = false;
          // Click navigation can continue steering while a target is blocked
          // by a collider. Drive locomotion from actual horizontal travel so
          // the character does not stay in the run pose while standing still.
          // Preserve World's exact perspective predicate. HQ click navigation
          // uses resolved horizontal travel only while orthographic click-only
          // mode is active; perspective must not inherit that threshold.
          const worldMoving = inputMagnitude > 0.01 && movement.lengthSq() > 0.0001;
          const moving = topDownClickOnlyActive
            ? !inputFrozen &&
              inputMagnitude > 0.01 &&
              Math.hypot(movement.x, movement.z) > CLICK_NAVIGATION_MOVEMENT_EPSILON
            : worldMoving;
          if (clickNavigationSteering) {
            if (moving) {
              clickNavigationBlockedFrames = 0;
            } else {
              clickNavigationBlockedFrames += 1;
              if (clickNavigationBlockedFrames >= 8) {
                const replannedPath = buildClickNavigationPath(
                  clickNavigationTarget.x,
                  clickNavigationTarget.z,
                );
                clickNavigationPath.length = 0;
                clickNavigationPath.push(...replannedPath);
                clickNavigationPathIndex = 0;
                clickNavigationActive = replannedPath.length > 0;
                clickNavigationBlockedFrames = 0;
              }
            }
          } else {
            clickNavigationBlockedFrames = 0;
          }
          // Keep perspective on World's input-driven animation path verbatim.
          // Only the orthographic click-only view derives animation state from
          // resolved travel, with a short grace window over collision queries.
          const worldAnimationMoving = inputMagnitude > 0.01;
          const animationMoving = topDownClickOnlyActive
            ? clickNavigationSteering && (moving || clickNavigationBlockedFrames < 3)
            : worldAnimationMoving;

          const targetSwimTilt = isSwimming && floating ? SWIM_BODY_TILT : 0;
          swimTilt = THREE.MathUtils.damp(swimTilt, targetSwimTilt, SWIM_BODY_TILT_DAMPING, delta);
          // The swim clip only takes over once the body has actually laid down
          // on the water; while the character is still running/wading through
          // the shallows it keeps the locomotion animation.
          const laidDown = isSwimming && swimTilt > SWIM_POSE_TILT;
          if (characterRoot) {
            characterRoot.position.set(
              playerPosition.x,
              playerPosition.y - playerHeight / 2 - characterBottom + characterGroundOffset,
              playerPosition.z,
            );
            const facingMovement =
              topDownClickOnlyActive && clickNavigationSteering
                ? clickNavigationDirection
                : movement;
            const facingMoving = topDownClickOnlyActive ? animationMoving : moving;
            const travelYaw =
              facingMoving &&
              Math.hypot(facingMovement.x, facingMovement.z) > CLICK_NAVIGATION_MOVEMENT_EPSILON
                ? Math.atan2(facingMovement.x, facingMovement.z)
                : characterYaw;
            if (moving) {
              const targetYaw = travelYaw;
              const angleDelta = Math.atan2(
                Math.sin(targetYaw - characterYaw),
                Math.cos(targetYaw - characterYaw),
              );
              characterYaw += angleDelta * Math.min(1, delta * 12);
            }
            // Compose the swim tilt *before* the yaw (qYaw * qTilt applies the
            // tilt in the character's own frame), so the body lies head-first
            // along the facing direction on every heading. Rotating the root
            // with Euler XYZ would apply the X tilt after the Y yaw in the
            // world frame instead, tipping the body toward world +Z and making
            // the swimmer crab sideways whenever it does not face due north.
            characterRoot.quaternion
              .setFromEuler(characterYawEuler.set(0, characterYaw, 0))
              .multiply(swimTiltQuaternion.setFromEuler(swimTiltEuler.set(swimTilt, 0, 0)));
          }
          const isAirborne = !isSwimming && !groundedAfterMovement;
          const targetAnimationName = topDownClickOnlyActive
            ? animationMoving && locomotionName
              ? locomotionName
              : (idleName ?? null)
            : laidDown && swimmingName
              ? swimmingName
              : intentionalJumpActive && isAirborne && jumpName
                ? jumpName
                : worldAnimationMoving && locomotionName
                  ? locomotionName
                  : (groundedAfterMovement || isSwimming) && idleName
                    ? idleName
                    : (idleName ?? null);
          if (targetAnimationName && activeAnimationName !== targetAnimationName) {
            // Use the same transition as World in both HQ camera views. The
            // short click-only fade made the run pose visibly snap and jitter.
            const action = animationController?.play(targetAnimationName);
            if (action && targetAnimationName === jumpName) action.clampWhenFinished = true;
            if (action) activeAnimationName = targetAnimationName;
          } else if (!targetAnimationName && activeAnimationName) {
            animationController?.actions.forEach((action) => action.stop());
            activeAnimationName = null;
          }
          animationController?.actions.forEach((action, name) => {
            action.paused = activeAnimationName !== name;
          });
          if (locomotionAction) locomotionAction.timeScale = groundedAfterMovement ? 1 : 0.8;
          animationController?.update(delta);
          // Place the camera target at the upper torso/head area of the actual
          // visual model, not the physics capsule.
          characterTarget.set(
            playerPosition.x,
            playerPosition.y - playerHeight / 2 + cameraTargetOffset,
            playerPosition.z,
          );
          let obstructionDistance = cameraController.baseDistance;
          if (cameraController.isPerspective) {
            cameraController.getTargetViewDirection(viewDirection);
            if (cameraOcclusionFrame++ % 4 === 0) {
              cameraRay.origin.x = characterTarget.x;
              cameraRay.origin.y = characterTarget.y;
              cameraRay.origin.z = characterTarget.z;
              cameraRay.dir.x = -viewDirection.x;
              cameraRay.dir.y = -viewDirection.y;
              cameraRay.dir.z = -viewDirection.z;
              const obstruction = world.castRay(
                cameraRay,
                cameraController.perspectiveDistance,
                true,
                undefined,
                undefined,
                playerCollider,
              );
              cameraDistance = obstruction?.timeOfImpact ?? cameraController.perspectiveDistance;

              // The physics layer intentionally excludes many decorative
              // meshes. Sweep the rendered scene as well so furniture,
              // foliage, and other visual-only objects cannot hide the avatar.
              cameraOcclusionDirection.copy(viewDirection).negate();
              cameraOcclusionRaycaster.set(characterTarget, cameraOcclusionDirection);
              const visualObstruction = cameraOcclusionRaycaster
                .intersectObjects(scene.children, true)
                .find((hit) => isCameraOccluder(hit.object, characterRoot));
              if (visualObstruction) {
                cameraDistance = Math.min(cameraDistance, visualObstruction.distance);
              }
            }
            obstructionDistance = cameraDistance;
          }
          cameraController.update(characterTarget, delta, obstructionDistance);
          camera = cameraController.camera;
          updatePlayerVisibility();
          // Adaptive resolution: keep a rolling average of real frame time and
          // lower the render scale when the device cannot keep up, restoring
          // it after a grace period once frames are fast again.
          if (basePixelRatio > 1) {
            qualityFrameMs += delta * 1000;
            qualityFrames += 1;
            if (qualityFrames >= QUALITY_MONITOR_WINDOW_FRAMES) {
              const averageMs = qualityFrameMs / qualityFrames;
              if (averageMs > QUALITY_REDUCE_MS && renderScale > QUALITY_MIN_RENDER_SCALE) {
                renderScale = Math.max(QUALITY_MIN_RENDER_SCALE, renderScale - QUALITY_SCALE_STEP);
                activeRenderer.setPixelRatio(basePixelRatio * renderScale);
                qualityGraceFrames = QUALITY_GRACE_FRAMES;
              } else if (averageMs < QUALITY_MONITOR_MS && renderScale < 1) {
                qualityGraceFrames -= 1;
                if (qualityGraceFrames <= 0) {
                  renderScale = Math.min(1, renderScale + QUALITY_SCALE_STEP);
                  activeRenderer.setPixelRatio(basePixelRatio * renderScale);
                  qualityGraceFrames = QUALITY_GRACE_FRAMES;
                }
              }
              qualityFrames = 0;
              qualityFrameMs = 0;
            }
          }
          activeRenderer.render(scene, camera);
          telemetry.recordFrame(performance.now() - frameStartedAt);
          // Refresh the on-screen coordinate readout a few times per second
          // without re-rendering the whole overlay every frame.
          if (positionFrame++ % 6 === 0) {
            setPosition(
              `${playerPosition.x.toFixed(2)}, ${playerPosition.y.toFixed(2)}, ${playerPosition.z.toFixed(2)}`,
            );
          }
        };
        // Establish the initial view before the first movement frame so a
        // freshly loaded scene cannot use Three.js's default -Z heading for
        // one frame of WASD input.
        characterTarget.set(
          playerPosition.x,
          playerPosition.y - playerHeight / 2 + cameraTargetOffset,
          playerPosition.z,
        );
        cameraController.update(characterTarget, 1 / 60, cameraController.baseDistance);
        camera = cameraController.camera;
        render();
        const remainingLoadingTime =
          MIN_LOADING_INDICATOR_MS - (performance.now() - loadingStartedAt);
        if (remainingLoadingTime > 0) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, remainingLoadingTime));
        }
        if (disposed) return;
        onReady?.();
        // Let the first frame paint before starting optional animation parsing
        // or the nearest room's visual/collision decode. These tasks are useful
        // background work, but neither belongs on the entrance critical path.
        window.setTimeout(() => {
          if (disposed) return;
          proximityZonesReady = true;
          updateProximityZones();
        }, 5000);
        if (deferCharacterDetails && loadDeferredCharacterDetails) {
          window.setTimeout(() => {
            if (!disposed) void loadDeferredCharacterDetails();
          }, 7000);
        }
      } catch (cause) {
        if (disposed) return;
        telemetry.fail(cause);
        const message = cause instanceof Error ? cause.message : "Unknown scene loading error";
        console.error(`[Agent HQ] ${label} load failed`, cause);
        setError(message);
        setStatus(`Unable to load ${label}`);
        disposeResources();
      }
    };

    window.addEventListener("resize", resize);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    load();

    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", resize);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      canvas.removeEventListener("pointerdown", onCanvasPointerDown);
      canvas.removeEventListener("pointermove", onCanvasPointerMove);
      canvas.removeEventListener("pointerleave", onCanvasPointerLeave);
      canvas.removeEventListener("wheel", onCanvasWheel);
      canvas.removeEventListener("webglcontextlost", onWebglContextLost);
      navigationIndicator.geometry.dispose();
      navigationIndicator.material.dispose();
      cameraController.dispose();
      if (debugApiRef) debugApiRef.current = null;
      for (const colliders of zoneCollisionColliders.values()) {
        colliders.forEach((collider) => world?.removeCollider(collider, true));
      }
      zoneCollisionColliders.clear();
      telemetry.dispose();
      disposeResources();
    };
  }, [
    additionalAssetUrls,
    additionalCollisionAssetUrls,
    assetUrl,
    cameraBounds,
    characterGroundOffset,
    characterId,
    characterScale,
    clickNavigationBounds,
    clickNavigationIndicatorScale,
    collideAdditionalVisualLayers,
    collisionAssetUrl,
    collisionExclusionAreas,
    collisionIncludePatterns,
    coplanarMaterialMeshNames,
    deferCharacterDetails,
    editorOverridesUrl,
    enableClickNavigation,
    entryZoneId,
    environment,
    foliageManifestUrl,
    keepZoneCollisionsActive,
    label,
    loadDeferredCharacterDetails,
    materialOverrides,
    movementSpeedFactor,
    onDebugApiReady,
    onLoadingStart,
    onReady,
    orthographicClickOnly,
    orthographicMovementSpeedFactor,
    playerVisibilityGroups,
    preserveEntryCollision,
    propsManifestUrl,
    sceneScale,
    startPosition,
    staticFieldAssetUrls,
    staticFieldCollisionAssetUrls,
    staticFieldCollisionPatterns,
    visualSetup,
    visualUpdate,
    waterVolumes,
    zones,
  ]);

  return (
    <div
      style={{
        position: "relative",
        width: "100vw",
        height: "100dvh",
        overflow: "hidden",
        background: toCssColor(environment?.background),
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ display: "block", width: "100%", height: "100%", touchAction: "none" }}
      />
      {showHud ? (
        <div
          style={{
            position: "absolute",
            left: 20,
            top: 20,
            maxWidth: 420,
            padding: "12px 16px",
            borderRadius: 10,
            color: "#fff",
            background: "rgba(8, 24, 36, 0.78)",
            fontFamily: "system-ui, sans-serif",
            fontSize: 14,
            lineHeight: 1.45,
            pointerEvents: "none",
          }}
        >
          <strong>{label}</strong>
          <div>
            Pos: <span style={{ fontVariantNumeric: "tabular-nums" }}>{position}</span>
          </div>
          <div>{status}</div>
          <div style={{ marginTop: 6, opacity: 0.8 }}>
            {enableClickNavigation ? "Click a point to move · " : "Click to capture the mouse · "}
            Mouse orbit and arrow keys in perspective · WASD move · Space jump · V hoverboard · G
            jetpack · B exit · Shift/Ctrl lift · Esc release
          </div>
        </div>
      ) : null}
      {error ? (
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: 20,
            transform: "translateX(-50%)",
            maxWidth: 420,
            padding: "12px 16px",
            borderRadius: 10,
            color: "#ffb4b4",
            background: "rgba(8, 24, 36, 0.78)",
            fontFamily: "system-ui, sans-serif",
            fontSize: 14,
            lineHeight: 1.45,
            textAlign: "center",
          }}
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
