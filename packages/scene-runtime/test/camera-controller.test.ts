import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import {
  getOrthographicGroundHalfExtents,
  getPerspectiveCameraDistance,
} from "../src/camera-controller";
import { CameraController } from "../src/camera-controller";

describe("perspective camera obstruction framing", () => {
  test("keeps the authored distance when nothing blocks the character", () => {
    expect(
      getPerspectiveCameraDistance({ baseDistance: 1.7, obstructionDistance: Infinity }),
    ).toBeCloseTo(1.7, 5);
  });

  test("stops just in front of an obstructing object", () => {
    expect(
      getPerspectiveCameraDistance({ baseDistance: 1.7, obstructionDistance: 1.2 }),
    ).toBeCloseTo(1.05, 5);
  });

  test("allows the camera to move close enough for a nearby object to stay behind it", () => {
    expect(
      getPerspectiveCameraDistance({ baseDistance: 1.7, obstructionDistance: 0.18 }),
    ).toBeCloseTo(0.08, 5);
  });
});

describe("orthographic ground framing", () => {
  test("accounts for the top-down pitch when fitting a map inside the viewport", () => {
    const extents = getOrthographicGroundHalfExtents({
      halfHeight: 10.5,
      aspect: 1280 / 720,
      zoom: 1,
      viewDirectionY: Math.sin(-0.9),
    });

    expect(extents.halfWidth).toBeCloseTo(18.667, 2);
    expect(extents.halfDepth).toBeCloseTo(13.404, 2);
  });

  test("restores the scene-authored pan after a temporary reset", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { innerWidth: 1280, innerHeight: 720 },
    });
    const controller = new CameraController({
      canvas: {} as HTMLCanvasElement,
      initialViewMode: "orthographic",
      orthographicPan: { x: 0, z: 7.2 },
      orthographicHalfHeight: 10,
    });
    const target = new THREE.Vector3(0, 0, 0);

    controller.update(target, 1 / 60);
    const authoredPosition = controller.orthographicCamera.position.clone();
    controller.setOrthographicPan(0, 0);
    controller.resetOrthographicPan();
    controller.update(target, 1 / 60);

    expect(controller.orthographicCamera.position.z).toBeCloseTo(authoredPosition.z, 5);
  });
});
