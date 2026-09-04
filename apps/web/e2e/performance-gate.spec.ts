import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";

type BrowserSceneReport = {
  event: "load" | "runtime" | "dispose" | "error";
  scene: string;
  error?: string;
  milestones?: { playableCharacterMs?: number };
  network?: { transferBytes?: number };
  runtime?: { p95FrameMs?: number };
};

// Cold WebGL initialization can exceed Playwright's default 30-second action
// timeout in headless Chromium. This only allows the scene to report; the
// separate performance budget still enforces the 10-second playable-scene
// target.
const sceneCanvasTimeout = 60_000

type SceneDebugState = {
  cameraYaw: number;
  pitch: number;
  activeAnimationName: string | null;
  activeAnimationActions: string[];
  background: {
    mode: "screen-space-2d" | "scene";
    visible: boolean;
    cameraType: string;
    cameraPosition: number[];
    meshWorldMatrix: number[];
  };
};

type SceneDebugApi = {
  getState: () => SceneDebugState;
  adjustPerspectiveZoom: (delta: number) => void;
  setCameraViewMode: (viewMode: "perspective" | "orthographic") => void;
  teleportTo: (x: number, z: number) => void;
  camera: { position: { x: number; toArray: () => number[] } };
  scene?: {
    getObjectByName: (name: string) =>
      | {
          material?: { map?: { image?: { src?: string } } };
          rotation: { x: number };
        }
      | undefined;
  };
};

type CharacterDesignerDebugApi = SceneDebugApi & {
  characterRoot?: {
    position: { toArray: () => number[] };
    rotation: { toArray: () => number[] };
    traverse: (callback: (object: { isMesh?: boolean; visible?: boolean; name?: string }) => void) => void;
  } | null;
};

type AgentHqWindow = Window & { __agentHq?: SceneDebugApi };

async function runScenePerformanceGate(page: Page, scene: "home" | "work") {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  const response = await page.goto(`/?view=spatial&scene=${scene}&roomDesigner=0&camera=orthographic`, {
    waitUntil: "domcontentloaded",
  });
  expect(response?.ok()).toBe(true);
  await expect(page.locator("canvas")).toBeVisible({ timeout: sceneCanvasTimeout });

  await page.waitForFunction(
    () =>
      Array.isArray(
        (window as Window & { __AGENT_HQ_SCENE_PERF__?: unknown }).__AGENT_HQ_SCENE_PERF__,
      ) &&
      (
        (window as Window & { __AGENT_HQ_SCENE_PERF__?: BrowserSceneReport[] })
          .__AGENT_HQ_SCENE_PERF__ ?? []
      ).some((report) => report.event === "load" || report.event === "error"),
    undefined,
    { timeout: 30_000 },
  );

  await page.waitForFunction(
    () =>
      (
        (window as Window & { __AGENT_HQ_SCENE_PERF__?: BrowserSceneReport[] })
          .__AGENT_HQ_SCENE_PERF__ ?? []
      ).some((report) => report.event === "runtime" || report.event === "error"),
    undefined,
    { timeout: 30_000 },
  );

  const reports = await page.evaluate(
    () =>
      ((window as Window & { __AGENT_HQ_SCENE_PERF__?: BrowserSceneReport[] })
        .__AGENT_HQ_SCENE_PERF__ ?? []) as BrowserSceneReport[],
  );
  await mkdir(".artifacts", { recursive: true });
  let existingReports: BrowserSceneReport[] = [];
  if (scene === "work") {
    try {
      existingReports = JSON.parse(
        await readFile(".artifacts/scene-performance.json", "utf8"),
      ) as BrowserSceneReport[];
    } catch {
      // The work gate can still run independently when no Home artifact exists.
    }
  }
  await writeFile(
    ".artifacts/scene-performance.json",
    JSON.stringify([...existingReports, ...reports], null, 2),
  );

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(reports.some((report) => report.event === "load")).toBe(true);
  expect(reports.some((report) => report.event === "error")).toBe(false);
}

test("home scene meets runtime performance gates", async ({ page }) => {
  await runScenePerformanceGate(page, "home");
});

test("work scene meets runtime performance gates", async ({ page }) => {
  await runScenePerformanceGate(page, "work");
});

test("HQ defers perspective-only backgrounds in top-down view", async ({ page }) => {
  const backgroundRequests: string[] = [];
  const deferredRequests: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/assets/models/backgrounds/background_seasons_3.jpg")) {
      backgroundRequests.push(url);
    }
    if (
      url.includes("/assets/models/runtime.glb") ||
      url.includes("/assets/models/animals/Dog_001.glb") ||
      url.includes("/assets/models/animals/Kitty_001.glb")
    ) {
      deferredRequests.push(url);
    }
  });
  const response = await page.goto(
    "/?view=spatial&scene=home&roomDesigner=0&camera=orthographic&debug=1",
    { waitUntil: "domcontentloaded" },
  );
  expect(response?.ok()).toBe(true);
  await expect(page.locator("canvas")).toBeVisible({ timeout: sceneCanvasTimeout });
  await page.waitForFunction(
    () =>
      ((window as Window & { __AGENT_HQ_SCENE_PERF__?: BrowserSceneReport[] })
        .__AGENT_HQ_SCENE_PERF__ ?? []
      ).some((report) => report.event === "load" || report.event === "error"),
    undefined,
    { timeout: 90_000 },
  );
  expect(backgroundRequests).toHaveLength(0);
  expect(deferredRequests).toHaveLength(0);

  await Promise.all([
    page.waitForRequest(
      (request) => request.url().includes("/assets/models/backgrounds/background_seasons_3.jpg"),
      { timeout: 30_000 },
    ),
    page.getByRole("button", { name: "Perspective camera" }).click(),
  ]);
});

test("HQ keeps perspective backgrounds fixed while the camera moves", async ({ page }) => {
  const response = await page.goto("/?view=spatial&scene=home&roomDesigner=0&camera=perspective&debug=1", {
    waitUntil: "domcontentloaded",
  });
  expect(response?.ok()).toBe(true);
  await expect(page.locator("canvas")).toBeVisible({ timeout: sceneCanvasTimeout });
  await page.waitForFunction(() => {
    const api = (window as AgentHqWindow).__agentHq;
    const background = api?.getState().background;
    return background?.mode === "screen-space-2d" && background.visible === true;
  });

  const before = await page.evaluate(() => {
    const api = (window as AgentHqWindow).__agentHq!;
    const background = api.getState().background;
    api.adjustPerspectiveZoom(0.3);
    api.teleportTo(3, 3);
    return background;
  });
  await page.waitForTimeout(250);
  const after = await page.evaluate(
    () => (window as AgentHqWindow).__agentHq!.getState().background,
  );

  expect(before.cameraType).toBe("OrthographicCamera");
  expect(after.cameraType).toBe(before.cameraType);
  expect(after.cameraPosition).toEqual(before.cameraPosition);
  expect(after.meshWorldMatrix).toEqual(before.meshWorldMatrix);
});

test("HQ plays only the active locomotion animation", async ({ page }) => {
  const response = await page.goto("/?view=spatial&scene=home&roomDesigner=0&camera=perspective&debug=1", {
    waitUntil: "domcontentloaded",
  });
  expect(response?.ok()).toBe(true);
  await expect(page.locator("canvas")).toBeVisible({ timeout: sceneCanvasTimeout });
  await page.waitForFunction(() => {
    const api = (window as AgentHqWindow).__agentHq;
    const state = api?.getState();
    return state?.activeAnimationName === "idle" && state.activeAnimationActions?.length === 1;
  });

  await page.keyboard.down("KeyW");
  await expect
    .poll(() => page.evaluate(() => (window as AgentHqWindow).__agentHq!.getState()), {
      timeout: 5_000,
    })
    .toMatchObject({ activeAnimationName: "run", activeAnimationActions: ["run"] });
  await page.keyboard.up("KeyW");

  await expect
    .poll(() => page.evaluate(() => (window as AgentHqWindow).__agentHq!.getState()), {
      timeout: 5_000,
    })
    .toMatchObject({ activeAnimationName: "idle", activeAnimationActions: ["idle"] });
});

test("direct character designer mount skips HQ scene assets", async ({ page }) => {
  const assetRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/assets/")) assetRequests.push(request.url());
  });

  const characterAsset = page.waitForResponse(
    (assetResponse) =>
      assetResponse.url().endsWith("/assets/models/_complete/f_1.glb") && assetResponse.ok(),
    { timeout: 60_000 },
  );
  const response = await page.goto(
    "/?view=spatial&scene=home&roomDesigner=0&characterDesigner=1&camera=perspective&character=f_1",
    { waitUntil: "domcontentloaded" },
  );
  expect(response?.ok()).toBe(true);
  await expect(page.locator('[aria-label="Character designer"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("canvas").first()).toBeVisible({ timeout: sceneCanvasTimeout });
  await characterAsset;

  expect(assetRequests.some((url) => url.includes("/worlds/hq-home/floor.glb"))).toBe(false);
  expect(assetRequests.some((url) => url.includes("/worlds/hq-home/foliage.json"))).toBe(false);
  expect(assetRequests.some((url) => url.includes("/worlds/hq-home/props-runtime.json"))).toBe(false);
});

test("character designer keeps feet visible and supports drag orbit and pan", async ({ page }) => {
  const response = await page.goto(
    "/?view=spatial&characterDesigner=1&camera=perspective&character=configurable&debug=1",
    { waitUntil: "domcontentloaded" },
  );
  expect(response?.ok()).toBe(true);
  await expect(page.locator('[aria-label="Character designer"]')).toBeVisible({
    timeout: 30_000,
  });
  await page.waitForFunction(
    () => Boolean((window as AgentHqWindow).__agentHq?.characterRoot),
    undefined,
    { timeout: 60_000 },
  );

  const initial = await page.evaluate(() => {
    const api = (window as AgentHqWindow).__agentHq as CharacterDesignerDebugApi;
    return {
      characterPositionY: api.characterRoot?.position.toArray()[1] ?? 0,
      characterRotationY: api.characterRoot?.rotation.toArray()[1] ?? 0,
      cameraYaw: api.getState().cameraYaw,
      cameraPitch: api.getState().pitch,
    };
  });
  expect(initial.characterPositionY).toBeGreaterThan(0.1);
  expect(Math.abs(Math.sin((initial.characterRotationY - Math.PI) / 2))).toBeLessThan(0.1);

  for (const bodyName of [
    "Body 01",
    "Body 02",
    "Body 03",
    "Body 04",
    "Body 05",
    "Body 06",
    "Body 07",
    "Body 08",
    "Body 09",
    "Body 10",
    "Body 11",
    "Body 12",
    "Body 13",
    "Body 14",
    "Body 15",
    "Body 16",
  ]) {
    await page.getByRole("radio", { name: bodyName, exact: true }).click();
    await expect(page.getByRole("radio", { name: bodyName, exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    const bodyPositionY = await page.evaluate(
      () => (window as AgentHqWindow).__agentHq?.characterRoot?.position.toArray()[1] ?? 0,
    );
    expect(bodyPositionY, `${bodyName} should keep its feet above the platform`).toBeGreaterThan(
      0.1,
    );
  }

  const canvas = page.locator('.character-designer-room canvas[data-engine="three.js r185"]');
  const canvasBounds = await canvas.boundingBox();
  expect(canvasBounds).not.toBeNull();
  const startX = canvasBounds!.x + canvasBounds!.width * 0.75;
  const startY = canvasBounds!.y + canvasBounds!.height * 0.7;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 120, startY + 40, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const afterOrbit = await page.evaluate(() => {
    const api = (window as AgentHqWindow).__agentHq as CharacterDesignerDebugApi;
    return {
      pointerLocked: document.pointerLockElement !== null,
      cameraYaw: api.getState().cameraYaw,
      cameraPitch: api.getState().pitch,
    };
  });
  expect(afterOrbit.pointerLocked).toBe(false);
  expect(afterOrbit.cameraYaw).not.toBeCloseTo(initial.cameraYaw, 5);
  expect(afterOrbit.cameraPitch).not.toBeCloseTo(initial.cameraPitch, 5);

  const beforePan = await page.evaluate(
    () => ((window as AgentHqWindow).__agentHq as CharacterDesignerDebugApi).camera.position.toArray(),
  );
  await page.mouse.move(startX, startY);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(startX + 100, startY + 50, { steps: 3 });
  await page.mouse.up({ button: "right" });
  await page.waitForTimeout(100);
  const afterPan = await page.evaluate(
    () => ((window as AgentHqWindow).__agentHq as CharacterDesignerDebugApi).camera.position.toArray(),
  );
  expect(
    Math.hypot(
      afterPan[0] - beforePan[0],
      afterPan[1] - beforePan[1],
      afterPan[2] - beforePan[2],
    ),
  ).toBeGreaterThan(0.1);
});

test("character designer starts slot thumbnails without a long delay", async ({ page }) => {
  const startedAt = Date.now();
  const firstSlotAsset = page.waitForRequest(
    (request) => /\/assets\/models\/body\/[^/]+\.glb$/.test(request.url()),
    { timeout: 12_000 },
  );

  const response = await page.goto(
    "/?view=spatial&characterDesigner=1&camera=perspective&character=configurable",
    { waitUntil: "domcontentloaded" },
  );
  expect(response?.ok()).toBe(true);
  await expect(page.locator('[aria-label="Character designer"]')).toBeVisible({
    timeout: 30_000,
  });

  await firstSlotAsset;
  expect(Date.now() - startedAt).toBeLessThan(12_000);

  const characterCategoryStartedAt = Date.now();
  const firstCharacterAsset = page.waitForRequest(
    (request) => /\/assets\/models\/_complete\/[fm]_\d+\.glb$/.test(request.url()),
    { timeout: 12_000 },
  );
  await page.getByRole("tab", { name: "Characters", exact: true }).click();
  await firstCharacterAsset;
  expect(Date.now() - characterCategoryStartedAt).toBeLessThan(12_000);
});

test("saving a customized body restores it in the virtual space", async ({ page }) => {
  const response = await page.goto(
    "/?view=spatial&scene=home&characterDesigner=1&camera=perspective&character=configurable&debug=1",
    { waitUntil: "domcontentloaded" },
  );
  expect(response?.ok()).toBe(true);
  await expect(page.locator('[aria-label="Character designer"]')).toBeVisible({
    timeout: 30_000,
  });
  await page.waitForFunction(
    () => Boolean((window as AgentHqWindow).__agentHq?.characterRoot),
    undefined,
    { timeout: 60_000 },
  );
  await page.getByRole("tab", { name: "Body", exact: true }).click();
  const bodyOption = page.getByRole("radio", { name: "Body 09", exact: true });
  await bodyOption.click();
  await expect(bodyOption).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Save & return", exact: true }).click();

  await page.waitForURL(/characterDesigner=0/, { timeout: 60_000 });
  await expect(page.locator('canvas:not([aria-hidden="true"])').first()).toBeVisible({
    timeout: 60_000,
  });
  await page.waitForFunction(
    () => Boolean((window as AgentHqWindow).__agentHq?.characterRoot),
    undefined,
    { timeout: 60_000 },
  );
  const visibleMeshes = await page.evaluate(() => {
    const api = (window as AgentHqWindow).__agentHq as CharacterDesignerDebugApi;
    const names: string[] = [];
    api.characterRoot?.traverse((object) => {
      if (object.isMesh && object.visible && object.name) names.push(object.name);
    });
    return names;
  });
  expect(visibleMeshes).toContain("Body_09");
  expect(visibleMeshes).toContain("Shoe_Sneakers_01");
});

test("saving a customized body from virtual space keeps the body model", async ({ page }) => {
  const response = await page.goto(
    "/?view=spatial&scene=home&roomDesigner=0&characterDesigner=0&camera=orthographic&character=f_1&debug=1",
    { waitUntil: "domcontentloaded" },
  );
  expect(response?.ok()).toBe(true);
  await expect(page.locator('canvas:not([aria-hidden="true"])').first()).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole("button", { name: "Open character designer" }).click();
  await expect(page.locator('[aria-label="Character designer"]')).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("tab", { name: "Body", exact: true }).click();
  const bodyOption = page.getByRole("radio", { name: "Body 09", exact: true });
  await bodyOption.click();
  await expect(bodyOption).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Save & return", exact: true }).click();

  await expect(page.locator('[aria-label="Character designer"]')).toHaveCount(0);
  await page.waitForFunction(
    () => Boolean((window as AgentHqWindow).__agentHq?.characterRoot),
    undefined,
    { timeout: 60_000 },
  );
  await page.waitForTimeout(1_000);
  const visibleMeshes = await page.evaluate(() => {
    const api = (window as AgentHqWindow).__agentHq as CharacterDesignerDebugApi;
    const names: string[] = [];
    api.characterRoot?.traverse((object) => {
      if (object.isMesh && object.visible && object.name) names.push(object.name);
    });
    return names;
  });
  expect(visibleMeshes).toContain("Body_09");
  expect(visibleMeshes).toContain("Shoe_Sneakers_01");
});

test("switching from a reference character to Custom in the character designer without asset errors", async ({ page }) => {
  const pageErrors: string[] = [];
  const assetErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (assetResponse) => {
    if (assetResponse.url().includes("/assets/") && !assetResponse.ok()) {
      assetErrors.push(`${assetResponse.status()} ${assetResponse.url()}`);
    }
  });

  const response = await page.goto(
    "/?view=spatial&scene=home&roomDesigner=0&characterDesigner=0&camera=perspective&character=f_1&debug=1",
    { waitUntil: "domcontentloaded" },
  );
  expect(response?.ok()).toBe(true);
  await expect(page.locator('canvas:not([aria-hidden="true"])')).toBeVisible({
    timeout: sceneCanvasTimeout,
  });
  await expect(page.getByRole("button", { name: "Open character designer" })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Open character designer" }).click();
  await expect(page.locator('[aria-label="Character designer"]')).toBeVisible({
    timeout: 30_000,
  });
  const userMenu = page.getByRole("button", { name: /Open user menu|User settings/ });
  await expect(userMenu).toBeVisible();
  await userMenu.click();
  await expect(page.getByRole("heading", { name: "Character" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(userMenu).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("tab", { name: "Characters" }).click();
  const customAsset = page.waitForResponse(
    (assetResponse) =>
      assetResponse.url().endsWith("/assets/models/characters.glb") && assetResponse.ok(),
    { timeout: 60_000 },
  );
  await page.getByRole("radio", { name: "Custom" }).click();
  await customAsset;
  await page.waitForTimeout(3_000);

  expect(pageErrors).toEqual([]);
  expect(assetErrors).toEqual([]);
});

test("room designer loads compressed interior props", async ({ page }) => {
  const pageErrors: string[] = [];
  const catalogWarnings: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "warning" &&
      message.text().includes("[HQ room designer] Could not load")
    ) {
      catalogWarnings.push(message.text());
    }
  });

  const response = await page.goto(
    "/?view=spatial&scene=home&roomDesigner=1&camera=orthographic&debug=1",
    { waitUntil: "domcontentloaded" },
  );
  expect(response?.ok()).toBe(true);
  await expect(page.locator('[aria-label="Room designer"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.global-rail')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.workspace-ui')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Virtual Room' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Perspective camera' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Top-down camera' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open character designer' })).toHaveCount(0);
  await expect(page.locator('[aria-label^="Add "]').first()).toBeVisible({ timeout: 30_000 });

  expect(pageErrors).toEqual([]);
  expect(catalogWarnings).toEqual([]);
});

test("room designer camera state does not leak into HQ", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const response = await page.goto(
    "/?view=spatial&scene=home&roomDesigner=1&camera=orthographic&debug=1",
    { waitUntil: "domcontentloaded" },
  );
  expect(response?.ok()).toBe(true);
  await expect(page.locator('[aria-label="Room designer"]')).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(
    () => Boolean((window as AgentHqWindow).__agentHq?.characterRoot),
    undefined,
    { timeout: 60_000 },
  );

  await page.evaluate(() => {
    (window as AgentHqWindow).__agentHq?.setOrthographicPan(6, 6);
  });
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: 'Close room designer' }).click();
  await expect(page.locator('[aria-label="Room designer"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open room designer' })).toBeVisible({
    timeout: 30_000,
  });
  await page.waitForFunction(
    () => {
      const api = (window as AgentHqWindow).__agentHq;
      return Boolean(api?.characterRoot) && Math.abs((api?.camera.position.x ?? 99)) < 0.1;
    },
    undefined,
    { timeout: 60_000 },
  );
  await page.getByRole('button', { name: 'Open room designer' }).click();
  await expect(page.locator('[aria-label="Room designer"]')).toBeVisible({ timeout: 30_000 });

  expect(pageErrors).toEqual([]);
});

test("web layout does not reserve space for the desktop status bar", async ({ page }) => {
  const response = await page.goto("/?view=spatial&scene=home&roomDesigner=0&camera=orthographic", {
    waitUntil: "domcontentloaded",
  });
  expect(response?.ok()).toBe(true);
  await expect(page.locator("canvas")).toBeVisible({ timeout: sceneCanvasTimeout });
  await expect(page.locator('[data-agent-hq-on-screen-controls="true"]')).toBeVisible({
    timeout: 30_000,
  });

  await expect(page.locator(".workspace-statusbar")).toHaveCount(0);
  const bottomOffsets = await page.evaluate(() => ({
    caption: Number.parseFloat(
      getComputedStyle(document.querySelector<HTMLElement>(".workspace-scene-caption")!).bottom,
    ),
    controls: Number.parseFloat(
      getComputedStyle(
        document.querySelector<HTMLElement>('[data-agent-hq-on-screen-controls="true"]')!,
      ).bottom,
    ),
    viewSwitcher: Number.parseFloat(
      getComputedStyle(document.querySelector<HTMLElement>(".workspace-view-switcher")!).bottom,
    ),
    verticalCenterDelta: (() => {
      const camera = document
        .querySelector<HTMLElement>(".workspace-view-switcher")!
        .getBoundingClientRect();
      const zoom = document
        .querySelector<HTMLElement>('[aria-label="Camera zoom"]')!
        .getBoundingClientRect();
      return Math.abs(camera.top + camera.height / 2 - (zoom.top + zoom.height / 2));
    })(),
  }));

  expect(bottomOffsets.caption).toBeLessThanOrEqual(24);
  expect(bottomOffsets.controls).toBeLessThanOrEqual(32);
  expect(bottomOffsets.viewSwitcher).toBeLessThanOrEqual(24);
  expect(bottomOffsets.verticalCenterDelta).toBeLessThanOrEqual(2);
});

test("desktop runtime keeps the shared scene layout without a status bar", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  });
  const response = await page.goto("/?view=spatial&scene=home&roomDesigner=0&camera=orthographic", {
    waitUntil: "domcontentloaded",
  });
  expect(response?.ok()).toBe(true);
  await expect(page.locator(".workspace-statusbar")).toHaveCount(0);
  await expect(page.locator("canvas")).toBeVisible({ timeout: sceneCanvasTimeout });

  const layout = await page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>(".workspace-scene-viewport")!;
    const canvas = document.querySelector<HTMLCanvasElement>("canvas")!;
    const controls = document.querySelector<HTMLElement>(
      '[data-agent-hq-on-screen-controls="true"]',
    )!;
    const viewportRect = viewport.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const camera = document
      .querySelector<HTMLElement>(".workspace-view-switcher")!
      .getBoundingClientRect();
    const zoom = document
      .querySelector<HTMLElement>('[aria-label="Camera zoom"]')!
      .getBoundingClientRect();
    const sceneTools = document.querySelector<HTMLElement>('.workspace-scene-tools')!
    const loading = document.querySelector<HTMLElement>('[data-scene-loading]')
    return {
      canvasBottom: canvasRect.bottom,
      canvasHeight: canvas.height,
      controlsPosition: getComputedStyle(controls).position,
      viewportBottom: viewportRect.bottom,
      viewportHeight: viewportRect.height,
      controlsBottom: controls.getBoundingClientRect().bottom,
      controlsRight: controls.getBoundingClientRect().right,
      viewportRight: viewportRect.right,
      sceneToolsRight: sceneTools.getBoundingClientRect().right,
      loadingBackground: loading ? getComputedStyle(loading).backgroundColor : '',
      verticalCenterDelta: Math.abs(camera.top + camera.height / 2 - (zoom.top + zoom.height / 2)),
    };
  });

  expect(layout.controlsBottom).toBeLessThanOrEqual(layout.viewportBottom);
  expect(layout.controlsRight).toBeLessThanOrEqual(layout.viewportRight + 1);
  expect(layout.sceneToolsRight).toBeLessThanOrEqual(layout.viewportRight + 1);
  expect(layout.canvasBottom).toBeLessThanOrEqual(layout.viewportBottom + 1);
  expect(Math.abs(layout.canvasHeight - layout.viewportHeight)).toBeLessThanOrEqual(2);
  expect(layout.controlsPosition).toBe("absolute");
  expect(layout.verticalCenterDelta).toBeLessThanOrEqual(2);
});
