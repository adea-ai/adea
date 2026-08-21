import type { AgentSummary, TaskSummary, WorkspaceSummary } from "@agent-hq/types";

export type ApiWorkspaceResponse = {
  workspace: WorkspaceSummary;
  agents: readonly AgentSummary[];
  tasks: readonly TaskSummary[];
};

export type ApiClientOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  getAccessToken?: () => string | undefined;
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
  private readonly fetchImpl: typeof fetch;
  private readonly getAccessToken?: () => string | undefined;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "/api";
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.getAccessToken = options.getAccessToken;
  }

  async getWorkspace(workspaceId: string): Promise<ApiWorkspaceResponse> {
    return this.request<ApiWorkspaceResponse>(`/workspaces/${encodeURIComponent(workspaceId)}`);
  }

  private async request<T>(path: string): Promise<T> {
    const headers = new Headers({ Accept: "application/json" });
    const token = this.getAccessToken?.();
    if (token) headers.set("Authorization", `Bearer ${token}`);

    const requestUrl = /^https?:\/\//i.test(this.baseUrl)
      ? new URL(path, this.baseUrl).toString()
      : `${this.baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
    const response = await this.fetchImpl(requestUrl, { headers });
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
