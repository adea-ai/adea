import { describe, expect, it } from "vitest";

import { createWorkspaceStore } from "./workspace-store";

describe("workspace store", () => {
  it("keeps selection and view coordination client-only", () => {
    const store = createWorkspaceStore();

    store.getState().setViewMode("focus");

    expect(store.getState()).toMatchObject({
      viewMode: "focus",
    });
  });
});
