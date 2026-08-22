import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { collectSceneRuntimeStats } from "../src/performance";

describe("scene runtime profiling", () => {
  test("reports materials, frustum culling, and repeated foliage/fence geometry", () => {
    const scene = new THREE.Scene();
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const foliageMaterial = new THREE.MeshBasicMaterial();
    const fenceMaterial = new THREE.MeshBasicMaterial();
    const foliage = new THREE.InstancedMesh(geometry, foliageMaterial, 3);
    foliage.name = "foliage";
    const fence = new THREE.Mesh(geometry, fenceMaterial);
    fence.name = "hq-map-edge-fence";
    const secondFence = new THREE.Mesh(geometry, fenceMaterial);
    secondFence.name = "hq-map-edge-fence-gate";
    secondFence.frustumCulled = false;
    scene.add(foliage, fence, secondFence);

    expect(collectSceneRuntimeStats(scene)).toEqual({
      meshes: 3,
      visibleMeshes: 3,
      frustumCulledMeshes: 2,
      materials: 2,
      instancedMeshes: 1,
      instances: 5,
      foliageMeshes: 1,
      foliageInstances: 3,
      fenceMeshes: 2,
      fenceInstances: 2,
      repeatedGeometryGroups: 1,
      repeatedGeometryInstances: 5,
    });

    geometry.dispose();
    foliageMaterial.dispose();
    fenceMaterial.dispose();
  });
});
