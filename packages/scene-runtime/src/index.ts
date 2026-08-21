import * as THREE from "three";
import { CameraController } from "./camera-controller";

export type ThreeRuntime = {
  scene: THREE.Scene;
  camera: THREE.Camera;
  cameraController: CameraController;
  renderer: THREE.WebGLRenderer;
  dispose: () => void;
};

export function createThreeRuntime(canvas: HTMLCanvasElement): ThreeRuntime {
  const scene = new THREE.Scene();
  const cameraController = new CameraController({ canvas, enableInput: false });
  const camera = cameraController.camera;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });

  const resize = () => {
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    cameraController.resize(width, height);
    renderer.setSize(width, height, false);
  };

  resize();
  window.addEventListener("resize", resize);

  return {
    scene,
    camera,
    cameraController,
    renderer,
    dispose: () => {
      window.removeEventListener("resize", resize);
      cameraController.dispose();
      renderer.dispose();
    },
  };
}

export {
  SceneHost,
  type SceneDebugApi,
  type SceneDebugHit,
  type SceneEnvironmentConfig,
  type SceneHostProps,
  type SceneHostStart,
  type SceneVisualSetup,
  type SceneVisualUpdate,
  type CharacterScale,
  type CollisionExclusionArea,
  type PlayerVisibilityGroup,
  type SceneMaterialOverride,
  type SceneSpotlightConfig,
  type SceneWaterVolume,
  type StaticColliderConfig,
} from "./SceneHost";
export {
  CameraController,
  type CameraBounds,
  type CameraControllerOptions,
  type CameraViewMode,
} from "./camera-controller";
export type { TrafficConfig } from "./traffic";
export type { FlyerConfig } from "./flyers";
export type { ScenePerformanceReport, ScenePerformanceTelemetry } from "./performance";
export type {
  ParticleConfigFactory,
  ParticleManager,
  ParticleManagerConfig,
  ParticleFieldConfig,
  ParticleEmitter,
} from "@agent-hq/particles";
