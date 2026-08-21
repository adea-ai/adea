import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import {
  DEBUG_COMPONENT_PROXY,
  isSceneEditorObject,
  resolveDebugSourceObject,
} from "../src/sceneDebug";
import { applySceneEditorOverrides } from "../src/sceneEditorOverrides";

describe("scene editor debug picking", () => {
  test("recognizes gizmo descendants as editor-only objects", () => {
    const scene = new THREE.Scene();
    const helper = new THREE.Group();
    helper.name = "scene-editor-gizmo";
    const axis = new THREE.Object3D();
    axis.name = "X";
    helper.add(axis);
    scene.add(helper);

    expect(isSceneEditorObject(axis)).toBe(true);
  });

  test("leaves authored scene objects pickable", () => {
    const scene = new THREE.Scene();
    const authoredRoot = new THREE.Group();
    authoredRoot.name = "exchange-bank";
    const mesh = new THREE.Mesh();
    mesh.name = "exchange-bank-door";
    authoredRoot.add(mesh);
    scene.add(authoredRoot);

    expect(isSceneEditorObject(mesh)).toBe(false);
  });

  test("resolves disconnected-component proxies to their authored mesh", () => {
    const source = new THREE.Mesh();
    const proxy = source.clone();
    proxy.userData[DEBUG_COMPONENT_PROXY] = { source, component: 1 };

    expect(resolveDebugSourceObject(proxy)).toBe(source);
    expect(resolveDebugSourceObject(source)).toBe(source);
  });

  test("applies transforms and persistent deletion by full or legacy path", () => {
    const scene = new THREE.Scene();
    const zone = new THREE.Group();
    zone.name = "zone:example";
    const mesh = new THREE.Mesh();
    mesh.name = "exchange-bank-door";
    zone.add(mesh);
    scene.add(zone);

    applySceneEditorOverrides(scene, {
      objects: {
        "zone:example / exchange-bank-door": {
          transform: { p: [4, 5, 6], q: [0, 0, 0, 1], s: [2, 2, 2] },
          deleted: true,
        },
      },
    });

    expect(mesh.position.toArray()).toEqual([4, 5, 6]);
    expect(mesh.scale.toArray()).toEqual([2, 2, 2]);
    expect(mesh.visible).toBe(false);
  });

  test("matches editor paths copied with sanitized GLB names", () => {
    const scene = new THREE.Scene();
    const zone = new THREE.Group();
    zone.name = "zone:exchange-outside";
    const outside = new THREE.Group();
    outside.name = "exchange-outside";
    const coupe = new THREE.Mesh();
    coupe.name = "vehicles:luxury-coupe:0:all";
    outside.add(coupe);
    zone.add(outside);
    scene.add(zone);

    applySceneEditorOverrides(scene, {
      objects: {
        "zone:exchange-outside / exchange-outside / vehiclesluxury-coupe0all": {
          name: "vehiclesluxury-coupe0all",
          transform: { p: [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] },
          deleted: true,
        },
      },
    });

    expect(coupe.visible).toBe(false);
  });
});
