import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

export interface FlyerConfig {
  trackUrl: string;
  rootNames: string[];
  /** Fallback model used when the scene extraction removed named flyer roots. */
  modelUrl?: string;
  modelCount?: number;
  modelScale?: number;
  modelYawOffset?: number;
  heightOffset?: number;
  speedRange?: [number, number];
  blendSeconds?: number;
  yawOffset?: number;
  /** Optional second loop with an extra cloned helicopter (e.g. over the map centre). */
  centerTrackUrl?: string;
  centerSpeedRange?: [number, number];
  centerModelUrl?: string;
  centerModelScale?: number;
  centerModelYawOffset?: number;
  ktx2Loader?: KTX2Loader;
}

interface Flyer {
  root: THREE.Object3D;
  s: number;
  speed: number;
  spawn: THREE.Vector3;
  blendT: number;
}

export interface Flyers {
  update: (dt: number) => void;
  dispose: () => void;
}

/** Locate the Catmull-Rom segment for a wrapped track distance in O(log n). */
export function findTrackSegment(
  cumulative: readonly number[],
  pointCount: number,
  wrapped: number,
): number {
  let low = 1;
  let high = Math.max(1, pointCount - 2);
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (cumulative[middle + 1] < wrapped) low = middle + 1;
    else high = middle;
  }
  return low;
}

function catmullRom(
  p0: THREE.Vector3,
  p1: THREE.Vector3,
  p2: THREE.Vector3,
  p3: THREE.Vector3,
  t: number,
  out: THREE.Vector3,
) {
  const t2 = t * t;
  const t3 = t2 * t;
  out.set(
    0.5 *
      (2 * p1.x +
        (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    0.5 *
      (2 * p1.y +
        (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
    0.5 *
      (2 * p1.z +
        (-p0.z + p2.z) * t +
        (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 +
        (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
  );
}

export function createFlyers(scene: THREE.Scene, config: FlyerConfig): Flyers {
  const speedRange = config.speedRange ?? [18, 26];
  const blendSeconds = config.blendSeconds ?? 6;
  const yawOffset = config.yawOffset ?? 0;

  const strip = (value: string) => value.replace(/[\s.()|_]/g, "").toLowerCase();
  const findRoots = () => {
    const byName = new Map<string, THREE.Object3D>();
    const byStrippedName = new Map<string, THREE.Object3D>();
    // Build both indexes in one traversal. Calling getObjectByName for every
    // alias walked the complete scene several times while the flight track
    // was still downloading.
    scene.traverse((object) => {
      if (!object.name) return;
      if (!byName.has(object.name)) byName.set(object.name, object);
      const strippedName = strip(object.name);
      if (!byStrippedName.has(strippedName)) byStrippedName.set(strippedName, object);
    });
    return config.rootNames.flatMap((name) => {
      const match =
        byName.get(name) ?? byName.get(name.replace(/ /g, "_")) ?? byStrippedName.get(strip(name));
      return match ? [match] : [];
    });
  };
  let roots = findRoots();
  const ownedRoots: THREE.Object3D[] = [];
  let rootSearchDelay = 0;

  const points: THREE.Vector3[] = [];
  let totalLength = 1;
  const cumulative: number[] = [];
  const flyers: Flyer[] = [];
  let disposed = false;
  const centerPoints: THREE.Vector3[] = [];
  let centerTotalLength = 1;
  const centerCumulative: number[] = [];
  let centerFlyer: Flyer | null = null;
  let centerModelScene: THREE.Object3D | null = null;
  const centerSpeedRange = config.centerSpeedRange ?? [8, 12];

  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const target = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const targetQuat = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const forward = new THREE.Vector3();
  const zAxis = new THREE.Vector3();
  const basisMatrix = new THREE.Matrix4();

  const sampleAt = (
    s: number,
    pts: THREE.Vector3[],
    cum: number[],
    total: number,
    pos: THREE.Vector3,
  ) => {
    const wrapped = ((s % total) + total) % total;
    const seg = findTrackSegment(cum, pts.length, wrapped);
    const segLen = cum[seg + 1] - cum[seg];
    const t = segLen > 1e-6 ? Math.min(1, Math.max(0, (wrapped - cum[seg]) / segLen)) : 0;
    const n = pts.length;
    const i0 = (seg - 1 + n) % n;
    const i1 = seg % n;
    const i2 = (seg + 1) % n;
    const i3 = (seg + 2) % n;
    catmullRom(pts[i0], pts[i1], pts[i2], pts[i3], t, pos);
    catmullRom(pts[i0], pts[i1], pts[i2], pts[i3], Math.min(1, t + 0.01), tmp2);
    tangent.copy(tmp2).sub(pos).normalize();
  };

  const loadModel = async (url: string) => {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    if (config.ktx2Loader) loader.setKTX2Loader(config.ktx2Loader);
    return (await loader.loadAsync(url)).scene;
  };

  const createModelRoot = (
    source: THREE.Object3D,
    name: string,
    scale: number,
    yawOffset: number,
  ) => {
    const root = new THREE.Group();
    root.name = name;
    const modelRoot = source.clone(true);
    modelRoot.scale.setScalar(scale);
    modelRoot.rotation.y = yawOffset;
    root.add(modelRoot);
    return root;
  };

  const loadTrack = async () => {
    if (disposed) return;
    let json: unknown;
    try {
      const response = await fetch(config.trackUrl);
      json = await response.json();
    } catch (cause) {
      console.warn("[Agent HQ] flight track unavailable", cause);
      return;
    }
    if (disposed) return;
    if (!Array.isArray(json)) return;
    points.length = 0;
    cumulative.length = 0;
    for (const entry of json) {
      if (Array.isArray(entry) && entry.length >= 3) {
        points.push(new THREE.Vector3(Number(entry[0]), Number(entry[1]), Number(entry[2])));
      }
    }
    if (points.length < 4) return;
    totalLength = 0;
    cumulative.push(0);
    for (let i = 1; i < points.length; i++) {
      totalLength += Math.hypot(
        points[i].x - points[i - 1].x,
        points[i].y - points[i - 1].y,
        points[i].z - points[i - 1].z,
      );
      cumulative.push(totalLength);
    }
    const n = points.length;
    const gap = Math.hypot(
      points[0].x - points[n - 1].x,
      points[0].y - points[n - 1].y,
      points[0].z - points[n - 1].z,
    );
    totalLength += gap;
    cumulative.push(totalLength);

    spawnFlyers();
  };
  const spawnFlyers = () => {
    if (points.length < 4 || flyers.length > 0) return;
    roots.forEach((root, index) => {
      const speed = speedRange[0] + Math.random() * (speedRange[1] - speedRange[0]);
      const s = (index / Math.max(1, roots.length)) * totalLength;
      const spawn = new THREE.Vector3();
      sampleAt(s, points, cumulative, totalLength, spawn);
      spawn.y += config.heightOffset ?? 0;
      root.position.copy(spawn);
      flyers.push({ root, s, speed, spawn, blendT: 0 });
    });
  };
  void loadTrack();

  const loadModelFallback = async () => {
    if (!config.modelUrl || roots.length > 0 || disposed) return;
    try {
      const modelScene = await loadModel(config.modelUrl);
      if (disposed || roots.length > 0) return;
      roots = Array.from({ length: Math.max(1, config.modelCount ?? 2) }, (_, index) => {
        const root = createModelRoot(
          modelScene,
          `flyer-${index}`,
          config.modelScale ?? 1,
          config.modelYawOffset ?? 0,
        );
        scene.add(root);
        ownedRoots.push(root);
        return root;
      });
      spawnFlyers();
    } catch (cause) {
      console.warn("[Agent HQ] flyer model unavailable", cause);
    }
  };
  void loadModelFallback();

  const driveFlyer = (
    flyer: Flyer,
    pts: THREE.Vector3[],
    cum: number[],
    total: number,
    step: number,
    blendSec: number,
    heightOffset = 0,
  ) => {
    flyer.blendT += step / blendSec;
    const k = Math.min(1, flyer.blendT);
    const ease = k * k * (3 - 2 * k);
    flyer.s = (flyer.s + flyer.speed * step) % total;
    sampleAt(flyer.s, pts, cum, total, tmp);
    target.copy(tmp);
    target.y += heightOffset;
    target.lerpVectors(flyer.spawn, target, ease);
    flyer.root.position.copy(target);
    // face the travel direction (the helicopter model's forward is +X)
    const targetYaw = Math.atan2(tangent.x, tangent.z) + yawOffset;
    forward.set(Math.sin(targetYaw), 0, Math.cos(targetYaw));
    zAxis.crossVectors(forward, up).normalize();
    basisMatrix.makeBasis(forward, up, zAxis);
    targetQuat.setFromRotationMatrix(basisMatrix);
    flyer.root.quaternion.slerp(targetQuat, Math.min(1, step * 12));
  };

  // load the optional center loop and spawn a cloned helicopter on it
  const loadCenterTrack = async () => {
    if (!config.centerTrackUrl || disposed) return;
    let json: unknown;
    try {
      const response = await fetch(config.centerTrackUrl);
      json = await response.json();
    } catch (cause) {
      console.warn("[Agent HQ] center flight track unavailable", cause);
      return;
    }
    if (disposed || !Array.isArray(json)) return;
    centerPoints.length = 0;
    centerCumulative.length = 0;
    for (const entry of json) {
      if (Array.isArray(entry) && entry.length >= 3) {
        centerPoints.push(new THREE.Vector3(Number(entry[0]), Number(entry[1]), Number(entry[2])));
      }
    }
    if (centerPoints.length < 4) return;
    if (config.centerModelUrl) {
      try {
        centerModelScene = await loadModel(config.centerModelUrl);
      } catch (cause) {
        console.warn("[Agent HQ] center flyer model unavailable", cause);
      }
    }
    centerTotalLength = 0;
    centerCumulative.push(0);
    for (let i = 1; i < centerPoints.length; i++) {
      centerTotalLength += Math.hypot(
        centerPoints[i].x - centerPoints[i - 1].x,
        centerPoints[i].y - centerPoints[i - 1].y,
        centerPoints[i].z - centerPoints[i - 1].z,
      );
      centerCumulative.push(centerTotalLength);
    }
    const speed = centerSpeedRange[0] + Math.random() * (centerSpeedRange[1] - centerSpeedRange[0]);
    const spawn = new THREE.Vector3(centerPoints[0].x, centerPoints[0].y, centerPoints[0].z);
    centerFlyer = { root: null as unknown as THREE.Object3D, s: 0, speed, spawn, blendT: 0 };
  };
  void loadCenterTrack();

  const update = (dt: number) => {
    const step = Math.max(0, Math.min(dt, 0.05));
    if (flyers.length === 0) {
      // Retry missing roots at a low cadence while asynchronously-added scene
      // layers settle. Once roots exist, do not traverse the scene again while
      // merely waiting for the track request to finish.
      rootSearchDelay -= step;
      if (roots.length === 0 && rootSearchDelay <= 0) {
        roots = findRoots();
        rootSearchDelay = 0.5;
      }
      spawnFlyers();
    }
    for (const flyer of flyers) {
      driveFlyer(
        flyer,
        points,
        cumulative,
        totalLength,
        step,
        blendSeconds,
        config.heightOffset ?? 0,
      );
    }
    // the center flyer needs a cloned helicopter model once the roots exist
    if (
      centerFlyer &&
      centerFlyer.root === (null as unknown as THREE.Object3D) &&
      roots.length > 0
    ) {
      const clone = centerModelScene
        ? createModelRoot(
            centerModelScene,
            "flyer-center",
            config.centerModelScale ?? config.modelScale ?? 1,
            config.centerModelYawOffset ?? config.modelYawOffset ?? 0,
          )
        : roots[0].clone(true);
      clone.name = "flyer-center";
      clone.position.copy(centerFlyer.spawn);
      scene.add(clone);
      centerFlyer = { ...centerFlyer, root: clone };
    }
    if (centerFlyer && centerFlyer.root) {
      driveFlyer(
        centerFlyer,
        centerPoints,
        centerCumulative,
        centerTotalLength,
        step,
        blendSeconds,
      );
    }
  };

  return {
    update,
    dispose: () => {
      disposed = true;
      flyers.length = 0;
      for (const root of ownedRoots) scene.remove(root);
      ownedRoots.length = 0;
      if (centerFlyer && centerFlyer.root) {
        scene.remove(centerFlyer.root);
      }
      centerFlyer = null;
    },
  };
}
