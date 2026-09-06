"use client";

import { useEffect, useState } from "react";
import { Button } from "@adea-ai/ui/components/ui/button";
import { WorkspaceLogo } from "@adea-ai/ui/components/workspace-logo";
import { ExternalLink } from "lucide-react";

import { ModalDialog } from "./modal-dialog";

export function WorkspaceAboutDialog({
  appName = "Adea",
  onClose,
  open,
  platform = "web",
  version,
}: Readonly<{
  appName?: string;
  onClose: () => void;
  open: boolean;
  platform?: "desktop" | "web";
  version?: string;
}>) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const copyVersionInfo = async () => {
    const info = [
      appName,
      version ? `Version ${version}` : "Version unavailable",
      `Platform: ${platform}`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(info);
      setCopied(true);
    } catch {
      // Clipboard access is optional; leave the dialog usable when unavailable.
    }
  };

  return (
    <ModalDialog
      className="conventional-about-dialog"
      open={open}
      onClose={onClose}
      title="About Adea"
      description="A calm, connected home for your agents, rooms, and conversations."
    >
      <div className="conventional-about-dialog__body">
        <div className="conventional-about-dialog__identity">
          <div className="conventional-about-dialog__brand" aria-label="Adea" role="img">
            <WorkspaceLogo aria-hidden="true" role="presentation" />
          </div>
          <h3>{appName}</h3>
          <p>{version ? `Version ${version}` : "Version unavailable"}</p>
          <small>Copyright © 2026 0xPlayerOne</small>
        </div>
        <footer className="conventional-about-dialog__footer">
          <Button type="button" variant="outline" size="sm" onClick={() => void copyVersionInfo()}>
            {copied ? "Copied" : "Copy version info"}
          </Button>
          <a href="https://github.com/adea-ai/adea" target="_blank" rel="noreferrer">
            <ExternalLink aria-hidden="true" />
            View source
          </a>
        </footer>
      </div>
    </ModalDialog>
  );
}
