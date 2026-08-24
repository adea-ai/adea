import { describe, expect, test } from "bun:test";

import { extractReleaseNotes } from "./release-notes.mjs";

const changelog = `# Changelog

## [1.2.0](https://example.test/compare/v1.1.0...v1.2.0) (2026-08-24)

### Features

* add durable release notes

## [1.1.0](https://example.test/compare/v1.0.0...v1.1.0) (2026-08-23)

### Bug Fixes

* preserve the previous section
`;

describe("release notes extraction", () => {
  test("returns exactly one version section", () => {
    expect(extractReleaseNotes(changelog, "1.2.0"))
      .toBe(`## [1.2.0](https://example.test/compare/v1.1.0...v1.2.0) (2026-08-24)

### Features

* add durable release notes
`);
  });

  test("fails when the requested version is absent or malformed", () => {
    expect(() => extractReleaseNotes(changelog, "1.3.0")).toThrow("missing");
    expect(() => extractReleaseNotes(changelog, "latest")).toThrow("semantic version");
  });
});
