export type WorkspaceSceneId = "home" | "work";

export type WorkspaceViewMode = "perspective" | "orthographic";

export type AgentStatus = "idle" | "working" | "blocked" | "offline";

export type AgentSummary = {
  id: string;
  name: string;
  status: AgentStatus;
  avatarUrl?: string;
};

export type WorkspaceSummary = {
  id: string;
  name: string;
  scene: WorkspaceSceneId;
  updatedAt: string;
};

export type TaskSummary = {
  id: string;
  title: string;
  status: "backlog" | "todo" | "in_progress" | "done";
  assigneeId?: string;
};

export type MessageSummary = {
  id: string;
  workspaceId: string;
  authorId: string;
  body: string;
  createdAt: string;
};
