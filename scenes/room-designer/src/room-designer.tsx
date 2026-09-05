"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { RotateCw, Save, Trash2, Undo2, X } from "lucide-react";
import * as THREE from "three";
import { Button } from "@agent-hq/ui/components/ui/button";
import {
  PropCatalog,
  getSharedLoader,
  type PropCatalogItem,
} from "@agent-hq/ui/components/prop-catalog";
import type { SceneManifest } from "@agent-hq/asset-manifests";
import type { SceneDebugApi } from "@agent-hq/scene-runtime";
import {
  invalidateRoomDesignerDocument,
  loadRoomDesignerDocument,
  type RoomDesignerDocument,
} from "./room-designer-document";

export type RoomDesignerAsset = PropCatalogItem & {
  /** Authored footprint after the asset's default scale, in HQ map units. */
  footprint: readonly [number, number];
  /** Uniform model scale in shared World metres. */
  defaultScale: number;
  /** Yaw that presents the asset's authored front to the fixed HQ camera. */
  frontYaw: number;
  /** Top surface height in authored units (tables, counters). */
  surfaceHeight?: number;
  /** Small item that stacks on surfaces with surfaceHeight. */
  placeableOnTop?: boolean;
};

export type RoomDesignerRect = {
  id: string;
  x: number;
  z: number;
  width: number;
  depth: number;
};

export type RoomDesignerPlacement = {
  id: string;
  modelId: string;
  p: [number, number, number];
  q: [number, number, number, number];
  s: [number, number, number];
  footprint?: [number, number];
};

export function hasPlacementResetTarget(
  placement: RoomDesignerPlacement,
  savedPlacements: readonly RoomDesignerPlacement[]
): boolean {
  const saved = savedPlacements.find((candidate) => candidate.id === placement.id);
  if (!saved) return false;
  return (
    placement.modelId !== saved.modelId ||
    placement.p.some((value, index) => value !== saved.p[index]) ||
    placement.q.some((value, index) => value !== saved.q[index]) ||
    placement.s.some((value, index) => value !== saved.s[index])
  );
}

type Snapshot = { placements: RoomDesignerPlacement[] };

type MeasuredFootprint = {
  /** Local model bounds in authored HQ units, before placement rotation. */
  size: [number, number];
  /** Local model-bounds center relative to the placement origin. */
  offset: [number, number];
};

type DragState = {
  id?: string;
  modelId: string;
  existing: boolean;
  pointerId?: number;
  offsetX: number;
  offsetZ: number;
  moved: boolean;
  origin?: RoomDesignerPlacement;
};

export type RoomDesignerProps = {
  manifest: SceneManifest;
  debugApiRef: MutableRefObject<SceneDebugApi | null>;
  enabled: boolean;
  sceneScale: number;
  groundY: number;
  gridSize: number;
  mapBounds: RoomDesignerRect;
  /** Room interiors where furniture may be placed. */
  regions: readonly RoomDesignerRect[];
  /** Foundation wall rectangles used for overlap validation. */
  blockedRects: readonly RoomDesignerRect[];
  /** Doorway openings with a protected clearance corridor. */
  doorwayRects?: readonly RoomDesignerRect[];
  catalog: readonly RoomDesignerAsset[];
  /** Normal and design-only orthographic framing in authored HQ units. */
  normalOrthographicHalfHeight?: number;
  designOrthographicHalfHeight?: number;
  /** Design-only visual floor that extends beyond the gameplay map. */
  designBackdropColor?: number;
  designBackdropPadding?: number;
  /** Authored player position used while editing. */
  playerPosition?: { x: number; z: number };
  /** Increments when the underlying scene is recreated (e.g. character
   *  switch), so the designer can re-attach to the new scene graph. */
  sceneVersion?: number;
  /** Close the designer, allowing the shell to show its unsaved-changes prompt. */
  onClose?: () => void;
  /** Expose the save action to the surrounding scene's unsaved-changes prompt. */
  saveRef?: MutableRefObject<(() => Promise<boolean>) | null>;
  onDirtyChange?: (dirty: boolean) => void;
  /** Notify the surrounding scene after the saved layout is persisted. */
  onSaved?: () => void;
};

const IDENTITY_QUATERNION: [number, number, number, number] = [0, 0, 0, 1];
const DEFAULT_FOOTPRINT: [number, number] = [100, 100];
const OUTLINE_HEIGHT = 0.035;
const OUTLINE_THICKNESS = 0.018;

const yieldToBrowser = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function clonePlacement(placement: RoomDesignerPlacement): RoomDesignerPlacement {
  return {
    ...placement,
    p: [...placement.p] as [number, number, number],
    q: [...placement.q] as [number, number, number, number],
    s: [...placement.s] as [number, number, number],
    footprint: placement.footprint ? ([...placement.footprint] as [number, number]) : undefined,
  };
}

function cloneSnapshot(snapshot: Snapshot): Snapshot {
  return { placements: snapshot.placements.map(clonePlacement) };
}

function vectorOr<T extends number[]>(value: unknown, length: number, fallback: T): T {
  return Array.isArray(value) &&
    value.length === length &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
    ? ([...value] as T)
    : ([...fallback] as T);
}

function placementsFromDocument(
  document: RoomDesignerDocument,
  catalogById: ReadonlyMap<string, RoomDesignerAsset>,
  groundY: number
): RoomDesignerPlacement[] {
  const raw = Object.entries(document.placements ?? {}).flatMap(([modelId, entries]) =>
    entries.map((entry, index) => {
      const asset = catalogById.get(modelId);
      const p = vectorOr(entry.p, 3, [0, 0, 0] as [number, number, number]);
      const q = vectorOr(entry.q, 4, IDENTITY_QUATERNION);
      // Always use the catalog's defaultScale — the saved scale may be stale
      // from a previous version of the catalog (e.g. before a scale migration).
      const ds = asset?.defaultScale ?? 1;
      const s: [number, number, number] = [ds, ds, ds];
      const footprint = vectorOr(
        entry.footprint,
        2,
        asset?.footprint ? ([...asset.footprint] as [number, number]) : DEFAULT_FOOTPRINT
      );
      return {
        id: typeof entry.id === "string" && entry.id ? entry.id : `${modelId}-${index}`,
        modelId,
        p,
        q,
        s,
        footprint,
      };
    })
  );
  const emptyMeasured = new Map<string, MeasuredFootprint>();
  // Recompute Y values from the current catalog so saved placements pick up
  // changes to wallMountHeight and surfaceHeight without needing to re-place
  // every item. Wall items get y = groundY + wallMountHeight. placeableOnTop
  // items get y = groundY + surfaceHeight of the surface they overlap with.
  // Floor items keep y = groundY.
  for (const placement of raw) {
    const asset = catalogById.get(placement.modelId);
    if (!asset) continue;
    if (asset.placementSurface === "wall") {
      placement.p[1] = groundY + (asset.wallMountHeight ?? 96);
    } else if (asset.placeableOnTop) {
      const itemFootprint = footprintGeometryFor(placement, asset, emptyMeasured);
      const surface = raw.find((other) => {
        if (other.id === placement.id) return false;
        const surfaceAsset = catalogById.get(other.modelId);
        if (!surfaceAsset?.surfaceHeight) return false;
        return footprintsIntersect(
          itemFootprint,
          footprintGeometryFor(other, surfaceAsset, emptyMeasured),
          0
        );
      });
      const surfaceAsset = surface ? catalogById.get(surface.modelId) : undefined;
      if (surfaceAsset?.surfaceHeight) {
        placement.p[1] = groundY + surfaceAsset.surfaceHeight;
      }
      // If no surface is found, keep the saved Y — the item may have been
      // placed on a surface that was later moved or removed, and resetting
      // it to the floor would lose the user's intent.
    } else {
      placement.p[1] = groundY;
    }
  }
  return raw;
}

function placementsByModel(
  placements: readonly RoomDesignerPlacement[]
): Record<string, RoomDesignerPlacement[]> {
  return placements.reduce<Record<string, RoomDesignerPlacement[]>>((result, placement) => {
    const entries = result[placement.modelId] ?? [];
    entries.push(clonePlacement(placement));
    result[placement.modelId] = entries;
    return result;
  }, {});
}

function yawFromQuaternion(quaternion: readonly [number, number, number, number]): number {
  const [, y, , w] = quaternion;
  return Math.atan2(2 * w * y, 1 - 2 * y * y);
}

function quaternionForYaw(yaw: number): [number, number, number, number] {
  const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  return [quaternion.x, quaternion.y, quaternion.z, quaternion.w];
}

function footprintFor(
  placement: RoomDesignerPlacement,
  asset: RoomDesignerAsset | undefined,
  measured: ReadonlyMap<string, MeasuredFootprint>
): [number, number] {
  // Catalog footprint takes priority over measured — the catalog value is
  // the authoritative placement size. Measured footprints are only a fallback
  // for items without an explicit catalog footprint (e.g. when the model's
  // bounding box is needed because no footprint was authored).
  const measuredSize = asset ? measured.get(asset.id)?.size : undefined;
  const base = asset?.footprint ?? measuredSize ?? placement.footprint ?? DEFAULT_FOOTPRINT;
  if (!asset || asset.defaultScale <= 0) return [...base] as [number, number];
  const scaleX = Math.abs(placement.s[0]) / asset.defaultScale;
  const scaleZ = Math.abs(placement.s[2]) / asset.defaultScale;
  return [base[0] * scaleX, base[1] * scaleZ];
}

function offsetFor(
  placement: RoomDesignerPlacement,
  asset: RoomDesignerAsset | undefined,
  measured: ReadonlyMap<string, MeasuredFootprint>
): [number, number] {
  // Only use measured offset when there's no explicit catalog footprint —
  // the catalog footprint is centered on the origin by definition.
  if (!asset || asset.defaultScale <= 0) return [0, 0];
  if (asset.footprint) return [0, 0];
  const measuredOffset = measured.get(asset.id)?.offset;
  if (!measuredOffset) return [0, 0];
  return [
    (measuredOffset[0] * Math.abs(placement.s[0])) / asset.defaultScale,
    (measuredOffset[1] * Math.abs(placement.s[2])) / asset.defaultScale,
  ];
}

function rotatedFootprint(
  footprint: readonly [number, number],
  quaternion: readonly [number, number, number, number]
): [number, number] {
  const yaw = yawFromQuaternion(quaternion);
  const cos = Math.abs(Math.cos(yaw));
  const sin = Math.abs(Math.sin(yaw));
  return [footprint[0] * cos + footprint[1] * sin, footprint[0] * sin + footprint[1] * cos];
}

type PlacementFootprint = RoomDesignerRect & {
  shape: "rectangle" | "circle";
  radius?: number;
};

function rectIntersects(a: RoomDesignerRect, b: RoomDesignerRect, padding = 0): boolean {
  return (
    Math.abs(a.x - b.x) * 2 < a.width + b.width + padding &&
    Math.abs(a.z - b.z) * 2 < a.depth + b.depth + padding
  );
}

function rotateOffset(
  offset: readonly [number, number],
  quaternion: readonly [number, number, number, number]
): [number, number] {
  const yaw = yawFromQuaternion(quaternion);
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return [offset[0] * cos + offset[1] * sin, -offset[0] * sin + offset[1] * cos];
}

function footprintGeometryFor(
  placement: RoomDesignerPlacement,
  asset: RoomDesignerAsset | undefined,
  measured: ReadonlyMap<string, MeasuredFootprint>
): PlacementFootprint {
  const [width, depth] = rotatedFootprint(footprintFor(placement, asset, measured), placement.q);
  const [offsetX, offsetZ] = rotateOffset(offsetFor(placement, asset, measured), placement.q);
  const shape = asset?.footprintShape ?? "rectangle";
  return {
    id: placement.id,
    x: placement.p[0] + offsetX,
    z: placement.p[2] + offsetZ,
    width,
    depth,
    shape,
    radius: shape === "circle" ? Math.max(width, depth) / 2 : undefined,
  };
}

function circleIntersectsRect(
  circle: PlacementFootprint,
  rect: RoomDesignerRect,
  padding = 0
): boolean {
  const radius = (circle.radius ?? Math.max(circle.width, circle.depth) / 2) + padding / 2;
  const closestX = Math.max(rect.x - rect.width / 2, Math.min(circle.x, rect.x + rect.width / 2));
  const closestZ = Math.max(rect.z - rect.depth / 2, Math.min(circle.z, rect.z + rect.depth / 2));
  return Math.hypot(circle.x - closestX, circle.z - closestZ) < radius;
}

function footprintsIntersect(
  a: PlacementFootprint,
  b: RoomDesignerRect | PlacementFootprint,
  padding = 0
): boolean {
  if (a.shape === "circle" && "shape" in b && b.shape === "circle") {
    return (
      Math.hypot(a.x - b.x, a.z - b.z) <
      (a.radius ?? a.width / 2) + (b.radius ?? b.width / 2) + padding / 2
    );
  }
  if (a.shape === "circle") return circleIntersectsRect(a, b, padding);
  if ("shape" in b && b.shape === "circle") return circleIntersectsRect(b, a, padding);
  return rectIntersects(a, b, padding);
}

function footprintInsideRegion(
  footprint: PlacementFootprint,
  region: RoomDesignerRect,
  padding = 0
): boolean {
  if (footprint.shape === "circle") {
    const radius = (footprint.radius ?? footprint.width / 2) + padding;
    return (
      footprint.x - radius >= region.x - region.width / 2 &&
      footprint.x + radius <= region.x + region.width / 2 &&
      footprint.z - radius >= region.z - region.depth / 2 &&
      footprint.z + radius <= region.z + region.depth / 2
    );
  }
  return (
    Math.abs(footprint.x - region.x) * 2 + footprint.width <= region.width - padding * 2 &&
    Math.abs(footprint.z - region.z) * 2 + footprint.depth <= region.depth - padding * 2
  );
}

function placementRect(
  placement: RoomDesignerPlacement,
  asset: RoomDesignerAsset | undefined,
  measured: ReadonlyMap<string, MeasuredFootprint>
): RoomDesignerRect {
  const {
    shape: _shape,
    radius: _radius,
    ...rect
  } = footprintGeometryFor(placement, asset, measured);
  return rect;
}

function makePlacement(
  id: string,
  asset: RoomDesignerAsset,
  x: number,
  z: number,
  groundY: number
): RoomDesignerPlacement {
  const y = groundY + (asset.placementSurface === "wall" ? (asset.wallMountHeight ?? 96) : 0);
  return {
    id,
    modelId: asset.id,
    p: [x, y, z],
    q: quaternionForYaw(asset.frontYaw),
    s: [asset.defaultScale, asset.defaultScale, asset.defaultScale],
    footprint: [...asset.footprint],
  };
}

function createOutline(sceneScale: number): THREE.Group {
  const outline = new THREE.Group();
  outline.name = "room-designer-footprint";
  outline.renderOrder = 200;
  outline.visible = false;
  const material = new THREE.MeshBasicMaterial({
    color: 0x5eead4,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.98,
  });
  // Filled glow plane that sits on the floor under the outline edges.
  const glowMaterial = new THREE.MeshBasicMaterial({
    color: 0x5eead4,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.18,
    side: THREE.DoubleSide,
  });
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), glowMaterial);
  glow.name = "room-designer-footprint-glow";
  glow.rotation.x = -Math.PI / 2;
  glow.renderOrder = 199;
  outline.add(glow);
  // Vertical glow plane for wall items — stretches from the floor up to
  // the item's mount height, giving a natural "wall footprint" feel.
  const wallGlow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), glowMaterial.clone());
  wallGlow.name = "room-designer-footprint-wall-glow";
  wallGlow.renderOrder = 198;
  wallGlow.visible = false;
  outline.add(wallGlow);
  const addEdge = (name: string) => {
    const edge = new THREE.Mesh(
      new THREE.BoxGeometry(1, OUTLINE_HEIGHT, OUTLINE_THICKNESS),
      material
    );
    edge.name = name;
    edge.scale.set(1, sceneScale, sceneScale);
    edge.renderOrder = 200;
    outline.add(edge);
  };
  addEdge("room-designer-footprint-top");
  addEdge("room-designer-footprint-bottom");
  const sideMaterial = material.clone();
  const addSide = (name: string) => {
    const edge = new THREE.Mesh(
      new THREE.BoxGeometry(OUTLINE_THICKNESS, OUTLINE_HEIGHT, 1),
      sideMaterial
    );
    edge.name = name;
    edge.scale.set(sceneScale, sceneScale, 1);
    edge.renderOrder = 200;
    outline.add(edge);
  };
  addSide("room-designer-footprint-left");
  addSide("room-designer-footprint-right");
  const circle = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, 48), material.clone());
  circle.name = "room-designer-footprint-circle";
  circle.rotation.x = -Math.PI / 2;
  circle.renderOrder = 200;
  circle.visible = false;
  outline.add(circle);
  const circleGlow = new THREE.Mesh(new THREE.CircleGeometry(1, 48), glowMaterial.clone());
  circleGlow.name = "room-designer-footprint-circle-glow";
  circleGlow.rotation.x = -Math.PI / 2;
  circleGlow.renderOrder = 199;
  circleGlow.visible = false;
  outline.add(circleGlow);
  return outline;
}

function updateOutline(
  outline: THREE.Group,
  placement: RoomDesignerPlacement,
  asset: RoomDesignerAsset | undefined,
  measured: ReadonlyMap<string, MeasuredFootprint>,
  sceneScale: number,
  groundY: number,
  valid: boolean
): void {
  const [width, depth] = footprintFor(placement, asset, measured);
  const worldWidth = width * sceneScale;
  const worldDepth = depth * sceneScale;
  const halfLine = OUTLINE_THICKNESS / 2;
  const [offsetX, offsetZ] = rotateOffset(offsetFor(placement, asset, measured), placement.q);
  outline.position.set(
    (placement.p[0] + offsetX) * sceneScale,
    (placement.p[1] + 2) * sceneScale,
    (placement.p[2] + offsetZ) * sceneScale
  );
  outline.quaternion.set(...placement.q);
  outline.visible = true;
  const color = valid ? 0x5eead4 : 0xfb7185;
  for (const child of outline.children) {
    if (!(child instanceof THREE.Mesh)) continue;
    (child.material as THREE.MeshBasicMaterial).color.set(color);
  }
  const top = outline.getObjectByName("room-designer-footprint-top");
  const bottom = outline.getObjectByName("room-designer-footprint-bottom");
  const left = outline.getObjectByName("room-designer-footprint-left");
  const right = outline.getObjectByName("room-designer-footprint-right");
  const circle = outline.getObjectByName("room-designer-footprint-circle");
  const glow = outline.getObjectByName("room-designer-footprint-glow");
  const circleGlow = outline.getObjectByName("room-designer-footprint-circle-glow");
  const wallGlow = outline.getObjectByName("room-designer-footprint-wall-glow");
  const isCircle = asset?.footprintShape === "circle";
  const isWall = asset?.placementSurface === "wall";
  if (circle) {
    circle.visible = isCircle;
    circle.scale.setScalar(isCircle ? Math.max(worldWidth, worldDepth) / 2 : 1);
  }
  if (circleGlow) {
    circleGlow.visible = isCircle;
    circleGlow.scale.setScalar(isCircle ? Math.max(worldWidth, worldDepth) / 2 : 1);
  }
  if (glow) {
    glow.visible = !isCircle && !isWall;
    glow.scale.set(worldWidth, worldDepth, 1);
  }
  // Wall items: show a vertical glow plane that stretches from the floor
  // (groundY) up to the item's mount height. The plane is centered at the
  // midpoint between floor and mount height, facing along the wall (the
  // outline group's local Z axis after quaternion rotation).
  if (wallGlow) {
    wallGlow.visible = isWall && !isCircle;
    if (isWall) {
      const mountY = placement.p[1] * sceneScale;
      const floorY = groundY * sceneScale;
      const glowHeight = mountY - floorY;
      const glowCenterY = floorY + glowHeight / 2 - outline.position.y;
      wallGlow.scale.set(worldWidth, glowHeight, 1);
      wallGlow.position.set(0, glowCenterY, 0);
      // The plane faces +Z by default; the outline group's quaternion
      // already rotates it to align with the wall face, so no extra
      // rotation is needed.
    }
  }
  for (const edge of [top, bottom, left, right]) {
    if (edge) edge.visible = !isCircle;
  }
  if (isCircle || !top || !bottom || !left || !right) return;
  top.position.set(0, 0, worldDepth / 2 - halfLine);
  bottom.position.set(0, 0, -worldDepth / 2 + halfLine);
  top.scale.set(worldWidth, 1, 1);
  bottom.scale.set(worldWidth, 1, 1);
  left.position.set(-worldWidth / 2 + halfLine, 0, 0);
  right.position.set(worldWidth / 2 - halfLine, 0, 0);
  left.scale.set(1, 1, worldDepth);
  right.scale.set(1, 1, worldDepth);
}

function createFloorplanGrid(
  bounds: RoomDesignerRect,
  sceneScale: number,
  gridSize: number
): THREE.Group {
  const grid = new THREE.Group();
  const positions: number[] = [];
  const xMin = bounds.x - bounds.width / 2;
  const xMax = bounds.x + bounds.width / 2;
  const zMin = bounds.z - bounds.depth / 2;
  const zMax = bounds.z + bounds.depth / 2;
  const step = Math.max(gridSize, 0.01);
  const addVertical = (x: number) => {
    positions.push(x * sceneScale, 0, zMin * sceneScale, x * sceneScale, 0, zMax * sceneScale);
  };
  const addHorizontal = (z: number) => {
    positions.push(xMin * sceneScale, 0, z * sceneScale, xMax * sceneScale, 0, z * sceneScale);
  };
  for (let x = Math.ceil(xMin / step) * step; x <= xMax + step * 0.001; x += step) addVertical(x);
  for (let z = Math.ceil(zMin / step) * step; z <= zMax + step * 0.001; z += step) addHorizontal(z);
  addVertical(xMin);
  addVertical(xMax);
  addHorizontal(zMin);
  addHorizontal(zMax);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({
    color: 0xe2e8f0,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.name = "room-designer-grid-lines";
  lines.renderOrder = 20;
  grid.add(lines);
  return grid;
}

export function RoomDesigner({
  manifest,
  debugApiRef,
  enabled,
  sceneScale,
  groundY,
  gridSize,
  mapBounds,
  regions,
  blockedRects,
  doorwayRects = [],
  catalog,
  normalOrthographicHalfHeight = 720,
  designOrthographicHalfHeight = 840,
  designBackdropColor = 0x668b59,
  designBackdropPadding = 360,
  playerPosition,
  sceneVersion = 0,
  onClose,
  saveRef,
  onDirtyChange,
  onSaved,
}: RoomDesignerProps) {
  const [placements, setPlacements] = useState<RoomDesignerPlacement[]>([]);
  const [savedPlacements, setSavedPlacements] = useState<RoomDesignerPlacement[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const selectedIdRef = useRef(selectedId);
  const selectedModelIdRef = useRef(selectedModelId);
  const [_hoveredId, setHoveredId] = useState<string | null>(null);
  const [actionAnchor, setActionAnchor] = useState<{ x: number; y: number } | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [apiReady, setApiReady] = useState(false);
  const [, setStatus] = useState("Drag a prop onto a room.");
  const placementsRef = useRef(placements);
  const savedPlacementsRef = useRef(savedPlacements);
  const historyRef = useRef<Snapshot[]>([]);
  const futureRef = useRef<Snapshot[]>([]);
  const dragRef = useRef<DragState | null>(null);
  const dragCandidateRef = useRef<RoomDesignerPlacement | null>(null);
  const dragValidRef = useRef(false);
  const actionTargetIdRef = useRef<string | null>(null);
  const groupRef = useRef<THREE.Group | null>(null);
  const backdropRef = useRef<THREE.Mesh | null>(null);
  const gridRef = useRef<THREE.Group | null>(null);
  const outlineRef = useRef<THREE.Group | null>(null);
  const modelCacheRef = useRef(new Map<string, Promise<THREE.Object3D>>());
  const measuredFootprintsRef = useRef(new Map<string, MeasuredFootprint>());
  const [measuredFootprintVersion, setMeasuredFootprintVersion] = useState(0);
  const designerPanRef = useRef<[number, number]>([0, 0]);
  const designerZoomRef = useRef(1);
  const previousPlayerPositionRef = useRef<[number, number, number] | null>(null);
  const backgroundPanRef = useRef<{
    lastPoint: THREE.Vector3;
    moved: boolean;
    pointerId: number;
  } | null>(null);
  const suppressNextCanvasClickRef = useRef(false);
  const hoverClearTimeoutRef = useRef<number | null>(null);
  const catalogById = useMemo(() => new Map(catalog.map((asset) => [asset.id, asset])), [catalog]);
  const hasEdits = useMemo(
    () =>
      placements.length !== savedPlacements.length ||
      placements.some((p, i) => {
        const s = savedPlacements[i];
        return (
          !s ||
          p.id !== s.id ||
          p.modelId !== s.modelId ||
          p.p[0] !== s.p[0] ||
          p.p[1] !== s.p[1] ||
          p.p[2] !== s.p[2] ||
          p.q[0] !== s.q[0] ||
          p.q[1] !== s.q[1] ||
          p.q[2] !== s.q[2] ||
          p.q[3] !== s.q[3] ||
          p.s[0] !== s.s[0] ||
          p.s[1] !== s.s[1] ||
          p.s[2] !== s.s[2]
        );
      }),
    [placements, savedPlacements]
  );
  const selectedPlacement = selectedId
    ? placements.find((placement) => placement.id === selectedId)
    : null;

  useEffect(() => {
    onDirtyChange?.(hasEdits);
  }, [hasEdits, onDirtyChange]);

  const applySnapshot = (snapshot: Snapshot) => {
    const next = cloneSnapshot(snapshot);
    placementsRef.current = next.placements;
    setPlacements(next.placements);
  };

  const commitSnapshot = (next: Snapshot, message?: string) => {
    historyRef.current = [
      ...historyRef.current,
      cloneSnapshot({ placements: placementsRef.current }),
    ].slice(-50);
    futureRef.current = [];
    applySnapshot(next);
    if (message) setStatus(message);
  };

  const modelFor = (asset: RoomDesignerAsset): Promise<THREE.Object3D> => {
    const cached = modelCacheRef.current.get(asset.id);
    if (cached) return cached;
    const loaded = getSharedLoader()
      .loadAsync(asset.assetUrl)
      .then(({ scene }: { scene: THREE.Object3D }) => scene);
    modelCacheRef.current.set(asset.id, loaded);
    return loaded;
  };

  const measureAssetFootprint = async (
    asset: RoomDesignerAsset
  ): Promise<MeasuredFootprint | null> => {
    try {
      const source = await modelFor(asset);
      const sample = source.clone(true);
      sample.position.set(0, 0, 0);
      sample.quaternion.identity();
      sample.scale.setScalar(asset.defaultScale);
      sample.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(sample);
      if (bounds.isEmpty()) return null;
      const size = bounds.getSize(new THREE.Vector3());
      const center = bounds.getCenter(new THREE.Vector3());
      return {
        size: [Math.max(size.x / sceneScale, 0.01), Math.max(size.z / sceneScale, 0.01)],
        offset: [center.x / sceneScale, center.z / sceneScale],
      };
    } catch {
      return null;
    }
  };

  const worldPointAt = (clientX: number, clientY: number): THREE.Vector3 | null => {
    const api = debugApiRef.current;
    if (!api) return null;
    const rect = api.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, api.camera);
    return raycaster.ray.intersectPlane(
      new THREE.Plane(new THREE.Vector3(0, 1, 0), -groundY * sceneScale),
      new THREE.Vector3()
    );
  };

  const screenAnchorBelow = (object: THREE.Object3D): { x: number; y: number } | null => {
    const api = debugApiRef.current;
    if (!api) return null;
    const rect = api.renderer.domElement.getBoundingClientRect();
    const bounds = new THREE.Box3().setFromObject(object);
    const corners = [
      new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z),
      new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.max.z),
      new THREE.Vector3(bounds.max.x, bounds.min.y, bounds.min.z),
      new THREE.Vector3(bounds.max.x, bounds.min.y, bounds.max.z),
    ];
    const projected = corners.map((corner) => corner.project(api.camera));
    const left = Math.min(...projected.map(({ x }) => rect.left + ((x + 1) * rect.width) / 2));
    const right = Math.max(...projected.map(({ x }) => rect.left + ((x + 1) * rect.width) / 2));
    const bottom = Math.max(...projected.map(({ y }) => rect.top + ((1 - y) * rect.height) / 2));
    // Clamp within the viewport so very large objects don't push the
    // tooltip off-screen, making its controls unreachable.
    const x = THREE.MathUtils.clamp((left + right) / 2, rect.left + 80, rect.right - 80);
    const y = THREE.MathUtils.clamp(bottom, rect.top + 20, rect.bottom - 60);
    return { x, y };
  };

  const screenAnchorBelowPlacement = (
    placement: RoomDesignerPlacement,
    asset: RoomDesignerAsset | undefined
  ): { x: number; y: number } | null => {
    const api = debugApiRef.current;
    if (!api) return null;
    const rect = api.renderer.domElement.getBoundingClientRect();
    const footprint = placementRect(placement, asset, measuredFootprintsRef.current);
    const halfWidth = (footprint.width * sceneScale) / 2;
    const halfDepth = (footprint.depth * sceneScale) / 2;
    const centerX = footprint.x * sceneScale;
    const centerZ = footprint.z * sceneScale;
    const floorY = placement.p[1] * sceneScale;
    const corners = [
      new THREE.Vector3(centerX - halfWidth, floorY, centerZ - halfDepth),
      new THREE.Vector3(centerX - halfWidth, floorY, centerZ + halfDepth),
      new THREE.Vector3(centerX + halfWidth, floorY, centerZ - halfDepth),
      new THREE.Vector3(centerX + halfWidth, floorY, centerZ + halfDepth),
    ].map((corner) => corner.project(api.camera));
    const left = Math.min(...corners.map(({ x }) => rect.left + ((x + 1) * rect.width) / 2));
    const right = Math.max(...corners.map(({ x }) => rect.left + ((x + 1) * rect.width) / 2));
    const bottom = Math.max(...corners.map(({ y }) => rect.top + ((1 - y) * rect.height) / 2));
    const x = THREE.MathUtils.clamp((left + right) / 2, rect.left + 80, rect.right - 80);
    const y = THREE.MathUtils.clamp(bottom, rect.top + 20, rect.bottom - 60);
    return { x, y };
  };

  const snapAuthored = (value: number): number => Math.round(value / gridSize) * gridSize;

  const candidateFor = (
    position: [number, number],
    drag: DragState
  ): RoomDesignerPlacement | null => {
    const source = drag.existing
      ? placementsRef.current.find((placement) => placement.id === drag.id)
      : null;
    const asset = catalogById.get(drag.modelId);
    if (!asset) return null;
    const x = position[0] - drag.offsetX;
    const z = position[1] - drag.offsetZ;
    if (source) return { ...clonePlacement(source), p: [x, source.p[1], z] };
    // For placeableOnTop items, check if dropping over a surface (table,
    // counter) and stack at the surface height. If no surface is found,
    // the item cannot be placed — it must sit on top of something.
    let y = groundY;
    if (asset.placeableOnTop) {
      const candidateFootprint = {
        id: "candidate",
        x,
        z,
        width: asset.footprint[0],
        depth: asset.footprint[1],
        shape: "rectangle" as const,
        radius: 0,
      };
      const surface = placementsRef.current.find((placement) => {
        const surfaceAsset = catalogById.get(placement.modelId);
        if (!surfaceAsset?.surfaceHeight) return false;
        return footprintsIntersect(
          candidateFootprint,
          footprintGeometryFor(placement, surfaceAsset, measuredFootprintsRef.current),
          gridSize * 0.1
        );
      });
      if (!surface) return null;
      const surfaceAsset = catalogById.get(surface.modelId);
      y = groundY + (surfaceAsset?.surfaceHeight ?? 0);
    }
    return makePlacement(`${drag.modelId}-${Date.now().toString(36)}`, asset, x, z, y);
  };

  const validateCandidate = (candidate: RoomDesignerPlacement): boolean => {
    const asset = catalogById.get(candidate.modelId);
    const footprint = footprintGeometryFor(candidate, asset, measuredFootprintsRef.current);
    const footprintPadding = asset?.canOverlapFurniture ? 0 : gridSize * 0.1;
    const candidateCanCoverFurniture = asset?.canOverlapFurniture === true;
    const candidateIsOnTop = asset?.placeableOnTop === true && candidate.p[1] > groundY;
    // placeableOnTop items must sit on a surface — reject if on the floor.
    if (asset?.placeableOnTop && candidate.p[1] <= groundY) return false;
    const insideRegion = regions.some((region) => {
      // The authored region is already bounded by the foundation. Do not
      // remove a full grid cell here: that prevented props from reaching the
      // wall-adjacent squares. A small clearance is enough to keep a measured
      // footprint from visually touching the wall while still allowing the
      // closest legal placement.
      // Wall items are mounted on walls at the region boundary, so their
      // footprint naturally extends past the edge. Use a negative padding
      // (one grid cell) to allow this without letting items escape the
      // building entirely.
      if (asset?.placementSurface === "wall") {
        return footprintInsideRegion(footprint, region, -gridSize);
      }
      return footprintInsideRegion(footprint, region, footprintPadding);
    });
    if (!insideRegion) return false;
    if (doorwayRects.some((doorway) => footprintsIntersect(footprint, doorway, gridSize * 0.1)))
      return false;
    if (asset?.placementSurface === "wall") {
      if (!blockedRects.some((blocked) => footprintsIntersect(footprint, blocked, gridSize * 0.35)))
        return false;
    } else if (
      blockedRects.some((blocked) => footprintsIntersect(footprint, blocked, footprintPadding))
    ) {
      return false;
    }
    return placementsRef.current
      .filter((placement) => placement.id !== candidate.id)
      .every((placement) => {
        const existingAsset = catalogById.get(placement.modelId);
        const existingIsWallProp = existingAsset?.placementSurface === "wall";
        if (candidateCanCoverFurniture && !existingIsWallProp && !existingAsset?.blocksRugOverlap)
          return true;
        if (existingAsset?.allowItemsOnTop && !asset?.blocksRugOverlap) return true;
        // A placeableOnTop item sitting on a surface can overlap that surface.
        if (
          candidateIsOnTop &&
          existingAsset?.surfaceHeight &&
          candidate.p[1] >= groundY + existingAsset.surfaceHeight - 1
        )
          return true;
        // Floor items and wall items live at different heights — a counter
        // on the floor can sit under a wall-mounted cabinet without conflict.
        const candidateIsWallProp = asset?.placementSurface === "wall";
        if (candidateIsWallProp !== existingIsWallProp) return true;
        // No padding between items — allow them to line up flush (e.g.
        // kitchen counters side by side). The footprints are axis-aligned
        // rectangles, so touching edges produce no false overlap.
        return !footprintsIntersect(
          footprint,
          footprintGeometryFor(placement, existingAsset, measuredFootprintsRef.current),
          0
        );
      });
  };

  const updatePreview = (candidate: RoomDesignerPlacement | null, valid: boolean) => {
    const outline = outlineRef.current;
    const drag = dragRef.current;
    if (!outline || !drag || !candidate) {
      if (outline && !selectedId) outline.visible = false;
      return;
    }
    updateOutline(
      outline,
      candidate,
      catalogById.get(candidate.modelId),
      measuredFootprintsRef.current,
      sceneScale,
      groundY,
      valid
    );
    if (drag.existing) {
      const object = groupRef.current?.getObjectByName(`room-prop:${candidate.id}`);
      if (object) {
        const floorOffset =
          typeof object.userData.roomDesignerFloorOffset === "number"
            ? object.userData.roomDesignerFloorOffset
            : 0;
        object.position.set(
          candidate.p[0] * sceneScale,
          candidate.p[1] * sceneScale + floorOffset,
          candidate.p[2] * sceneScale
        );
      }
    }
  };

  const updateDragAt = (clientX: number, clientY: number) => {
    const drag = dragRef.current;
    const point = worldPointAt(clientX, clientY);
    if (!drag || !point) return;
    const authoredX = snapAuthored(point.x / sceneScale);
    const authoredZ = snapAuthored(point.z / sceneScale);
    const candidate = candidateFor([authoredX, authoredZ], drag);
    const valid = Boolean(candidate && validateCandidate(candidate));
    drag.moved = true;
    dragCandidateRef.current = candidate;
    dragValidRef.current = valid;
    if (gridRef.current) gridRef.current.visible = true;
    updatePreview(candidate, valid);
  };

  useEffect(() => {
    placementsRef.current = placements;
  }, [placements]);
  useEffect(() => {
    savedPlacementsRef.current = savedPlacements;
  }, [savedPlacements]);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);
  useEffect(() => {
    selectedModelIdRef.current = selectedModelId;
  }, [selectedModelId]);

  useEffect(() => {
    let cancelled = false;
    let frame = 0;
    const attach = async () => {
      const api = debugApiRef.current;
      if (!api) {
        frame = requestAnimationFrame(() => void attach());
        return;
      }
      const root = new THREE.Group();
      root.name = "room-designer";
      const backdrop = new THREE.Mesh(
        new THREE.PlaneGeometry(
          (mapBounds.width + designBackdropPadding * 2) * sceneScale,
          (mapBounds.depth + designBackdropPadding * 2) * sceneScale
        ),
        new THREE.MeshBasicMaterial({
          color: designBackdropColor,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
      );
      backdrop.name = "room-designer-backdrop";
      backdrop.rotation.x = -Math.PI / 2;
      backdrop.position.y = (groundY - 10) * sceneScale;
      backdrop.visible = false;
      const props = new THREE.Group();
      props.name = "room-designer-props";
      const grid = createFloorplanGrid(mapBounds, sceneScale, gridSize);
      grid.name = "room-designer-grid";
      grid.position.set(0, (groundY + 3) * sceneScale, 0);
      grid.visible = false;
      const outline = createOutline(sceneScale);
      root.add(backdrop, props, grid, outline);
      api.scene.add(root);
      groupRef.current = props;
      backdropRef.current = backdrop;
      gridRef.current = grid;
      outlineRef.current = outline;
      setApiReady(true);
      try {
        const document = await loadRoomDesignerDocument(manifest.id);
        if (cancelled) return;
        const loadedPlacements = placementsFromDocument(document, catalogById, groundY);
        placementsRef.current = loadedPlacements;
        savedPlacementsRef.current = loadedPlacements.map(clonePlacement);
        setPlacements(loadedPlacements);
        setSavedPlacements(loadedPlacements.map(clonePlacement));
        setStatus(
          loadedPlacements.length ? "Loaded saved room props." : "Drag a prop onto a room."
        );
      } catch {
        setStatus("No saved room layout yet. Drag a prop onto a room.");
      }
    };
    void attach();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      if (groupRef.current?.parent) groupRef.current.parent.remove(groupRef.current);
      if (backdropRef.current?.parent) backdropRef.current.parent.remove(backdropRef.current);
      if (gridRef.current?.parent) gridRef.current.parent.remove(gridRef.current);
      if (outlineRef.current?.parent) outlineRef.current.parent.remove(outlineRef.current);
      outlineRef.current?.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          (object.material as THREE.Material).dispose();
        }
      });
      groupRef.current = null;
      backdropRef.current = null;
      gridRef.current = null;
      outlineRef.current = null;
      setApiReady(false);
    };
  }, [
    catalogById,
    debugApiRef,
    designBackdropColor,
    designBackdropPadding,
    groundY,
    gridSize,
    manifest.id,
    mapBounds.depth,
    mapBounds.width,
    sceneScale,
    sceneVersion,
  ]);

  // Measure a single asset's footprint on demand (when it's being dragged
  // or placed). This avoids loading all 90+ GLBs on mount just to measure
  // footprints — the authored footprint from the config is used as a
  // fallback until the measured one is available.
  const ensureMeasured = useCallback(
    async (asset: RoomDesignerAsset) => {
      if (measuredFootprintsRef.current.has(asset.id)) return;
      const measured = await measureAssetFootprint(asset);
      if (measured) {
        measuredFootprintsRef.current.set(asset.id, measured);
        setMeasuredFootprintVersion((version) => version + 1);
      }
    },
    [sceneScale]
  );

  // Measure footprints for currently placed items so existing placements
  // show accurate outlines. This is typically a small number.
  useEffect(() => {
    if (!apiReady || !enabled) return;
    let cancelled = false;
    const modelIds = new Set(placements.map((p) => p.modelId));
    const toMeasure = catalog.filter(
      (asset) => modelIds.has(asset.id) && !measuredFootprintsRef.current.has(asset.id)
    );
    if (toMeasure.length === 0) return;
    void Promise.all(toMeasure.map((asset) => measureAssetFootprint(asset))).then((results) => {
      if (cancelled) return;
      results.forEach((measured, index) => {
        if (measured) measuredFootprintsRef.current.set(toMeasure[index].id, measured);
      });
      setMeasuredFootprintVersion((version) => version + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [apiReady, catalog, enabled, placements, sceneScale]);

  useEffect(() => {
    const api = debugApiRef.current;
    if (!apiReady || !api) return;
    api.setOrthographicHalfHeight(
      (enabled ? designOrthographicHalfHeight : normalOrthographicHalfHeight) * sceneScale
    );
    api.setOrthographicBoundsPadding((enabled ? designBackdropPadding : 0) * sceneScale);
    if (backdropRef.current) backdropRef.current.visible = enabled;
    if (!enabled && outlineRef.current) outlineRef.current.visible = false;
    return () => {
      api.setOrthographicHalfHeight(normalOrthographicHalfHeight * sceneScale);
    };
  }, [
    apiReady,
    debugApiRef,
    designOrthographicHalfHeight,
    enabled,
    normalOrthographicHalfHeight,
    sceneScale,
  ]);

  useEffect(() => {
    const api = debugApiRef.current;
    if (!apiReady || !api) return;
    if (!enabled) {
      api.resetOrthographicView();
      designerPanRef.current = [0, 0];
      designerZoomRef.current = 1;
      // Keep the player at the design-mode position (outside the house)
      // instead of restoring the pre-edit position, which may now overlap
      // a newly placed item. The player can navigate freely from here.
      previousPlayerPositionRef.current = null;
      return;
    }
    api.setOrthographicPan(
      designerPanRef.current[0] * sceneScale,
      designerPanRef.current[1] * sceneScale
    );
    api.setOrthographicZoomImmediate(designerZoomRef.current);
    if (playerPosition && !previousPlayerPositionRef.current) {
      const state = api.getState();
      const current = state.playerPosition;
      if (
        Array.isArray(current) &&
        current.length === 3 &&
        current.every((value) => typeof value === "number" && Number.isFinite(value))
      ) {
        previousPlayerPositionRef.current = [...current] as [number, number, number];
      }
      api.teleportTo(playerPosition.x * sceneScale, playerPosition.z * sceneScale);
    }
  }, [apiReady, debugApiRef, enabled, playerPosition?.x, playerPosition?.z, sceneScale]);

  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    let cancelled = false;
    const rebuild = async () => {
      group.clear();
      // Load one placed prop at a time and yield between models. Loading every
      // placement with Promise.all can monopolize the main thread and make
      // unrelated scene controls unresponsive while the designer is closed.
      for (const placement of placements) {
        if (cancelled) return;
        await yieldToBrowser();
        const asset = catalogById.get(placement.modelId);
        if (!asset) continue;
        try {
          const source = await modelFor(asset);
          if (cancelled) return;
          const object = source.clone(true);
          object.name = `room-prop:${placement.id}`;
          const floorY = placement.p[1] * sceneScale;
          object.position.set(placement.p[0] * sceneScale, floorY, placement.p[2] * sceneScale);
          object.quaternion.set(...placement.q);
          object.scale.set(...placement.s);
          object.updateMatrixWorld(true);
          // Use precise=true so Box3 traverses every vertex instead of
          // trusting cached geometry.boundingBox, which can miss vertices
          if (asset.placementSurface !== "wall") {
            const bounds = new THREE.Box3().setFromObject(object);
            // Floor items (including placeableOnTop): lift so the model's
            // bottom sits at floorY + floorLift. For placeableOnTop items,
            // floorY is already at groundY + surfaceHeight.
            const floorLift = (asset.floorLift ?? 0) * sceneScale;
            object.position.y += floorY + floorLift - (bounds.isEmpty() ? 0 : bounds.min.y);
          }
          object.userData.roomDesignerFloorOffset = object.position.y - floorY;
          object.userData.roomDesignerPlacementId = placement.id;
          object.userData.roomDesignerModelId = placement.modelId;
          group.add(object);
        } catch (error) {
          console.warn(`[HQ room designer] Could not load ${asset.id}.`, error);
        }
      }
    };
    let cancelScheduledRebuild: (() => void) | undefined;
    if (enabled) {
      void rebuild();
    } else if (typeof window.requestIdleCallback === "function") {
      const idleId = window.requestIdleCallback(() => void rebuild(), { timeout: 1500 });
      cancelScheduledRebuild = () => window.cancelIdleCallback(idleId);
    } else {
      const timeoutId = window.setTimeout(() => void rebuild(), 0);
      cancelScheduledRebuild = () => window.clearTimeout(timeoutId);
    }
    return () => {
      cancelled = true;
      cancelScheduledRebuild?.();
    };
  }, [catalogById, enabled, placements, sceneScale]);

  useEffect(() => {
    const outline = outlineRef.current;
    if (!outline || dragRef.current) return;
    if (!enabled || !selectedPlacement) {
      outline.visible = false;
      return;
    }
    updateOutline(
      outline,
      selectedPlacement,
      catalogById.get(selectedPlacement.modelId),
      measuredFootprintsRef.current,
      sceneScale,
      groundY,
      true
    );
  }, [
    catalogById,
    dragActive,
    enabled,
    groundY,
    measuredFootprintVersion,
    placements,
    sceneScale,
    selectedPlacement,
  ]);

  // Continuously update the tooltip anchor so it stays pinned under the
  // selected item. The camera is smoothing to its new position over several
  // frames, so a one-shot anchor computed on click would be stale.
  useEffect(() => {
    if (!enabled || !selectedPlacement) return;
    let raf = 0;
    const tick = () => {
      const api = debugApiRef.current;
      if (api) {
        const object = groupRef.current?.getObjectByName(`room-prop:${selectedPlacement.id}`);
        const anchor = object
          ? screenAnchorBelow(object)
          : screenAnchorBelowPlacement(
              selectedPlacement,
              catalogById.get(selectedPlacement.modelId)
            );
        if (anchor) setActionAnchor(anchor);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [catalogById, enabled, sceneScale, selectedPlacement]);

  useEffect(() => {
    if (!enabled || !apiReady) return;
    const canvas = debugApiRef.current?.renderer.domElement;
    if (!canvas) return;
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const hitObject = (clientX: number, clientY: number): THREE.Object3D | null => {
      const group = groupRef.current;
      const api = debugApiRef.current;
      if (!group || !api) return null;
      const rect = api.renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1
      );
      raycaster.setFromCamera(pointer, api.camera);
      let current: THREE.Object3D | null =
        raycaster.intersectObjects(group.children, true)[0]?.object ?? null;
      while (current && !current.name.startsWith("room-prop:")) current = current.parent;
      return current;
    };
    const clearHoverTimeout = () => {
      if (hoverClearTimeoutRef.current == null) return;
      window.clearTimeout(hoverClearTimeoutRef.current);
      hoverClearTimeoutRef.current = null;
    };
    const clearHover = () => {
      // Tooltip is now driven by selection, not hover. Nothing to clear.
    };
    const updateBackgroundPan = (event: PointerEvent) => {
      const background = backgroundPanRef.current;
      if (!background || background.pointerId !== event.pointerId) return false;
      const point = worldPointAt(event.clientX, event.clientY);
      if (!point) return true;
      const deltaX = (background.lastPoint.x - point.x) / sceneScale;
      const deltaZ = (background.lastPoint.z - point.z) / sceneScale;
      if (Math.abs(deltaX) + Math.abs(deltaZ) > 0.01) background.moved = true;
      designerPanRef.current[0] += deltaX;
      designerPanRef.current[1] += deltaZ;
      background.lastPoint.copy(point);
      debugApiRef.current?.setOrthographicPan(
        designerPanRef.current[0] * sceneScale,
        designerPanRef.current[1] * sceneScale
      );
      event.preventDefault();
      return true;
    };
    const releaseCanvasPointer = (pointerId: number) => {
      if (!canvas.hasPointerCapture(pointerId)) return;
      try {
        canvas.releasePointerCapture(pointerId);
      } catch {
        // The browser may release capture before the window-level cleanup.
      }
    };
    const restoreDraggedObject = (drag: DragState) => {
      if (!drag.existing || !drag.origin) return;
      const object = groupRef.current?.getObjectByName(`room-prop:${drag.origin.id}`);
      if (!object) return;
      const floorOffset =
        typeof object.userData.roomDesignerFloorOffset === "number"
          ? object.userData.roomDesignerFloorOffset
          : 0;
      object.position.set(
        drag.origin.p[0] * sceneScale,
        drag.origin.p[1] * sceneScale + floorOffset,
        drag.origin.p[2] * sceneScale
      );
    };
    const clearDragState = (cancelled = false) => {
      const drag = dragRef.current;
      if (drag) {
        if (cancelled || !dragCandidateRef.current || !dragValidRef.current || !drag.moved)
          restoreDraggedObject(drag);
        if (drag.pointerId != null) releaseCanvasPointer(drag.pointerId);
      }
      dragRef.current = null;
      dragCandidateRef.current = null;
      dragValidRef.current = false;
      setDragActive(false);
      if (gridRef.current) gridRef.current.visible = false;
      if (outlineRef.current && selectedIdRef.current == null) outlineRef.current.visible = false;
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      if (dragRef.current?.pointerId === event.pointerId && !dragRef.current.existing) {
        event.preventDefault();
        return;
      }
      const object = hitObject(event.clientX, event.clientY);
      if (!object) {
        clearHoverTimeout();
        clearHover();
        const point = worldPointAt(event.clientX, event.clientY);
        if (point) {
          backgroundPanRef.current = { lastPoint: point, moved: false, pointerId: event.pointerId };
          try {
            canvas.setPointerCapture(event.pointerId);
          } catch {
            // Pointer capture is an enhancement; window listeners still handle the drag.
          }
        }
        return;
      }
      clearHoverTimeout();
      const id = object.name.slice("room-prop:".length);
      const placement = placementsRef.current.find((candidate) => candidate.id === id);
      if (!placement) return;
      const point = worldPointAt(event.clientX, event.clientY);
      if (!point) return;
      dragRef.current = {
        id,
        modelId: placement.modelId,
        existing: true,
        pointerId: event.pointerId,
        offsetX: placement.p[0] - point.x / sceneScale,
        offsetZ: placement.p[2] - point.z / sceneScale,
        moved: false,
        origin: clonePlacement(placement),
      };
      dragCandidateRef.current = null;
      dragValidRef.current = false;
      setDragActive(true);
      selectPlacement(id);
      suppressNextCanvasClickRef.current = true;
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is an enhancement; window listeners still handle the drag.
      }
      event.preventDefault();
    };
    const onCanvasPointerMove = (_event: PointerEvent) => {
      // Tooltip positioning is handled by the rAF loop in selectPlacement.
      // Nothing to do here — hover no longer drives the tooltip.
    };
    const onWindowPointerMove = (event: PointerEvent) => {
      if (dragRef.current && dragRef.current.pointerId === event.pointerId) {
        updateDragAt(event.clientX, event.clientY);
        return;
      }
      updateBackgroundPan(event);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (backgroundPanRef.current?.pointerId === event.pointerId) {
        releaseCanvasPointer(event.pointerId);
        suppressNextCanvasClickRef.current = backgroundPanRef.current.moved;
        backgroundPanRef.current = null;
        return;
      }
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const candidate = dragCandidateRef.current;
      const valid = dragValidRef.current;
      if (candidate && valid && drag.moved) {
        const next = drag.existing
          ? placementsRef.current.map((placement) =>
              placement.id === candidate.id ? candidate : placement
            )
          : [...placementsRef.current, candidate];
        commitSnapshot({ placements: next }, drag.existing ? "Prop moved." : "Prop added.");
        selectPlacement(candidate.id);
        // A pointerup on the canvas is followed by a click event. The click
        // handler is for selecting a location after a catalog click, so it
        // must not process the same successful drag a second time.
        suppressNextCanvasClickRef.current = true;
        const object = groupRef.current?.getObjectByName(`room-prop:${candidate.id}`);
        setActionAnchor(
          object
            ? screenAnchorBelow(object)
            : (screenAnchorBelowPlacement(candidate, catalogById.get(candidate.modelId)) ?? {
                x: event.clientX,
                y: event.clientY,
              })
        );
      } else if (drag.existing && drag.origin) {
        restoreDraggedObject(drag);
      } else if (drag.moved) {
        setStatus("Drop blocked. Keep the prop inside a room and away from walls or other props.");
      }
      releaseCanvasPointer(event.pointerId);
      clearDragState();
    };
    const onPointerCancel = (event: PointerEvent) => {
      if (backgroundPanRef.current?.pointerId === event.pointerId) {
        releaseCanvasPointer(event.pointerId);
        backgroundPanRef.current = null;
      }
      if (dragRef.current?.pointerId === event.pointerId) clearDragState(true);
    };
    const onWindowBlur = () => {
      backgroundPanRef.current = null;
      clearDragState(true);
    };
    const onCanvasClick = (event: MouseEvent) => {
      if (suppressNextCanvasClickRef.current) {
        suppressNextCanvasClickRef.current = false;
        return;
      }
      const currentSelectedId = selectedIdRef.current;
      const currentSelectedModelId = selectedModelIdRef.current;
      if (dragRef.current?.existing || currentSelectedId) return;
      if (!currentSelectedModelId) return;
      if (event.target instanceof Element && event.target.closest('[aria-label="Room designer"]'))
        return;
      const point = worldPointAt(event.clientX, event.clientY);
      const asset = catalogById.get(currentSelectedModelId);
      if (!point || !asset) return;
      const candidate = makePlacement(
        `${currentSelectedModelId}-${Date.now().toString(36)}`,
        asset,
        snapAuthored(point.x / sceneScale),
        snapAuthored(point.z / sceneScale),
        groundY
      );
      if (!validateCandidate(candidate)) {
        setStatus("Drop blocked. Keep the prop inside a room and away from walls or other props.");
        return;
      }
      commitSnapshot({ placements: [...placementsRef.current, candidate] }, "Prop added.");
      selectPlacement(candidate.id);
      dragRef.current = null;
    };
    const onWheel = (event: WheelEvent) => {
      const nextZoom = THREE.MathUtils.clamp(
        designerZoomRef.current * Math.exp(event.deltaY * 0.001),
        0.85,
        1.8
      );
      designerZoomRef.current = nextZoom;
      debugApiRef.current?.setOrthographicZoomImmediate(nextZoom);
      event.preventDefault();
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onCanvasPointerMove);
    canvas.addEventListener("pointercancel", onPointerCancel);
    canvas.addEventListener("click", onCanvasClick);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("pointermove", onWindowPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onCanvasPointerMove);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("click", onCanvasClick);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("pointermove", onWindowPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("blur", onWindowBlur);
      clearHoverTimeout();
      backgroundPanRef.current = null;
      clearDragState(true);
    };
  }, [
    apiReady,
    catalogById,
    debugApiRef,
    doorwayRects,
    enabled,
    groundY,
    gridSize,
    regions,
    blockedRects,
    sceneScale,
  ]);

  const selectPlacement = (id: string) => {
    const placement = placementsRef.current.find((candidate) => candidate.id === id);
    if (!placement) return;
    selectedIdRef.current = id;
    setSelectedId(id);
    setSelectedModelId(placement.modelId);
    const object = groupRef.current?.getObjectByName(`room-prop:${id}`);
    setActionAnchor(
      object
        ? screenAnchorBelow(object)
        : screenAnchorBelowPlacement(placement, catalogById.get(placement.modelId))
    );
    // Pan and zoom the camera to center on the selected prop so it stays
    // in focus and the tooltip menu remains accessible without other items
    // stealing it. Zoom in enough that the camera bounds allow panning
    // to the prop (when zoomed out, the view covers the whole map and
    // the bounds clamp the target to center).
    const api = debugApiRef.current;
    if (api && enabled) {
      const focusZoom = 1.6;
      designerZoomRef.current = focusZoom;
      designerPanRef.current = [placement.p[0], placement.p[2]];
      api.setOrthographicZoomImmediate(focusZoom);
      api.setOrthographicPan(placement.p[0] * sceneScale, placement.p[2] * sceneScale);
    }
  };

  const rotatePlacement = (id: string | null) => {
    if (!id) return;
    const selected = placementsRef.current.find((placement) => placement.id === id);
    if (!selected) return;
    const next = clonePlacement(selected);
    next.q = quaternionForYaw(yawFromQuaternion(next.q) + Math.PI / 2);
    commitSnapshot(
      {
        placements: placementsRef.current.map((placement) =>
          placement.id === id ? next : placement
        ),
      },
      "Prop rotated."
    );
    selectPlacement(id);
  };

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      )
        return;
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && (key === "z" || event.code === "KeyZ")) {
        event.preventDefault();
        if (event.shiftKey) {
          const next = futureRef.current.pop();
          if (!next) return;
          historyRef.current.push(cloneSnapshot({ placements: placementsRef.current }));
          applySnapshot(next);
        } else {
          const previous = historyRef.current.pop();
          if (!previous) return;
          futureRef.current.push(cloneSnapshot({ placements: placementsRef.current }));
          applySnapshot(previous);
        }
        return;
      }
      if (key === "r" && selectedId) {
        event.preventDefault();
        rotatePlacement(selectedId);
        return;
      }
      if (selectedId && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault();
        const selected = placementsRef.current.find((placement) => placement.id === selectedId);
        if (!selected) return;
        const delta = gridSize;
        const next = clonePlacement(selected);
        // HQ's fixed orthographic camera renders authored +Z as screen-up
        // and +X as screen-left. Keep keyboard movement in screen directions.
        if (event.key === "ArrowUp") next.p[2] += delta;
        if (event.key === "ArrowDown") next.p[2] -= delta;
        if (event.key === "ArrowLeft") next.p[0] += delta;
        if (event.key === "ArrowRight") next.p[0] -= delta;
        if (!validateCandidate(next)) {
          setStatus(
            "Move blocked. Keep the prop inside a room and away from walls, doorways, and other props."
          );
          return;
        }
        commitSnapshot(
          {
            placements: placementsRef.current.map((placement) =>
              placement.id === selectedId ? next : placement
            ),
          },
          "Prop moved."
        );
        selectPlacement(selectedId);
        return;
      }
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (!selectedId) return;
      event.preventDefault();
      commitSnapshot(
        { placements: placementsRef.current.filter((placement) => placement.id !== selectedId) },
        "Prop removed."
      );
      selectedIdRef.current = null;
      setSelectedId(null);
      setSelectedModelId(null);
      setHoveredId((current) => (current === selectedId ? null : current));
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [enabled, selectedId]);

  const save = useCallback(async (): Promise<boolean> => {
    setStatus("Saving room layout…");
    try {
      const response = await fetch("/api/scene-editor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scene: manifest.id,
          roomDesigner: { placements: placementsByModel(placementsRef.current) },
        }),
      });
      if (!response.ok)
        throw new Error(
          ((await response.json()) as { error?: string }).error ??
            `Save failed (${response.status})`
        );
      const nextPlacements = placementsRef.current.map(clonePlacement);
      invalidateRoomDesignerDocument(manifest.id);
      onSaved?.();
      savedPlacementsRef.current = nextPlacements;
      setSavedPlacements(nextPlacements);
      setStatus("Saved.");
      return true;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save room layout.");
      return false;
    }
  }, [manifest.id, onSaved]);

  useEffect(() => {
    if (!saveRef) return;
    saveRef.current = save;
    return () => {
      if (saveRef.current === save) saveRef.current = null;
    };
  }, [save, saveRef]);

  const resetPlacement = (id: string | null) => {
    if (!id) return;
    const saved = savedPlacementsRef.current.find((placement) => placement.id === id);
    if (!saved) {
      commitSnapshot(
        { placements: placementsRef.current.filter((placement) => placement.id !== id) },
        "New prop reset."
      );
      setSelectedId((current) => (current === id ? null : current));
      setSelectedModelId((current) => {
        const placement = placementsRef.current.find((candidate) => candidate.id === id);
        return current === placement?.modelId ? null : current;
      });
      setHoveredId((current) => (current === id ? null : current));
      return;
    }
    selectPlacement(id);
    commitSnapshot(
      {
        placements: placementsRef.current.map((placement) =>
          placement.id === id ? clonePlacement(saved) : placement
        ),
      },
      "Prop reset."
    );
  };

  const resetAll = () => {
    commitSnapshot({ placements: savedPlacementsRef.current }, "All unsaved room changes reset.");
  };

  const discardUnsavedChanges = useCallback(() => {
    const nextPlacements = savedPlacementsRef.current.map(clonePlacement);
    placementsRef.current = nextPlacements;
    setPlacements(nextPlacements);
    dragRef.current = null;
    actionTargetIdRef.current = null;
    selectedIdRef.current = null;
    setSelectedId(null);
    setSelectedModelId(null);
    setHoveredId(null);
    setActionAnchor(null);
    setStatus("Unsaved room changes discarded.");
  }, []);

  useEffect(() => {
    if (enabled) return;
    if (JSON.stringify(placementsRef.current) === JSON.stringify(savedPlacementsRef.current))
      return;
    discardUnsavedChanges();
  }, [discardUnsavedChanges, enabled]);

  const removePlacement = (id: string) => {
    commitSnapshot(
      { placements: placementsRef.current.filter((placement) => placement.id !== id) },
      "Prop removed."
    );
    setSelectedId((current) => (current === id ? null : current));
    setSelectedModelId((current) => {
      const placement = placementsRef.current.find((candidate) => candidate.id === id);
      return current === placement?.modelId ? null : current;
    });
    setHoveredId((current) => (current === id ? null : current));
  };

  const onCatalogPointerDown = (
    asset: PropCatalogItem,
    event: ReactPointerEvent<HTMLButtonElement>
  ) => {
    const roomAsset = catalogById.get(asset.id);
    if (!roomAsset) return;
    selectedIdRef.current = null;
    setSelectedId(null);
    setSelectedModelId(asset.id);
    // Kick off footprint measurement for this asset so the outline is
    // accurate during drag. Falls back to authored footprint if the GLB
    // hasn't loaded yet.
    void ensureMeasured(roomAsset);
    dragRef.current = {
      modelId: asset.id,
      existing: false,
      pointerId: event.pointerId,
      offsetX: 0,
      offsetZ: 0,
      moved: false,
    };
    dragCandidateRef.current = null;
    dragValidRef.current = false;
    setDragActive(true);
    const canvas = debugApiRef.current?.renderer.domElement;
    try {
      canvas?.setPointerCapture(event.pointerId);
    } catch {
      // Window-level listeners remain the fallback when capture is unavailable.
    }
  };

  // The tooltip follows the selected placement only — not hover. It hides
  // when a drag is in progress and when nothing is selected.
  const actionId = dragActive ? null : selectedId;
  const actionPlacement = actionId
    ? placements.find((placement) => placement.id === actionId)
    : null;
  const actionAsset = actionPlacement ? catalogById.get(actionPlacement.modelId) : undefined;
  const actionCanReset = actionPlacement
    ? hasPlacementResetTarget(actionPlacement, savedPlacementsRef.current)
    : false;

  return enabled ? (
    <>
      {actionPlacement && actionAnchor ? (
        <div
          data-room-designer-tooltip
          className="pointer-events-auto fixed z-50 flex items-center gap-1 rounded-lg border border-border/70 bg-background/35 p-1.5 text-foreground shadow-xl backdrop-blur-md"
          style={{
            left: actionAnchor.x,
            top: `max(var(--workspace-topbar-offset, 0px), ${actionAnchor.y}px)`,
            transform: "translate(-50%, 6px)",
          }}
          aria-label={`Actions for ${actionAsset?.label ?? actionPlacement.modelId}`}
          onPointerDown={(event) => {
            event.stopPropagation();
            selectPlacement(actionPlacement.id);
          }}
          onClick={() => selectPlacement(actionPlacement.id)}
        >
          <span
            className="max-w-32 truncate px-2 text-xs font-medium"
            title={actionAsset?.label ?? actionPlacement.modelId}
          >
            {actionAsset?.label ?? actionPlacement.modelId}
          </span>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="text-foreground hover:bg-muted"
            aria-label="Rotate 90 degrees"
            title="Rotate 90 degrees"
            onClick={() => rotatePlacement(actionPlacement.id)}
          >
            <RotateCw className="size-4.5" aria-hidden="true" />
          </Button>
          {actionCanReset ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="text-amber-700 hover:bg-amber-100/60 dark:text-amber-200 dark:hover:bg-amber-300/15"
              aria-label="Reset"
              title="Reset"
              onClick={() => resetPlacement(actionPlacement.id)}
            >
              <Undo2 className="size-4.5" aria-hidden="true" />
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="text-destructive hover:bg-destructive/10"
            aria-label="Delete"
            title="Delete"
            onClick={() => removePlacement(actionPlacement.id)}
          >
            <Trash2 className="size-4.5" aria-hidden="true" />
          </Button>
        </div>
      ) : null}
      <aside
        className={`pointer-events-auto fixed right-3 z-40 flex w-[min(22rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-xl border border-border bg-background/80 text-foreground shadow-2xl backdrop-blur-md transition-opacity ${dragActive ? "pointer-events-none opacity-0" : "opacity-100"}`}
        style={{
          top: "calc(var(--workspace-topbar-offset, 0px) + 0.75rem)",
          maxHeight: "calc(100dvh - var(--workspace-topbar-offset, 0px) - 1.5rem)",
        }}
        aria-label="Room designer"
        aria-hidden={dragActive}
        data-room-designer-active="true"
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-3">
          <p className="text-sm font-semibold">Room designer</p>
          {onClose ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Close room designer"
              title="Close room designer"
              onClick={onClose}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          ) : null}
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-3 py-3">
          <section className="flex min-h-0 flex-1 flex-col">
            <div className="mb-2 flex shrink-0 items-center justify-between">
              <p className="text-xs font-semibold">Prop list</p>
              <span className="text-[10px] text-muted-foreground">drag to map</span>
            </div>
            <PropCatalog
              className="min-h-0 flex-1"
              items={catalog}
              selectedId={selectedModelId}
              onItemPointerDown={onCatalogPointerDown}
            />
          </section>
          <p className="sr-only" aria-live="polite">
            {status}
          </p>
        </div>
        {hasEdits ? (
          <div className="sticky bottom-0 grid shrink-0 grid-cols-2 gap-2 border-t border-border bg-background/85 p-3">
            <Button type="button" variant="secondary" onClick={resetAll}>
              <Undo2 className="mr-2 size-4" aria-hidden="true" />
              Reset all
            </Button>
            <Button type="button" variant="default" onClick={() => void save()}>
              <Save className="mr-2 size-4" aria-hidden="true" />
              Save all
            </Button>
          </div>
        ) : null}
      </aside>
    </>
  ) : null;
}
