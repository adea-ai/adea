import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

import {
  loadIthappyCharacter,
  loadIthappyCharacterAnimations,
  ithappyInteriorPropAssets,
} from "@agent-hq/ithappy";
import {
  ROOM_GALLERY_BOUNDS,
  ROOM_GALLERY_FOUNDATION_TOP_Y,
  ROOM_GALLERY_PLACEABLE_SLOTS,
  ROOM_GALLERY_RUNTIME_SCALE,
  ROOM_GALLERY_WALL_SEGMENTS,
  roomTemplates,
  type RoomLayoutDocument,
} from "@agent-hq/rooms";

const MAX_PIXEL_RATIO = 2;
const AUTHORING_SCALE = ROOM_GALLERY_RUNTIME_SCALE;
const PLAYER_RADIUS = 24;
const PLAYER_SPEED = 240;
const DEFAULT_ORTHOGRAPHIC_HALF_HEIGHT = 720 * AUTHORING_SCALE;
const DEFAULT_PERSPECTIVE_DISTANCE = 18;

export type HqSceneId = "hq-home" | "hq-work";
export type HqCameraMode = "perspective" | "orthographic";

export type HqSceneState = {
  status: "idle" | "loading" | "ready" | "error";
  sceneId: HqSceneId;
  cameraMode: HqCameraMode;
  characterId: string;
  roomCount: number;
  propCount: number;
  position: { x: number; y: number; z: number };
  message?: string;
};

export type HqSceneRuntimeOptions = {
  sceneId: HqSceneId;
  characterId: string;
  cameraMode: HqCameraMode;
  initialLayout?: RoomLayoutDocument;
  onStateChange?: (state: HqSceneState) => void;
};

export interface HqSceneRuntime {
  mount(container: HTMLElement): void;
  resize(width: number, height: number, pixelRatio?: number): void;
  render(deltaSeconds?: number): void;
  dispose(): void;
  setCameraMode(mode: HqCameraMode): void;
  setCharacter(id: string): Promise<void>;
  setRoomLayout(layout: RoomLayoutDocument): Promise<void>;
  getState(): HqSceneState;
}

type PropPlacement = {
  id?: string;
  modelId?: string;
  p?: [number, number, number];
  q?: [number, number, number, number];
  s?: [number, number, number];
};

type PropDocument = { placements?: Record<string, PropPlacement[]> };

function createLoader(): GLTFLoader {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

function disposeObject(root: THREE.Object3D): void {
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
      material.dispose();
    }
  });
  for (const texture of textures) texture.dispose();
}

function isFiniteVector(values: readonly number[] | undefined, length: number): values is number[] {
  return Boolean(values && values.length === length && values.every(Number.isFinite));
}

function wallAabb(segment: (typeof ROOM_GALLERY_WALL_SEGMENTS)[number]) {
  if (segment.orientation === "horizontal") {
    return {
      xMin: segment.x - segment.length / 2,
      xMax: segment.x + segment.length / 2,
      zMin:
        segment.wallPlacement === "center"
          ? segment.z - segment.thickness / 2
          : segment.z >= 0
            ? segment.z - segment.thickness
            : segment.z,
      zMax:
        segment.wallPlacement === "center"
          ? segment.z + segment.thickness / 2
          : segment.z >= 0
            ? segment.z
            : segment.z + segment.thickness,
    };
  }
  return {
    xMin:
      segment.wallPlacement === "center"
        ? segment.x - segment.thickness / 2
        : segment.x >= 0
          ? segment.x - segment.thickness
          : segment.x,
    xMax:
      segment.wallPlacement === "center"
        ? segment.x + segment.thickness / 2
        : segment.x >= 0
          ? segment.x
          : segment.x + segment.thickness,
    zMin: segment.z - segment.length / 2,
    zMax: segment.z + segment.length / 2,
  };
}

const ROOM_WALL_BOUNDS = ROOM_GALLERY_WALL_SEGMENTS.map(wallAabb);

function intersectsWall(x: number, z: number): boolean {
  return ROOM_WALL_BOUNDS.some((bounds) => {
    return (
      x + PLAYER_RADIUS > bounds.xMin &&
      x - PLAYER_RADIUS < bounds.xMax &&
      z + PLAYER_RADIUS > bounds.zMin &&
      z - PLAYER_RADIUS < bounds.zMax
    );
  });
}

function roomVisualUrl(roomId: string): string | undefined {
  return roomTemplates.find((room) => room.id === roomId)?.visualUrl;
}

export function createHqSceneRuntime(options: HqSceneRuntimeOptions): HqSceneRuntime {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(options.sceneId === "hq-home" ? 0x6d8c5d : 0x6d777d);
  const perspectiveCamera = new THREE.PerspectiveCamera(42, 1, 0.05, 200);
  const orthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 200);
  let cameraMode = options.cameraMode;
  let activeCamera: THREE.Camera =
    cameraMode === "perspective" ? perspectiveCamera : orthographicCamera;
  let renderer: THREE.WebGLRenderer | undefined;
  let container: HTMLElement | undefined;
  let canvas: HTMLCanvasElement | undefined;
  let animationFrame = 0;
  let lastFrameTime = 0;
  let disposed = false;
  let width = 1;
  let height = 1;
  let pixelRatio = 1;
  let orbitYaw = 0.62;
  let orbitPitch = 0.78;
  let orbitDistance = DEFAULT_PERSPECTIVE_DISTANCE;
  let orthographicHalfHeight = DEFAULT_ORTHOGRAPHIC_HALF_HEIGHT;
  let pointerDown:
    { startX: number; startY: number; lastX: number; lastY: number; button: number } | undefined;
  let moveTarget: { x: number; z: number } | undefined;
  let layout = options.initialLayout ?? { version: 1, scene: options.sceneId, placements: {} };
  let characterId = options.characterId;
  let status: HqSceneState["status"] = "idle";
  let statusMessage: string | undefined;
  const pressedKeys = new Set<string>();
  const loader = createLoader();
  const root = new THREE.Group();
  const roomRoot = new THREE.Group();
  const propRoot = new THREE.Group();
  const characterRoot = new THREE.Group();
  const target = new THREE.Vector3();
  const movement = new THREE.Vector3();
  const raycaster = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(
    new THREE.Vector3(0, 1, 0),
    -ROOM_GALLERY_FOUNDATION_TOP_Y * AUTHORING_SCALE,
  );
  const player = new THREE.Vector3(0, ROOM_GALLERY_FOUNDATION_TOP_Y, 0);
  let characterModel: THREE.Object3D | undefined;
  let mixer: THREE.AnimationMixer | undefined;
  let idleAction: THREE.AnimationAction | undefined;
  let walkAction: THREE.AnimationAction | undefined;
  let roomCount = 0;
  let propCount = 0;
  let loadVersion = 0;
  let characterLoadVersion = 0;
  let roomLoadVersion = 0;
  let lastStateEmitAt = 0;

  root.scale.setScalar(AUTHORING_SCALE);
  root.add(roomRoot, propRoot, characterRoot);
  scene.add(root);
  scene.add(new THREE.HemisphereLight(0xeaf0ff, 0x2f3b32, 1.8));
  const keyLight = new THREE.DirectionalLight(0xfff1d6, 2.2);
  keyLight.position.set(18, 28, -24);
  keyLight.castShadow = true;
  scene.add(keyLight);
  scene.add(new THREE.AmbientLight(0x8da0b7, 0.35));

  const getState = (): HqSceneState => ({
    status,
    sceneId: options.sceneId,
    cameraMode,
    characterId,
    roomCount,
    propCount,
    position: { x: player.x, y: player.y, z: player.z },
    message: statusMessage,
  });
  const emit = (force = false) => {
    const now = globalThis.performance?.now() ?? Date.now();
    if (!force && now - lastStateEmitAt < 100) return;
    lastStateEmitAt = now;
    options.onStateChange?.(getState());
  };
  const setStatus = (next: HqSceneState["status"], message?: string) => {
    status = next;
    statusMessage = message;
    emit(true);
  };

  function updateCamera(): void {
    target.set(player.x * AUTHORING_SCALE, player.y * AUTHORING_SCALE, player.z * AUTHORING_SCALE);
    if (cameraMode === "perspective") {
      activeCamera = perspectiveCamera;
      const horizontal = Math.cos(orbitPitch) * orbitDistance;
      perspectiveCamera.position.set(
        target.x + Math.sin(orbitYaw) * horizontal,
        target.y + Math.sin(orbitPitch) * orbitDistance,
        target.z + Math.cos(orbitYaw) * horizontal,
      );
      perspectiveCamera.lookAt(target);
    } else {
      activeCamera = orthographicCamera;
      const aspect = width / height;
      orthographicCamera.left = -orthographicHalfHeight * aspect;
      orthographicCamera.right = orthographicHalfHeight * aspect;
      orthographicCamera.top = orthographicHalfHeight;
      orthographicCamera.bottom = -orthographicHalfHeight;
      orthographicCamera.position.set(target.x, target.y + 22, target.z + 14);
      orthographicCamera.lookAt(target);
      orthographicCamera.updateProjectionMatrix();
    }
    perspectiveCamera.aspect = width / height;
    perspectiveCamera.updateProjectionMatrix();
  }

  function canOccupy(x: number, z: number): boolean {
    const bounds = ROOM_GALLERY_BOUNDS;
    if (
      x < bounds.xMin + PLAYER_RADIUS ||
      x > bounds.xMax - PLAYER_RADIUS ||
      z < bounds.zMin + PLAYER_RADIUS ||
      z > bounds.zMax - PLAYER_RADIUS
    )
      return false;
    return !intersectsWall(x, z);
  }

  function movePlayer(deltaSeconds: number): void {
    movement.set(0, 0, 0);
    if (pressedKeys.has("w") || pressedKeys.has("arrowup")) movement.z -= 1;
    if (pressedKeys.has("s") || pressedKeys.has("arrowdown")) movement.z += 1;
    if (pressedKeys.has("a") || pressedKeys.has("arrowleft")) movement.x -= 1;
    if (pressedKeys.has("d") || pressedKeys.has("arrowright")) movement.x += 1;
    if (moveTarget) {
      movement.set(moveTarget.x - player.x, 0, moveTarget.z - player.z);
      if (movement.lengthSq() < 16) moveTarget = undefined;
    }
    if (movement.lengthSq() === 0) {
      idleAction?.fadeIn(0.12).play();
      walkAction?.fadeOut(0.12);
      return;
    }
    movement.normalize().multiplyScalar(PLAYER_SPEED * deltaSeconds);
    const nextX = player.x + movement.x;
    const nextZ = player.z + movement.z;
    if (canOccupy(nextX, player.z)) player.x = nextX;
    if (canOccupy(player.x, nextZ)) player.z = nextZ;
    if (characterModel) characterModel.rotation.y = Math.atan2(movement.x, movement.z);
    idleAction?.fadeOut(0.12);
    walkAction?.reset().fadeIn(0.12).play();
    characterRoot.position.set(player.x, player.y, player.z);
    emit();
  }

  async function loadCharacter(nextCharacterId = characterId): Promise<void> {
    const currentVersion = ++characterLoadVersion;
    const loaded = await loadIthappyCharacter(loader, nextCharacterId);
    if (disposed || currentVersion !== characterLoadVersion) {
      disposeObject(loaded.scene);
      return;
    }
    const nextModel = loaded.scene;
    nextModel.scale.setScalar(100);
    nextModel.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.castShadow = true;
        object.receiveShadow = true;
      }
    });
    const nextMixer = new THREE.AnimationMixer(nextModel);
    const animations = await loadIthappyCharacterAnimations(loader, nextCharacterId, [
      "idle",
      "walk",
      "run",
    ]);
    if (disposed || currentVersion !== characterLoadVersion) {
      nextMixer.stopAllAction();
      disposeObject(nextModel);
      return;
    }
    const nextIdleAction = animations.clips.find((clip) => clip.name === "idle");
    const nextWalkClip = animations.clips.find(
      (clip) => clip.name === "walk" || clip.name === "run",
    );
    const nextIdle = nextIdleAction ? nextMixer.clipAction(nextIdleAction) : undefined;
    const nextWalk = nextWalkClip ? nextMixer.clipAction(nextWalkClip) : undefined;
    if (nextIdle) nextIdle.play();
    if (characterModel) {
      disposeObject(characterModel);
      characterRoot.remove(characterModel);
    }
    mixer?.stopAllAction();
    characterModel = nextModel;
    mixer = nextMixer;
    idleAction = nextIdle;
    walkAction = nextWalk;
    characterRoot.add(nextModel);
    characterRoot.position.set(player.x, player.y, player.z);
  }

  async function loadFloor(): Promise<void> {
    const gltf = await loader.loadAsync(`/assets/worlds/${options.sceneId}/floor.glb`);
    const floor = gltf.scene;
    if (disposed) {
      disposeObject(floor);
      return;
    }
    floor.name = `${options.sceneId}-foundation`;
    floor.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.receiveShadow = true;
        object.castShadow = true;
      }
    });
    root.add(floor);
  }

  async function loadRooms(nextLayout: RoomLayoutDocument): Promise<void> {
    const currentVersion = ++roomLoadVersion;
    const nextRoomRoot = new THREE.Group();
    let nextRoomCount = 0;
    const slotMap = new Map(ROOM_GALLERY_PLACEABLE_SLOTS.map((slot) => [slot.id, slot]));
    const roomLoads = Object.entries(nextLayout.placements).flatMap(([slotId, roomId]) => {
      const slot = slotMap.get(slotId);
      const assetUrl = typeof roomId === "string" ? roomVisualUrl(roomId) : undefined;
      return slot && assetUrl ? [{ slot, assetUrl, roomId }] : [];
    });
    try {
      await Promise.all(
        roomLoads.map(async ({ slot, assetUrl, roomId }) => {
          const gltf = await loader.loadAsync(assetUrl);
          const room = gltf.scene;
          room.name = `room:${slot.id}:${roomId}`;
          room.position.set(slot.x, ROOM_GALLERY_FOUNDATION_TOP_Y, slot.z);
          room.quaternion.fromArray(slot.quaternion);
          room.scale.fromArray(slot.scale);
          room.traverse((object) => {
            if (object instanceof THREE.Mesh) {
              object.castShadow = true;
              object.receiveShadow = true;
            }
          });
          nextRoomRoot.add(room);
          nextRoomCount += 1;
        }),
      );
    } catch (cause) {
      disposeObject(nextRoomRoot);
      throw cause;
    }
    if (disposed || currentVersion !== roomLoadVersion) {
      disposeObject(nextRoomRoot);
      return;
    }
    for (const child of [...roomRoot.children]) {
      disposeObject(child);
      roomRoot.remove(child);
    }
    for (const child of [...nextRoomRoot.children]) roomRoot.add(child);
    roomCount = nextRoomCount;
  }

  async function loadProps(): Promise<void> {
    const response = await fetch(`/assets/worlds/${options.sceneId}/props.json`, {
      cache: "no-store",
    });
    if (!response.ok) return;
    const document = (await response.json()) as PropDocument;
    const catalog = new Map(ithappyInteriorPropAssets.map((asset) => [asset.id, asset]));
    const modelCache = new Map<string, Promise<THREE.Object3D>>();
    const placements = Object.values(document.placements ?? {}).flat();
    await Promise.all(
      placements.map(async (placement) => {
        const modelId = placement.modelId;
        const asset = modelId ? catalog.get(modelId) : undefined;
        if (
          !modelId ||
          !asset ||
          !isFiniteVector(placement.p, 3) ||
          !isFiniteVector(placement.q, 4) ||
          !isFiniteVector(placement.s, 3)
        )
          return;
        let sourcePromise = modelCache.get(modelId);
        if (!sourcePromise) {
          sourcePromise = loader
            .loadAsync(asset.assetUrl)
            .then(({ scene: loadedScene }) => loadedScene);
          modelCache.set(modelId, sourcePromise);
        }
        const source = await sourcePromise;
        if (disposed) return;
        const model = source.clone(true);
        model.name = `prop:${placement.id ?? modelId}`;
        model.position.fromArray(placement.p);
        model.quaternion.fromArray(placement.q);
        model.scale.fromArray(placement.s);
        model.traverse((object) => {
          if (object instanceof THREE.Mesh) {
            object.castShadow = true;
            object.receiveShadow = true;
          }
        });
        if (disposed) {
          disposeObject(model);
          return;
        }
        propRoot.add(model);
      }),
    );
    propCount = placements.length;
  }

  async function loadScene(): Promise<void> {
    const currentVersion = ++loadVersion;
    setStatus("loading", "Loading HQ assets…");
    try {
      await loadFloor();
      if (disposed || currentVersion !== loadVersion) return;
      await Promise.all([loadRooms(layout), loadProps(), loadCharacter()]);
      if (disposed || currentVersion !== loadVersion) return;
      updateCamera();
      setStatus("ready");
    } catch (cause) {
      if (disposed || currentVersion !== loadVersion) return;
      setStatus("error", cause instanceof Error ? cause.message : "The scene could not be loaded.");
    }
  }

  function pointerToGround(event: PointerEvent): { x: number; z: number } | undefined {
    if (!canvas) return undefined;
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, activeCamera);
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(groundPlane, hit)) return undefined;
    return { x: hit.x / AUTHORING_SCALE, z: hit.z / AUTHORING_SCALE };
  }

  function onPointerDown(event: PointerEvent): void {
    pointerDown = {
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      button: event.button,
    };
    canvas?.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent): void {
    if (!pointerDown) return;
    const dx = event.clientX - pointerDown.lastX;
    const dy = event.clientY - pointerDown.lastY;
    if (cameraMode === "perspective") {
      orbitYaw -= dx * 0.008;
      orbitPitch = THREE.MathUtils.clamp(orbitPitch + dy * 0.006, 0.35, 1.35);
    } else if (pointerDown.button === 2 || event.buttons === 2) {
      const panScale = orthographicHalfHeight / Math.max(1, height) / AUTHORING_SCALE;
      player.x -= dx * panScale;
      player.z += dy * panScale;
    }
    pointerDown.lastX = event.clientX;
    pointerDown.lastY = event.clientY;
    updateCamera();
  }

  function onPointerUp(event: PointerEvent): void {
    if (
      pointerDown &&
      Math.hypot(event.clientX - pointerDown.startX, event.clientY - pointerDown.startY) < 8 &&
      event.button === 0
    ) {
      const point = pointerToGround(event);
      if (point && canOccupy(point.x, point.z)) moveTarget = point;
    }
    pointerDown = undefined;
    if (canvas?.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    if (cameraMode === "perspective")
      orbitDistance = THREE.MathUtils.clamp(orbitDistance + event.deltaY * 0.01, 6, 32);
    else
      orthographicHalfHeight = THREE.MathUtils.clamp(
        orthographicHalfHeight + event.deltaY * 0.7,
        4,
        30,
      );
    updateCamera();
  }

  function onContextMenu(event: MouseEvent): void {
    event.preventDefault();
  }

  function onKeyDown(event: KeyboardEvent): void {
    const key = event.key.toLowerCase();
    if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(key)) {
      pressedKeys.add(key);
      event.preventDefault();
    }
  }

  function onKeyUp(event: KeyboardEvent): void {
    pressedKeys.delete(event.key.toLowerCase());
  }

  return {
    mount(nextContainer) {
      if (renderer || disposed) return;
      container = nextContainer;
      canvas = document.createElement("canvas");
      canvas.setAttribute("aria-label", "Agent HQ spatial workspace");
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        canvas,
        powerPreference: "high-performance",
      });
      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("contextmenu", onContextMenu);
      canvas.addEventListener("wheel", onWheel, { passive: false });
      window.addEventListener("keydown", onKeyDown);
      window.addEventListener("keyup", onKeyUp);
      nextContainer.appendChild(canvas);
      this.resize(nextContainer.clientWidth || 1, nextContainer.clientHeight || 1);
      updateCamera();
      void loadScene();
      const frame = (time: number) => {
        if (disposed) return;
        const delta = lastFrameTime === 0 ? 0.016 : Math.min(0.05, (time - lastFrameTime) / 1000);
        lastFrameTime = time;
        this.render(delta);
        animationFrame = window.requestAnimationFrame(frame);
      };
      animationFrame = window.requestAnimationFrame(frame);
    },
    resize(nextWidth, nextHeight, nextPixelRatio = window.devicePixelRatio) {
      width = Math.max(1, Math.floor(nextWidth));
      height = Math.max(1, Math.floor(nextHeight));
      pixelRatio = Math.min(MAX_PIXEL_RATIO, Math.max(1, nextPixelRatio));
      renderer?.setPixelRatio(pixelRatio);
      renderer?.setSize(width, height, false);
      updateCamera();
    },
    render(deltaSeconds = 0.016) {
      if (!renderer) return;
      movePlayer(deltaSeconds);
      mixer?.update(deltaSeconds);
      characterRoot.position.set(player.x, player.y, player.z);
      updateCamera();
      renderer.render(scene, activeCamera);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      window.cancelAnimationFrame(animationFrame);
      canvas?.removeEventListener("pointerdown", onPointerDown);
      canvas?.removeEventListener("pointermove", onPointerMove);
      canvas?.removeEventListener("pointerup", onPointerUp);
      canvas?.removeEventListener("contextmenu", onContextMenu);
      canvas?.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      renderer?.dispose();
      if (canvas && container?.contains(canvas)) container.removeChild(canvas);
      disposeObject(root);
      scene.clear();
      renderer = undefined;
      container = undefined;
    },
    setCameraMode(nextMode) {
      if (cameraMode === nextMode) return;
      cameraMode = nextMode;
      updateCamera();
      emit(true);
    },
    async setCharacter(nextCharacterId) {
      if (characterId === nextCharacterId) return;
      characterId = nextCharacterId;
      await loadCharacter(nextCharacterId);
      emit(true);
    },
    async setRoomLayout(nextLayout) {
      if (layout === nextLayout) return;
      layout = nextLayout;
      await loadRooms(nextLayout);
      emit(true);
    },
    getState,
  };
}
