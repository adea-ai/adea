import { useEffect, useState } from "react";
import type { TaskSummary } from "@adea-ai/types";

import type { PrivateContentResolver } from "./platform";

export function TaskObjective({
  privateContent,
  task,
}: Readonly<{ privateContent?: PrivateContentResolver; task: TaskSummary }>) {
  const [resolved, setResolved] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setResolved(null);
    setFailed(false);
    if (!task.objectiveContentRefId || task.objective || !privateContent) return;
    void privateContent
      .read({ contentId: task.objectiveContentRefId, workspaceId: task.workspaceId })
      .then(({ plaintext }) => active && setResolved(plaintext))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [privateContent, task.objective, task.objectiveContentRefId, task.workspaceId]);
  if (task.objective) return <>{task.objective}</>;
  if (!task.objectiveContentRefId) return <>Objective unavailable</>;
  if (resolved) return <>{resolved}</>;
  if (failed) return <>Private objective unavailable on this authorized device</>;
  return (
    <>
      {privateContent
        ? "Opening private objective…"
        : "Private objective unavailable on this device"}
    </>
  );
}
