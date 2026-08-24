export type WorkspaceSceneId = "home" | "work";

export type WorkspaceViewMode = "perspective" | "orthographic";

export type AgentStatus = "idle" | "working" | "blocked" | "offline";

export type UserPrincipalRef = Readonly<{ kind: "user"; userId: string }>;
export type ServicePrincipalRef = Readonly<{ kind: "service"; serviceId: string }>;
export type RuntimeNodePrincipalRef = Readonly<{
  kind: "runtime_node";
  runtimeNodeId: string;
}>;
export type AgentPrincipalRef = Readonly<{ agentId: string; kind: "agent" }>;
export type WorkerPrincipalRef = Readonly<{ kind: "worker"; workerId: string }>;

export type PrincipalRef =
  | UserPrincipalRef
  | ServicePrincipalRef
  | RuntimeNodePrincipalRef
  | AgentPrincipalRef
  | WorkerPrincipalRef;

export function isPrincipalRef(value: unknown): value is PrincipalRef {
  if (!value || typeof value !== "object" || !("kind" in value)) return false;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).length !== 2) return false;
  const hasId = (key: string) =>
    typeof candidate[key] === "string" && candidate[key].trim().length > 0;

  switch (candidate.kind) {
    case "user":
      return hasId("userId");
    case "service":
      return hasId("serviceId");
    case "runtime_node":
      return hasId("runtimeNodeId");
    case "agent":
      return hasId("agentId");
    case "worker":
      return hasId("workerId");
    default:
      return false;
  }
}

export function isUserPrincipalRef(principal: PrincipalRef): principal is UserPrincipalRef {
  return principal.kind === "user";
}

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
