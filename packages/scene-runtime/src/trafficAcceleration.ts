import * as THREE from "three";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";

export interface TrafficGroundAcceleration {
  targets: THREE.Object3D[];
  dispose: () => void;
}

/** Add owned BVHs to static driveable meshes without taking ownership of their geometry. */
export function createTrafficGroundAcceleration(scene: THREE.Scene): TrafficGroundAcceleration {
  const targets: THREE.Object3D[] = [];
  const ownedBoundsTrees = new Set<THREE.BufferGeometry>();
  const originalRaycasts = new Map<THREE.Mesh, THREE.Mesh["raycast"]>();
  scene.traverse((object) => {
    if (
      !(object instanceof THREE.Mesh) ||
      !object.visible ||
      !/Road|Sand|Floor|Soil|Sidewalk/i.test(object.name || "")
    )
      return;
    const geometry = object.geometry;
    if (!geometry.boundsTree) {
      // Indirect mode leaves the source index/triangle order untouched because
      // the scene owns this geometry and may use it for rendering elsewhere.
      computeBoundsTree.call(geometry, { indirect: true, verbose: false });
      ownedBoundsTrees.add(geometry);
    }
    originalRaycasts.set(object, object.raycast);
    object.raycast = acceleratedRaycast;
    targets.push(object);
  });
  return {
    targets,
    dispose: () => {
      originalRaycasts.forEach((raycast, mesh) => {
        mesh.raycast = raycast;
      });
      ownedBoundsTrees.forEach((geometry) => {
        disposeBoundsTree.call(geometry);
      });
    },
  };
}
