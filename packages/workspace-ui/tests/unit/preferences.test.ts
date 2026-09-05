import { describe, expect, test } from "bun:test";

import {
  createBrowserSettingsProvider,
  normalizeWorkspacePreferences,
} from "../../src/preferences";

describe("workspace preferences boundary", () => {
  test("normalizes untrusted persisted values to the supported M2 shape", () => {
    expect(
      normalizeWorkspacePreferences({
        dictationLocale: " en-US ",
        notifyMentions: false,
        notifyTasks: "yes",
        privateNotificationPreviews: true,
        secret: "must-not-survive",
      })
    ).toEqual({
      dictationLocale: "en-US",
      notifyMentions: false,
      notifyTasks: true,
      privateNotificationPreviews: true,
      version: 1,
    });
  });

  test("round trips through the typed provider without runtime credentials", async () => {
    const values = new Map<string, string>();
    const provider = createBrowserSettingsProvider({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
    });
    const saved = await provider.save({
      dictationLocale: "es-PR",
      notifyMentions: true,
      notifyTasks: false,
      privateNotificationPreviews: false,
      version: 1,
    });
    expect(await provider.load()).toEqual(saved);
    expect([...values.values()].join("")).not.toContain("credential");
  });
});
