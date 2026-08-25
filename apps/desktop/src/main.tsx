import { createApiClient } from "@agent-hq/api-client";
import {
  createDesktopAuthorizationManager,
  createDesktopAuthorizationUrl,
  createDesktopHttpSessionBroker,
  createDesktopSessionManager,
  type DesktopAuthorizationAttempt,
  type DesktopSession,
  type DesktopSessionVault,
} from "@agent-hq/auth/desktop";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { bootstrapDesktopWorkspace, type DesktopWorkspaceBootstrap } from "./workspace-session";
import "./styles.css";

const cloudOrigin =
  import.meta.env.VITE_AGENT_HQ_CLOUD_ORIGIN || "https://agent-hq-site.vercel.app";

type AppStatus =
  "authenticated" | "failed" | "guest" | "loading" | "offline" | "opening" | "waiting";

const sessionVault: DesktopSessionVault = {
  clear: () => invoke("desktop_user_session_clear"),
  load: () => invoke<DesktopSession | null>("desktop_user_session_load"),
  save: (session) => invoke("desktop_user_session_save", { session }),
};
const temporaryVault = {
  clear: () => invoke<void>("desktop_temporary_workspace_clear"),
  load: () => invoke<string | null>("desktop_temporary_workspace_load"),
  save: (credential: string) => invoke<void>("desktop_temporary_workspace_save", { credential }),
};
const authorizationManager = createDesktopAuthorizationManager({
  vault: {
    clear: () => invoke("desktop_auth_attempt_clear"),
    load: () => invoke<DesktopAuthorizationAttempt | null>("desktop_auth_attempt_load"),
    save: (authorizationAttempt) =>
      invoke("desktop_auth_attempt_save", { attempt: authorizationAttempt }),
  },
});
const sessionManager = createDesktopSessionManager({
  broker: createDesktopHttpSessionBroker({ cloudOrigin }),
  vault: sessionVault,
});

function workspaceClient(session?: DesktopSession, temporaryCredential?: string) {
  return createApiClient({
    baseUrl: `${cloudOrigin}/api`,
    client: "desktop",
    getDesktopSession: session
      ? () => ({ credential: session.credential, sessionId: session.sessionId })
      : undefined,
    getTemporaryCredential: temporaryCredential ? () => temporaryCredential : undefined,
  });
}

function DesktopApp() {
  const [status, setStatus] = useState<AppStatus>("loading");
  const [message, setMessage] = useState("Opening your workspace…");
  const [workspaceState, setWorkspaceState] = useState<DesktopWorkspaceBootstrap | null>(null);
  const [session, setSession] = useState<DesktopSession | undefined>();

  const openWorkspace = useCallback(async (activeSession?: DesktopSession) => {
    setStatus("loading");
    setMessage(
      activeSession ? "Opening your saved workspace…" : "Opening a private guest workspace…",
    );
    try {
      const storedTemporaryCredential = await temporaryVault.load();
      const nextWorkspace = await bootstrapDesktopWorkspace({
        createClient: ({ session: clientSession, temporaryCredential }) =>
          workspaceClient(clientSession, temporaryCredential),
        session: activeSession,
        storedTemporaryCredential,
        temporaryVault,
      });
      setSession(activeSession);
      setWorkspaceState(nextWorkspace);
      setStatus(activeSession ? "authenticated" : "guest");
      setMessage(
        activeSession
          ? "Your workspace is saved to your Agent HQ account."
          : "You can use this workspace now. Sign in whenever you want to save it to an account.",
      );
    } catch {
      setStatus("offline");
      setMessage(
        "Agent HQ could not reach the workspace service. Your local credentials are safe.",
      );
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void sessionManager.restore().then((sessionState) => {
      if (disposed) return;
      void openWorkspace(
        sessionState.status === "authenticated" ? sessionState.session : undefined,
      );
    });

    async function receiveCallback() {
      let callbackUrl: string | null;
      try {
        callbackUrl = await invoke<string | null>("desktop_auth_take_callback");
      } catch {
        return;
      }
      if (!callbackUrl || disposed) return;
      try {
        const exchange = await authorizationManager.consume(callbackUrl);
        const sessionState = await sessionManager.completeSignIn(exchange);
        if (sessionState.status !== "authenticated") throw new Error("Authentication failed");
        await openWorkspace(sessionState.session);
      } catch {
        setStatus("failed");
        setMessage(
          "The sign-in callback was invalid or expired. Your guest workspace is unchanged.",
        );
      }
    }

    void listen("desktop-auth-callback-ready", () => void receiveCallback()).then((dispose) => {
      if (disposed) return dispose();
      unlisten = dispose;
      void receiveCallback();
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openWorkspace]);

  async function beginSignIn() {
    setStatus("opening");
    setMessage("Opening your system browser…");
    try {
      const nextAttempt = await authorizationManager.begin();
      await invoke("desktop_auth_start", {
        authorizationUrl: createDesktopAuthorizationUrl(cloudOrigin, nextAttempt),
      });
      setStatus("waiting");
      setMessage(
        "Finish signing in in your browser, then return here. This app will reopen automatically.",
      );
    } catch {
      await authorizationManager.cancel().catch(() => undefined);
      setStatus(workspaceState?.temporary ? "guest" : "failed");
      setMessage("Agent HQ could not open the trusted sign-in page. Your workspace is unchanged.");
    }
  }

  async function signOut() {
    await sessionManager.signOut().catch(() => undefined);
    setSession(undefined);
    setWorkspaceState(null);
    await openWorkspace();
  }

  const busy = status === "loading" || status === "opening" || status === "waiting";

  return (
    <main className="auth-shell">
      <section className="auth-panel desktop-panel" aria-labelledby="desktop-title">
        <div className="workspace-heading">
          <div>
            <p className="auth-eyebrow">Agent HQ desktop</p>
            <h1 className="auth-title" id="desktop-title">
              {workspaceState?.workspace.name ?? "Your workspace, ready when you are."}
            </h1>
          </div>
          {workspaceState ? (
            <span
              className={`workspace-badge workspace-badge--${workspaceState.temporary ? "guest" : "saved"}`}
            >
              {workspaceState.temporary ? "Guest workspace" : "Saved workspace"}
            </span>
          ) : null}
        </div>
        <p className="auth-introduction">
          Start immediately without an account. Sign in later to keep this workspace across devices.
        </p>

        {workspaceState ? (
          <div className="workspace-card">
            <span className="workspace-card__label">Current scene</span>
            <strong>{workspaceState.workspace.scene === "work" ? "Work" : "Home"}</strong>
            <span>
              {workspaceState.workspaces.length} workspace
              {workspaceState.workspaces.length === 1 ? "" : "s"}
            </span>
          </div>
        ) : null}

        <div className="status" role="status" aria-live="polite">
          <span className={`status-mark status-mark--${status}`} aria-hidden="true" />
          <p>{message}</p>
        </div>

        <div className="workspace-actions">
          {session ? (
            <button type="button" className="button-secondary" onClick={signOut} disabled={busy}>
              Sign out
            </button>
          ) : (
            <button type="button" onClick={beginSignIn} disabled={busy || !workspaceState}>
              {status === "waiting" ? "Waiting for browser" : "Save this workspace"}
            </button>
          )}
          {(status === "offline" || status === "failed") && (
            <button
              type="button"
              className="button-secondary"
              onClick={() => void openWorkspace(session)}
            >
              Try again
            </button>
          )}
        </div>

        <p className="privacy-note">
          Guest access is protected by a device-only keychain credential. Optional sign-in uses
          PKCE; no session token is placed in the browser callback URL.
        </p>
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Desktop application root is unavailable");
createRoot(root).render(
  <StrictMode>
    <DesktopApp />
  </StrictMode>,
);
