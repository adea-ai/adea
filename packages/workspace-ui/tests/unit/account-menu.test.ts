import { describe, expect, test } from "bun:test";

import {
  accountMenuItems,
  accountMenuItemsForPlatform,
  accountSessionItem,
} from "../../src/account-menu-model";

describe("account menu contract", () => {
  test("keeps the account menu order and disables unavailable destinations", () => {
    expect(accountMenuItems.map(({ id }) => id)).toEqual([
      "mobile",
      "about",
      "help",
      "feedback",
      "updates",
      "settings",
    ]);
    expect(accountMenuItems.filter(({ disabled }) => disabled).map(({ id }) => id)).toEqual([
      "mobile",
      "help",
      "feedback",
    ]);
    expect(accountMenuItems.filter(({ disabled }) => !disabled).map(({ id }) => id)).toEqual([
      "about",
      "updates",
      "settings",
    ]);
    expect(accountMenuItems.find(({ id }) => id === "updates")).toMatchObject({
      desktopOnly: true,
    });
  });

  test("keeps desktop update controls out of web menus", () => {
    expect(accountMenuItemsForPlatform("web").map(({ id }) => id)).toEqual([
      "mobile",
      "about",
      "help",
      "feedback",
      "settings",
    ]);
    expect(accountMenuItemsForPlatform("desktop").map(({ id }) => id)).toContain("updates");
  });

  test("uses the current session action at the bottom of the menu", () => {
    expect(accountSessionItem(false)).toEqual({ id: "sign-in", label: "Sign in", disabled: false });
    expect(accountSessionItem(true)).toEqual({
      id: "sign-out",
      label: "Sign out",
      disabled: false,
    });
  });
});
