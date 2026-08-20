import {
  Color,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
  type Camera,
  type WebGLRendererParameters,
} from "three";

const MAX_PIXEL_RATIO = 2;

export interface SceneRenderer {
  readonly domElement: HTMLCanvasElement;
  dispose(): void;
  render(scene: Scene, camera: Camera): void;
  setPixelRatio(value: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
}

export interface SceneControllerState {
  readonly mounted: boolean;
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
}

export interface SceneControllerOptions {
  background?: number | string;
  canvasFactory?: () => HTMLCanvasElement;
  rendererFactory?: (canvas: HTMLCanvasElement) => SceneRenderer;
}

export interface SceneController {
  mount(container: HTMLElement): void;
  resize(width: number, height: number, pixelRatio?: number): void;
  render(): void;
  dispose(): void;
  getState(): SceneControllerState;
}

function createDefaultRenderer(canvas: HTMLCanvasElement): SceneRenderer {
  const options: WebGLRendererParameters = {
    antialias: true,
    canvas,
    powerPreference: "high-performance",
  };

  return new WebGLRenderer(options);
}

export function createSceneController(options: SceneControllerOptions = {}): SceneController {
  const scene = new Scene();
  scene.background = new Color(options.background ?? 0x0b0f14);

  const camera = new PerspectiveCamera(45, 1, 0.1, 1000);
  camera.position.set(0, 1.8, 4.5);

  let renderer: SceneRenderer | undefined;
  let container: HTMLElement | undefined;
  let state: SceneControllerState = {
    mounted: false,
    width: 0,
    height: 0,
    pixelRatio: 1,
  };

  const createCanvas =
    options.canvasFactory ??
    (() => {
      if (typeof document === "undefined") {
        throw new Error("SceneController.mount must run in a browser environment.");
      }

      return document.createElement("canvas");
    });
  const createRenderer = options.rendererFactory ?? createDefaultRenderer;

  return {
    mount(nextContainer) {
      if (renderer) return;

      const canvas = createCanvas();
      renderer = createRenderer(canvas);
      container = nextContainer;
      container.appendChild(renderer.domElement);
      state = { ...state, mounted: true };
      this.resize(nextContainer.clientWidth || 1, nextContainer.clientHeight || 1);
    },

    resize(width, height, pixelRatio = globalThis.window?.devicePixelRatio ?? 1) {
      const safeWidth = Math.max(1, Math.floor(width));
      const safeHeight = Math.max(1, Math.floor(height));
      const safePixelRatio = Math.min(MAX_PIXEL_RATIO, Math.max(1, pixelRatio));

      camera.aspect = safeWidth / safeHeight;
      camera.updateProjectionMatrix();
      renderer?.setPixelRatio(safePixelRatio);
      renderer?.setSize(safeWidth, safeHeight, false);
      state = {
        mounted: state.mounted,
        width: safeWidth,
        height: safeHeight,
        pixelRatio: safePixelRatio,
      };
    },

    render() {
      if (renderer) renderer.render(scene, camera);
    },

    dispose() {
      if (!renderer) return;

      renderer.dispose();
      if (container?.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      renderer = undefined;
      container = undefined;
      scene.clear();
      state = { ...state, mounted: false };
    },

    getState() {
      return { ...state };
    },
  };
}
