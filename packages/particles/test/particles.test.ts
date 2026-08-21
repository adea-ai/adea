import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { createParticleManager } from "../src";

describe("particle manager", () => {
  test("creates, updates, and disposes shared particle fields", () => {
    const scene = new THREE.Scene();
    const manager = createParticleManager(scene, {
      fields: [
        {
          name: "Test spray",
          behavior: "spray",
          color: 0xffffff,
          count: 4,
          opacity: 1,
          size: 0.2,
          emitters: [
            {
              position: new THREE.Vector3(),
              quaternion: new THREE.Quaternion(),
              size: new THREE.Vector3(1, 1, 1),
              spread: 0.2,
            },
          ],
        },
      ],
    });
    const field = scene.getObjectByName("Test spray particle field") as THREE.Points;
    const before = Array.from(field.geometry.getAttribute("position").array);

    expect(scene.getObjectByName("Particle Manager")).toBeDefined();
    expect(field).toBeDefined();
    manager.update(0.1);
    expect(Array.from(field.geometry.getAttribute("position").array)).not.toEqual(before);

    manager.dispose();
    expect(scene.getObjectByName("Particle Manager")).toBeUndefined();
  });
});
