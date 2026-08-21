import * as THREE from "three";

export type SceneRuntimeOptions = {
  antialias?: boolean;
  clearColor?: THREE.ColorRepresentation;
};

export type SceneRuntime = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  resize: (width: number, height: number) => void;
  render: () => void;
  start: (update?: (deltaSeconds: number) => void) => void;
  stop: () => void;
  dispose: () => void;
};

/**
 * Framework-independent Three.js runtime for platform adapters.
 * React, Tauri, and Capacitor must treat this as an imperative boundary.
 */
export function createSceneRuntime(
  canvas: HTMLCanvasElement,
  options: SceneRuntimeOptions = {},
): SceneRuntime {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: options.antialias ?? true,
  });
  if (options.clearColor !== undefined) renderer.setClearColor(options.clearColor);

  let animationFrame = 0;
  let lastTime = 0;
  let update: ((deltaSeconds: number) => void) | undefined;

  const render = () => renderer.render(scene, camera);
  const tick = (time: number) => {
    const deltaSeconds = lastTime === 0 ? 0 : Math.min((time - lastTime) / 1000, 0.1);
    lastTime = time;
    update?.(deltaSeconds);
    render();
    animationFrame = requestAnimationFrame(tick);
  };

  return {
    scene,
    camera,
    renderer,
    resize(width, height) {
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    },
    render,
    start(nextUpdate) {
      update = nextUpdate;
      if (!animationFrame) animationFrame = requestAnimationFrame(tick);
    },
    stop() {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      lastTime = 0;
      update = undefined;
    },
    dispose() {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      renderer.dispose();
      scene.clear();
    },
  };
}
