import { describe, expect, it } from "vitest";

import { buttonVariants } from "./button";

describe("buttonVariants", () => {
  it("keeps destructive actions visibly distinct from the default action", () => {
    expect(buttonVariants({ variant: "destructive" })).toContain("bg-danger");
    expect(buttonVariants({ variant: "default" })).toContain("bg-accent");
  });
});
