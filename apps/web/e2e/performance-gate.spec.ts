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
  teleportTo: (x: number, z: number) => void;
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

test("switching from a reference character to Custom does not surface aborted asset errors", async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  const response = await page.goto(
    "/?view=spatial&scene=home&roomDesigner=0&camera=perspective&character=f_1&debug=1",
    { waitUntil: "domcontentloaded" },
  );
  expect(response?.ok()).toBe(true);
  await expect(page.locator("canvas")).toBeVisible({ timeout: sceneCanvasTimeout });
  await expect(page.getByRole("button", { name: /Open user menu/ })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: /Open user menu/ }).click();
  await expect(page.getByRole("radio", { name: "Custom" })).toBeVisible();
  const customAsset = page.waitForResponse(
    (assetResponse) =>
      assetResponse.url().endsWith("/assets/models/characters.glb") && assetResponse.ok(),
    { timeout: 60_000 },
  );
  await page.getByRole("radio", { name: "Custom" }).click();
  await customAsset;
  await page.waitForTimeout(3_000);

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
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

  const response = await page.goto("/?view=spatial&scene=home&roomDesigner=1&camera=orthographic", {
    waitUntil: "domcontentloaded",
  });
  expect(response?.ok()).toBe(true);
  await expect(page.locator('[aria-label="Room designer"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[aria-label^="Add "]').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1_500);

  expect(pageErrors).toEqual([]);
  expect(catalogWarnings).toEqual([]);
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
