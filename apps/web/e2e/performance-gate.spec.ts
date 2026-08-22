import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

type BrowserSceneReport = {
  event: "load" | "runtime" | "dispose" | "error";
  scene: string;
  error?: string;
  milestones?: { playableCharacterMs?: number };
  network?: { transferBytes?: number };
  runtime?: { p95FrameMs?: number };
};

test("home scene meets runtime performance gates", async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  const response = await page.goto("/?scene=home&roomDesigner=0&camera=orthographic", {
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
  await writeFile(".artifacts/scene-performance.json", JSON.stringify(reports, null, 2));

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(reports.some((report) => report.event === "load")).toBe(true);
  expect(reports.some((report) => report.event === "error")).toBe(false);
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
