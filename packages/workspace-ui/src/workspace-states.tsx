import { AlertTriangle, Inbox, RefreshCw } from "lucide-react";
import { ApiClientError } from "@adea/api-client";

export function WorkspaceSkeleton({ label = "Loading workspace" }: { label?: string }) {
  return (
    <div className="conventional-skeleton" aria-busy="true" aria-label={label}>
      {Array.from({ length: 6 }, (_, index) => (
        <span key={index} />
      ))}
    </div>
  );
}

export function WorkspaceEmpty({
  action,
  detail,
  title,
}: {
  action?: React.ReactNode;
  detail: string;
  title: string;
}) {
  return (
    <section className="conventional-empty" aria-labelledby="workspace-empty-title">
      <Inbox aria-hidden="true" />
      <h2 id="workspace-empty-title">{title}</h2>
      <p>{detail}</p>
      {action}
    </section>
  );
}

function errorCopy(error: unknown) {
  if (error instanceof ApiClientError) {
    if (error.status === 401) return "Your session expired. Sign in again to continue.";
    if (error.status === 403) return "You do not have permission to use this workspace.";
    if (error.status === 404) return "This workspace item is no longer available.";
    if (error.status === 409) return "This changed elsewhere. Reload the latest version and retry.";
    if (error.status === 400) return "The request was not valid. Check the fields and try again.";
  }
  if (typeof navigator !== "undefined" && !navigator.onLine)
    return "You appear to be offline. Your draft is safe on this device.";
  return "Agent HQ could not load this content. Your durable workspace was not changed.";
}

export function WorkspaceError({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <section className="conventional-error" role="alert">
      <AlertTriangle aria-hidden="true" />
      <div>
        <h2>Something interrupted the workspace</h2>
        <p>{errorCopy(error)}</p>
      </div>
      {retry ? (
        <button type="button" className="conventional-secondary-button" onClick={retry}>
          <RefreshCw aria-hidden="true" />
          Retry
        </button>
      ) : null}
    </section>
  );
}
