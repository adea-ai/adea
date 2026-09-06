import type {
  AgentSummary,
  ArtifactLocation,
  ArtifactSummary,
  ChannelReadStateSummary,
  ChannelSummary,
  ConversationParticipantRef,
  ContentRefSummary,
  MessageSummary,
  PrincipalRef,
  RoomSummary,
  TaskKind,
  TaskSummary,
  WorkspaceSummary,
  WorkspaceSearchPage,
} from "@adea-ai/types";

export type ApiAgentCreateInput = Readonly<{
  avatarRef?: string;
  characterRef?: string;
  name: string;
  presentationMetadata?: Readonly<Record<string, string>>;
  profileId: string;
  profileVersion: string;
  roleSummary?: string;
  roomId?: string;
}>;
export type ApiAgentPresentationInput = Readonly<{
  avatarRef?: string | null;
  characterRef?: string | null;
  name?: string;
  presentationMetadata?: Readonly<Record<string, string>>;
  roleSummary?: string | null;
}>;
export type ApiAgentProfileInput = Readonly<{
  profileId: string;
  profileState?: "available" | "deprecated" | "missing";
  profileVersion: string;
}>;
export type ApiAgentResponse = Readonly<{ agent: AgentSummary }>;

export type ApiArtifactCreateInput = Readonly<{
  agentId?: string;
  availability?: ArtifactSummary["availability"];
  checksumSha256: string;
  executionRef?: string;
  filename: string;
  location: ArtifactLocation;
  mediaType: string;
  provenance?: Readonly<Record<string, unknown>>;
  retentionPolicy?: ArtifactSummary["retentionPolicy"];
  sensitivity?: ArtifactSummary["sensitivity"];
  sizeBytes: number;
  sourceArtifactRef: string;
  sourcePrincipal: PrincipalRef;
  taskId?: string;
}>;
export type ApiArtifactResponse = Readonly<{ artifact: ArtifactSummary }>;

export type ApiTaskCommand = Readonly<{
  correlationId?: string;
  expectedVersion?: number;
  idempotencyKey: string;
  requestId: string;
}>;
export type ApiTaskCreateInput = Readonly<{
  agentId?: string;
  artifactRefs?: readonly string[];
  controlPlaneExecutionRef?: string;
  controlPlaneWorkflowRef?: string;
  conversation?: Readonly<{
    channelId?: string;
    messageId?: string;
    threadRootMessageId?: string;
  }>;
  dependencyIds?: readonly string[];
  kind?: TaskKind;
  objective?: string;
  objectiveContentRefId?: string;
  priority?: "low" | "normal" | "high" | "urgent";
  roomId?: string;
  title: string;
}>;
export type ApiTaskUpdateInput = Readonly<{
  controlPlaneExecutionRef?: string | null;
  controlPlaneWorkflowRef?: string | null;
  kind?: TaskKind;
  objective?: string;
  objectiveContentRefId?: string;
  priority?: "low" | "normal" | "high" | "urgent";
  title?: string;
}>;
export type ApiTaskResponse = Readonly<{ task: TaskSummary }>;

export type ApiContentRefCreateInput = Readonly<{
  availability: Exclude<ContentRefSummary["availability"], "deleted">;
  contentType: ContentRefSummary["contentType"];
  digestSha256: string;
  id: string;
  keyVersion: number;
  messageId?: string;
  schemaVersion: number;
  sensitivity: ContentRefSummary["sensitivity"];
  storagePolicy: ContentRefSummary["storagePolicy"];
  synchronizationPolicy: ContentRefSummary["synchronizationPolicy"];
  taskId?: string;
}>;
export type ApiContentRefUpdateInput = Readonly<{
  availability: ContentRefSummary["availability"];
  digestSha256: string;
  expectedRevision: number;
  keyVersion: number;
  revision: number;
}>;
export type ApiContentRefResponse = Readonly<{ contentRef: ContentRefSummary }>;
export type ApiReadStateResponse = Readonly<{ readState: readonly ChannelReadStateSummary[] }>;

export type ApiChannelResponse = Readonly<{ channel: ChannelSummary }>;
export type ApiMessageResponse = Readonly<{ message: MessageSummary }>;
export type ApiMessagePage = Readonly<{
  messages: readonly MessageSummary[];
  nextAfterSequence?: number;
}>;
export type ApiMessageCreateInput = Readonly<{
  artifactIds?: readonly string[];
  bodyContentRefId?: string;
  bodyText?: string;
  executionRef?: string;
  externalSessionRef?: string;
  idempotencyKey: string;
  mentions?: readonly ConversationParticipantRef[];
  replyToMessageId?: string;
  taskId?: string;
  threadRootMessageId?: string;
}>;

function taskCommandHeaders(command: ApiTaskCommand): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Idempotency-Key": command.idempotencyKey,
    "X-Request-ID": command.requestId,
    ...(command.correlationId ? { "X-Correlation-ID": command.correlationId } : {}),
    ...(command.expectedVersion !== undefined
      ? { "If-Match": String(command.expectedVersion) }
      : {}),
  };
}

export type ApiRoomCreateInput = Readonly<{
  functionKey: string;
  layoutRef?: string;
  name: string;
  spatialRef?: string;
  templateKey?: string;
}>;

export type ApiRoomUpdateInput = Readonly<{
  functionKey?: string;
  layoutRef?: string | null;
  name?: string;
  spatialRef?: string | null;
  templateKey?: string | null;
}>;

export type ApiRoomResponse = Readonly<{ room: RoomSummary }>;
export type ApiRoomArchiveResponse = Readonly<{ archived: true }>;

export type ApiWorkspaceResponse = {
  workspace: WorkspaceSummary;
  agents: readonly AgentSummary[];
  tasks: readonly TaskSummary[];
};

export type ApiWorkspaceBootstrapResponse = {
  activeWorkspace: WorkspaceSummary;
  principal: Readonly<{ displayName?: string; temporary: boolean; userId?: string }>;
  sessionRotated: boolean;
  temporaryCredential?: string;
  workspaces: readonly WorkspaceSummary[];
};

export type ApiWorkspaceCreateResponse = {
  created: boolean;
  workspace: WorkspaceSummary;
};

export type ApiWorkspaceClaimResponse = Readonly<{ claimed: true }>;

export type ApiWorkspaceReopenResponse = Readonly<{ workspace: WorkspaceSummary }>;

export type ApiMarketplaceCatalogResponse = Readonly<{
  catalogId: string;
  releaseId: string;
  state: "ready" | "stale";
  artifacts: Readonly<{
    "catalog.v1.json": string;
    "catalog-latest.v1.json": string;
    "catalog-summary.v1.json": string;
    "categories.v1.json": string;
    "compatibility.v1.json": string;
    "integrity.json": string;
    "sources.lock.json": string;
  }>;
  installations?: readonly Readonly<{
    pluginId: string;
    releaseId: string;
    canonicalContentDigest: string;
    state:
      "pending-authorization" | "unavailable" | "rejected-by-policy" | "installed" | "superseded";
  }>[];
}>;

export type ApiMarketplaceInstallInput = Readonly<{
  pluginId: string;
  releaseId: string;
  canonicalContentDigest: string;
  requestedHarness: string;
  workspaceIdentity: Readonly<{ userId: string; workspaceId: string }>;
  idempotencyKey: string;
}>;

export type ApiMarketplaceInstallResponse = Readonly<{
  installationId: string;
  pluginId: string;
  releaseId: string;
  canonicalContentDigest: string;
  state:
    "pending-authorization" | "unavailable" | "rejected-by-policy" | "installed" | "superseded";
  requiredConnectors: readonly string[];
  requiredCredentials: readonly string[];
  message?: string;
}>;

export type ApiDesktopSessionCredential = Readonly<{
  credential: string;
  sessionId: string;
}>;

export type ApiClientOptions = {
  baseUrl?: string;
  client?: "browser" | "desktop";
  fetchImpl?: typeof fetch;
  getAccessToken?: () => string | undefined;
  getDesktopSession?: () => ApiDesktopSessionCredential | undefined;
  getTemporaryCredential?: () => string | undefined;
};

export class ApiClientError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
  }
}

export class AgentHqApiClient {
  private readonly baseUrl: string;
  private readonly client: "browser" | "desktop";
  private readonly fetchImpl: typeof fetch;
  private readonly getAccessToken?: () => string | undefined;
  private readonly getDesktopSession?: () => ApiDesktopSessionCredential | undefined;
  private readonly getTemporaryCredential?: () => string | undefined;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "/api";
    this.client = options.client ?? "browser";
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.getAccessToken = options.getAccessToken;
    this.getDesktopSession = options.getDesktopSession;
    this.getTemporaryCredential = options.getTemporaryCredential;
  }

  async bootstrapWorkspace(): Promise<ApiWorkspaceBootstrapResponse> {
    return this.request<ApiWorkspaceBootstrapResponse>("/workspaces/bootstrap", { method: "POST" });
  }

  async listWorkspaces(): Promise<readonly WorkspaceSummary[]> {
    return this.request<readonly WorkspaceSummary[]>("/workspaces");
  }

  async createWorkspace(
    input: Readonly<{
      idempotencyKey: string;
      name: string;
      scene?: "home" | "work";
    }>
  ): Promise<ApiWorkspaceCreateResponse> {
    return this.request<ApiWorkspaceCreateResponse>("/workspaces", {
      body: JSON.stringify({ name: input.name, scene: input.scene }),
      headers: { "Content-Type": "application/json", "Idempotency-Key": input.idempotencyKey },
      method: "POST",
    });
  }

  async getWorkspace(workspaceId: string): Promise<ApiWorkspaceResponse> {
    return this.request<ApiWorkspaceResponse>(`/workspaces/${encodeURIComponent(workspaceId)}`);
  }

  async reopenWorkspace(workspaceId: string): Promise<ApiWorkspaceReopenResponse> {
    return this.request<ApiWorkspaceReopenResponse>(
      `/workspaces/${encodeURIComponent(workspaceId)}/reopen`,
      { method: "POST" }
    );
  }

  async getMarketplaceCatalog(workspaceId: string): Promise<ApiMarketplaceCatalogResponse> {
    return this.request<ApiMarketplaceCatalogResponse>("/marketplace/catalog", {
      body: JSON.stringify({ workspaceId }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
  }

  async requestMarketplaceInstall(
    workspaceId: string,
    input: ApiMarketplaceInstallInput
  ): Promise<ApiMarketplaceInstallResponse> {
    return this.request<ApiMarketplaceInstallResponse>("/marketplace/install", {
      body: JSON.stringify(input),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
  }

  async claimTemporaryWorkspace(temporaryCredential: string): Promise<ApiWorkspaceClaimResponse> {
    return this.request<ApiWorkspaceClaimResponse>("/workspaces/claim", {
      headers: { "X-Agent-HQ-Temporary-Session": temporaryCredential },
      method: "POST",
    });
  }

  async listRooms(workspaceId: string): Promise<readonly RoomSummary[]> {
    return this.request<readonly RoomSummary[]>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/rooms`
    );
  }

  async getRoom(workspaceId: string, roomId: string): Promise<ApiRoomResponse> {
    return this.request<ApiRoomResponse>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/rooms/${encodeURIComponent(roomId)}`
    );
  }

  async createRoom(workspaceId: string, input: ApiRoomCreateInput): Promise<ApiRoomResponse> {
    return this.request<ApiRoomResponse>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/rooms`,
      {
        body: JSON.stringify(input),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }
    );
  }

  async updateRoom(
    workspaceId: string,
    roomId: string,
    input: ApiRoomUpdateInput
  ): Promise<ApiRoomResponse> {
    return this.request<ApiRoomResponse>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/rooms/${encodeURIComponent(roomId)}`,
      {
        body: JSON.stringify(input),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      }
    );
  }

  async archiveRoom(workspaceId: string, roomId: string): Promise<ApiRoomArchiveResponse> {
    return this.request<ApiRoomArchiveResponse>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/rooms/${encodeURIComponent(roomId)}`,
      { method: "DELETE" }
    );
  }

  async reorderRooms(
    workspaceId: string,
    roomIds: readonly string[]
  ): Promise<readonly RoomSummary[]> {
    return this.request<readonly RoomSummary[]>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/rooms/reorder`,
      {
        body: JSON.stringify({ roomIds }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }
    );
  }

  async listAgents(workspaceId: string): Promise<readonly AgentSummary[]> {
    return this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/agents`);
  }

  async getAgent(workspaceId: string, agentId: string): Promise<ApiAgentResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}`
    );
  }

  async createAgent(workspaceId: string, input: ApiAgentCreateInput): Promise<ApiAgentResponse> {
    return this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/agents`, {
      body: JSON.stringify(input),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
  }

  async assignAgentToRoom(
    workspaceId: string,
    agentId: string,
    roomId: string | null
  ): Promise<ApiAgentResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/room`,
      {
        body: JSON.stringify({ roomId }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }
    );
  }

  async updateAgentPresentation(
    workspaceId: string,
    agentId: string,
    input: ApiAgentPresentationInput
  ): Promise<ApiAgentResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/presentation`,
      {
        body: JSON.stringify(input),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      }
    );
  }

  async changeAgentProfile(
    workspaceId: string,
    agentId: string,
    input: ApiAgentProfileInput
  ): Promise<ApiAgentResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/profile`,
      {
        body: JSON.stringify(input),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }
    );
  }

  async archiveAgent(workspaceId: string, agentId: string): Promise<Readonly<{ archived: true }>> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}`,
      { method: "DELETE" }
    );
  }

  async listTasks(workspaceId: string): Promise<readonly TaskSummary[]> {
    return this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/tasks`);
  }

  async createContentRef(
    workspaceId: string,
    input: ApiContentRefCreateInput
  ): Promise<ApiContentRefResponse> {
    return this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/content-refs`, {
      body: JSON.stringify(input),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
  }

  async getContentRef(workspaceId: string, contentId: string): Promise<ApiContentRefResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/content-refs/${encodeURIComponent(contentId)}`
    );
  }

  async updateContentRef(
    workspaceId: string,
    contentId: string,
    input: ApiContentRefUpdateInput
  ): Promise<ApiContentRefResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/content-refs/${encodeURIComponent(contentId)}`,
      {
        body: JSON.stringify(input),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      }
    );
  }

  async getReadState(workspaceId: string): Promise<ApiReadStateResponse> {
    return this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/read-state`);
  }

  async markAllRead(workspaceId: string): Promise<ApiReadStateResponse> {
    return this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/read-state`, {
      body: JSON.stringify({ action: "read_all" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
  }

  async setChannelReadState(
    workspaceId: string,
    channelId: string,
    input: Readonly<{ action: "read" | "unread"; lastReadSequence?: number }>
  ): Promise<ApiReadStateResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/read-state/channels/${encodeURIComponent(channelId)}`,
      {
        body: JSON.stringify(input),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }
    );
  }

  async setThreadReadState(
    workspaceId: string,
    channelId: string,
    threadRootMessageId: string,
    input: Readonly<{ action: "read" | "unread"; lastReadSequence?: number }>
  ): Promise<ApiReadStateResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/read-state/threads/${encodeURIComponent(threadRootMessageId)}`,
      {
        body: JSON.stringify({ ...input, channelId }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }
    );
  }

  async searchWorkspace(
    workspaceId: string,
    query: string,
    options: Readonly<{
      channelId?: string;
      limit?: number;
      offset?: number;
      signal?: AbortSignal;
    }> = {}
  ): Promise<WorkspaceSearchPage> {
    const parameters = new URLSearchParams({ q: query });
    if (options.channelId) parameters.set("channelId", options.channelId);
    if (options.limit !== undefined) parameters.set("limit", String(options.limit));
    if (options.offset !== undefined) parameters.set("offset", String(options.offset));
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/search?${parameters.toString()}`,
      { ...(options.signal ? { signal: options.signal } : {}) }
    );
  }

  async getTask(workspaceId: string, taskId: string): Promise<ApiTaskResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/tasks/${encodeURIComponent(taskId)}`
    );
  }

  async createTask(
    workspaceId: string,
    input: ApiTaskCreateInput,
    command: ApiTaskCommand
  ): Promise<ApiTaskResponse> {
    return this.taskCommand(workspaceId, undefined, undefined, input, command);
  }

  async updateTask(
    workspaceId: string,
    taskId: string,
    input: ApiTaskUpdateInput,
    command: ApiTaskCommand
  ): Promise<ApiTaskResponse> {
    return this.taskCommand(workspaceId, taskId, undefined, input, command, "PATCH");
  }

  async assignTask(
    workspaceId: string,
    taskId: string,
    agentId: string | null,
    command: ApiTaskCommand
  ): Promise<ApiTaskResponse> {
    return this.taskCommand(workspaceId, taskId, "assign", { agentId }, command);
  }

  async moveTaskToRoom(
    workspaceId: string,
    taskId: string,
    roomId: string | null,
    command: ApiTaskCommand
  ): Promise<ApiTaskResponse> {
    return this.taskCommand(workspaceId, taskId, "room", { roomId }, command);
  }

  async queueTask(workspaceId: string, taskId: string, command: ApiTaskCommand) {
    return this.taskCommand(workspaceId, taskId, "queue", {}, command);
  }

  async startTask(workspaceId: string, taskId: string, command: ApiTaskCommand) {
    return this.taskCommand(workspaceId, taskId, "start", {}, command);
  }

  async reviewTask(workspaceId: string, taskId: string, command: ApiTaskCommand) {
    return this.taskCommand(workspaceId, taskId, "review", {}, command);
  }

  async completeTask(workspaceId: string, taskId: string, command: ApiTaskCommand) {
    return this.taskCommand(workspaceId, taskId, "complete", {}, command);
  }

  async cancelTask(workspaceId: string, taskId: string, command: ApiTaskCommand) {
    return this.taskCommand(workspaceId, taskId, "cancel", {}, command);
  }

  async archiveTask(workspaceId: string, taskId: string, command: ApiTaskCommand) {
    return this.taskCommand(workspaceId, taskId, "archive", {}, command);
  }

  async listArtifacts(workspaceId: string): Promise<readonly ArtifactSummary[]> {
    return this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts`);
  }

  async getArtifact(workspaceId: string, artifactId: string): Promise<ApiArtifactResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}`
    );
  }

  async createArtifact(
    workspaceId: string,
    input: ApiArtifactCreateInput
  ): Promise<ApiArtifactResponse> {
    return this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts`, {
      body: JSON.stringify(input),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
  }

  async setArtifactAvailability(
    workspaceId: string,
    artifactId: string,
    availability: ArtifactSummary["availability"],
    expectedVersion: number
  ): Promise<ApiArtifactResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}`,
      {
        body: JSON.stringify({ availability }),
        headers: { "Content-Type": "application/json", "If-Match": String(expectedVersion) },
        method: "PATCH",
      }
    );
  }

  async deleteArtifact(
    workspaceId: string,
    artifactId: string,
    expectedVersion: number
  ): Promise<ApiArtifactResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}`,
      { headers: { "If-Match": String(expectedVersion) }, method: "DELETE" }
    );
  }

  async listChannels(workspaceId: string): Promise<readonly ChannelSummary[]> {
    return this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/channels`);
  }

  async getChannel(workspaceId: string, channelId: string): Promise<ApiChannelResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}`
    );
  }

  async createRoomChannel(
    workspaceId: string,
    input: Readonly<{ idempotencyKey: string; roomId: string; taskId?: string; title: string }>
  ): Promise<ApiChannelResponse> {
    return this.createChannel(workspaceId, { ...input, kind: "room" });
  }

  async createDirectAgentChannel(
    workspaceId: string,
    agentId: string
  ): Promise<ApiChannelResponse> {
    return this.createChannel(workspaceId, {
      agentId,
      idempotencyKey: `direct-agent:${agentId}`,
      kind: "direct_agent",
      title: "Direct conversation",
    });
  }

  async createGroupChannel(
    workspaceId: string,
    input: Readonly<{ idempotencyKey: string; taskId?: string; title: string }>
  ): Promise<ApiChannelResponse> {
    return this.createChannel(workspaceId, { ...input, kind: "group" });
  }

  async updateChannel(
    workspaceId: string,
    channelId: string,
    input: Readonly<{
      taskId?: string | null;
      title?: string;
      visibility?: "workspace" | "participants";
    }>,
    expectedVersion: number
  ): Promise<ApiChannelResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}`,
      {
        body: JSON.stringify(input),
        headers: { "Content-Type": "application/json", "If-Match": String(expectedVersion) },
        method: "PATCH",
      }
    );
  }

  async setChannelParticipants(
    workspaceId: string,
    channelId: string,
    participants: readonly ConversationParticipantRef[],
    expectedVersion: number
  ): Promise<ApiChannelResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/participants`,
      {
        body: JSON.stringify({ participants }),
        headers: { "Content-Type": "application/json", "If-Match": String(expectedVersion) },
        method: "POST",
      }
    );
  }

  async archiveChannel(
    workspaceId: string,
    channelId: string,
    expectedVersion: number
  ): Promise<ApiChannelResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}`,
      { headers: { "If-Match": String(expectedVersion) }, method: "DELETE" }
    );
  }

  async listMessages(
    workspaceId: string,
    channelId: string,
    options: Readonly<{
      afterSequence?: number;
      limit?: number;
      threadRootMessageId?: string;
    }> = {}
  ): Promise<ApiMessagePage> {
    const query = new URLSearchParams();
    if (options.afterSequence !== undefined)
      query.set("afterSequence", String(options.afterSequence));
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.threadRootMessageId) query.set("threadRootMessageId", options.threadRootMessageId);
    const suffix = query.size ? `?${query}` : "";
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/messages${suffix}`
    );
  }

  async createMessage(
    workspaceId: string,
    channelId: string,
    input: ApiMessageCreateInput
  ): Promise<ApiMessageResponse> {
    const { idempotencyKey, ...body } = input;
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/messages`,
      {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        method: "POST",
      }
    );
  }

  async getMessage(workspaceId: string, messageId: string): Promise<ApiMessageResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/messages/${encodeURIComponent(messageId)}`
    );
  }

  async editMessage(
    workspaceId: string,
    messageId: string,
    input: Readonly<{ bodyContentRefId?: string | null; bodyText?: string | null }>,
    expectedVersion: number
  ): Promise<ApiMessageResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/messages/${encodeURIComponent(messageId)}`,
      {
        body: JSON.stringify(input),
        headers: { "Content-Type": "application/json", "If-Match": String(expectedVersion) },
        method: "PATCH",
      }
    );
  }

  async deleteMessage(
    workspaceId: string,
    messageId: string,
    expectedVersion: number
  ): Promise<ApiMessageResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/messages/${encodeURIComponent(messageId)}`,
      { headers: { "If-Match": String(expectedVersion) }, method: "DELETE" }
    );
  }

  private async createChannel(
    workspaceId: string,
    input: Readonly<{
      agentId?: string;
      idempotencyKey: string;
      kind: "room" | "direct_agent" | "group";
      roomId?: string;
      taskId?: string;
      title: string;
    }>
  ): Promise<ApiChannelResponse> {
    const { idempotencyKey, ...body } = input;
    return this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/channels`, {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      method: "POST",
    });
  }

  async setTaskDependencies(
    workspaceId: string,
    taskId: string,
    dependencyIds: readonly string[],
    command: ApiTaskCommand
  ) {
    return this.taskCommand(workspaceId, taskId, "dependencies", { dependencyIds }, command);
  }

  async setTaskArtifactReferences(
    workspaceId: string,
    taskId: string,
    artifactRefs: readonly string[],
    command: ApiTaskCommand
  ) {
    return this.taskCommand(workspaceId, taskId, "artifacts", { artifactRefs }, command);
  }

  async setTaskConversationReferences(
    workspaceId: string,
    taskId: string,
    conversation: Readonly<{
      channelId?: string | null;
      messageId?: string | null;
      threadRootMessageId?: string | null;
    }>,
    command: ApiTaskCommand
  ) {
    return this.taskCommand(workspaceId, taskId, "conversation", conversation, command);
  }

  private async taskCommand(
    workspaceId: string,
    taskId: string | undefined,
    action: string | undefined,
    payload: unknown,
    command: ApiTaskCommand,
    method = "POST"
  ): Promise<ApiTaskResponse> {
    const path = [
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/tasks`,
      taskId ? encodeURIComponent(taskId) : undefined,
      action,
    ]
      .filter(Boolean)
      .join("/");
    return this.request(path, {
      body: JSON.stringify(payload),
      headers: taskCommandHeaders(command),
      method,
    });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (this.client === "desktop") headers.set("X-Agent-HQ-Client", "desktop");
    const desktopSession = this.getDesktopSession?.();
    const token = this.getAccessToken?.();
    const temporaryCredential = this.getTemporaryCredential?.();
    if (desktopSession) {
      headers.set("Authorization", `Desktop ${desktopSession.credential}`);
      headers.set("X-Agent-HQ-Desktop-Session", desktopSession.sessionId);
    } else if (token) headers.set("Authorization", `Bearer ${token}`);
    else if (temporaryCredential) headers.set("Authorization", `Temporary ${temporaryCredential}`);

    const requestUrl = /^https?:\/\//i.test(this.baseUrl)
      ? new URL(path.replace(/^\//, ""), `${this.baseUrl.replace(/\/$/, "")}/`).toString()
      : `${this.baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
    const response = await this.fetchImpl(requestUrl, {
      ...init,
      credentials: init.credentials ?? (this.client === "desktop" ? "omit" : "include"),
      headers,
    });
    if (!response.ok) {
      let code: string | undefined;
      try {
        const payload = (await response.json()) as { code?: string; message?: string };
        code = payload.code;
        throw new ApiClientError(payload.message ?? response.statusText, response.status, code);
      } catch (error) {
        if (error instanceof ApiClientError) throw error;
        throw new ApiClientError(response.statusText, response.status, code);
      }
    }
    return (await response.json()) as T;
  }
}

export function createApiClient(options?: ApiClientOptions): AgentHqApiClient {
  return new AgentHqApiClient(options);
}
