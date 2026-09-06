"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Download,
  ExternalLink,
  FileText,
  LoaderCircle,
  RefreshCw,
  Sparkles,
} from "lucide-react";

import { formatReleaseDate, plainTextFromMarkdown } from "#lib/version-notes";
import { Button } from "#components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "#components/ui/dialog";

export type SharedDesktopUpdate = Readonly<{
  available_version: string | null;
  changelog: string;
  current_version: string;
  downloaded_bytes: number;
  error: string | null;
  github_url: string;
  phase:
    | "idle"
    | "checking"
    | "current"
    | "available"
    | "downloading"
    | "installing"
    | "installed"
    | "failed";
  release_date: string | null;
  release_notes: string | null;
  restart_required: boolean;
  total_bytes: number | null;
}>;

export type VersionDialogAdapter = Readonly<{
  check(): Promise<SharedDesktopUpdate>;
  getStatus(): Promise<SharedDesktopUpdate>;
  install(expectedVersion: string): Promise<SharedDesktopUpdate>;
  isDesktopRuntime(): boolean;
}>;

function errorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof Error && caught.message) return caught.message;
  if (typeof caught === "string" && caught) return caught;
  return fallback;
}

function phaseLabel(update: SharedDesktopUpdate | null, fallbackVersion: string): string {
  if (!update) return `Adea v${fallbackVersion}`;
  if (update.phase === "checking") return "Checking for updates…";
  if (update.phase === "available" && update.available_version) {
    return `Update v${update.available_version} available`;
  }
  if (update.phase === "downloading" || update.phase === "installing") {
    return "Installing update…";
  }
  if (update.phase === "failed") return `Version ${update.current_version} · Retry`;
  return `Adea v${update.current_version || fallbackVersion}`;
}

function isUpdateBusy(update: SharedDesktopUpdate | null): boolean {
  return (
    update?.phase === "checking" ||
    update?.phase === "downloading" ||
    update?.phase === "installing"
  );
}

export function VersionDialog({
  adapter,
  fallbackVersion = "0.1.0",
  onOpenChange,
  open: controlledOpen,
}: Readonly<{
  adapter: VersionDialogAdapter;
  fallbackVersion?: string;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
}>) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = useCallback(
    (nextOpen: boolean) => {
      if (controlledOpen === undefined) setUncontrolledOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [controlledOpen, onOpenChange]
  );
  const [desktopRuntime, setDesktopRuntime] = useState(false);
  const [update, setUpdate] = useState<SharedDesktopUpdate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => setDesktopRuntime(adapter.isDesktopRuntime()), [adapter]);

  const loadCurrentStatus = useCallback(async () => {
    if (!desktopRuntime) return;
    try {
      setUpdate(await adapter.getStatus());
    } catch (caught) {
      setError(errorMessage(caught, "Version status is unavailable"));
    }
  }, [adapter, desktopRuntime]);

  useEffect(() => {
    if (desktopRuntime) void loadCurrentStatus();
  }, [desktopRuntime, loadCurrentStatus]);

  const checkForUpdates = useCallback(async () => {
    if (!desktopRuntime) {
      setError("Update checks are available from the desktop app.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      setUpdate(await adapter.check());
    } catch (caught) {
      setError(errorMessage(caught, "Could not check for updates"));
      await loadCurrentStatus();
    } finally {
      setBusy(false);
    }
  }, [adapter, desktopRuntime, loadCurrentStatus]);

  useEffect(() => {
    if (!open || !desktopRuntime) return;
    let active = true;
    setError("");
    setBusy(true);
    void (async () => {
      try {
        const current = await adapter.getStatus();
        if (!active) return;
        setUpdate(current);
        const checked = await adapter.check();
        if (active) setUpdate(checked);
      } catch (caught) {
        if (active) setError(errorMessage(caught, "Could not check for updates"));
      } finally {
        if (active) setBusy(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [adapter, desktopRuntime, open]);

  const install = async () => {
    const version = update?.available_version;
    if (!version) return;
    setBusy(true);
    setError("");
    try {
      setUpdate(await adapter.install(version));
    } catch (caught) {
      setError(errorMessage(caught, "Update installation failed"));
      await loadCurrentStatus();
    } finally {
      setBusy(false);
    }
  };

  const currentChangelog = useMemo(
    () => plainTextFromMarkdown(update?.changelog || "Changelog is loading…"),
    [update?.changelog]
  );
  const releaseNotes = update?.release_notes ? plainTextFromMarkdown(update.release_notes) : "";
  const busyFromSnapshot = isUpdateBusy(update);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {controlledOpen === undefined ? (
        <DialogTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Open version and updates dialog"
              aria-haspopup="dialog"
              onClick={() => setOpen(true)}
            />
          }
        >
          {update?.phase === "available" ? (
            <Sparkles aria-hidden="true" />
          ) : (
            <FileText aria-hidden="true" />
          )}
          {phaseLabel(update, fallbackVersion)}
        </DialogTrigger>
      ) : null}

      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <Sparkles className="size-5" aria-hidden="true" />
            </span>
            <div>
              <DialogTitle>Version & updates</DialogTitle>
              <DialogDescription>
                Keep Adea current and review what changed in each release.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 space-y-5 overflow-y-auto p-6">
          <section className="rounded-xl border bg-background/45 p-4" aria-label="Version status">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Installed version
                </p>
                <p className="text-xl font-semibold tracking-tight">
                  v{update?.current_version || fallbackVersion}
                </p>
                <p className="text-sm text-muted-foreground">
                  {update?.phase === "current"
                    ? "You are running the latest desktop release."
                    : update?.phase === "available" && update.available_version
                      ? `A newer desktop release, v${update.available_version}, is ready.`
                      : desktopRuntime
                        ? "Check the release channel for the latest signed build."
                        : "Open this dialog inside the desktop app to check for updates."}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!desktopRuntime || busy || busyFromSnapshot}
                onClick={() => void checkForUpdates()}
              >
                {busy || busyFromSnapshot ? (
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw aria-hidden="true" />
                )}
                Check latest version
              </Button>
            </div>
          </section>

          {update?.phase === "available" && update.available_version ? (
            <section
              className="rounded-xl border border-primary/35 bg-primary/8 p-4"
              aria-label="Available update"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-1">
                  <p className="flex items-center gap-2 text-sm font-semibold">
                    <Sparkles className="size-4 text-primary" aria-hidden="true" />
                    Version {update.available_version} is ready
                  </p>
                  <p className="text-sm text-muted-foreground">
                    The signed installer will be verified before Adea restarts.
                  </p>
                  {formatReleaseDate(update.release_date) ? (
                    <p className="text-xs text-muted-foreground">
                      Released {formatReleaseDate(update.release_date)}
                    </p>
                  ) : null}
                </div>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy || busyFromSnapshot}
                  onClick={() => void install()}
                >
                  {busy || busyFromSnapshot ? (
                    <LoaderCircle className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Download aria-hidden="true" />
                  )}
                  Install and restart
                </Button>
              </div>
            </section>
          ) : null}

          {update?.phase === "current" ? (
            <p
              className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300"
              role="status"
            >
              <Check className="size-4" aria-hidden="true" />
              Adea is up to date.
            </p>
          ) : null}
          {error ? (
            <p
              className="rounded-lg border border-destructive/35 bg-destructive/8 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          ) : null}

          {releaseNotes ? (
            <section className="space-y-2" aria-labelledby="adea-release-notes">
              <div>
                <h2 id="adea-release-notes" className="text-sm font-semibold">
                  What changed in this release
                </h2>
                <p className="text-xs text-muted-foreground">
                  Release notes are shown as readable text.
                </p>
              </div>
              <div className="max-h-52 overflow-y-auto whitespace-pre-wrap rounded-xl border bg-background/45 p-4 font-mono text-xs leading-5 text-muted-foreground">
                {releaseNotes}
              </div>
            </section>
          ) : null}

          <section className="space-y-2" aria-labelledby="agent-hq-changelog">
            <div>
              <h2 id="agent-hq-changelog" className="text-sm font-semibold">
                Installed changelog
              </h2>
              <p className="text-xs text-muted-foreground">
                A plain-text history of the installed channel.
              </p>
            </div>
            <div className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-xl border bg-background/45 p-4 font-mono text-xs leading-5 text-muted-foreground">
              {currentChangelog}
            </div>
          </section>
        </div>

        <DialogFooter>
          {update?.github_url ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => window.open(update.github_url, "_blank", "noopener,noreferrer")}
            >
              <ExternalLink aria-hidden="true" />
              View releases
            </Button>
          ) : null}
          <DialogClose render={<Button type="button" variant="outline" size="sm" />}>
            Close
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
