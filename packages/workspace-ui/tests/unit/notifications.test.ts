import { describe, expect, test } from "bun:test";

import { canonicalNotificationHref, notificationPreview } from "../../src/notifications";

describe("privacy-safe canonical notifications", () => {
  test("routes only through canonical workspace identities", () => {
    expect(
      canonicalNotificationHref({
        channelId: "channel/1",
        messageId: "message 1",
        taskId: "task-1",
        workspaceId: "workspace-1",
      })
    ).toBe("/?workspace=workspace-1&channel=channel%2F1&message=message+1&task=task-1");
  });

  test("does not expose private plaintext without explicit preview authorization", () => {
    const hidden = notificationPreview({
      destination: { channelId: "channel-1", workspaceId: "workspace-1" },
      privateBody: "private canary",
      privateContent: true,
      privatePreviewAuthorized: false,
      sender: "Planner",
    });
    expect(hidden.body).not.toContain("private canary");
    expect(
      notificationPreview({
        destination: { channelId: "channel-1", workspaceId: "workspace-1" },
        privateBody: "private canary",
        privateContent: true,
        privatePreviewAuthorized: true,
        sender: "Planner",
      }).body
    ).toContain("private canary");
  });
});
