import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
export {
  computeHoverboardTrailAnchors,
  computeJetpackNozzles,
  createHoverboardTrail,
  createJetpackFlames,
  type HoverboardTrail,
  type JetpackFlames,
} from "./flames.js";

export const vehicleIds = ["hoverboard", "jetpack"] as const;
export type VehicleId = (typeof vehicleIds)[number];

export function isVehicleId(value: string | undefined): value is VehicleId {
  return value !== undefined && vehicleIds.includes(value as VehicleId);
}

export type VehicleManifest = {
  id: VehicleId;
  label: string;
  assetUrl: string;
  textureUrl: string;
  browserScale: number;
  animationKeys: readonly string[];
};

export const vehicleManifests: Record<VehicleId, VehicleManifest> = {
  hoverboard: {
    id: "hoverboard",
    label: "Hoverboard",
    assetUrl: "",
    textureUrl: "",
    // The FBX is authored ~312 units long; 0.0012 brings the board to ~0.38
    // units at the reference (100%) character scale. SceneHost multiplies this
    // by the per-scene character scale.
    browserScale: 0.0012,
    animationKeys: [
      "hoverboardIdle",
      "hoverboardLaunch",
      "hoverboardTravel",
      "boardLeanLeft",
      "boardLeanRight",
      "hoverboardDismountIdle",
      "hoverboardDismountRun",
    ],
  },
  jetpack: {
    id: "jetpack",
    label: "Jetpack",
    assetUrl: "",
    textureUrl: "",
    // The FBX is authored 5.8 units tall at the source scale; 0.055 brings the
    // pack to ~0.275m at the reference (100%) character scale. SceneHost
    // multiplies this by the per-scene character scale.
    browserScale: 0.055,
    animationKeys: [
      "jetpackIdle1",
      "jetpackIdle2",
      "jetpackTakeOff",
      "jetpackGoUp",
      "jetpackGoDown",
      "jetpackLeanLeft",
      "jetpackLeanRight",
      "jetpackSkyFall",
      "jetpackLand",
      "jetpackLandHigh",
    ],
  },
};

export const cityArtVehicleAssets = [] as const;

export type CityArtVehicleId = (typeof cityArtVehicleAssets)[number]["id"];

export type CityArtVehicleManifest = (typeof cityArtVehicleAssets)[number];

export type LoadedCityArtVehicle = {
  id: CityArtVehicleId;
  scene: THREE.Object3D;
};

export const vehicleControls = {
  toggleHoverboard: ["KeyV"],
  toggleJetpack: ["KeyG"],
  leaveVehicle: ["KeyB"],
  jump: ["Space"],
  ascend: ["ShiftLeft", "ShiftRight"],
  descend: ["ControlLeft", "ControlRight"],
} as const;

export type VehicleControlAction = keyof typeof vehicleControls;

export type VehicleInputState = {
  readonly pressed: ReadonlySet<string>;
  isPressed: (action: VehicleControlAction) => boolean;
  consume: (action: VehicleControlAction) => boolean;
  attach: (target?: Window) => void;
  detach: (target?: Window) => void;
};

export function createVehicleInputState(): VehicleInputState {
  const pressed = new Set<string>();
  const justPressed = new Set<string>();
  const onKeyDown = (event: KeyboardEvent) => {
    if (!event.repeat) justPressed.add(event.code);
    pressed.add(event.code);
  };
  const onKeyUp = (event: KeyboardEvent) => {
    pressed.delete(event.code);
  };
  const onBlur = () => {
    pressed.clear();
    justPressed.clear();
  };
  return {
    pressed,
    isPressed(action) {
      return vehicleControls[action].some((code) => pressed.has(code));
    },
    consume(action) {
      const code = vehicleControls[action].find((candidate) => justPressed.has(candidate));
      if (!code) return false;
      justPressed.delete(code);
      return true;
    },
    attach(target = window) {
      target.addEventListener("keydown", onKeyDown);
      target.addEventListener("keyup", onKeyUp);
      target.addEventListener("blur", onBlur);
    },
    detach(target = window) {
      target.removeEventListener("keydown", onKeyDown);
      target.removeEventListener("keyup", onKeyUp);
      target.removeEventListener("blur", onBlur);
    },
  };
}

export type VehicleControllerFrame = {
  activeVehicle: VehicleId | null;
  horizontalSpeed: number;
  verticalVelocity: number;
  usesGravity: boolean;
  snapToGround: boolean;
  jumpRequested: boolean;
  justMounted: VehicleId | null;
  justDismounted: VehicleId | null;
};

export type VehicleControllerUpdate = {
  inputX: number;
  inputZ: number;
  inWater: boolean;
};

export type VehicleController = {
  readonly input: VehicleInputState;
  readonly activeVehicle: VehicleId | null;
  update: (state: VehicleControllerUpdate) => VehicleControllerFrame;
  dismount: () => VehicleId | null;
  dispose: (target?: Window) => void;
};

const HOVERBOARD_SPEED = 9;
const JETPACK_SPEED = 8;
export const JETPACK_LIFT_SPEED = 7;
// Mirrors Unity JetpackBehaviour._initializingLiftTime: mounting the jetpack
// sustains an upward launch for a short window before settling into hover.
// Tracked in 60 Hz frames so the window is stable across refresh rates.
const JETPACK_INIT_LIFT_FRAMES = 54;
const JETPACK_INIT_LIFT_FACTOR = 0.45;

/**
 * Shared vehicle state machine. It deliberately does not know about a scene,
 * renderer, or physics library so every scene can reuse the same input rules.
 * The host applies the returned movement policy to its own character body.
 */
export function createVehicleController(input = createVehicleInputState()): VehicleController {
  let activeVehicle: VehicleId | null = null;
  let jetpackLiftRemaining = 0;

  return {
    input,
    get activeVehicle() {
      return activeVehicle;
    },
    update({ inWater }) {
      const previousVehicle = activeVehicle;
      const wasRidingHoverboard = previousVehicle === "hoverboard";
      if (input.consume("toggleHoverboard")) {
        activeVehicle = activeVehicle === "hoverboard" ? null : "hoverboard";
      } else if (input.consume("toggleJetpack")) {
        activeVehicle = activeVehicle === "jetpack" ? null : "jetpack";
      }

      // A jump pressed before mounting must not become a delayed hoverboard
      // dismount on the next frame.
      if (!wasRidingHoverboard && activeVehicle === "hoverboard") input.consume("jump");

      if (activeVehicle && input.consume("leaveVehicle")) activeVehicle = null;

      let jumpRequested = false;
      if (wasRidingHoverboard && activeVehicle === "hoverboard" && input.consume("jump")) {
        activeVehicle = null;
        jumpRequested = true;
      }
      if (inWater) activeVehicle = null;

      const justMounted =
        previousVehicle !== activeVehicle && activeVehicle !== null ? activeVehicle : null;
      const justDismounted =
        previousVehicle !== activeVehicle && activeVehicle === null ? previousVehicle : null;
      const horizontalSpeed =
        activeVehicle === "hoverboard"
          ? HOVERBOARD_SPEED
          : activeVehicle === "jetpack"
            ? JETPACK_SPEED
            : 0;
      if (justMounted === "jetpack") jetpackLiftRemaining = JETPACK_INIT_LIFT_FRAMES;
      if (activeVehicle !== "jetpack") jetpackLiftRemaining = 0;
      const lift = Number(input.isPressed("ascend")) - Number(input.isPressed("descend"));
      const initLiftActive = jetpackLiftRemaining > 0;
      let verticalVelocity = 0;
      if (activeVehicle === "jetpack") {
        if (initLiftActive) {
          jetpackLiftRemaining -= 1;
          verticalVelocity = Math.max(
            JETPACK_LIFT_SPEED * JETPACK_INIT_LIFT_FACTOR,
            lift * JETPACK_LIFT_SPEED,
          );
        } else {
          verticalVelocity = lift * JETPACK_LIFT_SPEED;
        }
      }

      return {
        activeVehicle,
        horizontalSpeed,
        verticalVelocity,
        // The hoverboard rides terrain: it inherits gravity so the host can
        // keep the rider pinned to slopes instead of floating off crests.
        usesGravity: activeVehicle !== "jetpack",
        snapToGround: activeVehicle !== "jetpack",
        jumpRequested,
        justMounted,
        justDismounted,
      };
    },
    dismount() {
      const previousVehicle = activeVehicle;
      activeVehicle = null;
      return previousVehicle;
    },
    dispose(target) {
      input.detach(target);
      activeVehicle = null;
    },
  };
}

export type LoadedVehicle = {
  id: VehicleId;
  scene: THREE.Group;
  texture: THREE.Texture;
};

const FBX_TGA_WARNING_PREFIX = "FBXLoader: TGA loader not found, skipping";
const FBX_ORTHO_CAMERA_WARNING = "THREE.FBXLoader: Orthographic cameras not supported yet.";
const FBX_MULTI_LAYER_WARNING =
  "THREE.FBXLoader: Encountered an animation stack with multiple layers, this is currently not supported. Ignoring subsequent layers.";

async function loadVehicleFbxQuietly(loader: FBXLoader, url: string): Promise<THREE.Group> {
  const originalWarn = console.warn;
  console.warn = (...args) => {
    // The Unity vehicle FBX exports reference an authoring TGA map and editor
    // cameras. The TGA is intentionally unavailable (the browser texture is
    // applied afterwards) and the cameras are removed, so these are expected.
    if (
      typeof args[0] === "string" &&
      (args[0].startsWith(FBX_TGA_WARNING_PREFIX) ||
        args[0] === FBX_ORTHO_CAMERA_WARNING ||
        args[0] === FBX_MULTI_LAYER_WARNING)
    )
      return;
    originalWarn(...args);
  };
  try {
    return await loader.loadAsync(url);
  } finally {
    console.warn = originalWarn;
  }
}

/**
 * Load a Unity FBX vehicle, remove editor-only cameras/lights, apply its browser
 * scale, and replace the unavailable embedded TGA/Unity material map with the
 * package's browser texture.
 */
export async function loadVehicle(
  loader: FBXLoader,
  textureLoader: THREE.TextureLoader,
  id: VehicleId,
): Promise<LoadedVehicle> {
  const manifest = vehicleManifests[id];
  const scene = await loadVehicleFbxQuietly(loader, manifest.assetUrl);
  const editorObjects: THREE.Object3D[] = [];
  scene.traverse((object) => {
    if (
      /camera|light/i.test(object.name) ||
      object instanceof THREE.Camera ||
      object instanceof THREE.Light
    ) {
      editorObjects.push(object);
    }
  });
  editorObjects.forEach((object) => object.parent?.remove(object));

  const texture = await textureLoader.loadAsync(manifest.textureUrl);
  texture.colorSpace = THREE.SRGBColorSpace;
  // These textures use the Unity-extracted atlas convention. Keep the
  // browser texture orientation aligned with the FBX UVs.
  texture.flipY = true;
  texture.needsUpdate = true;
  scene.scale.setScalar(manifest.browserScale);
  const staleTextures = new Set<THREE.Texture>();
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = true;
    object.receiveShadow = true;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => {
      const texturedMaterial = material as THREE.Material & { map?: THREE.Texture };
      if (texturedMaterial.map && texturedMaterial.map !== texture)
        staleTextures.add(texturedMaterial.map);
      texturedMaterial.map = texture;
      material.side = THREE.DoubleSide;
      material.alphaTest = Math.max(material.alphaTest, 0.1);
      (material as THREE.Material & { color?: THREE.Color }).color?.set(0xffffff);
      material.needsUpdate = true;
    });
    if (Array.isArray(object.material)) {
      // three.js only renders material arrays through geometry groups, and the
      // exported FBX meshes have no groups, so array materials draw nothing.
      // The Unity FBX duplicates its material per slot; collapse to the first.
      object.material = materials[0];
    }
  });
  staleTextures.forEach((staleTexture) => staleTexture.dispose());
  const bounds = new THREE.Box3().setFromObject(scene);
  console.info(
    `[Agent HQ] ${id} vehicle loaded bounds=${bounds.min.toArray().join(",")}..${bounds.max.toArray().join(",")}`,
  );
  return { id, scene, texture };
}

export function disposeVehicle(vehicle: LoadedVehicle): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  vehicle.scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
    objectMaterials.forEach((material) => materials.add(material));
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  vehicle.texture.dispose();
}

/** Load one standalone city vehicle without loading the other vehicle assets. */
export async function loadCityArtVehicle(
  _loader: GLTFLoader,
  id: CityArtVehicleId,
): Promise<LoadedCityArtVehicle> {
  throw new Error(`No optional city vehicle is registered for ${id}`);
}
