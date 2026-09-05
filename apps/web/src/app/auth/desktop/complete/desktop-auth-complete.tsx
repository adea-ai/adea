"use client";

import { Check, ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { parseDesktopCallbackFragment } from "../../../../lib/desktop-auth-navigation";

type CompletionStatus = "opening" | "opened" | "invalid";

export function DesktopAuthComplete() {
  const callbackRef = useRef<string | null>(null);
  const attemptedRef = useRef(false);
  const [status, setStatus] = useState<CompletionStatus>("opening");

  function openDesktopApp() {
    if (!callbackRef.current) return;
    window.location.assign(callbackRef.current);
    setStatus("opened");
  }

  useEffect(() => {
    if (attemptedRef.current) return;
    attemptedRef.current = true;

    callbackRef.current = parseDesktopCallbackFragment(window.location.hash);
    window.history.replaceState(null, "", window.location.pathname);
    if (!callbackRef.current) {
      setStatus("invalid");
      return;
    }
    openDesktopApp();
  }, []);

  if (status === "invalid") {
    return (
      <>
        <p className="auth-eyebrow">Agent HQ desktop</p>
        <h1 className="auth-title" id="desktop-auth-complete-title">
          Return link expired
        </h1>
        <p className="auth-introduction" role="alert">
          Start sign-in again from the Agent HQ desktop app to generate a new secure return link.
        </p>
      </>
    );
  }

  return (
    <>
      <span className="browser-auth-success-mark" aria-hidden="true">
        <Check />
      </span>
      <p className="auth-eyebrow">Sign-in successful</p>
      <h1 className="auth-title" id="desktop-auth-complete-title">
        You’re all set
      </h1>
      <p className="auth-introduction" role="status" aria-live="polite">
        Agent HQ {status === "opening" ? "is opening" : "has been opened"}. You can close this tab
        and continue in the desktop app.
      </p>
      <button
        className="browser-auth-submit browser-auth-open-app"
        type="button"
        onClick={openDesktopApp}
      >
        Open Agent HQ
        <ExternalLink aria-hidden="true" />
      </button>
    </>
  );
}
