import { handleDesktopWorkspacePreflight } from "../../../../../../../../server/desktop-workspace";
import { handleTaskAction } from "../../../../../../../../server/task-request";

export const runtime = "nodejs";
export const OPTIONS = handleDesktopWorkspacePreflight;
export const POST = (
  request: Request,
  context: { params: Promise<{ taskId: string; workspaceId: string }> }
) => handleTaskAction("dependencies", request, context.params);
