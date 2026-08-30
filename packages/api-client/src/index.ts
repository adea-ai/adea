import type { AgentSummary, RoomSummary, TaskSummary, WorkspaceSummary } from '@agent-hq/types'

export type ApiRoomCreateInput = Readonly<{
  functionKey: string
  layoutRef?: string
  name: string
  spatialRef?: string
  templateKey?: string
}>

export type ApiRoomUpdateInput = Readonly<{
  functionKey?: string
  layoutRef?: string | null
  name?: string
  spatialRef?: string | null
  templateKey?: string | null
}>

export type ApiRoomResponse = Readonly<{ room: RoomSummary }>
export type ApiRoomArchiveResponse = Readonly<{ archived: true }>

export type ApiWorkspaceResponse = {
  workspace: WorkspaceSummary
  agents: readonly AgentSummary[]
  tasks: readonly TaskSummary[]
}

export type ApiWorkspaceBootstrapResponse = {
  activeWorkspace: WorkspaceSummary
  principal: Readonly<{ displayName?: string; temporary: boolean }>
  temporaryCredential?: string
  workspaces: readonly WorkspaceSummary[]
}

export type ApiWorkspaceCreateResponse = {
  created: boolean
  workspace: WorkspaceSummary
}

export type ApiWorkspaceClaimResponse = Readonly<{ claimed: true }>

export type ApiWorkspaceReopenResponse = Readonly<{ workspace: WorkspaceSummary }>

export type ApiDesktopSessionCredential = Readonly<{
  credential: string
  sessionId: string
}>

export type ApiClientOptions = {
  baseUrl?: string
  client?: 'browser' | 'desktop'
  fetchImpl?: typeof fetch
  getAccessToken?: () => string | undefined
  getDesktopSession?: () => ApiDesktopSessionCredential | undefined
  getTemporaryCredential?: () => string | undefined
}

export class ApiClientError extends Error {
  readonly status: number
  readonly code?: string

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'ApiClientError'
    this.status = status
    this.code = code
  }
}

export class AgentHqApiClient {
  private readonly baseUrl: string
  private readonly client: 'browser' | 'desktop'
  private readonly fetchImpl: typeof fetch
  private readonly getAccessToken?: () => string | undefined
  private readonly getDesktopSession?: () => ApiDesktopSessionCredential | undefined
  private readonly getTemporaryCredential?: () => string | undefined

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? '/api'
    this.client = options.client ?? 'browser'
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.getAccessToken = options.getAccessToken
    this.getDesktopSession = options.getDesktopSession
    this.getTemporaryCredential = options.getTemporaryCredential
  }

  async bootstrapWorkspace(): Promise<ApiWorkspaceBootstrapResponse> {
    return this.request<ApiWorkspaceBootstrapResponse>('/workspaces/bootstrap', { method: 'POST' })
  }

  async listWorkspaces(): Promise<readonly WorkspaceSummary[]> {
    return this.request<readonly WorkspaceSummary[]>('/workspaces')
  }

  async createWorkspace(
    input: Readonly<{
      idempotencyKey: string
      name: string
      scene?: 'home' | 'work'
    }>
  ): Promise<ApiWorkspaceCreateResponse> {
    return this.request<ApiWorkspaceCreateResponse>('/workspaces', {
      body: JSON.stringify({ name: input.name, scene: input.scene }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': input.idempotencyKey },
      method: 'POST',
    })
  }

  async getWorkspace(workspaceId: string): Promise<ApiWorkspaceResponse> {
    return this.request<ApiWorkspaceResponse>(`/workspaces/${encodeURIComponent(workspaceId)}`)
  }

  async reopenWorkspace(workspaceId: string): Promise<ApiWorkspaceReopenResponse> {
    return this.request<ApiWorkspaceReopenResponse>(
      `/workspaces/${encodeURIComponent(workspaceId)}/reopen`,
      { method: 'POST' }
    )
  }

  async claimTemporaryWorkspace(temporaryCredential: string): Promise<ApiWorkspaceClaimResponse> {
    return this.request<ApiWorkspaceClaimResponse>('/workspaces/claim', {
      headers: { 'X-Agent-HQ-Temporary-Session': temporaryCredential },
      method: 'POST',
    })
  }

  async listRooms(workspaceId: string): Promise<readonly RoomSummary[]> {
    return this.request<readonly RoomSummary[]>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/rooms`
    )
  }

  async getRoom(workspaceId: string, roomId: string): Promise<ApiRoomResponse> {
    return this.request<ApiRoomResponse>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/rooms/${encodeURIComponent(roomId)}`
    )
  }

  async createRoom(workspaceId: string, input: ApiRoomCreateInput): Promise<ApiRoomResponse> {
    return this.request<ApiRoomResponse>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/rooms`,
      {
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }
    )
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
        headers: { 'Content-Type': 'application/json' },
        method: 'PATCH',
      }
    )
  }

  async archiveRoom(workspaceId: string, roomId: string): Promise<ApiRoomArchiveResponse> {
    return this.request<ApiRoomArchiveResponse>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/rooms/${encodeURIComponent(roomId)}`,
      { method: 'DELETE' }
    )
  }

  async reorderRooms(
    workspaceId: string,
    roomIds: readonly string[]
  ): Promise<readonly RoomSummary[]> {
    return this.request<readonly RoomSummary[]>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/rooms/reorder`,
      {
        body: JSON.stringify({ roomIds }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }
    )
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('Accept', 'application/json')
    if (this.client === 'desktop') headers.set('X-Agent-HQ-Client', 'desktop')
    const desktopSession = this.getDesktopSession?.()
    const token = this.getAccessToken?.()
    const temporaryCredential = this.getTemporaryCredential?.()
    if (desktopSession) {
      headers.set('Authorization', `Desktop ${desktopSession.credential}`)
      headers.set('X-Agent-HQ-Desktop-Session', desktopSession.sessionId)
    } else if (token) headers.set('Authorization', `Bearer ${token}`)
    else if (temporaryCredential) headers.set('Authorization', `Temporary ${temporaryCredential}`)

    const requestUrl = /^https?:\/\//i.test(this.baseUrl)
      ? new URL(path.replace(/^\//, ''), `${this.baseUrl.replace(/\/$/, '')}/`).toString()
      : `${this.baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
    const response = await this.fetchImpl(requestUrl, {
      ...init,
      credentials: init.credentials ?? (this.client === 'desktop' ? 'omit' : 'include'),
      headers,
    })
    if (!response.ok) {
      let code: string | undefined
      try {
        const payload = (await response.json()) as { code?: string; message?: string }
        code = payload.code
        throw new ApiClientError(payload.message ?? response.statusText, response.status, code)
      } catch (error) {
        if (error instanceof ApiClientError) throw error
        throw new ApiClientError(response.statusText, response.status, code)
      }
    }
    return (await response.json()) as T
  }
}

export function createApiClient(options?: ApiClientOptions): AgentHqApiClient {
  return new AgentHqApiClient(options)
}
