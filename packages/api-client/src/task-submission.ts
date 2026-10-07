import type { TaskSubmissionSummary } from '@adea-ai/types'

import { AgentHqApiClient, taskCommandHeaders, type ApiTaskCommand } from './index.js'

export type ApiTaskSubmissionInput = Readonly<{
  runtimeNodeId: string
  queueWhenOffline: boolean
  profile: TaskSubmissionSummary['profile']
  envelope: unknown
}>
export type ApiTaskSubmissionResponse = Readonly<{ submission: TaskSubmissionSummary | null }>

/** Separate client so delivery commands are loaded only by their consumers. */
export class TaskSubmissionApiClient extends AgentHqApiClient {
  /** Durable ciphertext admission. The response is delivery intent, not execution acceptance. */
  async enqueueTaskSubmission(
    workspaceId: string,
    taskId: string,
    input: ApiTaskSubmissionInput,
    command: ApiTaskCommand
  ): Promise<ApiTaskSubmissionResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/tasks/${encodeURIComponent(taskId)}/submission`,
      {
        method: 'POST',
        headers: taskCommandHeaders(command),
        body: JSON.stringify(input),
      }
    )
  }

  async getTaskSubmission(workspaceId: string, taskId: string): Promise<ApiTaskSubmissionResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/tasks/${encodeURIComponent(taskId)}/submission`
    )
  }
}
