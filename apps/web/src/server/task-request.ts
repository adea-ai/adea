import "server-only";

import type { ApiTaskResponse } from "@adea/api-client";
import {
  archiveTask,
  assignTask,
  cancelTask,
  completeTask,
  moveTaskToRoom,
  queueTask,
  reviewTask,
  setTaskArtifactReferences,
  setTaskConversationReferences,
  setTaskDependencies,
  startTask,
  type TaskCommand,
} from "@adea/db";

import { applicationDatabase } from "./database";
import { guardDesktopWorkspaceRequest } from "./desktop-workspace";
import { authorizeWorkspace } from "./workspace-authorization";
import type { WorkspacePrincipalResolution } from "./workspace-principal";
import { resolveWorkspacePrincipal } from "./workspace-principal";
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from "./workspace-response";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function optionalUuid(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || isUuid(value);
}

export function readTaskCommand(request: Request, requireVersion: boolean): TaskCommand | null {
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  const requestId = request.headers.get("x-request-id")?.trim();
  const correlationId = request.headers.get("x-correlation-id")?.trim();
  const versionHeader = request.headers.get("if-match")?.trim();
  const expectedVersion = versionHeader ? Number(versionHeader) : undefined;
  if (
    !idempotencyKey ||
    idempotencyKey.length > 128 ||
    !isUuid(requestId) ||
    (correlationId !== undefined && correlationId.length > 128) ||
    (requireVersion && (!Number.isInteger(expectedVersion) || expectedVersion! < 1))
  )
    return null;
  return {
    ...(correlationId ? { correlationId } : {}),
    ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    idempotencyKey,
    requestId,
  };
}

export function taskErrorResponse(
  error: unknown,
  resolution: WorkspacePrincipalResolution,
  request: Request
) {
  const message = error instanceof Error ? error.message : "";
  if (message === "Task version conflict")
    return workspaceJsonResponse(
      { code: "task_version_conflict", message: "Task version conflict" },
      resolution,
      request,
      { status: 409 }
    );
  if (message === "Task idempotency conflict")
    return workspaceJsonResponse(
      { code: "task_idempotency_conflict", message: "Task idempotency conflict" },
      resolution,
      request,
      { status: 409 }
    );
  if (message.startsWith("Invalid Task lifecycle") || message.startsWith("Task dependency"))
    return workspaceJsonResponse({ code: "task_conflict", message }, resolution, request, {
      status: 409,
    });
  if (message.endsWith("unavailable")) return workspaceUnavailableResponse(request);
  return workspaceJsonResponse(
    { code: "invalid_request", message: "Invalid request" },
    resolution,
    request,
    { status: 400 }
  );
}

export type TaskAction =
  | "archive"
  | "artifacts"
  | "assign"
  | "cancel"
  | "complete"
  | "conversation"
  | "dependencies"
  | "queue"
  | "review"
  | "room"
  | "start";

export async function handleTaskAction(
  action: TaskAction,
  request: Request,
  params: Promise<{ taskId: string; workspaceId: string }>
) {
  const rejected = guardDesktopWorkspaceRequest(request);
  if (rejected) return rejected;
  const { taskId, workspaceId } = await params;
  const resolution = await resolveWorkspacePrincipal(request);
  if (!resolution) return workspaceUnavailableResponse(request, 401);
  if (!(await authorizeWorkspace(resolution.principal, "workspace.update", workspaceId)).allowed)
    return workspaceUnavailableResponse(request);
  const command = readTaskCommand(request, true);
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return workspaceInvalidRequestResponse(request);
  }
  if (!command || !body) return workspaceInvalidRequestResponse(request);
  const database = applicationDatabase();
  try {
    let task;
    switch (action) {
      case "archive":
        task = await archiveTask(database, workspaceId, taskId, resolution.principal, command);
        break;
      case "assign":
        if (body.agentId !== null && !isUuid(body.agentId))
          return workspaceInvalidRequestResponse(request);
        task = await assignTask(
          database,
          workspaceId,
          taskId,
          resolution.principal,
          body.agentId,
          command
        );
        break;
      case "cancel":
        task = await cancelTask(database, workspaceId, taskId, resolution.principal, command);
        break;
      case "complete":
        task = await completeTask(database, workspaceId, taskId, resolution.principal, command);
        break;
      case "queue":
        task = await queueTask(database, workspaceId, taskId, resolution.principal, command);
        break;
      case "review":
        task = await reviewTask(database, workspaceId, taskId, resolution.principal, command);
        break;
      case "start":
        task = await startTask(database, workspaceId, taskId, resolution.principal, command);
        break;
      case "room":
        if (body.roomId !== null && !isUuid(body.roomId))
          return workspaceInvalidRequestResponse(request);
        task = await moveTaskToRoom(
          database,
          workspaceId,
          taskId,
          resolution.principal,
          body.roomId,
          command
        );
        break;
      case "dependencies": {
        if (
          !Array.isArray(body.dependencyIds) ||
          body.dependencyIds.length > 64 ||
          !body.dependencyIds.every(isUuid)
        )
          return workspaceInvalidRequestResponse(request);
        task = await setTaskDependencies(
          database,
          workspaceId,
          taskId,
          resolution.principal,
          body.dependencyIds,
          command
        );
        break;
      }
      case "artifacts": {
        if (
          !Array.isArray(body.artifactRefs) ||
          body.artifactRefs.length > 64 ||
          !body.artifactRefs.every(
            (value) => typeof value === "string" && value.trim() && value.length <= 256
          )
        )
          return workspaceInvalidRequestResponse(request);
        task = await setTaskArtifactReferences(
          database,
          workspaceId,
          taskId,
          resolution.principal,
          body.artifactRefs,
          command
        );
        break;
      }
      case "conversation": {
        if (
          !optionalUuid(body.channelId) ||
          !optionalUuid(body.messageId) ||
          !optionalUuid(body.threadRootMessageId)
        )
          return workspaceInvalidRequestResponse(request);
        const conversation = {
          channelId: body.channelId,
          messageId: body.messageId,
          threadRootMessageId: body.threadRootMessageId,
        };
        task = await setTaskConversationReferences(
          database,
          workspaceId,
          taskId,
          resolution.principal,
          conversation,
          command
        );
        break;
      }
    }
    const payload: ApiTaskResponse = { task };
    return workspaceJsonResponse(payload, resolution, request);
  } catch (error) {
    return taskErrorResponse(error, resolution, request);
  }
}
