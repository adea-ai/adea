import { describe, expect, test } from "bun:test";
import { appRouteHref } from "../src/scene-spawn";

describe("scene portal routes", () => {
  test("uses named Portless routes for sibling apps", () => {
    expect(appRouteHref("hq", "/?scene=work", "https://agent-hq.localhost/")).toBe(
      "https://agent-hq.localhost/?scene=work"
    );
    expect(appRouteHref("world", "/?scene=home", "https://agent-hq.localhost/")).toBe(
      "https://world.localhost/?scene=home"
    );
  });

  test("keeps direct development ports as a fallback", () => {
    expect(appRouteHref("world", "/?scene=home", "http://amf-mb-pro:3004/")).toBe(
      "http://amf-mb-pro:3000/?scene=home"
    );
  });
});
