import { Suspense } from "react";

import { WorkspaceShell } from "@/components/workspace-shell";

export default function HomePage() {
  return (
    <Suspense fallback={<div className="scene-viewport__loading">Loading Agent HQ…</div>}>
      <WorkspaceShell />
    </Suspense>
  );
}
