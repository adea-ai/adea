import { describe, expect, test } from "bun:test";
import { plainTextFromMarkdown } from "../src/lib/version-notes";

describe("version notes", () => {
  test("renders release markdown as plain readable text", () => {
    expect(
      plainTextFromMarkdown(
        "## Features\n\n- **Rooms:** add [Home](https://example.com)\n- `version` check\n\n---\n\n1. Restart safely",
      ),
    ).toBe("Features\n\n• Rooms: add Home\n• version check\n\nRestart safely");
  });

  test("keeps ordinary text intact", () => {
    expect(plainTextFromMarkdown("A small release.\n\nReady to use.")).toBe(
      "A small release.\n\nReady to use.",
    );
  });
});
