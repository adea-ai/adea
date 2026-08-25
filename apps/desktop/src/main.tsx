import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  createDesktopAuthorizationManager,
  createDesktopAuthorizationUrl,
  createDesktopHttpSessionBroker,
  createDesktopSessionManager,
  type DesktopAuthorizationAttempt,
  type DesktopSession,
  type DesktopSessionVault,
} from "@agent-hq/auth/desktop";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";

const cloudOrigin =
  import.meta.env.VITE_AGENT_HQ_CLOUD_ORIGIN || "https://agent-hq-site.vercel.app";

type AuthStatus = "authenticated" | "failed" | "idle" | "offline" | "opening" | "waiting";

const sessionVault: DesktopSessionVault = {
  clear: () => invoke("desktop_user_session_clear"),
  load: () => invoke<DesktopSession | null>("desktop_user_session_load"),
  save: (session) => invoke("desktop_user_session_save", { session }),
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

function DesktopApp() {
  const [status, setStatus] = useState<AuthStatus>("idle");
  const [message, setMessage] = useState(
    "Sign in through your system browser. Agent HQ never places session credentials in callback URLs.",
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void sessionManager.restore().then((sessionState) => {
      if (sessionState.status === "authenticated") {
        setStatus("authenticated");
        setMessage("Your desktop user session is active.");
      } else if (sessionState.status === "offline") {
        setStatus("offline");
        setMessage("Agent HQ is offline. Your saved session remains protected on this device.");
      }
    });
    async function receiveCallback() {
      let callbackUrl: string | null;
      try {
        callbackUrl = await invoke<string | null>("desktop_auth_take_callback");
      } catch {
        return;
      }
      if (!callbackUrl) return;
      try {
        const exchange = await authorizationManager.consume(callbackUrl);
        const sessionState = await sessionManager.completeSignIn(exchange);
        if (sessionState.status !== "authenticated") throw new Error("Authentication failed");
        setStatus("authenticated");
        setMessage("Sign-in complete. Your desktop user session is active.");
      } catch {
        setStatus("failed");
        setMessage("The sign-in callback was invalid or expired. Start again from this app.");
      }
    }

    void listen("desktop-auth-callback-ready", () => {
      void receiveCallback();
    }).then((dispose) => {
      unlisten = dispose;
      void receiveCallback();
    });
    return () => unlisten?.();
  }, []);

  async function beginSignIn() {
    setStatus("opening");
    setMessage("Opening your system browser…");
    try {
      const nextAttempt = await authorizationManager.begin();
      await invoke("desktop_auth_start", {
        authorizationUrl: createDesktopAuthorizationUrl(cloudOrigin, nextAttempt),
      });
      setStatus("waiting");
      setMessage("Finish signing in in your browser, then return to Agent HQ.");
    } catch {
      await authorizationManager.cancel().catch(() => undefined);
      setStatus("failed");
      setMessage(
        "Agent HQ could not open the trusted sign-in page. Check your connection and try again.",
      );
    }
  }

  async function signOut() {
    try {
      await sessionManager.signOut();
      setStatus("idle");
      setMessage("Signed out of Agent HQ. Paired RuntimeNodes were not changed.");
    } catch {
      setStatus("idle");
      setMessage("Signed out on this device. The remote session could not be reached.");
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel" aria-labelledby="desktop-title">
        <p className="auth-eyebrow">Agent HQ desktop</p>
        <h1 className="auth-title" id="desktop-title">
          Your workspace, packaged for this device.
        </h1>
        <p className="auth-introduction">
          The desktop app runs bundled client code and connects to Agent HQ cloud services over a
          narrow, authenticated boundary.
        </p>
        <div className="status" role="status" aria-live="polite">
          <span className={`status-mark status-mark--${status}`} aria-hidden="true" />
          <p>{message}</p>
        </div>
        {status === "authenticated" ? (
          <button type="button" onClick={signOut}>
            Sign out
          </button>
        ) : (
          <button
            type="button"
            onClick={beginSignIn}
            disabled={status === "opening" || status === "waiting"}
          >
            {status === "waiting" ? "Waiting for browser" : "Continue in browser"}
          </button>
        )}
        <p className="privacy-note">
          Authentication uses PKCE, a short-lived one-time code, and the registered Agent HQ
          callback. RuntimeNode device credentials remain separate.
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
