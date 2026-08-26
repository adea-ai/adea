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

async function runScenePerformanceGate(page: Page, scene: "home" | "work") {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  const response = await page.goto(`/?scene=${scene}&roomDesigner=0&camera=orthographic`, {
    waitUntil: "domcontentloaded",
  });
  expect(response?.ok()).toBe(true);
  await expect(page.locator("canvas")).toBeVisible({ timeout: 30_000 });

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

  const response = await page.goto("/?scene=home&roomDesigner=1&camera=orthographic", {
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
  const response = await page.goto("/?scene=home&roomDesigner=0&camera=orthographic", {
    waitUntil: "domcontentloaded",
  });
  expect(response?.ok()).toBe(true);
  await expect(page.locator("canvas")).toBeVisible({ timeout: 30_000 });
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

test("desktop status bar and overlays stay inside the scene viewport", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  });
  const response = await page.goto("/?scene=home&roomDesigner=0&camera=orthographic", {
    waitUntil: "domcontentloaded",
  });
  expect(response?.ok()).toBe(true);
  await expect(page.locator(".workspace-statusbar")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("canvas")).toBeVisible({ timeout: 30_000 });

  const layout = await page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>(".workspace-scene-viewport")!;
    const statusBar = document.querySelector<HTMLElement>(".workspace-statusbar")!;
    const canvas = document.querySelector<HTMLCanvasElement>("canvas")!;
    const controls = document.querySelector<HTMLElement>(
      '[data-agent-hq-on-screen-controls="true"]',
    )!;
    const viewportRect = viewport.getBoundingClientRect();
    const statusBarRect = statusBar.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const camera = document
      .querySelector<HTMLElement>(".workspace-view-switcher")!
      .getBoundingClientRect();
    const zoom = document
      .querySelector<HTMLElement>('[aria-label="Camera zoom"]')!
      .getBoundingClientRect();
    return {
      canvasBottom: canvasRect.bottom,
      canvasHeight: canvas.height,
      controlsPosition: getComputedStyle(controls).position,
      statusInsideViewport: statusBar.parentElement === viewport,
      statusBarTop: statusBarRect.top,
      viewportBottom: viewportRect.bottom,
      viewportHeight: viewportRect.height,
      controlsBottom: controls.getBoundingClientRect().bottom,
      verticalCenterDelta: Math.abs(camera.top + camera.height / 2 - (zoom.top + zoom.height / 2)),
    };
  });

  expect(layout.statusInsideViewport).toBe(true);
  expect(layout.statusBarTop).toBeLessThan(layout.viewportBottom);
  expect(layout.controlsBottom).toBeLessThan(layout.statusBarTop);
  expect(layout.canvasBottom).toBeLessThanOrEqual(layout.viewportBottom + 1);
  expect(Math.abs(layout.canvasHeight - layout.viewportHeight)).toBeLessThanOrEqual(2);
  expect(layout.controlsPosition).toBe("absolute");
  expect(layout.verticalCenterDelta).toBeLessThanOrEqual(2);
});
