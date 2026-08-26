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
  const userMenu = page.getByRole("button", { name: "Open user menu for Sign in" });
  await expect(userMenu).toBeVisible();
  await expect(page.locator(".workspace-statusbar")).toHaveCount(0);

  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    const layout = await page.evaluate(() => {
      const topbar = document.querySelector<HTMLElement>(".workspace-topbar")!;
      const switcher = document.querySelector<HTMLElement>(".workspace-scene-nav")!;
      const bar = topbar.getBoundingClientRect();
      const control = switcher.getBoundingClientRect();
      return {
        barHeight: bar.height,
        centerDelta: Math.abs(control.left + control.width / 2 - window.innerWidth / 2),
      };
    });
    expect(layout.barHeight).toBeLessThanOrEqual(80);
    expect(layout.centerDelta).toBeLessThanOrEqual(2);
  }

  await userMenu.click();
  await expect(page.getByRole("radiogroup", { name: "Theme" })).toBeVisible();
  const musicSection = page.getByRole("region", { name: "Music" });
  const accountSection = page.getByRole("region", { name: "Account" });
  const musicHeading = musicSection.getByRole("heading", { name: "Music" });
  const musicButton = musicSection.getByRole("button", { name: /music/i });
  const accountHeading = accountSection.getByRole("heading", { name: "Account" });
  const signInButton = accountSection.getByRole("button", { name: "Sign in", exact: true });
  await expect(musicHeading).toBeVisible();
  await expect(musicButton).toBeVisible();
  await expect(accountHeading).toBeVisible();
  await expect(signInButton).toBeVisible();

  const drawerAlignment = await page.evaluate(() => {
    function isRightAligned(headingId: string) {
      const heading = document.getElementById(headingId);
      const section = heading?.closest("section");
      const button = section?.querySelector<HTMLElement>("button");
      if (!heading || !button) return false;
      const headingBox = heading.getBoundingClientRect();
      const buttonBox = button.getBoundingClientRect();
      return buttonBox.left > headingBox.right;
    }

    return {
      account: isRightAligned("account-session-title"),
      music: isRightAligned("account-music-title"),
    };
  });
  expect(drawerAlignment).toEqual({ account: true, music: true });
  await signInButton.click();
  await expect(page).toHaveURL(/\/auth\/sign-in\?returnTo=%2F$/);
  await expect(page.getByRole("heading", { name: "Save your workspace" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue without an account" })).toBeVisible();
});

test("desktop authentication ends on a clear browser success page", async ({ page }) => {
  const callback =
    "agent-hq://auth/callback?code=one-time-code&nonce=nonce-value-12345&state=state-value-12345";
  const fragment = new URLSearchParams({ callback }).toString();
  await page.route("agent-hq://**", (route) => route.abort());

  await page.goto(`/auth/desktop/complete#${fragment}`, { waitUntil: "commit" });

  await expect(page.getByRole("heading", { name: "You’re all set" })).toBeVisible();
  await expect(page.getByText("You can close this tab")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Agent HQ" })).toBeVisible();
  await expect(page).toHaveURL(/\/auth\/desktop\/complete$/);
});
