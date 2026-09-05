import { expect, test } from "@playwright/test";

test("interactive controls show the pointer cursor", async ({ page }) => {
  await page.goto("/?view=chat");
  const railSwitch = page.getByRole("button", { name: /Switch workspace/i });
  await expect(railSwitch).toBeVisible({ timeout: 60_000 });

  const result = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button:not(:disabled)")];
    const offenders: string[] = [];
    for (const element of buttons) {
      if (getComputedStyle(element).cursor !== "pointer") {
        offenders.push(
          `${element.tagName.toLowerCase()} "${(element.textContent ?? "").trim().slice(0, 40)}" aria=${element.getAttribute("aria-label") ?? "-"}`
        );
      }
    }
    return { total: buttons.length, offenders };
  });

  expect(result.total).toBeGreaterThan(0);
  expect(result.offenders).toEqual([]);
});
