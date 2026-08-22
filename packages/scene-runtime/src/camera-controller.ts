import * as THREE from "three";

export type CameraViewMode = "perspective" | "orthographic";

export type CameraBounds = {
  xMin: number;
  xMax: number;
  zMin: number;
  zMax: number;
};

export type CameraControllerOptions = {
  canvas: HTMLCanvasElement;
  initialViewMode?: CameraViewMode;
  initialYaw?: number;
  initialPerspectivePitch?: number;
  characterScale?: number;
  enableInput?: boolean;
  cameraBounds?: CameraBounds;
  /** Scene-specific top-down framing; defaults preserve existing World views. */
  orthographicHalfHeight?: number;
  orthographicPitch?: number;
  /** Initial authored-world pan applied only to the orthographic camera target. */
  orthographicPan?: { x: number; z: number };
};

type CameraViewState = {
  yaw: number;
  pitch: number;
};

const CAMERA_DISTANCE = 1.7;
const CAMERA_TARGET_HEIGHT = 0.5;
const CAMERA_ROTATE_SPEED = 2.6;
const CAMERA_PITCH_SPEED = 1.4;
const CAMERA_MOUSE_SENSITIVITY = 0.003;
const PERSPECTIVE_FOV = 60;
const CAMERA_NEAR = 0.05;
const CAMERA_FAR = 2000;
const ORTHOGRAPHIC_DISTANCE = 16;
const CAMERA_OCCLUSION_PADDING = 0.15;
const CAMERA_MIN_DISTANCE = 0.08;
// Preserve the World orthographic framing default; large HQ maps opt into
// their own half-height through CameraControllerOptions.
const DEFAULT_ORTHOGRAPHIC_HALF_HEIGHT = 12;
const DEFAULT_ORTHOGRAPHIC_PITCH = -0.9;
const CAMERA_SMOOTHING = 14;
const CAMERA_TRANSITION_SMOOTHING = 8;
const PERSPECTIVE_MIN_ZOOM = 0.7;
const PERSPECTIVE_MAX_ZOOM = 1.6;
const CAMERA_KEY_CODES = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

export function getOrthographicGroundHalfExtents({
  halfHeight,
  aspect,
  zoom,
  viewDirectionY,
}: {
  halfHeight: number;
  aspect: number;
  zoom: number;
  viewDirectionY: number;
}): { halfWidth: number; halfDepth: number } {
  const safeZoom = Math.max(zoom, 0.001);
  return {
    halfWidth: (halfHeight * aspect) / safeZoom,
    halfDepth: halfHeight / Math.max(safeZoom * Math.abs(viewDirectionY), 0.2),
  };
}

/** Return a perspective follow distance that keeps an obstruction behind the camera. */
export function getPerspectiveCameraDistance({
  baseDistance,
  obstructionDistance,
  zoom = 1,
  maxDistance = Infinity,
}: {
  baseDistance: number;
  obstructionDistance: number;
  zoom?: number;
  maxDistance?: number;
}): number {
  const safeBaseDistance = Math.max(baseDistance, CAMERA_MIN_DISTANCE);
  const safeZoom = THREE.MathUtils.clamp(zoom, PERSPECTIVE_MIN_ZOOM, PERSPECTIVE_MAX_ZOOM);
  let distance = safeBaseDistance / safeZoom;
  if (Number.isFinite(obstructionDistance)) {
    distance = Math.min(
      distance,
      Math.max(CAMERA_MIN_DISTANCE, obstructionDistance - CAMERA_OCCLUSION_PADDING),
    );
  }
  if (Number.isFinite(maxDistance)) {
    distance = Math.min(distance, Math.max(CAMERA_MIN_DISTANCE, maxDistance));
  }
  return Math.max(CAMERA_MIN_DISTANCE, distance);
}

/**
 * Owns every runtime view camera, its controls, projection setup, and follow
 * framing. The scene only supplies a target and an optional collision distance.
 */
export class CameraController {
  readonly perspectiveCamera: THREE.PerspectiveCamera;
  readonly orthographicCamera: THREE.OrthographicCamera;

  private readonly canvas: HTMLCanvasElement;
  private readonly characterScale: number;
  private readonly cameraBounds?: CameraBounds;
  private orthographicHalfHeight: number;
  private readonly orthographicPitch: number;
  private readonly cameraKeys = new Set<string>();
  private readonly views: Record<CameraViewMode, CameraViewState>;
  private readonly lookAtMatrix = new THREE.Matrix4();
  private readonly desiredQuaternion = new THREE.Quaternion();
  private readonly desiredPosition = new THREE.Vector3();
  private readonly viewDirection = new THREE.Vector3();
  private readonly cameraTarget = new THREE.Vector3();
  private readonly touchState = { id: null as number | null, x: 0, y: 0 };
  private activeViewMode: CameraViewMode;
  private inputEnabled = false;
  private transitionActive = false;
  private hasInitialView = false;
  private perspectiveFov = PERSPECTIVE_FOV;
  private perspectiveZoom = 1;
  private perspectiveTargetZoom = 1;
  private orthographicZoom = 1;
  private orthographicTargetZoom = 1;
  private readonly orthographicPan = new THREE.Vector2();
  private readonly initialOrthographicPan = new THREE.Vector2();
  private orthographicBoundsPadding = 0;
  private cameraDistance = CAMERA_DISTANCE;

  constructor({
    canvas,
    initialViewMode = "perspective",
    initialYaw = 0,
    initialPerspectivePitch = -0.2,
    characterScale = 1,
    enableInput = true,
    cameraBounds,
    orthographicHalfHeight = DEFAULT_ORTHOGRAPHIC_HALF_HEIGHT,
    orthographicPitch = DEFAULT_ORTHOGRAPHIC_PITCH,
    orthographicPan,
  }: CameraControllerOptions) {
    this.canvas = canvas;
    this.characterScale = characterScale;
    this.cameraBounds = cameraBounds;
    this.orthographicHalfHeight = orthographicHalfHeight;
    this.orthographicPitch = orthographicPitch;
    this.initialOrthographicPan.set(orthographicPan?.x ?? 0, orthographicPan?.z ?? 0);
    this.orthographicPan.copy(this.initialOrthographicPan);
    this.activeViewMode = initialViewMode;
    this.views = {
      perspective: { yaw: initialYaw, pitch: initialPerspectivePitch },
      orthographic: { yaw: initialYaw, pitch: orthographicPitch },
    };
    this.perspectiveCamera = new THREE.PerspectiveCamera(
      PERSPECTIVE_FOV,
      1,
      CAMERA_NEAR,
      CAMERA_FAR,
    );
    this.orthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, CAMERA_NEAR, CAMERA_FAR);
    // Orthographic scenes can use a larger authored coordinate system than
    // the default World scenes. Keep the shared default far plane unchanged
    // for normal scales, but make sure a scaled top-down camera can still see
    // the ground it is framing instead of clipping the entire scene.
    this.orthographicCamera.far = Math.max(CAMERA_FAR, ORTHOGRAPHIC_DISTANCE * characterScale * 2);
    this.resize(window.innerWidth, window.innerHeight);
    this.inputEnabled = enableInput && initialViewMode !== "orthographic";
    if (this.inputEnabled) this.attachInput();
  }

  get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    return this.activeViewMode === "perspective" ? this.perspectiveCamera : this.orthographicCamera;
  }

  get viewMode(): CameraViewMode {
    return this.activeViewMode;
  }

  get targetHeight(): number {
    return CAMERA_TARGET_HEIGHT * this.characterScale;
  }

  get baseDistance(): number {
    return CAMERA_DISTANCE * this.characterScale;
  }

  get perspectiveDistance(): number {
    return getPerspectiveCameraDistance({
      baseDistance: this.baseDistance,
      obstructionDistance: Infinity,
      zoom: this.perspectiveTargetZoom,
    });
  }

  get isPerspective(): boolean {
    return this.activeViewMode === "perspective";
  }

  get state(): {
    viewMode: CameraViewMode;
    cameraYaw: number;
    pitch: number;
    cameraDistance: number;
    perspectiveZoom: number;
  } {
    const view = this.views[this.activeViewMode];
    return {
      viewMode: this.activeViewMode,
      cameraYaw: view.yaw,
      pitch: view.pitch,
      cameraDistance: this.cameraDistance,
      perspectiveZoom: this.perspectiveTargetZoom,
    };
  }

  setYaw(yaw: number): void {
    this.views.perspective.yaw = yaw;
    this.views.orthographic.yaw = yaw;
  }

  setOrthographicHalfHeight(halfHeight: number): void {
    this.orthographicHalfHeight = Math.max(halfHeight, 0.1);
    const aspect = this.orthographicCamera.right / Math.max(this.orthographicCamera.top, 0.1);
    this.orthographicCamera.left = -this.orthographicHalfHeight * aspect;
    this.orthographicCamera.right = this.orthographicHalfHeight * aspect;
    this.orthographicCamera.top = this.orthographicHalfHeight;
    this.orthographicCamera.bottom = -this.orthographicHalfHeight;
    this.orthographicCamera.updateProjectionMatrix();
  }

  setOrthographicPan(x: number, z: number): void {
    this.orthographicPan.set(x, z);
  }

  resetOrthographicPan(): void {
    this.orthographicPan.copy(this.initialOrthographicPan);
  }

  setOrthographicZoom(zoom: number): void {
    this.orthographicTargetZoom = THREE.MathUtils.clamp(zoom, 0.65, 1.8);
  }

  setOrthographicZoomImmediate(zoom: number): void {
    const nextZoom = THREE.MathUtils.clamp(zoom, 0.65, 1.8);
    this.orthographicTargetZoom = nextZoom;
    this.orthographicZoom = nextZoom;
    this.orthographicCamera.zoom = nextZoom;
    this.orthographicCamera.updateProjectionMatrix();
  }

  resetOrthographicZoom(): void {
    this.orthographicTargetZoom = 1;
  }

  setPerspectiveZoom(zoom: number): void {
    this.perspectiveTargetZoom = THREE.MathUtils.clamp(
      zoom,
      PERSPECTIVE_MIN_ZOOM,
      PERSPECTIVE_MAX_ZOOM,
    );
  }

  adjustPerspectiveZoom(delta: number): void {
    this.setPerspectiveZoom(this.perspectiveTargetZoom + delta);
  }

  adjustOrthographicZoom(delta: number): void {
    this.setOrthographicZoom(this.orthographicTargetZoom + delta);
  }

  setOrthographicBoundsPadding(padding: number): void {
    this.orthographicBoundsPadding = Math.max(0, padding);
  }

  setViewMode(viewMode: CameraViewMode): void {
    if (viewMode === this.activeViewMode) return;

    const previousCamera = this.camera;
    if (viewMode === "orthographic") {
      const distance = Math.max(previousCamera.position.distanceTo(this.cameraTarget), 0.1);
      const visibleHalfHeight =
        this.perspectiveCamera === previousCamera
          ? distance * Math.tan(THREE.MathUtils.degToRad(this.perspectiveFov) / 2)
          : this.orthographicHalfHeight / Math.max(this.orthographicZoom, 0.001);
      this.orthographicZoom = this.orthographicHalfHeight / Math.max(visibleHalfHeight, 0.1);
      this.orthographicCamera.position.copy(previousCamera.position);
      this.orthographicCamera.quaternion.copy(previousCamera.quaternion);
      this.orthographicCamera.up.copy(previousCamera.up);
      this.orthographicCamera.updateProjectionMatrix();
    } else {
      const distance = Math.max(previousCamera.position.distanceTo(this.cameraTarget), 0.1);
      const visibleHalfHeight =
        this.orthographicHalfHeight / Math.max(this.orthographicZoom, 0.001);
      this.perspectiveFov = THREE.MathUtils.radToDeg(2 * Math.atan(visibleHalfHeight / distance));
      this.perspectiveCamera.position.copy(previousCamera.position);
      this.perspectiveCamera.quaternion.copy(previousCamera.quaternion);
      this.perspectiveCamera.up.copy(previousCamera.up);
      this.perspectiveCamera.updateProjectionMatrix();
    }

    this.activeViewMode = viewMode;
    if (viewMode !== "orthographic") {
      this.resetOrthographicPan();
      this.resetOrthographicZoom();
    }
    this.setInputEnabled(viewMode !== "orthographic");
    this.transitionActive = true;
  }

  toggle(): CameraViewMode {
    const nextViewMode = this.activeViewMode === "perspective" ? "orthographic" : "perspective";
    this.setViewMode(nextViewMode);
    return nextViewMode;
  }

  getTargetViewDirection(result: THREE.Vector3): THREE.Vector3 {
    const view = this.views[this.activeViewMode];
    result.set(
      Math.sin(view.yaw) * Math.cos(view.pitch),
      Math.sin(view.pitch),
      Math.cos(view.yaw) * Math.cos(view.pitch),
    );
    return result.normalize();
  }

  setCameraRelativeBasis(forward: THREE.Vector3, right: THREE.Vector3): void {
    // Use the camera's rendered heading while it eases between views so WASD
    // never snaps to a different direction during a camera transition.
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 0.000001) forward.set(0, 0, 1);
    else forward.normalize();
    right.crossVectors(forward, THREE.Object3D.DEFAULT_UP).normalize();
  }

  resize(width: number, height: number): void {
    const aspect = width / Math.max(height, 1);
    this.perspectiveCamera.aspect = aspect;
    this.perspectiveCamera.updateProjectionMatrix();
    this.orthographicCamera.left = -this.orthographicHalfHeight * aspect;
    this.orthographicCamera.right = this.orthographicHalfHeight * aspect;
    this.orthographicCamera.top = this.orthographicHalfHeight;
    this.orthographicCamera.bottom = -this.orthographicHalfHeight;
    this.orthographicCamera.updateProjectionMatrix();
  }

  update(target: THREE.Vector3, delta: number, obstructionDistance = this.baseDistance): void {
    this.updateInput(delta);
    const view = this.views[this.activeViewMode];
    this.viewDirection.set(
      Math.sin(view.yaw) * Math.cos(view.pitch),
      Math.sin(view.pitch),
      Math.cos(view.yaw) * Math.cos(view.pitch),
    );
    this.cameraTarget.copy(target);
    if (this.activeViewMode === "orthographic") {
      this.cameraTarget.x += this.orthographicPan.x;
      this.cameraTarget.z += this.orthographicPan.y;
    }
    this.cameraTarget.copy(this.constrainTarget(this.cameraTarget));
    const smoothing =
      1 -
      Math.exp(-delta * (this.transitionActive ? CAMERA_TRANSITION_SMOOTHING : CAMERA_SMOOTHING));
    if (this.activeViewMode === "perspective") {
      this.perspectiveZoom = THREE.MathUtils.lerp(
        this.perspectiveZoom,
        this.perspectiveTargetZoom,
        smoothing,
      );
    }
    const targetDistance =
      this.activeViewMode === "perspective"
        ? getPerspectiveCameraDistance({
            baseDistance: this.baseDistance,
            obstructionDistance,
            zoom: this.perspectiveZoom,
            maxDistance: this.getPerspectiveBoundsDistance(),
          })
        : ORTHOGRAPHIC_DISTANCE * this.characterScale;
    this.cameraDistance = targetDistance;
    this.desiredPosition
      .copy(this.cameraTarget)
      .addScaledVector(this.viewDirection, -targetDistance);
    this.lookAtMatrix.lookAt(this.desiredPosition, this.cameraTarget, THREE.Object3D.DEFAULT_UP);
    this.desiredQuaternion.setFromRotationMatrix(this.lookAtMatrix);

    // The renderer creates cameras at the origin with an identity rotation.
    // Snap the first frame to the authored view so a newly loaded scene never
    // flashes a diagonal/default view while the smoothing state catches up.
    if (!this.hasInitialView) {
      this.camera.position.copy(this.desiredPosition);
      this.camera.quaternion.copy(this.desiredQuaternion);
      this.hasInitialView = true;
      return;
    }

    this.camera.position.lerp(this.desiredPosition, smoothing);
    this.camera.quaternion.slerp(this.desiredQuaternion, smoothing);
    if (this.activeViewMode === "orthographic") {
      this.orthographicZoom = THREE.MathUtils.lerp(
        this.orthographicZoom,
        this.orthographicTargetZoom,
        smoothing,
      );
      this.orthographicCamera.zoom = this.orthographicZoom;
      this.orthographicCamera.updateProjectionMatrix();
    } else {
      this.perspectiveFov = THREE.MathUtils.lerp(this.perspectiveFov, PERSPECTIVE_FOV, smoothing);
      this.perspectiveCamera.fov = this.perspectiveFov;
      this.perspectiveCamera.updateProjectionMatrix();
    }
    if (
      this.transitionActive &&
      this.camera.position.distanceToSquared(this.desiredPosition) < 0.0001
    ) {
      this.transitionActive = false;
    }
  }

  private constrainTarget(target: THREE.Vector3): THREE.Vector3 {
    // Orthographic scenes clamp their target so the full map stays in view.
    // Perspective scenes retain character-follow framing and instead cap the
    // camera distance against the same envelope below.
    if (!this.cameraBounds || this.activeViewMode !== "orthographic") return target;

    const aspect = this.orthographicCamera.right / Math.max(this.orthographicCamera.top, 0.001);
    const { halfWidth, halfDepth } = getOrthographicGroundHalfExtents({
      halfHeight: this.orthographicHalfHeight,
      aspect,
      zoom: this.orthographicZoom,
      viewDirectionY: this.viewDirection.y,
    });
    const clampCenter = (value: number, min: number, max: number, halfExtent: number): number => {
      if (max - min <= halfExtent * 2) return (min + max) / 2;
      return THREE.MathUtils.clamp(value, min + halfExtent, max - halfExtent);
    };
    const boundsPadding = this.orthographicBoundsPadding;
    this.cameraTarget.set(
      clampCenter(
        target.x,
        this.cameraBounds.xMin - boundsPadding,
        this.cameraBounds.xMax + boundsPadding,
        halfWidth,
      ),
      target.y,
      clampCenter(
        target.z,
        this.cameraBounds.zMin - boundsPadding,
        this.cameraBounds.zMax + boundsPadding,
        halfDepth,
      ),
    );
    return this.cameraTarget;
  }

  private getPerspectiveBoundsDistance(): number {
    if (!this.cameraBounds) return Infinity;

    const axisDistance = (position: number, direction: number, min: number, max: number) => {
      const cameraMovement = -direction;
      if (Math.abs(cameraMovement) < 0.0001) return Infinity;
      const edge = cameraMovement > 0 ? max : min;
      return Math.max(0, (edge - position) / cameraMovement);
    };

    return Math.min(
      axisDistance(
        this.cameraTarget.x,
        this.viewDirection.x,
        this.cameraBounds.xMin,
        this.cameraBounds.xMax,
      ),
      axisDistance(
        this.cameraTarget.z,
        this.viewDirection.z,
        this.cameraBounds.zMin,
        this.cameraBounds.zMax,
      ),
    );
  }

  dispose(): void {
    this.detachInput();
  }

  private updateInput(delta: number): void {
    if (!this.inputEnabled) return;
    const view = this.views[this.activeViewMode];
    const yawInput =
      Number(this.cameraKeys.has("ArrowLeft")) - Number(this.cameraKeys.has("ArrowRight"));
    const pitchInput =
      Number(this.cameraKeys.has("ArrowUp")) - Number(this.cameraKeys.has("ArrowDown"));
    view.yaw += yawInput * CAMERA_ROTATE_SPEED * delta;
    view.pitch = THREE.MathUtils.clamp(
      view.pitch - pitchInput * CAMERA_PITCH_SPEED * delta,
      -Math.PI / 2 + 0.05,
      Math.PI / 2 - 0.05,
    );
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (!this.inputEnabled || !CAMERA_KEY_CODES.has(event.code)) return;
    event.preventDefault();
    this.cameraKeys.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    this.cameraKeys.delete(event.code);
  };

  private readonly onBlur = () => {
    this.cameraKeys.clear();
    this.touchState.id = null;
  };

  private readonly onMouseMove = (event: MouseEvent) => {
    if (!this.inputEnabled || document.pointerLockElement !== this.canvas) return;
    const view = this.views[this.activeViewMode];
    view.yaw -= event.movementX * CAMERA_MOUSE_SENSITIVITY;
    view.pitch = THREE.MathUtils.clamp(
      view.pitch - event.movementY * CAMERA_MOUSE_SENSITIVITY,
      -Math.PI / 2 + 0.05,
      Math.PI / 2 - 0.05,
    );
  };

  private readonly onPointerDown = (event: PointerEvent) => {
    if (!this.inputEnabled) return;
    if (event.pointerType === "mouse" && document.pointerLockElement !== this.canvas) {
      void this.canvas.requestPointerLock().catch(() => undefined);
    }
  };

  private readonly onTouchStart = (event: TouchEvent) => {
    if (!this.inputEnabled) return;
    if (this.touchState.id !== null) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    this.touchState.id = touch.identifier;
    this.touchState.x = touch.clientX;
    this.touchState.y = touch.clientY;
  };

  private readonly onTouchMove = (event: TouchEvent) => {
    if (!this.inputEnabled || this.touchState.id === null) return;
    for (const touch of event.changedTouches) {
      if (touch.identifier !== this.touchState.id) continue;
      const view = this.views[this.activeViewMode];
      view.yaw -= (touch.clientX - this.touchState.x) * CAMERA_MOUSE_SENSITIVITY;
      view.pitch = THREE.MathUtils.clamp(
        view.pitch - (touch.clientY - this.touchState.y) * CAMERA_MOUSE_SENSITIVITY,
        -Math.PI / 2 + 0.05,
        Math.PI / 2 - 0.05,
      );
      this.touchState.x = touch.clientX;
      this.touchState.y = touch.clientY;
      break;
    }
  };

  private readonly onTouchEnd = (event: TouchEvent) => {
    for (const touch of event.changedTouches) {
      if (touch.identifier === this.touchState.id) this.touchState.id = null;
    }
  };

  private attachInput(): void {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    document.addEventListener("mousemove", this.onMouseMove);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("touchstart", this.onTouchStart, { passive: true });
    this.canvas.addEventListener("touchmove", this.onTouchMove, { passive: true });
    this.canvas.addEventListener("touchend", this.onTouchEnd);
    this.canvas.addEventListener("touchcancel", this.onTouchEnd);
  }

  private detachInput(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    document.removeEventListener("mousemove", this.onMouseMove);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("touchstart", this.onTouchStart);
    this.canvas.removeEventListener("touchmove", this.onTouchMove);
    this.canvas.removeEventListener("touchend", this.onTouchEnd);
    this.canvas.removeEventListener("touchcancel", this.onTouchEnd);
  }

  private setInputEnabled(enabled: boolean): void {
    if (enabled === this.inputEnabled) return;
    if (enabled) {
      this.inputEnabled = true;
      this.attachInput();
    } else {
      this.inputEnabled = false;
      this.cameraKeys.clear();
      this.touchState.id = null;
      this.detachInput();
    }
  }
}
