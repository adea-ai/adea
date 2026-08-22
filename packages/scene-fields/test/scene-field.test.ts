import { describe, expect, test } from "bun:test";
import type { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { loadSceneField } from "../src/index.ts";

describe("scene-field loading", () => {
  test("propagates the scene abort signal to model loading", async () => {
    const manager = { abortController: new AbortController() };
    let resolveLoaderStarted: (() => void) | undefined;
    const loaderStarted = new Promise<void>((resolve) => {
      resolveLoaderStarted = resolve;
    });
    const pendingLoad = new Promise<never>((_, reject) => {
      manager.abortController.signal.addEventListener(
        "abort",
        () => reject(new DOMException("The scene load was aborted", "AbortError")),
        { once: true },
      );
    });
    const loader = {
      manager,
      loadAsync: () => {
        resolveLoaderStarted?.();
        return pendingLoad;
      },
    } as unknown as GLTFLoader;
    const sceneAbortController = new AbortController();
    const manifestUrl = `data:application/json,${encodeURIComponent(
      JSON.stringify({ version: 1, scene: "test", placements: { prop: [{}] } }),
    )}`;

    const load = loadSceneField(
      loader,
      manifestUrl,
      () => "prop.glb",
      "test-field",
      false,
      sceneAbortController.signal,
    );
    await loaderStarted;
    sceneAbortController.abort();

    const settled = await Promise.race([
      load.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);

    expect(settled).toBe(true);
    expect(manager.abortController.signal.aborted).toBe(true);
  });
});
