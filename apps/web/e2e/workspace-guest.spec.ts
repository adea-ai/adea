import { expect, test } from "@playwright/test";

const workspace = {
  id: "workspace-guest-e2e",
  name: "My Agent HQ",
  scene: "home",
  updatedAt: "2026-08-25T00:00:00.000Z",
};

test("a guest can use a workspace before opening the optional persistence flow", async ({
  page,
}) => {
  await page.route("**/api/workspaces/bootstrap", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        activeWorkspace: workspace,
        principal: { temporary: true },
        workspaces: [workspace],
      },
    });
  });

  await page.goto("/");
  await expect(page.getByRole("link", { name: "Save workspace" })).toBeVisible();
  await expect(page.locator(".workspace-statusbar")).toHaveCount(0);

  await page.getByRole("link", { name: "Save workspace" }).click();
  await expect(page).toHaveURL(/\/auth\/sign-in\?returnTo=%2F$/);
  await expect(page.getByRole("heading", { name: "Save your workspace" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue without an account" })).toBeVisible();
});
