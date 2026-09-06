import type { ApiMessagePage, ApiMessageResponse } from "@adea/api-client";
import { createMessage, listMessagesForUser } from "@adea/db";

import {
  conversationErrorResponse,
  isConversationUuid,
  parseConversationParticipant,
} from "../../../../../../../../server/conversation-request";
import { applicationDatabase } from "../../../../../../../../server/database";
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from "../../../../../../../../server/desktop-workspace";
import { authorizeWorkspace } from "../../../../../../../../server/workspace-authorization";
import { resolveWorkspacePrincipal } from "../../../../../../../../server/workspace-principal";
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from "../../../../../../../../server/workspace-response";

export const runtime = "nodejs";
export const OPTIONS = handleDesktopWorkspacePreflight;
type Context = { params: Promise<{ channelId: string; workspaceId: string }> };

export async function GET(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request);
  if (rejected) return rejected;
  const { channelId, workspaceId } = await params;
  const resolution = await resolveWorkspacePrincipal(request);
  if (!resolution) return workspaceUnavailableResponse(request, 401);
  if (!(await authorizeWorkspace(resolution.principal, "workspace.read", workspaceId)).allowed)
    return workspaceUnavailableResponse(request);
  const url = new URL(request.url);
  const afterSequence = url.searchParams.has("afterSequence")
    ? Number(url.searchParams.get("afterSequence"))
    : undefined;
  const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
  const threadRootMessageId = url.searchParams.get("threadRootMessageId") ?? undefined;
  if (
    (afterSequence !== undefined && (!Number.isSafeInteger(afterSequence) || afterSequence < 0)) ||
    (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) ||
    (threadRootMessageId !== undefined && !isConversationUuid(threadRootMessageId))
  )
    return workspaceInvalidRequestResponse(request);
  try {
    const payload: ApiMessagePage = await listMessagesForUser(
      applicationDatabase(),
      workspaceId,
      channelId,
      resolution.principal,
      { afterSequence, limit, threadRootMessageId }
    );
    return workspaceJsonResponse(payload, resolution, request, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return conversationErrorResponse(error, resolution, request);
  }
}

export async function POST(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request);
  if (rejected) return rejected;
  const { channelId, workspaceId } = await params;
  const resolution = await resolveWorkspacePrincipal(request);
  if (!resolution) return workspaceUnavailableResponse(request, 401);
  if (!(await authorizeWorkspace(resolution.principal, "workspace.update", workspaceId)).allowed)
    return workspaceUnavailableResponse(request);
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return workspaceInvalidRequestResponse(request);
  }
  const hasBodyText = typeof body?.bodyText === "string" && Boolean(body.bodyText.trim());
  const hasBodyRef = isConversationUuid(body?.bodyContentRefId);
  const mentions = Array.isArray(body?.mentions)
    ? body.mentions.map(parseConversationParticipant)
    : [];
  if (
    !body ||
    !idempotencyKey ||
    idempotencyKey.length > 128 ||
    hasBodyText === hasBodyRef ||
    (hasBodyText && (body.bodyText as string).length > 100_000) ||
    (body.mentions !== undefined &&
      (!Array.isArray(body.mentions) ||
        body.mentions.length > 64 ||
        mentions.some((value) => !value))) ||
    (body.artifactIds !== undefined &&
      (!Array.isArray(body.artifactIds) ||
        body.artifactIds.length > 64 ||
        !body.artifactIds.every(isConversationUuid))) ||
    [body.taskId, body.replyToMessageId, body.threadRootMessageId]
      .filter((value) => value !== undefined)
      .some((value) => !isConversationUuid(value)) ||
    [body.executionRef, body.externalSessionRef]
      .filter((value) => value !== undefined)
      .some((value) => typeof value !== "string" || !value.trim() || value.length > 256)
  )
    return workspaceInvalidRequestResponse(request);
  try {
    const payload: ApiMessageResponse = {
      message: await createMessage(
        applicationDatabase(),
        workspaceId,
        channelId,
        resolution.principal,
        {
          ...(Array.isArray(body.artifactIds) ? { artifactIds: body.artifactIds as string[] } : {}),
          ...(hasBodyRef ? { bodyContentRefId: body.bodyContentRefId as string } : {}),
          ...(hasBodyText ? { bodyText: body.bodyText as string } : {}),
          ...(typeof body.executionRef === "string" ? { executionRef: body.executionRef } : {}),
          ...(typeof body.externalSessionRef === "string"
            ? { externalSessionRef: body.externalSessionRef }
            : {}),
          idempotencyKey,
          mentions: mentions as never,
          ...(isConversationUuid(body.replyToMessageId)
            ? { replyToMessageId: body.replyToMessageId }
            : {}),
          sender: resolution.principal,
          ...(isConversationUuid(body.taskId) ? { taskId: body.taskId } : {}),
          ...(isConversationUuid(body.threadRootMessageId)
            ? { threadRootMessageId: body.threadRootMessageId }
            : {}),
        }
      ),
    };
    return workspaceJsonResponse(payload, resolution, request, { status: 201 });
  } catch (error) {
    return conversationErrorResponse(error, resolution, request);
  }
}
