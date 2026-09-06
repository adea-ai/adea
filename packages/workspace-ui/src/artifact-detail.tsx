import type { ArtifactSummary } from "@adea/types";
import { FileText, X } from "lucide-react";

export function ArtifactDetail({
  artifact,
  dismiss,
  openTask,
}: Readonly<{
  artifact: ArtifactSummary;
  dismiss: () => void;
  openTask: (taskId: string) => void;
}>) {
  return (
    <section className="conventional-artifact-detail" aria-labelledby="artifact-title">
      <header className="conventional-surface-header">
        <div>
          <span>Artifact</span>
          <h1 id="artifact-title">{artifact.filename}</h1>
        </div>
        <button type="button" aria-label="Dismiss Artifact details" onClick={dismiss}>
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="conventional-artifact-detail__body">
        <FileText aria-hidden="true" />
        <p>{artifact.mediaType}</p>
        <p>{artifact.availability}</p>
        <p>{artifact.sizeBytes.toLocaleString()} bytes</p>
        {artifact.taskId ? (
          <button type="button" onClick={() => openTask(artifact.taskId!)}>
            Open linked Task
          </button>
        ) : null}
      </div>
    </section>
  );
}
