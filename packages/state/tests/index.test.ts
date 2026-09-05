import { afterEach, expect, test } from "bun:test";

import { useWorkspaceStore } from "../src";

const initialState = useWorkspaceStore.getState();

afterEach(() => {
  useWorkspaceStore.setState(initialState, true);
});

test("switchWorkspace starts a fresh workspace context with its configured scene", () => {
  useWorkspaceStore.setState({
    activeSurface: "tasks",
    cameraViewMode: "perspective",
    collapsedRoomIds: ["room-work"],
    drafts: { "channel-work": "unsent work" },
    globalPanel: "plugins",
    mobileSidebarOpen: true,
    selectedAgentId: "agent-work",
    selectedChannelId: "channel-work",
    selectedRoomId: "room-work",
    selectedTaskId: "task-work",
    selectedWorkspaceId: "workspace-work",
    selectedScene: "work",
    threadRootMessageId: "thread-work",
  });

  useWorkspaceStore.getState().switchWorkspace("workspace-home", "home");

  expect(useWorkspaceStore.getState()).toMatchObject({
    activeSurface: "conversation",
    cameraViewMode: "orthographic",
    collapsedRoomIds: [],
    drafts: {},
    globalPanel: null,
    mobileSidebarOpen: false,
    selectedAgentId: null,
    selectedChannelId: null,
    selectedRoomId: null,
    selectedScene: "home",
    selectedTaskId: null,
    selectedWorkspaceId: "workspace-home",
    threadRootMessageId: null,
  });
});
